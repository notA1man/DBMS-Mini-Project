// GET /api/search/itineraries?from&to&date&pax - connecting itineraries (graph search, confirmed
// against PostgreSQL). Public, like direct search. Contract agreed in docs/commercial.md.
import { z } from 'zod';
import { pool } from '@/lib/db/postgres';
import { neo4jDriver } from '@/lib/db/neo4j';
import { apiError, HttpError } from '@/server/access';
import { findItineraries } from '@/server/itineraries';
import { opsQueries } from '@/server/queries/ops';

const schema = z.object({ from: z.string().regex(/^[A-Z]{3}$/), to: z.string().regex(/^[A-Z]{3}$/), date: z.iso.date(),
  pax: z.coerce.number().int().min(1).max(6).default(1) }).refine(v => v.from !== v.to, 'Origin and destination must differ');

export async function GET(request: Request) {
  try {
    const q = schema.parse(Object.fromEntries(new URL(request.url).searchParams));
    const day = (await pool.query(opsQueries.dayWindow, [q.from, q.date])).rows[0];
    if (!day) throw new HttpError(404, 'Unknown origin airport.');
    const { source, itineraries } = await findItineraries(pool, neo4jDriver,
      { from: q.from, to: q.to, start: day.start.toISOString(), end: day.end.toISOString() }, { pax: q.pax });
    return Response.json({ itineraries, source }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return apiError(error); }
}
