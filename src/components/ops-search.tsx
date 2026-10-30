'use client';
import { useState } from 'react';
import { request } from './api';
import { PageHead } from './page-head';

export function OpsSearch({ complaints = false }: { complaints?: boolean }) {
  const [rows, setRows] = useState<Record<string, unknown>[]>([]), [error, setError] = useState(''), [busy, setBusy] = useState(false), [searched, setSearched] = useState(false);
  return <>
    <PageHead eyebrow="OPERATIONS" title={complaints ? 'Similar complaints' : 'Passenger lookup'}
      lede={complaints ? 'Find reviews that read like this issue. Similarity is computed over stored feedback embeddings, with a keyword fallback.' : 'Look up a passenger by name, email or booking reference.'}
      readouts={searched ? [['HITS', rows.length]] : undefined} />
    <section className="card"><form className="stack" onSubmit={async event => {
      event.preventDefault(); setBusy(true); setError(''); const f = new FormData(event.currentTarget);
      try {
        if (complaints) { const d = await request<{ complaints: Record<string, unknown>[] }>('/api/commercial/complaints', { query: f.get('query'), flightId: f.get('flightId') || null, route: f.get('route') || null, since: f.get('since') || '2000-01-01' }); setRows(d.complaints); }
        else { const d = await request<{ passengers: Record<string, unknown>[] }>(`/api/commercial/lookup?q=${encodeURIComponent(String(f.get('query')))}`); setRows(d.passengers); }
        setSearched(true);
      } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
    }}><label>{complaints ? 'Describe the issue' : 'Passenger name, email or PNR'}<input name="query" required minLength={complaints ? 3 : 2} maxLength={complaints ? 1000 : 100} /></label>
      {complaints && <div className="grid2"><label>Flight ID (optional)<input name="flightId" pattern="[0-9]+" /></label><label>Route (optional)<input name="route" placeholder="BLR-BOM" pattern="[A-Z]{3}-[A-Z]{3}" /></label><label>Since<input name="since" type="date" /></label></div>}
      <button disabled={busy}>{busy ? 'Searching…' : 'Search'}</button><p role="alert">{error}</p></form></section>
    {searched && <section className="card results">
      {rows.length === 0 && <p className="empty">{complaints ? 'No similar complaints.' : 'No passengers match.'}</p>}
      {rows.map((r, i) => <article className="hit" key={i}>{complaints ? <>
        <p className="eyebrow">FLIGHT {String(r.flight_id)} · SIMILARITY {Number(r.similarity).toFixed(3)}<span className="score"><i style={{ width: `${Math.round(Number(r.similarity) * 100)}%` }} /></span></p>
        <p>{String((r.feedback as { comment?: string })?.comment || 'Feedback source no longer available.')}</p>
      </> : <>
        <h2>{String(r.first_name)} {String(r.last_name)}</h2>
        <p>{String(r.email)} · Passenger {String(r.passenger_id)}</p>
      </>}</article>)}
    </section>}
  </>;
}
