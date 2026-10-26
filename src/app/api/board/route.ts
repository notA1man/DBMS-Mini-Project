// GET /api/board?airport=BLR&hours=12 - public departures board snapshot (PostgreSQL).
import { z } from 'zod';
import { pool } from '@/lib/db/postgres';
import { apiError } from '@/server/access';
import { opsQueries } from '@/server/queries/ops';

export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  try {
    const q = new URL(request.url).searchParams;
    const airport = z.string().regex(/^[A-Z]{3}$/).parse(q.get('airport') ?? 'BLR');
    const hours = z.coerce.number().int().min(1).max(48).parse(q.get('hours') ?? '12');
    return Response.json({ airport, departures: (await pool.query(opsQueries.departures, [airport, hours])).rows,
      generatedAt: new Date().toISOString() }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return apiError(error); }
}
