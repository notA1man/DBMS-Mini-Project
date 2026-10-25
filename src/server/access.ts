import { auth } from '@/auth';
import { withTx } from '@/lib/db/postgres';
import type { PoolClient } from 'pg';

export type Identity={user_id:string;email:string;role:string;passenger_id:string|null;crew_id:string|null};
export class HttpError extends Error {
  constructor(public status:number,message:string) { super(message); }
}

export async function asIdentity<T>(roles:string[]|null,fn:(client:PoolClient,user:Identity)=>Promise<T>) {
  const session=await auth();
  if(!session?.user.id) throw new HttpError(401,'Please sign in.');
  // Re-read the account on every request: disabling or changing roles takes effect immediately.
  return withTx({userId:session.user.id},async client=>{
    const {rows}=await client.query<Identity>('SELECT * FROM fn_session_user()');
    const user=rows[0];
    if(!user) throw new HttpError(401,'Please sign in again.');
    if(roles && !roles.includes(user.role)) throw new HttpError(403,'You do not have access to this action.');
    return fn(client,user);
  });
}

export function checkOrigin(request:Request) {
  const origin=request.headers.get('origin');
  if(!origin || origin!==new URL(request.url).origin) throw new HttpError(403,'Invalid request origin.');
}

export function apiError(error:unknown) {
  if(error instanceof HttpError) return Response.json({error:error.message},{status:error.status});
  const e=error as {code?:string;name?:string;message?:string};
  if(e.name==='ZodError' || error instanceof SyntaxError) return Response.json({error:'Please check the submitted fields.'},{status:400});
  const errors:Record<string,[number,string]>={
    '23505':[409,'This seat, passenger or reference is already in use.'],
    '23503':[400,'A selected record is unavailable.'],
    '23514':[400,'The submitted values do not meet the booking rules.'],
    '23P01':[409,'The selected schedule conflicts with an existing assignment.'],
    '42501':[403,'This record is unavailable to your account.'],
    '40001':[409,'Availability changed. Please try again.'],
    '40P01':[409,'Availability changed. Please try again.'],
    'P0001':[400,e.message || 'The action could not be completed.'],
  };
  const mapped=e.code && errors[e.code];
  if(mapped) return Response.json({error:mapped[1]},{status:mapped[0]});
  // Log code/name only; errors can contain SQL parameters and personal data.
  console.error('Commercial request failed',{code:e.code,name:e.name});
  return Response.json({error:'This service is temporarily unavailable.'},{status:503});
}

export async function retryTransaction<T>(fn:()=>Promise<T>) {
  for(let attempt=0;;attempt++) {
    try { return await fn(); }
    catch(error) {
      if(attempt>=2 || !['40001','40P01'].includes((error as {code:string}).code)) throw error;
      await new Promise(resolve=>setTimeout(resolve,30*(attempt+1)+Math.random()*50));
    }
  }
}
