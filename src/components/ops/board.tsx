'use client';
// Live departures board: snapshot from PostgreSQL, then flight-by-flight updates over Server-Sent
// Events (MongoDB change stream on flight_status, fed by the outbox dispatcher).
import { useEffect, useState } from 'react';
import { localTime } from './ui';

type Departure = { flightId: string; flightNumber: string; destination: string; destinationCity?: string; departureTime: string;
  scheduledDeparture: string; status: string; delayMinutes: number; delayReason: string | null; gate: string | null };
const HUBS = ['BLR', 'DEL', 'BOM', 'MAA', 'HYD', 'CCU', 'COK'];

function Flap({ text }: { text: string }) {
  return <span className="cell">{[...text].map((ch, i) => <span key={i}>{ch === ' ' ? '\u00a0' : ch}</span>)}</span>;
}

export function Board() {
  const [airport, setAirport] = useState('BLR');
  const [rows, setRows] = useState<Departure[]>([]);
  const [live, setLive] = useState(false), [changed, setChanged] = useState<string | null>(null), [error, setError] = useState('');
  const [clock, setClock] = useState('--:--');
  useEffect(() => {
    const tick = () => setClock(new Date().toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour12: false }).slice(0, 5));
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    const source = new EventSource(`/api/board/stream?airport=${airport}`);
    source.addEventListener('snapshot', e => { setRows(JSON.parse((e as MessageEvent).data)); setError(''); });
    source.addEventListener('mode', e => setLive(JSON.parse((e as MessageEvent).data).live));
    source.addEventListener('error', e => { if ((e as MessageEvent).data) setError(JSON.parse((e as MessageEvent).data).message); });
    source.addEventListener('flight', e => {
      const f = JSON.parse((e as MessageEvent).data) as Departure;
      setRows(current => {
        const i = current.findIndex(r => r.flightId === f.flightId);
        if (i < 0) return current;
        const next = [...current]; next[i] = { ...next[i], ...f }; return next;
      });
      setChanged(f.flightId);
    });
    return () => source.close();
  }, [airport]);
  const remark = (r: Departure) => r.status === 'Delayed' ? `DELAYED ${r.delayMinutes} MIN` : r.status === 'Boarding' ? 'BOARDING'
    : r.status === 'Departed' ? 'DEPARTED' : r.status === 'Cancelled' ? 'CANCELLED' : r.status === 'Landed' ? 'LANDED' : 'ON TIME';
  const onTime = rows.filter(r => r.status === 'Scheduled' || r.status === 'Boarding').length;
  return <>
    <header className="fids-head">
      <div><p className="eyebrow">LIVE DEPARTURES</p><h1>{airport}</h1></div>
      <div className="fids-airports" role="group" aria-label="Airport">{HUBS.map(h =>
        <button key={h} type="button" aria-pressed={h === airport} onClick={() => setAirport(h)}>{h}</button>)}</div>
      <div className="fids-clock"><strong>{clock}</strong><span className={`live ${live ? 'on' : ''}`}>{live ? 'Live · change stream' : 'Refresh · 15 s'}</span></div>
    </header>
    <p role="alert">{error}</p>
    <div className="fids"><table><thead><tr><th>Time</th><th>Flight</th><th>Destination</th><th>Gate</th><th>Status</th></tr></thead>
      <tbody>{rows.map(r => {
        const delayed = r.delayMinutes > 0 && r.status !== 'Cancelled';
        return <tr key={r.flightId} className={changed === r.flightId ? 'changed' : ''}>
          <td><Flap text={localTime(r.scheduledDeparture, airport)} />{delayed && <span className="new-time">{localTime(r.departureTime, airport)}</span>}</td>
          <td><Flap text={r.flightNumber} /></td>
          <td className="city">{r.destinationCity ?? r.destination}<small>{r.destination}</small></td>
          <td><Flap text={r.gate ?? '—'} /></td>
          <td className={`remark ${r.status}`}>{remark(r)}</td>
        </tr>;
      })}{!rows.length && <tr><td colSpan={5}>No departures in the next 12 hours.</td></tr>}</tbody></table></div>
    <p className="muted results">{rows.length} departures in the next 12 hours · {onTime} on time or boarding · times are local to {airport}</p>
  </>;
}
