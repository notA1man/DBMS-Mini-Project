// GET /api/airports?q=bengalru - typo-tolerant airport autocomplete (FTS + pg_trgm). Public.
import { z } from 'zod';
import { pool } from '@/lib/db/postgres';
import { apiError } from '@/server/access';
import { opsQueries } from '@/server/queries/ops';

export async function GET(request: Request) {
  try {
    const q = z.string().trim().min(2).max(60).parse(new URL(request.url).searchParams.get('q'));
    return Response.json({ airports: (await pool.query(opsQueries.airportSearch, [q])).rows });
  } catch (error) { return apiError(error); }
}
