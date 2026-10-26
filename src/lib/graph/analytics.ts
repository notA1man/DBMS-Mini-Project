// Network analytics on the route graph. With the Graph Data Science plugin (local Docker) hubs
// are ranked by weighted PageRank and betweenness; AuraDB Free has no GDS, so the fallback is
// weighted degree centrality in plain Cypher (NEO4J_GDS_ENABLED=false).
import type { Driver } from 'neo4j-driver';
import { randomUUID } from 'node:crypto';

export type HubRank = { code: string; city: string; score: number; betweenness: number | null; routes: number };

export async function hubRanking(driver: Driver, useGds = process.env.NEO4J_GDS_ENABLED !== 'false'): Promise<{ method: string; hubs: HubRank[] }> {
  if (useGds) {
    const name = `routes_${randomUUID().replaceAll('-', '')}`;
    try {
      await driver.executeQuery(`CALL gds.graph.project($name, 'Airport', {ROUTE: {properties: 'flightsPerWeek'}})`, { name });
      const { records } = await driver.executeQuery(`
        CALL gds.pageRank.stream($name, {relationshipWeightProperty: 'flightsPerWeek'}) YIELD nodeId, score
        WITH gds.util.asNode(nodeId) AS a, score
        CALL { WITH a RETURN COUNT { (a)-[:ROUTE]-() } AS routes }
        RETURN a.code AS code, a.city AS city, score, routes ORDER BY score DESC LIMIT 12`, { name });
      const between = await driver.executeQuery(`CALL gds.betweenness.stream($name) YIELD nodeId, score
        RETURN gds.util.asNode(nodeId).code AS code, score`, { name });
      const b = new Map(between.records.map(r => [r.get('code') as string, Number(r.get('score'))]));
      return { method: 'GDS PageRank (weighted by flights/week) + betweenness', hubs: records.map(r => ({
        code: r.get('code'), city: r.get('city'), score: Number(r.get('score')), betweenness: b.get(r.get('code')) ?? 0,
        routes: Number(r.get('routes')) })) };
    } catch (error) {
      if (!/gds|procedure|function/i.test((error as Error).message)) throw error;   // GDS missing: fall back
    } finally {
      await driver.executeQuery('CALL gds.graph.drop($name, false)', { name }).catch(() => {});
    }
  }
  const { records } = await driver.executeQuery(`
    MATCH (a:Airport)
    OPTIONAL MATCH (a)-[r:ROUTE]-()
    WITH a, sum(coalesce(r.flightsPerWeek, 0)) AS weighted, count(r) AS routes
    WHERE routes > 0
    RETURN a.code AS code, a.city AS city, weighted AS score, routes ORDER BY score DESC LIMIT 12`);
  return { method: 'Weighted degree centrality (Cypher fallback, no GDS)', hubs: records.map(r => ({
    code: r.get('code'), city: r.get('city'), score: Number(r.get('score')), betweenness: null, routes: Number(r.get('routes')) })) };
}

/** Shortest route by great-circle distance (up to 3 sectors). */
export async function shortestRoute(driver: Driver, from: string, to: string) {
  const { records } = await driver.executeQuery(`
    MATCH p = (a:Airport {code: $from})-[:ROUTE*1..3]->(b:Airport {code: $to})
    WHERE all(r IN relationships(p) WHERE r.flightsPerWeek > 0)
      AND size(nodes(p)) = size(apoc.coll.toSet([n IN nodes(p) | n.code]))
    RETURN [n IN nodes(p) | n.code] AS stops, reduce(km = 0, r IN relationships(p) | km + r.distanceKm) AS km
    ORDER BY km LIMIT 1`, { from, to }).catch(async () =>
    // Without APOC: same query with a pure-Cypher distinct-stops check.
    driver.executeQuery(`
      MATCH p = (a:Airport {code: $from})-[:ROUTE*1..3]->(b:Airport {code: $to})
      WITH p, [n IN nodes(p) | n.code] AS stops
      WHERE all(r IN relationships(p) WHERE r.flightsPerWeek > 0)
        AND all(i IN range(0, size(stops) - 2) WHERE NOT stops[i] IN stops[i + 1..])
      RETURN stops, reduce(km = 0, r IN relationships(p) | km + r.distanceKm) AS km
      ORDER BY km LIMIT 1`, { from, to }));
  const r = records[0];
  return r ? { stops: r.get('stops') as string[], km: Number(r.get('km')) } : null;
}

/** Airport pairs with no path of up to 3 sectors in the current network. */
export async function unreachablePairs(driver: Driver) {
  const { records } = await driver.executeQuery(`
    MATCH (a:Airport), (b:Airport)
    WHERE a <> b AND EXISTS { (a)-[:ROUTE]-() } AND EXISTS { (b)-[:ROUTE]-() }
      AND NOT EXISTS { (a)-[:ROUTE*1..3]->(b) }
    RETURN count(*) AS pairs, collect(a.code + '→' + b.code)[0..12] AS sample`);
  return { pairs: Number(records[0].get('pairs')), sample: records[0].get('sample') as string[] };
}

/** "If this airport closes for N hours": flights touching it and connections broken through it. */
export async function impactRadius(driver: Driver, code: string, hours = 24) {
  const { records } = await driver.executeQuery(`
    MATCH (f:Flight)
    WHERE (f.origin = $code OR f.destination = $code) AND f.status IN ['Scheduled', 'Delayed', 'Boarding']
      AND f.dep < datetime() + duration({hours: $hours}) AND f.arr > datetime()
    WITH collect(f) AS touched
    OPTIONAL MATCH (inbound:Flight)-[c:CONNECTS_TO]->(onward:Flight)
    WHERE inbound IN touched AND inbound.destination = $code
    RETURN [x IN touched | x.flightId] AS flightIds, size(touched) AS flights, count(c) AS brokenConnections,
           collect(DISTINCT onward.destination)[0..15] AS strandedDestinations`, { code, hours });
  const r = records[0];
  return { flightIds: r.get('flightIds') as string[], flights: Number(r.get('flights')),
    brokenConnections: Number(r.get('brokenConnections')), strandedDestinations: r.get('strandedDestinations') as string[] };
}

/** Crew pairs who fly together most often (FLEW_WITH network). */
export async function crewPairs(driver: Driver) {
  const { records } = await driver.executeQuery(`
    MATCH (a:Crew)-[w:FLEW_WITH]-(b:Crew) WHERE a.crewId < b.crewId
    RETURN a.name AS a, a.designation AS aRole, b.name AS b, b.designation AS bRole, w.flights AS flights
    ORDER BY flights DESC LIMIT 10`);
  return records.map(r => r.toObject());
}
