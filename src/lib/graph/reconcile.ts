// Rebuilds the whole Neo4j graph from PostgreSQL (the source of truth). It turns current rows
// into the same snapshot events the outbox carries and feeds them through applyGraphEvents, so
// a rebuilt graph is identical to an incrementally synced one.
import type { Pool } from 'pg';
import type { Driver } from 'neo4j-driver';
import { applyGraphEvents, ensureGraphSchema, replaceCrewNetwork, type GraphEvent } from './sync';

const asEvents = (type: string, rows: Record<string, unknown>[]): GraphEvent[] =>
  rows.map((payload, i) => ({ event_id: `reconcile-${type}-${i}`, event_type: type, payload }));

export async function reconcileGraph(pool: Pool, driver: Driver, { daysBack = 30, daysAhead = 30 } = {}) {
  await ensureGraphSchema(driver);
  // Delete in chunks to keep each transaction small.
  for (;;) {
    const { records } = await driver.executeQuery('MATCH (n) WITH n LIMIT 5000 DETACH DELETE n RETURN count(*) AS n');
    if (Number(records[0].get('n')) === 0) break;
  }
  const airports = (await pool.query(`SELECT airport_code AS code, airport_name AS name, city, country, timezone,
    latitude AS lat, longitude AS lon, updated_at AS "updatedAt" FROM airport`)).rows;
  const aircraft = (await pool.query(`SELECT aircraft_id::text AS "aircraftId", registration, model, type_rating AS "typeRating",
    capacity, status, updated_at AS "updatedAt" FROM aircraft`)).rows;
  const flights = (await pool.query(`SELECT flight_id::text AS "flightId", flight_number AS "flightNumber", origin, destination,
    departure_time AS "departureTime", arrival_time AS "arrivalTime", flight_status AS status, delay_minutes AS "delayMinutes",
    gate, aircraft_id::text AS "aircraftId", duration_minutes AS "durationMinutes", updated_at AS "updatedAt"
    FROM flight WHERE departure_time BETWEEN now() - make_interval(days => $1) AND now() + make_interval(days => $2)
    ORDER BY departure_time`, [daysBack, daysAhead])).rows;
  const fares = (await pool.query(`SELECT ff.flight_id::text AS "flightId", ff.fare_class AS "fareClass", ff.base_fare AS "baseFare"
    FROM flight_fare ff JOIN flight f USING (flight_id)
    WHERE f.departure_time BETWEEN now() - make_interval(days => $1) AND now() + make_interval(days => $2)`, [daysBack, daysAhead])).rows;

  const json = (rows: Record<string, unknown>[]) => JSON.parse(JSON.stringify(rows)) as Record<string, unknown>[];
  await applyGraphEvents(driver, [...asEvents('AIRPORT_UPSERT', json(airports)), ...asEvents('AIRCRAFT_UPSERT', json(aircraft))]);
  for (let i = 0; i < flights.length; i += 500) {
    await applyGraphEvents(driver, asEvents('FLIGHT_UPSERT', json(flights.slice(i, i + 500)).map(flight => ({ flight }))));
  }
  for (let i = 0; i < fares.length; i += 2000) {
    await applyGraphEvents(driver, asEvents('FLIGHT_FARE_UPSERT', json(fares.slice(i, i + 2000))));
  }

  const crew = (await pool.query(`SELECT crew_id::text AS "crewId", crew_name AS name, designation, base_airport AS base FROM crew`)).rows;
  const pairs = (await pool.query(`SELECT a.crew_id::text AS a, b.crew_id::text AS b, count(*)::int AS flights
    FROM crew_assignment a JOIN crew_assignment b ON a.flight_id = b.flight_id AND a.crew_id < b.crew_id
    WHERE a.duty_start > now() - interval '90 days' GROUP BY 1, 2`)).rows;
  await replaceCrewNetwork(driver, crew, pairs);

  const { records } = await driver.executeQuery(`MATCH (n) WITH labels(n)[0] AS label, count(*) AS n
    RETURN collect([label, n]) AS nodes, COUNT { ()-[:CONNECTS_TO]->() } AS connections, COUNT { ()-[:ROUTE]->() } AS routes`);
  const r = records[0];
  return { nodes: Object.fromEntries(r.get('nodes') as [string, number][]), connections: Number(r.get('connections')), routes: Number(r.get('routes')) };
}
