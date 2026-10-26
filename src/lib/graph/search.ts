// Itinerary search over the flight-connection graph: a variable-length CONNECTS_TO traversal
// with per-hop time windows already baked into the edges (45-360 min layovers). The same
// question in SQL needs a recursive CTE that joins flight to itself once per hop
// (see opsQueries.itinerariesFallback) - used automatically when Neo4j is unreachable.
import type { Driver } from 'neo4j-driver';

export type Candidate = { flightIds: string[]; totalMinutes: number };
export type Window = { from: string; to: string; start: string; end: string; arriveBy?: string | null; limit?: number };

const ITINERARIES = `
MATCH (o:Airport {code: $from})-[:HAS_DEPARTURE]->(first:Flight)
WHERE first.dep >= datetime($start) AND first.dep < datetime($end)
  AND first.status IN ['Scheduled', 'Delayed'] AND first.dep > datetime() + duration('PT1H')
MATCH p = (first)-[:CONNECTS_TO*0..2]->(last:Flight)
WHERE last.destination = $to
WITH nodes(p) AS legs
WHERE all(x IN legs WHERE x.status IN ['Scheduled', 'Delayed'])
  AND ($arriveBy IS NULL OR legs[-1].arr <= datetime($arriveBy))
WITH legs, [x IN legs | x.origin] + [legs[-1].destination] AS stops
WHERE all(i IN range(0, size(stops) - 2) WHERE NOT stops[i] IN stops[i + 1..])
RETURN [x IN legs | x.flightId] AS flightIds,
       duration.inSeconds(legs[0].dep, legs[-1].arr).minutes AS totalMinutes
ORDER BY size(legs), totalMinutes
LIMIT $limit`;

export async function graphItineraries(driver: Driver, w: Window): Promise<Candidate[]> {
  const { records } = await driver.executeQuery(ITINERARIES, {
    from: w.from, to: w.to, start: w.start, end: w.end, arriveBy: w.arriveBy ?? null, limit: w.limit ?? 40,
  });
  return records.map(r => ({ flightIds: r.get('flightIds') as string[], totalMinutes: Number(r.get('totalMinutes')) }));
}

export const ITINERARY_CYPHER = ITINERARIES.trim();
