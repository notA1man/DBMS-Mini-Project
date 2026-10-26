'use client';
// Small shared pieces for the operations, crew and admin screens (Aditya).
import { useState, type ReactNode } from 'react';
import { request } from '@/components/api';
import { AIRPORT_BY_CODE } from '@/lib/airports';

export { useResource, request } from '@/components/api';
export const ops = <T,>(action: string, body: unknown) => request<T>(`/api/ops/${action}`, body);

/** Wall-clock time at an airport (flights are shown in the local time of where they are). */
export function localTime(value: string | Date, airport?: string, withDate = false) {
  const tz = (airport && AIRPORT_BY_CODE[airport]?.tz) || 'Asia/Kolkata';
  return new Date(value).toLocaleString('en-IN', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false,
    ...(withDate ? { day: '2-digit', month: 'short' } : {}) });
}
export const ist = (value: string | Date) => new Date(value).toLocaleString('en-IN',
  { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' });
export const istDate = (offsetDays = 0) =>
  new Date(Date.now() + offsetDays * 86400e3 + 5.5 * 3600e3).toISOString().slice(0, 10);
export const money = (v: unknown) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(Number(v));
export const pct = (v: unknown) => (v === null || v === undefined ? '—' : `${(Number(v) * 100).toFixed(1)}%`);

export function Status({ value }: { value: string }) { return <span className={`pill ${value}`}>{value}</span>; }

export function Kpi({ label, value, alert = false }: { label: string; value: ReactNode; alert?: boolean }) {
  return <div className={`kpi ${alert ? 'alert' : ''}`}><span>{label}</span><strong>{value}</strong></div>;
}

export function Bars({ rows, format = (v: number) => String(v) }: { rows: { label: string; value: number }[]; format?: (v: number) => string }) {
  const max = Math.max(...rows.map(r => r.value), 1);
  if (!rows.length) return <p className="muted">No data yet.</p>;
  return <div className="bars">{rows.map(r => <div className="bar" key={r.label}><span>{r.label}</span>
    <i><em style={{ width: `${(r.value / max) * 100}%` }} /></i><span>{format(r.value)}</span></div>)}</div>;
}

/** Notice for a section whose store (MongoDB / Neo4j) could not be reached. */
export function Unavailable({ error, store }: { error?: string | null; store: string }) {
  return error ? <p className="muted">{store} unavailable right now ({error}). Start it and run <code>npm run outbox:drain</code>.</p> : null;
}

/** Button that POSTs to an ops action and reports the outcome inline. */
export function ActionButton({ action, body, label, confirm, className, onDone }: { action: string; body: () => unknown;
  label: string; confirm?: string; className?: string; onDone?: (result: unknown) => void }) {
  const [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  return <span className="stack" style={{ gap: '.3rem' }}>
    <button type="button" className={className} disabled={busy} onClick={async () => {
      if (confirm && !window.confirm(confirm)) return;
      setBusy(true); setMessage('');
      try { const r = await ops(action, body()); onDone?.(r); setMessage('Done.'); }
      catch (e) { setMessage((e as Error).message); } finally { setBusy(false); }
    }}>{busy ? 'Working…' : label}</button>{message && <small role="status">{message}</small>}</span>;
}

export function DataTable({ rows, columns, empty = 'Nothing to show.' }: { rows: Record<string, unknown>[];
  columns: [string, string, ((row: Record<string, unknown>) => ReactNode)?][]; empty?: string }) {
  if (!rows.length) return <p className="muted">{empty}</p>;
  return <div className="overflow"><table><thead><tr>{columns.map(([key, label]) => <th key={key}>{label}</th>)}</tr></thead>
    <tbody>{rows.map((row, i) => <tr key={i}>{columns.map(([key, , render]) =>
      <td key={key}>{render ? render(row) : row[key] === null || row[key] === undefined ? '—' : String(row[key])}</td>)}</tr>)}</tbody></table></div>;
}
