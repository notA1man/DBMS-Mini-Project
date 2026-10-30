'use client';
import Link from 'next/link';
import { useState } from 'react';
import { PageHead } from '@/components/page-head';
import { DataTable, Status, istDate, localTime, ops, useResource } from './ui';

type Row = Record<string, unknown>;

export function Schedule() {
  const [filters, setFilters] = useState({ from: istDate(0), days: '1', airport: '', status: '' });
  const query = new URLSearchParams(Object.entries(filters).filter(([, v]) => v) as [string, string][]);
  const { data, error, reload } = useResource<{ flights: Row[]; fleet: { aircraftId: string; registration: string; typeRating: string }[] }>(`/api/ops/schedule?${query}`);
  const [message, setMessage] = useState(''), [busy, setBusy] = useState(false);
  return <>
    <PageHead eyebrow="OPERATIONS" title="Flight schedule" lede="Times are local to the airport. An aircraft that is already flying, or inside its 45-minute turnaround, is refused by the database."
      readouts={data ? [['FLIGHTS', data.flights.length], ['AIRCRAFT', data.fleet.length]] : undefined} />
    <form className="toolbar" onSubmit={e => { e.preventDefault(); const f = Object.fromEntries(new FormData(e.currentTarget)) as typeof filters; setFilters(f); }}>
      <label>From (IST date)<input type="date" name="from" defaultValue={filters.from} /></label>
      <label>Days<select name="days" defaultValue={filters.days}>{[1, 2, 3, 7, 14].map(n => <option key={n}>{n}</option>)}</select></label>
      <label>Airport<input name="airport" placeholder="BLR" maxLength={3} pattern="[A-Z]{3}" defaultValue={filters.airport} /></label>
      <label>Status<select name="status" defaultValue={filters.status}><option value="">Any</option>
        {['Scheduled', 'Delayed', 'Boarding', 'Departed', 'Landed', 'Cancelled'].map(s => <option key={s}>{s}</option>)}</select></label>
      <button>Show</button>
    </form>
    <p role="alert">{error}</p>
    <section className="card"><h2>{data?.flights.length ?? 0} flights</h2>
      <DataTable rows={data?.flights ?? []} empty="No flights match." columns={[
        ['flightNumber', 'Flight', r => <Link href={`/ops/flights/${r.flightId}`}>{String(r.flightNumber)}</Link>],
        ['route', 'Route', r => `${r.origin} → ${r.destination}`],
        ['dep', 'Dep', r => <span className="mono">{localTime(String(r.departureTime), String(r.origin), true)}</span>],
        ['arr', 'Arr', r => <span className="mono">{localTime(String(r.arrivalTime), String(r.destination), true)}</span>],
        ['registration', 'Aircraft', r => `${r.registration} (${r.typeRating})`],
        ['status', 'Status', r => <Status value={String(r.status)} />],
        ['delayMinutes', 'Delay', r => Number(r.delayMinutes) ? `+${r.delayMinutes}m` : ''],
        ['crew', 'Crew', r => r.crewComplete ? '✓' : `${r.crew}`],
        ['seatsLeft', 'Seats left'],
      ]} />
    </section>
    <section className="card results"><h2>Schedule a flight</h2>
      <p className="muted">The database refuses an aircraft that is already flying (or within its 45-minute turnaround) with an exclusion-constraint error.</p>
      <form className="stack" onSubmit={async e => {
        e.preventDefault(); setBusy(true); setMessage('');
        const f = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
        const toIso = (local: string) => new Date(`${local}:00+05:30`).toISOString();
        const fares: Record<string, number> = {};
        for (const c of ['Economy', 'Business', 'First']) if (f[c]) fares[c] = Number(f[c]);
        try {
          const r = await ops<{ flightId: string }>('schedule', { flightNumber: f.flightNumber, aircraftId: f.aircraftId,
            origin: f.origin, destination: f.destination, departure: toIso(f.departure), arrival: toIso(f.arrival), gate: f.gate || null, fares });
          setMessage(`Scheduled flight ${r.flightId}.`); reload();
        } catch (err) { setMessage((err as Error).message); } finally { setBusy(false); }
      }}>
        <div className="grid2">
          <label>Flight number<input name="flightNumber" required pattern="SK[0-9]{2,4}" placeholder="SK801" /></label>
          <label>Aircraft<select name="aircraftId" required>{data?.fleet.map(a => <option key={a.aircraftId} value={a.aircraftId}>{a.registration} · {a.typeRating}</option>)}</select></label>
          <label>Origin<input name="origin" required pattern="[A-Z]{3}" maxLength={3} placeholder="BLR" /></label>
          <label>Destination<input name="destination" required pattern="[A-Z]{3}" maxLength={3} placeholder="GOI" /></label>
          <label>Departure (IST)<input type="datetime-local" name="departure" required /></label>
          <label>Arrival (IST)<input type="datetime-local" name="arrival" required /></label>
          <label>Gate (optional)<input name="gate" pattern="[A-Z]?[0-9]{1,3}[A-Z]?" /></label>
          <label>Economy base fare (INR)<input name="Economy" type="number" min="1" placeholder="4500" /></label>
          <label>Business base fare<input name="Business" type="number" min="1" placeholder="14000" /></label>
          <label>First base fare (787 only)<input name="First" type="number" min="1" /></label>
        </div>
        <button disabled={busy}>{busy ? 'Scheduling…' : 'Schedule flight'}</button><p role="status">{message}</p>
      </form>
    </section>
  </>;
}
