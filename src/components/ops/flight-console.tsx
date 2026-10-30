'use client';
import { useState } from 'react';
import { PageHead } from '@/components/page-head';
import { ActionButton, DataTable, Status, Unavailable, ist, localTime, ops, pct, request, useResource } from './ui';

type Row = Record<string, unknown>;
type Flight = Row & { flight_id: string; flight_number: string; origin: string; destination: string; departure_time: string;
  arrival_time: string; scheduled_departure: string; flight_status: string; delay_minutes: number; delay_reason: string | null;
  gate: string | null; registration: string; model: string; capacity: number; crew_complete: boolean; cancel_reason: string | null };
type Candidate = { crewId: string; name: string; designation: string; base: string; location: string; legal: boolean;
  failures: { rule: string; detail: string }[] | null };
const ROLES = ['Captain', 'First Officer', 'Purser', 'Cabin Crew'];
const REASONS = ['Weather', 'ATC', 'Technical', 'Crew', 'Late inbound aircraft', 'Ground handling', 'Security', 'Other'];
const NEXT: Record<string, string[]> = { Scheduled: ['Boarding'], Delayed: ['Boarding'], Boarding: ['Departed'], Departed: ['Landed'] };

export function FlightConsole({ id }: { id: string }) {
  const { data, error, reload } = useResource<{ flight: Flight; crew: Row[]; load: Row[]; manifest: Row[]; events: Row[]; eventsError: string | null }>(`/api/ops/flight?id=${id}`);
  const [role, setRole] = useState('Captain');
  const [result, setResult] = useState('');
  const f = data?.flight;
  if (!f) return <><PageHead eyebrow="FLIGHT" title="Flight" /><p role="alert">{error || 'Loading…'}</p></>;
  const open = ['Scheduled', 'Delayed', 'Boarding'].includes(f.flight_status);
  const summarize = (r: unknown) => {
    const x = r as { knockOn?: { flightNumber: string; addedMinutes: number }[]; releasedCrew?: unknown[]; disruptedTickets?: number; disruptedBookings?: number };
    const parts: string[] = [];
    if (x.knockOn?.length) parts.push(`Knock-on: ${x.knockOn.map(k => `${k.flightNumber} +${k.addedMinutes}m`).join(', ')}`);
    if (x.releasedCrew?.length) parts.push(`${x.releasedCrew.length} crew released from later flights (see coverage)`);
    if (x.disruptedTickets !== undefined) parts.push(`${x.disruptedTickets} tickets / ${x.disruptedBookings} bookings disrupted`);
    setResult(parts.join(' · ') || 'Saved.'); reload();
  };
  return <>
    <PageHead eyebrow={`FLIGHT ${f.flight_id} · ${f.registration} ${f.model}`}
      title={<>{f.flight_number} {f.origin} → {f.destination} <Status value={f.flight_status} /></>}
      lede={<>Departs {localTime(f.departure_time, f.origin, true)} local ({ist(f.departure_time)} IST) · arrives {localTime(f.arrival_time, f.destination, true)} local
        {f.delay_minutes > 0 && <> · <b>+{f.delay_minutes} min</b> ({f.delay_reason}), scheduled {localTime(f.scheduled_departure, f.origin)}</>}
        {f.gate && <> · Gate {f.gate}</>}</>}
      readouts={[['CREW', f.crew_complete ? 'Complete' : 'Gap', f.crew_complete ? 'good' : 'bad'], ['PAX', data.manifest.length], ['DELAY', f.delay_minutes ? `+${f.delay_minutes}m` : 'On time', f.delay_minutes ? 'warn' : undefined]]} />
    {f.cancel_reason && <p role="alert">Cancelled: {f.cancel_reason}</p>}
    {result && <p role="status" className="card">{result}</p>}

    {open && <section className="card stack"><h2>Status & delay</h2>
      <form className="toolbar" onSubmit={async e => {
        e.preventDefault(); const v = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
        try { summarize(await ops('status', { flightId: f.flight_id, delayMinutes: Number(v.delay), delayReason: v.reason || null, gate: v.gate || null })); }
        catch (err) { setResult((err as Error).message); }
      }}>
        <label>Total delay (min)<input name="delay" type="number" min="0" max="1440" defaultValue={f.delay_minutes} /></label>
        <label>Reason<select name="reason" defaultValue={f.delay_reason ?? ''}><option value="">—</option>{REASONS.map(r => <option key={r}>{r}</option>)}</select></label>
        <label>Gate<input name="gate" defaultValue={f.gate ?? ''} pattern="[A-Z]?[0-9]{1,3}[A-Z]?" /></label>
        <button>Update</button>
      </form>
      <div className="toolbar">
        {(NEXT[f.flight_status] ?? []).map(s => <ActionButton key={s} action="status" label={`Mark ${s}`} body={() => ({ flightId: f.flight_id, status: s })} onDone={summarize} />)}
        <form className="toolbar" onSubmit={async e => {
          e.preventDefault(); const reason = String(new FormData(e.currentTarget).get('reason'));
          if (!window.confirm(`Cancel ${f.flight_number}? Every passenger becomes disrupted and the crew is released.`)) return;
          try { summarize(await ops('cancel', { flightId: f.flight_id, reason })); } catch (err) { setResult((err as Error).message); }
        }}><label>Cancellation reason<input name="reason" required minLength={3} placeholder="Technical fault on inbound aircraft" /></label>
          <button className="danger">Cancel flight</button></form>
      </div></section>}

    <div className="split results">
      <section className="card"><h2>Crew {f.crew_complete ? <span className="pill good">complete</span> : <span className="pill bad">incomplete</span>}</h2>
        <p className="muted">Needs a captain, a first officer and {Math.ceil(f.capacity / 50)} cabin crew ({f.capacity} seats).</p>
        <DataTable rows={data.crew} empty="No crew assigned." columns={[
          ['role', 'Role'], ['name', 'Name'], ['designation', 'Rank'],
          ['dutyStart', 'Duty', r => <span className="mono">{localTime(String(r.dutyStart), f.origin)}–{localTime(String(r.dutyEnd), f.destination)}</span>],
          ['x', '', r => open && f.flight_status !== 'Boarding' ? <ActionButton action="unassign" label="Remove" className="subtle"
            body={() => ({ crewId: r.crewId, flightId: f.flight_id })} onDone={() => reload()} /> : null],
        ]} />
        {/* keyed by role: switching role must never leave the previous role's candidates clickable */}
        {open && <CrewPicker key={role} flightId={f.flight_id} role={role} setRole={setRole} onAssigned={reload} />}
      </section>
      <section className="card"><h2>Load</h2>
        <DataTable rows={data.load} columns={[['fareClass', 'Class'], ['sold', 'Sold'], ['allocated', 'Seats'], ['loadFactor', 'Load', r => pct(r.loadFactor)]]} />
        <h2 className="results">Event timeline</h2><Unavailable store="MongoDB" error={data.eventsError} />
        <ul className="timeline">{data.events.map((e, i) => {
          const m = e.meta as Row, p = e.payload as Row;
          const text = m.type === 'DELAY' ? `Delayed +${p.addedMinutes} min (${p.reason})` : m.type === 'GATE_CHANGE' ? `Gate ${p.from ?? '—'} → ${p.to}`
            : m.type === 'CREW_REPORT' ? `Crew report: ${p.kind}${p.note ? ` — ${p.note}` : ''}` : m.type === 'SCHEDULED' ? 'Scheduled'
            : m.type === 'RETIME' ? `Delay reduced to ${p.toMinutes} min` : `${p.from} → ${p.to}${p.reason ? ` (${p.reason})` : ''}`;
          return <li key={i}><span className="mono">{ist(String(e.ts))}</span> · {text}</li>;
        })}</ul>
      </section>
    </div>
    <section className="card results"><h2>Passenger manifest ({data.manifest.length})</h2>
      <DataTable rows={data.manifest} empty="No passengers." columns={[['bookingId', 'PNR'], ['name', 'Passenger', r => `${r.firstName} ${r.lastName}`],
        ['fareClass', 'Class'], ['seat', 'Seat'], ['checkin', 'Check-in', r => r.checkin === 'CheckedIn' ? 'Checked in' : 'Not checked in'], ['status', 'Ticket', r => <Status value={String(r.status)} />], ['bags', 'Bags']]} />
    </section>
  </>;
}

function CrewPicker({ flightId, role, setRole, onAssigned }: { flightId: string; role: string; setRole: (r: string) => void; onAssigned: () => void }) {
  const { data, error, reload } = useResource<{ candidates: Candidate[] }>(`/api/ops/candidates?flight=${flightId}&role=${encodeURIComponent(role)}`);
  const [message, setMessage] = useState('');
  return <div className="stack results">
    <label>Assign crew<select value={role} onChange={e => setRole(e.target.value)}>{ROLES.map(r => <option key={r}>{r}</option>)}</select></label>
    <small className="muted">Candidates at {data?.candidates[0]?.location ?? 'the origin'} with the right rank and type rating; each is checked against every legality rule.</small>
    <p role="alert">{error}</p>{message && <p role="status">{message}</p>}
    {!data && !error && <p className="muted">Checking every {role.toLowerCase()} against the legality rules…</p>}
    {data?.candidates.length === 0 && <p className="muted">Nobody of this rank is positioned at the origin.</p>}
    {data?.candidates.map(c => <article key={c.crewId} className="crew-card">
      <div><strong>{c.name}</strong> <small>{c.designation} · base {c.base}</small>
        {c.legal ? <ul className="rules"><li>All rules pass</li></ul>
          : <ul className="rules">{c.failures?.map(x => <li key={x.rule} className="fail"><b>{x.rule}</b>{x.detail}</li>)}</ul>}</div>
        <button disabled={!c.legal} onClick={async () => {
          try { await request(`/api/ops/assign`, { crewId: c.crewId, flightId, role }); setMessage(`${c.name} assigned as ${role}.`); onAssigned(); reload(); }
          catch (e) { setMessage((e as Error).message); }
        }}>Assign</button>
    </article>)}
  </div>;
}
