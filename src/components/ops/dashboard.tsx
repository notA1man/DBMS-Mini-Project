'use client';
import Link from 'next/link';
import { PageHead } from '@/components/page-head';
import { DataTable, Kpi, Status, localTime, pct, useResource } from './ui';

type Overview = { next24h: Record<string, number> | null; onTimeRate7d: number | null; unresolvedDisruptions: number;
  crewGaps: number; outboxPending: number; outboxFailing: number };
type Row = Record<string, unknown>;

export function OpsDashboard() {
  const { data, error } = useResource<{ overview: Overview; coverage: Row[]; departures: Row[] }>('/api/ops/overview');
  const o = data?.overview;
  const active = o?.next24h ? Object.entries(o.next24h).filter(([s]) => s !== 'Cancelled').reduce((n, [, v]) => n + v, 0) : 0;
  return <>
    <PageHead eyebrow="OPERATIONS CONTROL" title="Ops console" lede="The next twelve hours, crew gaps, and anything that still has to reach MongoDB or Neo4j."
      readouts={o ? [['NEXT 24 H', active], ['ON TIME', pct(o.onTimeRate7d)], ['TO RE-BOOK', o.unresolvedDisruptions, o.unresolvedDisruptions ? 'warn' : undefined]] : undefined} />
    <p role="alert">{error}</p>
    {o && <div className="kpis">
      <Kpi label="FLIGHTS NEXT 24 H" value={active} />
      <Kpi label="ON-TIME (7 DAYS)" value={pct(o.onTimeRate7d)} />
      <Kpi label="DELAYED NOW" value={o.next24h?.Delayed ?? 0} alert={(o.next24h?.Delayed ?? 0) > 0} />
      <Kpi label="CREW GAPS (48 H)" value={o.crewGaps} alert={o.crewGaps > 0} />
      <Kpi label="PASSENGERS TO RE-BOOK" value={o.unresolvedDisruptions} alert={o.unresolvedDisruptions > 0} />
      <Kpi label="SYNC BACKLOG" value={o.outboxPending} alert={o.outboxFailing > 0} />
    </div>}
    <div className="split">
      <section className="card"><h2>Next 12 hours</h2>
        <DataTable rows={data?.departures ?? []} empty="No departures in the next 12 hours." columns={[
          ['flightNumber', 'Flight', r => <Link href={`/ops/flights/${r.flightId}`}>{String(r.flightNumber)}</Link>],
          ['route', 'Route', r => `${r.origin} → ${r.destination}`],
          ['departureTime', 'Dep (local)', r => <span className="mono">{localTime(String(r.departureTime), String(r.origin))}</span>],
          ['status', 'Status', r => <Status value={String(r.status)} />],
          ['delayMinutes', 'Delay', r => Number(r.delayMinutes) ? `+${r.delayMinutes}m` : ''],
          ['crew', 'Crew', r => r.crewComplete ? <span className="pill good">complete</span> : <span className="pill bad">{String(r.crew)} assigned</span>],
          ['seatsLeft', 'Seats left'],
        ]} /></section>
      <section className="card"><h2>Crew coverage gaps</h2><p className="muted">Flights in the next 48 h that cannot board yet.</p>
        <DataTable rows={data?.coverage ?? []} empty="Every flight in the next 48 hours is fully crewed." columns={[
          ['flightNumber', 'Flight', r => <Link href={`/ops/flights/${r.flightId}`}>{String(r.flightNumber)}</Link>],
          ['route', 'Route', r => `${r.origin}→${r.destination}`],
          ['departureTime', 'Departs', r => localTime(String(r.departureTime), String(r.origin), true)],
          ['missing', 'Missing', r => [Number(r.captains) < 1 && 'Captain', Number(r.firstOfficers) < 1 && 'F/O',
            Number(r.cabinCrew) < Number(r.cabinRequired) && `${Number(r.cabinRequired) - Number(r.cabinCrew)} cabin`].filter(Boolean).join(', ')],
        ]} />
        <p><Link href="/ops/crew">Crew & certificates →</Link> · <Link href="/ops/disruptions">Disruptions →</Link> · <Link href="/ops/network">Network →</Link> · <Link href="/ops/maintenance">Maintenance →</Link></p>
      </section>
    </div>
  </>;
}
