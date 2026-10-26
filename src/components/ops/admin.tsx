'use client';
import Link from 'next/link';
import { useState } from 'react';
import { ActionButton, Bars, DataTable, Unavailable, ist, money, ops, pct, useResource } from './ui';

type Row = Record<string, unknown>;
type Opt<T> = { data: T | null; error: string | null };

export function AdminHome() {
  const links: [string, string, string][] = [
    ['/admin/analytics', 'Analytics', 'Revenue, load, on-time performance, delay causes, maintenance and hubs: SQL, MongoDB and Neo4j side by side.'],
    ['/admin/fleet', 'Fleet & seat maps', 'Aircraft, their generated seat maps, and the seat-map generator.'],
    ['/admin/airports', 'Airports', 'IATA airports with validated time zones.'],
    ['/admin/users', 'Users & roles', 'Staff accounts and roles.'],
    ['/admin/audit', 'Audit log', 'Every privileged change, projected from the outbox into MongoDB.'],
    ['/admin/outbox', 'Outbox monitor', 'Delivery of PostgreSQL changes to MongoDB and Neo4j.'],
  ];
  return <><p className="eyebrow">ADMINISTRATION</p><h1>Admin</h1>
    <div className="feature-grid">{links.map(([href, title, text]) => <article key={href}><h2><Link href={href}>{title}</Link></h2><p>{text}</p></article>)}</div></>;
}

// ---------------------------------------------------------------- fleet
const PRESETS: Record<string, object> = {
  'A320neo (2-class, 182)': { cabins: [{ class: 'Business', fromRow: 1, toRow: 2, letters: 'AC DF' }, { class: 'Economy', fromRow: 3, toRow: 31, letters: 'ABC DEF' }], exitRows: [12, 13] },
  'ATR 72 (72)': { cabins: [{ class: 'Economy', fromRow: 1, toRow: 18, letters: 'AC DF' }], exitRows: [1] },
  '787-9 (3-class, 323)': { cabins: [{ class: 'First', fromRow: 1, toRow: 2, letters: 'A DG K' }, { class: 'Business', fromRow: 3, toRow: 8, letters: 'AC DG HK' },
    { class: 'Economy', fromRow: 10, toRow: 40, letters: 'ABC DEF HJK' }], exitRows: [10, 25] },
};

export function Fleet() {
  const { data, error, reload } = useResource<{ fleet: Row[] }>('/api/ops/fleet');
  const [selected, setSelected] = useState<string | null>(null);
  const [preset, setPreset] = useState(Object.keys(PRESETS)[0]);
  const [layoutText, setLayoutText] = useState(JSON.stringify(PRESETS[Object.keys(PRESETS)[0]], null, 1));
  const [message, setMessage] = useState('');
  return <>
    <p className="eyebrow">ADMINISTRATION</p><h1>Fleet & seat maps</h1><p role="alert">{error}</p>
    <section className="card"><DataTable rows={data?.fleet ?? []} columns={[
      ['registration', 'Registration', r => <button className="subtle" onClick={() => setSelected(String(r.aircraftId))}>{String(r.registration)}</button>],
      ['model', 'Model'], ['typeRating', 'Type'], ['capacity', 'Seats'],
      ['cabins', 'Cabins', r => Object.entries((r.cabins ?? {}) as Record<string, number>).map(([c, n]) => `${c} ${n}`).join(' · ')],
      ['ageYears', 'Age'], ['openFlights', 'Open flights'],
      ['status', 'Status', r => <select defaultValue={String(r.status)} onChange={async e => {
        try { await ops('aircraft-status', { aircraftId: r.aircraftId, status: e.target.value }); setMessage(`${r.registration} → ${e.target.value}`); reload(); }
        catch (err) { setMessage((err as Error).message); e.target.value = String(r.status); }
      }}>{['Active', 'Maintenance', 'Retired'].map(s => <option key={s}>{s}</option>)}</select>]]} />
      <p role="status">{message}</p></section>
    {selected && <SeatMap aircraftId={selected} />}
    <section className="card results"><h2>Add aircraft (seat-map generator)</h2>
      <p className="muted">The layout is expanded by <code>ops_generate_seat_map</code>: spaces are aisles, outer letters are windows. Capacity is set from the seat count and verified at COMMIT by a deferred constraint trigger.</p>
      <form className="stack" onSubmit={async e => {
        e.preventDefault(); setMessage('');
        const f = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
        try {
          const r = await ops<{ aircraftId: string }>('aircraft', { registration: f.registration, model: f.model, manufacturer: f.manufacturer,
            typeRating: f.typeRating, year: Number(f.year), layout: JSON.parse(layoutText) });
          setMessage(`Added aircraft ${r.aircraftId}.`); reload(); setSelected(r.aircraftId);
        } catch (err) { setMessage((err as Error).message); }
      }}><div className="grid2">
        <label>Registration<input name="registration" required pattern="[A-Z0-9]{1,2}-[A-Z0-9]{3,5}" placeholder="VT-SXZ" /></label>
        <label>Model<input name="model" required defaultValue="A320neo" /></label>
        <label>Manufacturer<input name="manufacturer" required defaultValue="Airbus" /></label>
        <label>Type rating<input name="typeRating" required pattern="[A-Z0-9]{3,6}" defaultValue="A20N" /></label>
        <label>Year<input name="year" type="number" min="1960" max="2100" defaultValue="2024" /></label>
        <label>Preset<select value={preset} onChange={e => { setPreset(e.target.value); setLayoutText(JSON.stringify(PRESETS[e.target.value], null, 1)); }}>
          {Object.keys(PRESETS).map(p => <option key={p}>{p}</option>)}</select></label>
      </div>
        <label>Layout (JSON)<textarea className="mono" rows={6} value={layoutText} onChange={e => setLayoutText(e.target.value)} /></label>
        <button>Add aircraft</button><p role="status">{message}</p></form>
    </section>
  </>;
}

function SeatMap({ aircraftId }: { aircraftId: string }) {
  const { data } = useResource<{ seats: { seat: string; class: string; position: string; exit: boolean }[] }>(`/api/ops/seat-map?aircraft=${aircraftId}`);
  const rows = new Map<number, typeof data extends null ? never : NonNullable<typeof data>['seats']>();
  for (const s of data?.seats ?? []) { const n = parseInt(s.seat, 10); rows.set(n, [...(rows.get(n) ?? []), s]); }
  return <section className="card results"><h2>Seat map</h2><small className="muted">Blue = Business, gold = First, orange underline = exit row.</small>
    <div className="seatmap results">{[...rows.entries()].map(([n, seats]) => <div className="row" key={n}><span>{n}</span>
      {seats.map((s, i) => <span key={s.seat} style={{ display: 'contents' }}>
        {i > 0 && s.position === 'Aisle' && seats[i - 1].position === 'Aisle' && <span className="aisle" />}
        <i className={`${s.class} ${s.exit ? 'exit' : ''}`} title={`${s.seat} · ${s.class} · ${s.position}`}>{s.seat.slice(-1)}</i></span>)}</div>)}</div>
  </section>;
}

// ---------------------------------------------------------------- airports
export function Airports() {
  const { data, error, reload } = useResource<{ airports: Row[] }>('/api/ops/airports');
  const [message, setMessage] = useState('');
  return <>
    <p className="eyebrow">ADMINISTRATION</p><h1>Airports</h1><p role="alert">{error}</p>
    <section className="card"><DataTable rows={data?.airports ?? []} columns={[['code', 'IATA'], ['name', 'Name'], ['city', 'City'], ['country', 'Country'],
      ['timezone', 'Time zone'], ['upcomingDepartures', 'Upcoming departures']]} /></section>
    <section className="card results"><h2>Add or update an airport</h2>
      <p className="muted">Time zones are checked against PostgreSQL&apos;s IANA catalogue by a trigger; the change syncs to Neo4j through the outbox.</p>
      <form className="stack" onSubmit={async e => {
        e.preventDefault(); const f = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
        try { await ops('airport', { ...f, lat: Number(f.lat), lon: Number(f.lon) }); setMessage('Saved.'); reload(); }
        catch (err) { setMessage((err as Error).message); }
      }}><div className="grid2">
        <label>IATA code<input name="code" required pattern="[A-Z]{3}" placeholder="IXB" /></label><label>Name<input name="name" required placeholder="Bagdogra" /></label>
        <label>City<input name="city" required placeholder="Siliguri" /></label><label>Country (ISO-2)<input name="country" required pattern="[A-Z]{2}" defaultValue="IN" /></label>
        <label>Time zone<input name="timezone" required defaultValue="Asia/Kolkata" /></label><span />
        <label>Latitude<input name="lat" type="number" step="0.0001" required placeholder="26.6812" /></label>
        <label>Longitude<input name="lon" type="number" step="0.0001" required placeholder="88.3286" /></label>
      </div><button>Save airport</button><p role="status">{message}</p></form>
    </section>
  </>;
}

// ---------------------------------------------------------------- analytics
type SqlAnalytics = { revenue: Row[]; load: Row[]; otp: Row[]; utilisation: Row[] };
type MongoAnalytics = { pareto: Opt<Row[]>; distribution: Opt<Row[]>; otp: Opt<Row[]>; maintenance: Opt<{ aogByAircraft: Row[] }[]> };
type GraphAnalytics = { hubs: Opt<{ method: string; hubs: Row[] }> };
export function Analytics() {
  const sql = useResource<SqlAnalytics>('/api/ops/analytics?part=sql');
  const mongo = useResource<MongoAnalytics>('/api/ops/analytics?part=mongo');
  const graph = useResource<GraphAnalytics>('/api/ops/analytics?part=graph');
  const data = { sql: sql.data, mongo: mongo.data, graph: graph.data };
  const error = sql.error || mongo.error || graph.error;
  const reload = sql.reload;
  const revenueByRoute = new Map<string, number>();
  for (const r of data.sql?.revenue ?? []) revenueByRoute.set(`${r.origin}-${r.destination}`, (revenueByRoute.get(`${r.origin}-${r.destination}`) ?? 0) + Number(r.revenue));
  const buckets = ['0–15', '15–30', '30–60', '60–120', '120–240', '240+'];
  return <>
    <p className="eyebrow">ADMINISTRATION · ANALYTICS</p><h1>Network analytics</h1><p role="alert">{error}</p>
    <div className="toolbar"><ActionButton action="refresh-analytics" label="Refresh revenue view" className="subtle" body={() => ({})} onDone={() => reload()} /></div>
    <div className="split">
      <section className="card"><p className="eyebrow">POSTGRESQL · MATERIALIZED VIEW</p><h2>Revenue by route (3 months)</h2>
        <Bars rows={[...revenueByRoute.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([label, value]) => ({ label, value }))} format={money} /></section>
      <section className="card"><p className="eyebrow">MONGODB · $setWindowFields</p><h2>Delay causes (Pareto, 30 days)</h2>
        <Unavailable store="MongoDB" error={data.mongo?.pareto.error} />
        <Bars rows={(data.mongo?.pareto.data ?? []).map(r => ({ label: String(r.reason), value: Number(r.minutes) }))} format={v => `${v} min`} />
        <small className="muted">{(data.mongo?.pareto.data ?? []).map(r => `${r.reason}: ${pct(r.cumulativeShare)} cumulative`).slice(0, 3).join(' · ')}</small></section>
      <section className="card"><p className="eyebrow">POSTGRESQL · VIEW v_flight_load</p><h2>Load factor by route</h2>
        <Bars rows={(data.sql?.load ?? []).map(r => ({ label: String(r.route), value: Number(r.loadFactor) }))} format={v => pct(v)} /></section>
      <section className="card"><p className="eyebrow">MONGODB · $bucket</p><h2>How long delays last</h2>
        <Bars rows={(data.mongo?.distribution.data ?? []).filter(r => r._id !== 'other').map((r, i) => ({ label: `${buckets[i] ?? r._id} min`, value: Number(r.flights) }))} /></section>
      <section className="card"><p className="eyebrow">POSTGRESQL</p><h2>Least punctual routes (30 days)</h2>
        <DataTable rows={data.sql?.otp ?? []} columns={[['route', 'Route'], ['flights', 'Flights'], ['onTimeRate', 'On time', r => pct(r.onTimeRate)], ['avgDelay', 'Avg delay (min)']]} /></section>
      <section className="card"><p className="eyebrow">NEO4J</p><h2>Hubs</h2><Unavailable store="Neo4j" error={data.graph?.hubs.error} />
        <small className="muted">{data.graph?.hubs.data?.method}</small>
        <Bars rows={(data.graph?.hubs.data?.hubs ?? []).map(h => ({ label: `${h.code}`, value: Number(h.score) }))} format={v => v.toFixed(v < 10 ? 3 : 0)} /></section>
      <section className="card"><p className="eyebrow">POSTGRESQL</p><h2>Fleet utilisation (block hours/day, 14 days)</h2>
        <Bars rows={(data.sql?.utilisation ?? []).slice(0, 14).map(r => ({ label: String(r.registration), value: Number(r.blockHoursPerDay ?? 0) }))} format={v => v.toFixed(1)} /></section>
      <section className="card"><p className="eyebrow">MONGODB · $dateTrunc</p><h2>On-time performance by route and month</h2>
        <DataTable rows={(data.mongo?.otp.data ?? []).slice(0, 12)} columns={[['route', 'Route'], ['month', 'Month', r => ist(String(r.month)).split(',')[0]], ['flights', 'Flights'], ['onTimeRate', 'On time', r => pct(r.onTimeRate)]]} /></section>
    </div>
  </>;
}

// ---------------------------------------------------------------- audit & outbox
export function Audit() {
  const [role, setRole] = useState('');
  const { data, error } = useResource<{ entries: Opt<Row[]>; byDay: Opt<Row[]> }>(`/api/ops/audit${role ? `?role=${role}` : ''}`);
  const days = new Map<string, number>();
  for (const r of data?.byDay.data ?? []) { const d = ist(String(r.day)).split(',')[0]; days.set(d, (days.get(d) ?? 0) + Number(r.actions)); }
  return <>
    <p className="eyebrow">ADMINISTRATION · AUDIT (MONGODB)</p><h1>Audit log</h1>
    <p>Privileged changes are written to the PostgreSQL outbox in the same transaction as the change, then projected into MongoDB (365-day TTL). Credentials never enter the payload.</p>
    <p role="alert">{error}</p><Unavailable store="MongoDB" error={data?.entries.error} />
    <section className="card"><h2>Actions per day</h2><Bars rows={[...days.entries()].map(([label, value]) => ({ label, value }))} /></section>
    <section className="card results"><div className="toolbar"><label>Role<select value={role} onChange={e => setRole(e.target.value)}><option value="">All</option>
      {['ADMIN', 'OPS', 'CREW', 'PASSENGER'].map(r => <option key={r}>{r}</option>)}</select></label></div>
      <DataTable rows={data?.entries.data ?? []} columns={[['ts', 'When', r => ist(String(r.ts))], ['role', 'Role'], ['userId', 'User'], ['action', 'Action'],
        ['entity', 'Entity', r => `${r.entity} ${r.entityId}`], ['detail', 'Detail', r => r.detail ? <code>{JSON.stringify(r.detail).slice(0, 120)}</code> : '']]} /></section>
  </>;
}

export function Outbox() {
  const { data, error, reload } = useResource<{ events: Row[]; overview: Row }>('/api/ops/outbox');
  const [result, setResult] = useState('');
  return <>
    <p className="eyebrow">ADMINISTRATION · TRANSACTIONAL OUTBOX</p><h1>Outbox monitor</h1>
    <p>Every change that must reach MongoDB or Neo4j is written to <code>outbox_event</code> inside the same PostgreSQL transaction. The dispatcher claims events with <code>FOR UPDATE SKIP LOCKED</code>, delivers them idempotently and retries failures with exponential backoff.</p>
    <p role="alert">{error}</p>
    <div className="kpis"><div className="kpi"><span>PENDING</span><strong>{String(data?.overview?.outboxPending ?? '—')}</strong></div>
      <div className={`kpi ${Number(data?.overview?.outboxFailing) ? 'alert' : ''}`}><span>RETRYING</span><strong>{String(data?.overview?.outboxFailing ?? '—')}</strong></div></div>
    <div className="toolbar"><ActionButton action="outbox-run" label="Deliver now" body={() => ({})} onDone={r => {
      const x = r as { claimed: number; delivered: number; failed: number; errors: Record<string, string> };
      setResult(`Claimed ${x.claimed}, delivered ${x.delivered}, failed ${x.failed}. ${Object.values(x.errors).join(' · ')}`); reload(); }} /></div>
    {result && <p role="status">{result}</p>}
    <section className="card"><DataTable rows={data?.events ?? []} columns={[['event_id', '#'], ['event_type', 'Type'], ['aggregate', 'Aggregate', r => `${r.aggregate} ${r.aggregate_id}`],
      ['created_at', 'Created', r => ist(String(r.created_at))],
      ['state', 'State', r => r.processed_at ? <span className="pill good">delivered</span> : Number(r.attempts) ? <span className="pill bad">retry {String(r.attempts)}</span> : <span className="pill warn">pending</span>],
      ['last_error', 'Last error'],
      ['retry', '', r => !r.processed_at && Number(r.attempts) ? <ActionButton action="outbox-retry" label="Retry now" className="subtle" body={() => ({ eventId: String(r.event_id) })} onDone={() => reload()} /> : null]]} /></section>
  </>;
}
