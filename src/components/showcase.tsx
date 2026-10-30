'use client';
import { useState } from 'react';
import { request } from './api';
import { PageHead } from './page-head';
export function Showcase() {
  const [result,setResult]=useState<{sql:string;rows:Record<string,unknown>[];plan:unknown}|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  return <><PageHead eyebrow="DBMS QUERY SHOWCASE · AIMAN" title="See the database at work." lede="Sign in to run named queries with your account’s row-level permissions. The double-booking demonstration rolls back every temporary reservation."/>
    <form className="card stack" onSubmit={async event=>{
      event.preventDefault();setBusy(true);setError('');const fields=Object.fromEntries(new FormData(event.currentTarget));
      try{setResult(await request('/api/showcase',fields));}catch(e){setError((e as Error).message);}finally{setBusy(false);}
    }}><label>Query<select name="query"><option value="seats">Seat availability and dynamic fares</option><option value="bookings">Booking summary with RLS</option><option value="lookup">Passenger full-text search (staff)</option><option value="double-book">Try to double-book a seat (rolled back)</option></select></label>
      <div className="grid2"><label>Flight ID<input name="flight" defaultValue="1" pattern="[0-9]+" required/></label><label>Seat (double-booking demo)<input name="seat" defaultValue="1A" required maxLength={8}/></label></div>
      <label>Search text<input name="text" maxLength={100}/></label><button disabled={busy}>{busy?'Running…':'Run query'}</button><p role="alert">{error}</p>
    </form>{result && <section className="stack results"><article className="card overflow"><h2>Parameterized SQL</h2><pre>{result.sql}</pre></article><article className="card overflow"><h2>Live results</h2>
      {result.rows.length===0?<p>No visible rows.</p>:<table><thead><tr>{Object.keys(result.rows[0]).map(k=><th key={k}>{k}</th>)}</tr></thead><tbody>{result.rows.map((r,i)=><tr key={i}>{Object.values(r).map((v,j)=><td key={j}>{v===null?'NULL':String(v)}</td>)}</tr>)}</tbody></table>}</article>
      {result.plan!==null && <article className="card overflow"><h2>EXPLAIN ANALYZE</h2><pre>{JSON.stringify(result.plan,null,2)}</pre></article>}</section>}
  </>;
}
