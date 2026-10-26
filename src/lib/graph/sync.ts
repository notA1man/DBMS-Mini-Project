// Neo4j projection of the operations data (Aditya). Applies outbox events in batches with
// UNWIND + MERGE, so delivering the same event twice leaves the graph unchanged (idempotent).
// Every event carries a full snapshot plus updatedAt; a node only accepts a snapshot that is
// at least as new as the one it holds, so out-of-order delivery is safe too.
//
// Model
//   (:Airport {code,name,city,country,timezone,lat,lon,location})
//   (:Aircraft {id,registration,model,typeRating,capacity,status})
//   (:Flight {flightId,number,origin,destination,dep,arr,status,delayMinutes,durationMin,minFare})
//   (:Airport)-[:HAS_DEPARTURE]->(:Flight)-[:ARRIVES_AT]->(:Airport)
//   (:Flight)-[:OPERATED_BY]->(:Aircraft)
//   (:Flight)-[:CONNECTS_TO {layoverMin}]->(:Flight)      same airport, 45-360 min, neither cancelled
//   (:Airport)-[:ROUTE {distanceKm,flightsPerWeek,avgDurationMin}]->(:Airport)
//   (:Crew {crewId,name,designation,base})-[:FLEW_WITH {flights}]-(:Crew)   (rebuilt by reconcile)
import type { Driver } from 'neo4j-driver';

export type GraphEvent = { event_id: string; event_type: string; payload: Record<string, unknown> };
type Row = Record<string, unknown>;

export const GRAPH_EVENT_TYPES = new Set(['AIRPORT_UPSERT', 'AIRCRAFT_UPSERT', 'FLIGHT_UPSERT', 'FLIGHT_FARE_UPSERT', 'FLIGHT_DELETED']);

export const CONSTRAINTS = [
  'CREATE CONSTRAINT airport_code IF NOT EXISTS FOR (a:Airport) REQUIRE a.code IS UNIQUE',
  'CREATE CONSTRAINT flight_id IF NOT EXISTS FOR (f:Flight) REQUIRE f.flightId IS UNIQUE',
  'CREATE CONSTRAINT aircraft_id IF NOT EXISTS FOR (x:Aircraft) REQUIRE x.id IS UNIQUE',
  'CREATE CONSTRAINT crew_id IF NOT EXISTS FOR (c:Crew) REQUIRE c.crewId IS UNIQUE',
  'CREATE INDEX flight_dep IF NOT EXISTS FOR (f:Flight) ON (f.dep)',
  'CREATE INDEX flight_route_dep IF NOT EXISTS FOR (f:Flight) ON (f.origin, f.dep)',
];

export async function ensureGraphSchema(driver: Driver) {
  for (const statement of CONSTRAINTS) await driver.executeQuery(statement);
}

const AIRPORTS = `
UNWIND $rows AS r
MERGE (a:Airport {code: r.code})
WITH a, r WHERE a.updatedAt IS NULL OR a.updatedAt <= datetime(r.updatedAt)
SET a.name = r.name, a.city = r.city, a.country = r.country, a.timezone = r.timezone,
    a.lat = toFloat(r.lat), a.lon = toFloat(r.lon),
    a.location = point({latitude: toFloat(r.lat), longitude: toFloat(r.lon)}),
    a.updatedAt = datetime(r.updatedAt)`;

const AIRCRAFT = `
UNWIND $rows AS r
MERGE (x:Aircraft {id: r.aircraftId})
WITH x, r WHERE x.updatedAt IS NULL OR x.updatedAt <= datetime(r.updatedAt)
SET x.registration = r.registration, x.model = r.model, x.typeRating = r.typeRating,
    x.capacity = r.capacity, x.status = r.status, x.updatedAt = datetime(r.updatedAt)`;

const FLIGHTS = `
UNWIND $rows AS r
MERGE (f:Flight {flightId: r.flightId})
WITH f, r WHERE f.updatedAt IS NULL OR f.updatedAt <= datetime(r.updatedAt)
SET f.number = r.flightNumber, f.origin = r.origin, f.destination = r.destination,
    f.dep = datetime(r.departureTime), f.arr = datetime(r.arrivalTime), f.status = r.status,
    f.delayMinutes = r.delayMinutes, f.durationMin = r.durationMinutes, f.gate = r.gate,
    f.updatedAt = datetime(r.updatedAt)
WITH f, r
OPTIONAL MATCH (oldO:Airport)-[h:HAS_DEPARTURE]->(f) WHERE oldO.code <> r.origin
DELETE h
WITH f, r
OPTIONAL MATCH (f)-[ar:ARRIVES_AT]->(oldD:Airport) WHERE oldD.code <> r.destination
DELETE ar
WITH f, r
OPTIONAL MATCH (f)-[op:OPERATED_BY]->(oldA:Aircraft) WHERE oldA.id <> r.aircraftId
DELETE op
WITH f, r
MATCH (o:Airport {code: r.origin}), (d:Airport {code: r.destination})
MERGE (o)-[:HAS_DEPARTURE]->(f)
MERGE (f)-[:ARRIVES_AT]->(d)
WITH f, r
OPTIONAL MATCH (x:Aircraft {id: r.aircraftId})
FOREACH (_ IN CASE WHEN x IS NULL THEN [] ELSE [1] END | MERGE (f)-[:OPERATED_BY]->(x))`;

const FARES = `
UNWIND $rows AS r
MATCH (f:Flight {flightId: r.flightId})
SET f.fareEconomy = CASE WHEN r.fareClass = 'Economy' THEN toFloat(r.baseFare) ELSE f.fareEconomy END,
    f.fareBusiness = CASE WHEN r.fareClass = 'Business' THEN toFloat(r.baseFare) ELSE f.fareBusiness END,
    f.fareFirst = CASE WHEN r.fareClass = 'First' THEN toFloat(r.baseFare) ELSE f.fareFirst END
SET f.minFare = coalesce(f.fareEconomy, f.fareBusiness, f.fareFirst)`;

const DELETES = `UNWIND $ids AS id MATCH (f:Flight {flightId: id}) DETACH DELETE f`;

// Connections are derived, so they are recomputed (delete + rebuild) around every changed flight.
const CONNECTIONS = `
UNWIND $ids AS id
MATCH (f:Flight {flightId: id})
OPTIONAL MATCH (f)-[old:CONNECTS_TO]-()
DELETE old
WITH DISTINCT f
WHERE f.status IN ['Scheduled', 'Delayed', 'Boarding'] AND f.arr > datetime() - duration('PT6H')
CALL {
  WITH f
  MATCH (g:Flight)
  WHERE g.origin = f.destination AND g.destination <> f.origin
    AND g.status IN ['Scheduled', 'Delayed']
    AND g.dep >= f.arr + duration('PT45M') AND g.dep <= f.arr + duration('PT6H')
  MERGE (f)-[c:CONNECTS_TO]->(g)
  SET c.layoverMin = duration.inSeconds(f.arr, g.dep).minutes
  RETURN count(*) AS outgoing
}
CALL {
  WITH f
  MATCH (h:Flight)
  WHERE h.destination = f.origin AND h.origin <> f.destination
    AND h.status IN ['Scheduled', 'Delayed', 'Boarding']
    AND f.dep >= h.arr + duration('PT45M') AND f.dep <= h.arr + duration('PT6H')
  MERGE (h)-[c:CONNECTS_TO]->(f)
  SET c.layoverMin = duration.inSeconds(h.arr, f.dep).minutes
  RETURN count(*) AS incoming
}
RETURN sum(outgoing + incoming) AS connections`;

// Route edges summarise a rolling two-week window of non-cancelled flights.
const ROUTES = `
UNWIND $pairs AS p
MATCH (o:Airport {code: p.o}), (d:Airport {code: p.d})
OPTIONAL MATCH (o)-[:HAS_DEPARTURE]->(f:Flight)-[:ARRIVES_AT]->(d)
WHERE f.status <> 'Cancelled' AND f.dep >= datetime() - duration('P7D') AND f.dep < datetime() + duration('P7D')
WITH o, d, count(f) AS n, avg(f.durationMin) AS avgDur
MERGE (o)-[r:ROUTE]->(d)
SET r.flightsPerWeek = n / 2.0, r.avgDurationMin = round(coalesce(avgDur, 0)),
    r.distanceKm = round(point.distance(o.location, d.location) / 1000)`;

/** Applies a batch of outbox events to Neo4j. Throws if any statement fails (the whole batch is retried). */
export async function applyGraphEvents(driver: Driver, events: GraphEvent[]) {
  const of = (type: string) => events.filter(e => e.event_type === type).map(e => e.payload);
  const airports = of('AIRPORT_UPSERT') as Row[];
  const aircraft = of('AIRCRAFT_UPSERT') as Row[];
  const flights = (of('FLIGHT_UPSERT') as Row[]).map(p => p.flight as Row);
  const fares = of('FLIGHT_FARE_UPSERT') as Row[];
  const deleted = (of('FLIGHT_DELETED') as Row[]).map(p => String(p.flightId));

  if (airports.length) await driver.executeQuery(AIRPORTS, { rows: airports });
  if (aircraft.length) await driver.executeQuery(AIRCRAFT, { rows: aircraft });
  if (flights.length) await driver.executeQuery(FLIGHTS, { rows: flights });
  if (fares.length) await driver.executeQuery(FARES, { rows: fares });
  if (deleted.length) await driver.executeQuery(DELETES, { ids: deleted });

  const changed = [...new Set(flights.map(f => String(f.flightId)))];
  for (let i = 0; i < changed.length; i += 200) {
    await driver.executeQuery(CONNECTIONS, { ids: changed.slice(i, i + 200) });
  }
  const pairs = [...new Map(flights.map(f => [`${f.origin}-${f.destination}`, { o: f.origin, d: f.destination }])).values()];
  if (pairs.length) await driver.executeQuery(ROUTES, { pairs });
  return { airports: airports.length, aircraft: aircraft.length, flights: changed.length, fares: fares.length, deleted: deleted.length };
}

/** Crew "flew-with" network: who has worked the same flights (used for crew pairing analysis). */
export async function replaceCrewNetwork(driver: Driver, crew: Row[], pairs: { a: string; b: string; flights: number }[]) {
  await driver.executeQuery('MATCH (c:Crew) DETACH DELETE c');
  await driver.executeQuery(`UNWIND $rows AS r MERGE (c:Crew {crewId: r.crewId})
    SET c.name = r.name, c.designation = r.designation, c.base = r.base`, { rows: crew });
  for (let i = 0; i < pairs.length; i += 2000) {
    await driver.executeQuery(`UNWIND $rows AS r
      MATCH (a:Crew {crewId: r.a}), (b:Crew {crewId: r.b})
      MERGE (a)-[w:FLEW_WITH]-(b) SET w.flights = r.flights`, { rows: pairs.slice(i, i + 2000) });
  }
}
