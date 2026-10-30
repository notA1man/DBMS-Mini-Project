'use client';
import Link from 'next/link';
import { PageHead } from '@/components/page-head';
import { DataTable, ist, localTime, useResource } from './ui';

type Row = Record<string, unknown>;

export function CrewOps() {
  const { data, error } = useResource<{ coverage: Row[]; expiring: Row[]; strength: Row[] }>('/api/ops/crew');
  const bases = [...new Set((data?.strength ?? []).map(r => String(r.base)))];
  const count = (base: string, d: string) => data?.strength.find(r => r.base === base && r.designation === d)?.n ?? 0;
  return <>
    <PageHead eyebrow="OPERATIONS · CREW" title="Crew coverage & certificates" lede="Flights that cannot board yet, certificates about to expire, and how many of each rank sit at each base."
      readouts={data ? [['GAPS', data.coverage.length, data.coverage.length ? 'warn' : undefined], ['EXPIRING', data.expiring.length, data.expiring.length ? 'warn' : undefined]] : undefined} />
    <p role="alert">{error}</p>
    <section className="card"><h2>Flights missing crew (next 72 h)</h2>
      <p className="muted">From the <code>v_crew_coverage</code> view (GROUP BY … HAVING). Open a flight to see legal candidates.</p>
      <DataTable rows={data?.coverage ?? []} empty="All flights in the next 72 hours are fully crewed." columns={[
        ['flightNumber', 'Flight', r => <Link href={`/ops/flights/${r.flightId}`}>{String(r.flightNumber)}</Link>],
        ['route', 'Route', r => `${r.origin} → ${r.destination}`], ['departureTime', 'Departs', r => localTime(String(r.departureTime), String(r.origin), true)],
        ['captains', 'CPT'], ['firstOfficers', 'F/O'], ['cabin', 'Cabin', r => `${r.cabinCrew}/${r.cabinRequired}`]]} />
    </section>
    <div className="split results">
      <section className="card"><h2>Certificates expiring within 30 days</h2>
        <p className="muted">Expired type ratings, medicals or safety training make an assignment illegal.</p>
        <DataTable rows={data?.expiring ?? []} empty="No certificates expiring soon." columns={[['name', 'Crew'], ['designation', 'Rank'], ['base', 'Base'],
          ['certification', 'Certificate'], ['validUntil', 'Valid until', r => {
            const d = new Date(String(r.validUntil)); return <span className={`pill ${d < new Date() ? 'bad' : 'warn'}`}>{ist(d).split(',')[0]}</span>; }]]} />
      </section>
      <section className="card"><h2>Crew strength by base</h2>
        <DataTable rows={bases.map(b => ({ base: b }))} columns={[['base', 'Base'],
          ...['Captain', 'First Officer', 'Purser', 'Cabin Crew'].map(d => [d, d, (r: Row) => String(count(String(r.base), d))] as [string, string, (r: Row) => string])]} />
      </section>
    </div>
  </>;
}
