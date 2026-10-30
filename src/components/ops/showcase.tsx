'use client';
import { useState } from 'react';
import { PageHead } from '@/components/page-head';
import { request } from './ui';

type Result = { sql: string; note: string; rows: Record<string, unknown>[]; plan: unknown };

export function OpsShowcase() {
  const [result, setResult] = useState<Result | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  return <section className="results">
    <PageHead eyebrow="DBMS QUERY SHOWCASE · ADITYA" title="Operations: constraints, recursion and graphs" lede="Named queries against the live database. The double-schedule demonstration rolls back inside a savepoint." />
    <form className="card stack" onSubmit={async e => {
      e.preventDefault(); setBusy(true); setError('');
      try { setResult(await request('/api/showcase/ops', Object.fromEntries(new FormData(e.currentTarget)))); }
      catch (err) { setError((err as Error).message); } finally { setBusy(false); }
    }}>
      <label>Query<select name="query">
        <option value="double-schedule">Try to double-schedule an aircraft (exclusion constraint, rolled back) · ops staff</option>
        <option value="crew-chain">Crew reporting chain (recursive CTE)</option>
        <option value="coverage">Under-crewed flights (GROUP BY … HAVING view) · ops staff</option>
        <option value="revenue">Monthly route revenue (materialized view) · ops staff</option>
        <option value="itinerary-sql">Connecting itineraries in SQL (recursive CTE) vs Cypher</option>
        <option value="airport-fuzzy">Typo-tolerant airport search (FTS + trigram)</option>
        <option value="load">Flight load factor (view) · ops staff</option>
      </select></label>
      <div className="grid2"><label>Search text (airport search)<input name="text" defaultValue="Bengalru" maxLength={60} /></label>
        <label>Flight ID (load factor)<input name="flight" defaultValue="1" pattern="[0-9]+" /></label></div>
      <button disabled={busy}>{busy ? 'Running…' : 'Run query'}</button><p role="alert">{error}</p>
    </form>
    {result && <div className="stack results">
      <article className="card overflow"><h2>What this shows</h2><pre>{result.note}</pre><h2>Parameterized SQL</h2><pre>{result.sql}</pre></article>
      <article className="card overflow"><h2>Live results</h2>
        {result.rows.length === 0 ? <p>No visible rows.</p> : <table><thead><tr>{Object.keys(result.rows[0]).map(k => <th key={k}>{k}</th>)}</tr></thead>
          <tbody>{result.rows.map((r, i) => <tr key={i}>{Object.values(r).map((v, j) => <td key={j}>{v === null ? 'NULL' : typeof v === 'object' ? JSON.stringify(v) : String(v)}</td>)}</tr>)}</tbody></table>}</article>
      {result.plan !== null && <article className="card overflow"><h2>EXPLAIN ANALYZE</h2><pre>{JSON.stringify(result.plan, null, 2)}</pre></article>}
    </div>}
  </section>;
}
