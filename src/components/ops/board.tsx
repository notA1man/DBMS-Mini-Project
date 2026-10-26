'use client';
// Live departures board: snapshot from PostgreSQL, then flight-by-flight updates over Server-Sent
// Events (MongoDB change stream on flight_status, fed by the outbox dispatcher).
import { useEffect, useState } from 'react';
import { localTime } from './ui';

type Departure = { flightId: string; flightNumber: string; destination: string; destinationCity?: string; departureTime: string;
  scheduledDeparture: string; status: string; delayMinutes: number; delayReason: string | null; gate: string | null };
const HUBS = ['BLR', 'DEL', 'BOM', 'MAA', 'HYD', 'CCU', 'COK'];

export function Board() {
  const [airport, setAirport] = useState('BLR');
  const [rows, setRows] = useState<Departure[]>([]);
  const [live, setLive] = useState(false), [changed, setChanged] = useState<string | null>(null), [error, setError] = useState('');
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
  return <>
    <p className="eyebrow">LIVE</p><h1>Departures</h1>
    <div className="toolbar"><label>Airport<select value={airport} onChange={e => setAirport(e.target.value)}>{HUBS.map(h => <option key={h}>{h}</option>)}</select></label>
      <span className={`live ${live ? 'on' : ''}`}>{live ? 'Live updates (change stream)' : 'Refreshing every 15 s'}</span></div>
    <p role="alert">{error}</p>
    <div className="board"><table><thead><tr><th>TIME</th><th>FLIGHT</th><th>TO</th><th>GATE</th><th>REMARKS</th></tr></thead>
      <tbody>{rows.map(r => <tr key={r.flightId} className={changed === r.flightId ? 'changed' : ''}>
        <td className="flip">{localTime(r.scheduledDeparture, airport)}{r.delayMinutes > 0 && r.status !== 'Cancelled' && <><br /><small style={{ color: '#ffb547' }}>{localTime(r.departureTime, airport)}</small></>}</td>
        <td className="flip">{r.flightNumber}</td><td>{r.destinationCity ?? r.destination} <small style={{ color: '#8ea0b4' }}>{r.destination}</small></td>
        <td className="flip">{r.gate ?? '—'}</td>
        <td className="flip" style={{ color: r.status === 'Cancelled' ? '#ff7b7b' : r.status === 'Delayed' ? '#ffb547' : r.status === 'Boarding' ? '#7fd1a0' : undefined }}>{remark(r)}</td></tr>)}
        {!rows.length && <tr><td colSpan={5}>No departures in the next 12 hours.</td></tr>}</tbody></table></div>
  </>;
}
