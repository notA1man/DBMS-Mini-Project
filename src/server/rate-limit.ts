import { createHash } from 'node:crypto';
import { pool } from '@/lib/db/postgres';
export async function requestBudget(request:Request,scope:string,limit:number,seconds:number) {
  // Enable only behind a proxy that overwrites forwarded client IP headers.
  // Local/untrusted deployments share a budget rather than trusting spoofable headers.
  const address=process.env.AUTH_TRUST_PROXY==='true'?(request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown'):'shared';
  const key=createHash('sha256').update(`${scope}:${address}`).digest('hex');
  const {rows}=await pool.query('SELECT fn_request_budget($1,$2,$3) AS allowed',[key,limit,seconds]);
  return rows[0].allowed as boolean;
}
