import { z } from 'zod';
import { pool } from '@/lib/db/postgres';
import { apiError, checkOrigin, HttpError } from '@/server/access';
import { requestBudget } from '@/server/rate-limit';
const schema=z.object({email:z.email().max(254),password:z.string().min(12).refine(v=>Buffer.byteLength(v)<=72),
  firstName:z.string().trim().min(1).max(80),lastName:z.string().trim().min(1).max(80),dateOfBirth:z.iso.date()});
export async function POST(request:Request) {
  try {
    checkOrigin(request);
    const d=schema.parse(await request.json());
    if(!await requestBudget(request,'register',5,600)) throw new HttpError(429,'Too many registrations. Please try again later.');
    await pool.query('SELECT fn_register($1,$2,$3,$4,$5)',[d.email,d.password,d.firstName,d.lastName,d.dateOfBirth]);
    return Response.json({ok:true},{status:201});
  } catch(error) { return apiError(error); }
}
