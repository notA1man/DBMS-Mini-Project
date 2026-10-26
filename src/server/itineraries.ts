// Connecting-itinerary search (Aditya's side of the shared search contract).
// Response shape agreed with the commercial UI (docs/commercial.md):
//   {itineraries:[{legs:[{flightId,flightNumber,origin,destination,departureTime,arrivalTime}],totalFare}]}
// Neo4j finds candidate paths; PostgreSQL (the source of truth) then confirms each leg is still
// bookable with enough seats and prices it with the live dynamic fare.
import type { Pool, PoolClient } from 'pg';
import type { Driver } from 'neo4j-driver';
import { graphItineraries, type Candidate, type Window } from '@/lib/graph/search';
import { opsQueries } from '@/server/queries/ops';

export type Leg = { flightId: string; flightNumber: string; origin: string; destination: string;
  departureTime: string; arrivalTime: string; remaining: number; price: number };
export type Itinerary = { legs: Leg[]; totalFare: number; totalMinutes: number; connections: number };

// Circuit breaker: after a graph failure, use the SQL path for a minute instead of paying the
// connection timeout on every search.
let graphDownUntil = 0;

export async function findItineraries(db: Pool | PoolClient, driver: Driver | null,
  window: Window, opts: { pax?: number; fareClass?: string; limit?: number } = {}) {
  const pax = opts.pax ?? 1, fareClass = opts.fareClass ?? 'Economy';
  let candidates: Candidate[] = [];
  let source: 'neo4j' | 'postgres' = 'neo4j';
  try {
    if (!driver || Date.now() < graphDownUntil) throw new Error('graph unavailable');
    candidates = await graphItineraries(driver, window);
  } catch (error) {
    if ((error as Error).message !== 'graph unavailable') graphDownUntil = Date.now() + 60_000;
    // Graph unreachable: identical semantics through a recursive CTE.
    source = 'postgres';
    candidates = (await db.query(opsQueries.itinerariesFallback,
      [window.from, window.to, window.start, window.end, window.arriveBy ?? null])).rows;
  }
  const ids = [...new Set(candidates.flatMap(c => c.flightIds))];
  const legs = new Map<string, Leg>();
  if (ids.length) {
    for (const r of (await db.query(opsQueries.legDetails, [ids, fareClass])).rows) {
      legs.set(r.flightId, { ...r, departureTime: new Date(r.departureTime).toISOString(),
        arrivalTime: new Date(r.arrivalTime).toISOString(), remaining: Number(r.remaining), price: Number(r.price) });
    }
  }
  const itineraries: Itinerary[] = [];
  for (const c of candidates) {
    const path = c.flightIds.map(id => legs.get(String(id)));
    if (path.some(l => !l || l.remaining < pax)) continue;   // sold out or no longer bookable
    const ok = path as Leg[];
    itineraries.push({ legs: ok, totalMinutes: c.totalMinutes, connections: ok.length - 1,
      totalFare: Math.round(ok.reduce((s, l) => s + l.price, 0) * 100) / 100 });
    if (itineraries.length >= (opts.limit ?? 12)) break;
  }
  return { source, itineraries };
}
