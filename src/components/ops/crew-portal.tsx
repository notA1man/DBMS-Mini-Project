'use client';
import Link from 'next/link';
import { useState } from 'react';
import { PageHead } from '@/components/page-head';
import { DataTable, Status, ist, localTime, ops, useResource } from './ui';

type Row = Record<string, unknown>;

export function CrewPortal() {
  const { data, error } = useResource<{ profile: Row & { certifications: { certification: string; validUntil: string }[] }; roster: Row[]; chain: Row[] }>('/api/ops/crew-me');
  const p = data?.profile;
  return <>
    <PageHead eyebrow="CREW PORTAL" title={p ? String(p.name) : 'My roster'}
      lede={p ? <>{String(p.designation)} · base {String(p.base)} · licence <span className="mono">{String(p.license)}</span></> : 'Duties, certificates and the reporting line above you.'}
      readouts={data ? [['DUTIES', data.roster.length], ['CERTIFICATES', p?.certifications?.length ?? 0]] : undefined} />
    <p role="alert">{error}</p>
    <div className="split">
      <section className="card"><h2>My duties</h2>
        <DataTable rows={data?.roster ?? []} empty="No upcoming duties." columns={[
          ['flightNumber', 'Flight', r => <Link href={`/crew/flights/${r.flightId}`}>{String(r.flightNumber)}</Link>],
          ['route', 'Route', r => `${r.origin} → ${r.destination}`], ['role', 'Role'],
          ['dutyStart', 'Report (local)', r => <span className="mono">{localTime(String(r.dutyStart), String(r.origin), true)}</span>],
          ['dutyEnd', 'Release', r => <span className="mono">{localTime(String(r.dutyEnd), String(r.destination))}</span>],
          ['status', 'Status', r => <Status value={String(r.status)} />]]} />
      </section>
      <section className="card"><h2>Certificates</h2>
        <ul className="rules">{p?.certifications?.map(c => <li key={c.certification} className={new Date(c.validUntil) < new Date() ? 'fail' : ''}>
          <b>{c.certification}</b>valid until {ist(c.validUntil).split(',')[0]}</li>)}</ul>
        <h2 className="results">Reporting line</h2><small className="muted">Recursive query over the supervisor hierarchy.</small>
        <ul className="timeline">{data?.chain.map(c => <li key={String(c.crewId)} style={{ marginLeft: `${Math.max(0, Number(c.depth) + 2) * 0.8}rem` }}>
          {Number(c.depth) === 0 ? <b>{String(c.name)} (you)</b> : String(c.name)} <small>{String(c.designation)}</small></li>)}</ul>
      </section>
    </div>
  </>;
}

export function CrewFlight({ id }: { id: string }) {
  const { data, error } = useResource<{ flight: Row; crew: Row[]; manifest: Row[] }>(`/api/ops/crew-flight?id=${id}`);
  const [message, setMessage] = useState('');
  const f = data?.flight;
  return <>
    <PageHead eyebrow="CREW PORTAL · FLIGHT" title={f ? <>{String(f.flightNumber)} {String(f.origin)} → {String(f.destination)} <Status value={String(f.status)} /></> : 'Flight'}
      lede={f ? <>Departs {localTime(String(f.departureTime), String(f.origin), true)} local{f.gate ? ` · Gate ${f.gate}` : ''}{Number(f.delayMinutes) ? ` · +${f.delayMinutes} min` : ''}</> : undefined}
      readouts={data ? [['PASSENGERS', data.manifest.length], ['CREW', data.crew.length]] : undefined} />
    <p role="alert">{error}</p>
    <div className="split">
      <section className="card"><h2>Passenger manifest ({data?.manifest.length ?? 0})</h2>
        <small className="muted">Visible only because you are rostered on this flight (row-level security).</small>
        <DataTable rows={data?.manifest ?? []} empty="No passengers yet." columns={[['seat', 'Seat'], ['name', 'Passenger', r => `${r.firstName} ${r.lastName}`],
          ['fareClass', 'Class'], ['checkin', 'Check-in', r => r.checkin === 'CheckedIn' ? 'Checked in' : 'Not checked in'], ['bags', 'Bags']]} /></section>
      <section className="card"><h2>Crew</h2>
        <DataTable rows={data?.crew ?? []} columns={[['role', 'Role'], ['name', 'Name']]} />
        <h2 className="results">Report an event</h2>
        <form className="stack" onSubmit={async e => {
          e.preventDefault(); const v = Object.fromEntries(new FormData(e.currentTarget));
          try { await ops('crew-report', { flightId: id, kind: v.kind, note: v.note }); setMessage('Reported to operations.'); (e.target as HTMLFormElement).reset(); }
          catch (err) { setMessage((err as Error).message); }
        }}><label>Event<select name="kind">{['Boarding complete', 'Doors closed', 'Medical incident', 'Technical snag', 'Disruptive passenger', 'Catering issue'].map(k => <option key={k}>{k}</option>)}</select></label>
          <label>Note<textarea name="note" maxLength={500} /></label><button>Send report</button><p role="status">{message}</p></form>
      </section>
    </div>
  </>;
}
