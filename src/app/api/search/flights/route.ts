import { z } from 'zod';
import { pool } from '@/lib/db/postgres';
import { commercialQueries } from '@/server/queries/commercial';
import { apiError } from '@/server/access';
const schema=z.object({from:z.string().regex(/^[A-Z]{3}$/),to:z.string().regex(/^[A-Z]{3}$/),date:z.iso.date(),pax:z.coerce.number().int().min(1).max(6).default(1)});
export async function GET(request:Request) {
  try {
    const q=schema.parse(Object.fromEntries(new URL(request.url).searchParams));
    const {rows}=await pool.query(commercialQueries.directFlights,[q.from,q.to,q.date]);
    return Response.json({flights:rows.filter(f=>Number(f.remaining)>=q.pax)});
  } catch(error) { return apiError(error); }
}
