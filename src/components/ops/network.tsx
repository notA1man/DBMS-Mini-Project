'use client';
import { useState } from 'react';
import { Bars, DataTable, Unavailable, request, useResource } from './ui';

type Opt<T> = { data: T | null; error: string | null };
type Row = Record<string, unknown>;

export function Network() {
  const { data: g, error } = useResource<{ hubs: Opt<{ method: string; hubs: Row[] }>; unreachable: Opt<{ pairs: number; sample: string[] }>; pairs: Opt<Row[]> }>('/api/ops/analytics?part=graph');
  const [route, setRoute] = useState<Opt<{ stops: string[]; km: number }> | null>(null);
  const [impact, setImpact] = useState<(Opt<{ flights: number; brokenConnections: number; strandedDestinations: string[] }> & { passengers: number }) | null>(null);
  return <>
    <p className="eyebrow">OPERATIONS · NETWORK (NEO4J)</p><h1>Route network</h1>
    <p>Airports, flights and connections as a graph: hub ranking, shortest routes, and what an airport closure would break.</p>
    <p role="alert">{error}</p><Unavailable store="Neo4j" error={g?.hubs.error} />
    <div className="split">
      <section className="card"><h2>Hub ranking</h2><small className="muted">{g?.hubs.data?.method}</small>
        <Bars rows={(g?.hubs.data?.hubs ?? []).map(h => ({ label: `${h.code} ${h.city}`, value: Number(h.score) }))} format={v => v.toFixed(v < 10 ? 3 : 0)} />
        {g?.unreachable.data && <p className="results">{g.unreachable.data.pairs} airport pairs have no route within three sectors{g.unreachable.data.sample.length ? `, e.g. ${g.unreachable.data.sample.slice(0, 5).join(', ')}` : ''}.</p>}
      </section>
      <section className="card stack"><h2>Shortest route by distance</h2>
        <form className="toolbar" onSubmit={async e => { e.preventDefault(); const f = new FormData(e.currentTarget);
          setRoute(await request(`/api/ops/shortest?from=${f.get('from')}&to=${f.get('to')}`)); }}>
          <label>From<input name="from" defaultValue="GAU" pattern="[A-Z]{3}" required /></label>
          <label>To<input name="to" defaultValue="DXB" pattern="[A-Z]{3}" required /></label><button>Find</button></form>
        {route && (route.data ? <p className="mono">{route.data.stops.join(' → ')} · {route.data.km.toLocaleString('en-IN')} km</p>
          : <p className="muted">{route.error ?? 'No route within three sectors.'}</p>)}
        <h2>Impact radius</h2>
        <form className="toolbar" onSubmit={async e => { e.preventDefault(); const f = new FormData(e.currentTarget);
          setImpact(await request(`/api/ops/impact?airport=${f.get('airport')}&hours=${f.get('hours')}`)); }}>
          <label>If this airport closes<input name="airport" defaultValue="BOM" pattern="[A-Z]{3}" required /></label>
          <label>for (hours)<input name="hours" type="number" min="1" max="72" defaultValue="24" /></label><button>Assess</button></form>
        {impact && (impact.data ? <p>{impact.data.flights} flights touch it, carrying {impact.passengers} booked passengers; {impact.data.brokenConnections} connections through it break
          {impact.data.strandedDestinations.length ? ` (onward to ${impact.data.strandedDestinations.join(', ')})` : ''}.</p> : <p className="muted">{impact.error}</p>)}
      </section>
    </div>
    <section className="card results"><h2>Crews who fly together most</h2><small className="muted">FLEW_WITH relationships built from rosters (last 90 days).</small>
      <DataTable rows={g?.pairs.data ?? []} empty="Run npm run graph:reconcile to build the crew network." columns={[['a', 'Crew member'], ['aRole', 'Rank'], ['b', 'Flies with'], ['bRole', 'Rank'], ['flights', 'Shared flights']]} />
    </section>
  </>;
}
