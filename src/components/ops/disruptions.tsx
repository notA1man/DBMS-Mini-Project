'use client';
import Link from 'next/link';
import { useState } from 'react';
import { DataTable, ist, localTime, money, ops, request, useResource } from './ui';

type Ticket = { booking_id: string; ticket_seq: number; first_name: string; last_name: string; fare_class: string;
  flight_id: string; flight_number: string; origin: string; destination: string; departure_time: string;
  cancel_reason: string; must_arrive_by: string | null };
type Leg = { flightId: string; flightNumber: string; origin: string; destination: string; departureTime: string; arrivalTime: string; remaining: number };
type Itinerary = { legs: Leg[]; totalMinutes: number; connections: number; totalFare: number };
type Row = Record<string, unknown>;

export function Disruptions() {
  const { data, error, reload } = useResource<{ tickets: Ticket[]; cancelled: Row[] }>('/api/ops/disruptions');
  return <>
    <p className="eyebrow">OPERATIONS · DISRUPTION WORKBENCH</p><h1>Re-book disrupted passengers</h1>
    <p>When a flight is cancelled its tickets become <b>Disrupted</b>. Alternatives come from the Neo4j connection graph (falling back to a recursive SQL query) and are re-checked against live PostgreSQL availability. Re-booking keeps the passenger&apos;s PNR and costs them nothing.</p>
    <p role="alert">{error}</p>
    <section className="card"><h2>Recently cancelled flights</h2>
      <DataTable rows={data?.cancelled ?? []} empty="No cancellations in the last two days." columns={[
        ['flightNumber', 'Flight', r => <Link href={`/ops/flights/${r.flightId}`}>{String(r.flightNumber)}</Link>],
        ['route', 'Route', r => `${r.origin} → ${r.destination}`], ['departureTime', 'Was due', r => ist(String(r.departureTime))], ['reason', 'Reason']]} />
    </section>
    <h2 className="results">{data?.tickets.length ?? 0} passengers waiting</h2>
    {data?.tickets.length === 0 && <p className="muted">Nobody is waiting for a new itinerary. Cancel a booked flight from its flight page to see this workflow.</p>}
    <div className="stack">{data?.tickets.map(t => <TicketCard key={`${t.booking_id}-${t.ticket_seq}`} t={t} onDone={reload} />)}</div>
  </>;
}

function TicketCard({ t, onDone }: { t: Ticket; onDone: () => void }) {
  const [options, setOptions] = useState<{ itineraries: Itinerary[]; source: string } | null>(null);
  const [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  return <article className="card">
    <div className="flight-row"><div>
      <p className="eyebrow">PNR {t.booking_id} · TICKET {t.ticket_seq} · {t.fare_class.toUpperCase()}</p>
      <h2>{t.first_name} {t.last_name}: {t.origin} → {t.destination}</h2>
      <p>{t.flight_number} was due {ist(t.departure_time)} — {t.cancel_reason}
        {t.must_arrive_by && <><br /><b>Must arrive by {ist(t.must_arrive_by)}</b> for an onward flight in the same booking.</>}</p>
    </div>
      <button disabled={busy} onClick={async () => {
        setBusy(true); setMessage('');
        try { setOptions(await request(`/api/ops/reroute?pnr=${t.booking_id}&seq=${t.ticket_seq}`)); }
        catch (e) { setMessage((e as Error).message); } finally { setBusy(false); }
      }}>{busy ? 'Searching…' : 'Find alternatives'}</button></div>
    <p role="status">{message}</p>
    {options && <div className="stack">
      <small className="muted">Source: {options.source === 'neo4j' ? 'Neo4j CONNECTS_TO traversal' : 'PostgreSQL recursive CTE (graph unavailable)'} · availability confirmed in PostgreSQL</small>
      {options.itineraries.length === 0 && <p>No {t.fare_class} seats on any itinerary in the next 36 hours. Offer a full refund (the passenger can cancel from My Trips).</p>}
      {options.itineraries.map((it, i) => <div key={i} className="flight-row" style={{ borderTop: '1px solid var(--line)', paddingTop: '.8rem' }}>
        <div>{it.legs.map(l => <p key={l.flightId} className="mono">{l.flightNumber} {l.origin} {localTime(l.departureTime, l.origin, true)} → {l.destination} {localTime(l.arrivalTime, l.destination)} · {l.remaining} seats</p>)}
          <small>{Math.floor(it.totalMinutes / 60)}h {it.totalMinutes % 60}m · {it.connections ? `${it.connections} connection${it.connections > 1 ? 's' : ''}` : 'direct'} · fare value {money(it.totalFare)} (passenger pays nothing)</small></div>
        <button onClick={async () => {
          try {
            const r = await ops<{ bookingStatus: string }>('rebook', { pnr: t.booking_id, seq: t.ticket_seq, flightIds: it.legs.map(l => l.flightId) });
            setMessage(`Re-booked. Booking is now ${r.bookingStatus}; the passenger is notified.`); setOptions(null); onDone();
          } catch (e) { setMessage((e as Error).message); }
        }}>Re-book</button></div>)}
    </div>}
  </article>;
}
