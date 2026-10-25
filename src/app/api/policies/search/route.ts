import { z } from 'zod';
import { embed } from '@/lib/ai/embed';
import { pool } from '@/lib/db/postgres';
import { apiError,HttpError } from '@/server/access';
import { requestBudget } from '@/server/rate-limit';
const schema=z.object({query:z.string().trim().min(2).max(500),category:z.enum(['baggage','refund','check-in','assistance','pets','travel-docs']).optional()});
export async function POST(request:Request) {
  try {
    const q=schema.parse(await request.json());
    if(!await requestBudget(request,'policies',20,60)) throw new HttpError(429,'Too many searches. Please try again shortly.');
    let vector:number[]|null=null;
    if(process.env.EMBEDDINGS_ENABLED!=='false') {
      try { vector=await embed(q.query); } catch { /* Explicit keyword fallback below. */ }
    }
    const {rows}=await pool.query('SELECT * FROM fn_hybrid_kb($1::vector,$2,$3)',[vector?JSON.stringify(vector):null,q.query,q.category || null]);
    return Response.json({mode:vector?'hybrid':'keyword',passages:rows});
  } catch(error) { return apiError(error); }
}
