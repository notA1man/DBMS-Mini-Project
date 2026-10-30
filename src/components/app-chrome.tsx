'use client';
// Shared chrome for the application pages: the section tabs for the ops/admin areas and the
// instrument strip along the bottom (clock and live store health), echoing the landing HUD.
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';

const SECTIONS: Record<string, { label: string; tabs: [string, string][] }> = {
  ops: { label: 'OPERATIONS', tabs: [['/ops', 'Console'], ['/ops/schedule', 'Schedule'], ['/ops/disruptions', 'Disruptions'],
    ['/ops/crew', 'Crew'], ['/ops/network', 'Network'], ['/ops/maintenance', 'Maintenance'], ['/ops/passengers', 'Passengers'],
    ['/ops/complaints', 'Complaints']] },
  admin: { label: 'ADMINISTRATION', tabs: [['/admin', 'Overview'], ['/admin/analytics', 'Analytics'], ['/admin/fleet', 'Fleet'],
    ['/admin/airports', 'Airports'], ['/admin/users', 'Users'], ['/admin/audit', 'Audit'], ['/admin/outbox', 'Outbox']] },
};

/** Numbered tabs for the staff areas; the flight console counts as part of the ops console. */
export function SectionNav({ role }: { role: string }) {
  const pathname = usePathname();
  const key = pathname.startsWith('/admin') ? 'admin' : pathname.startsWith('/ops') ? 'ops' : null;
  if (!key || !['ADMIN', 'OPS'].includes(role) || (key === 'admin' && role !== 'ADMIN')) return null;
  const { label, tabs } = SECTIONS[key];
  const active = (href: string) => href === `/${key}` ? pathname === href || pathname.startsWith('/ops/flights') : pathname.startsWith(href);
  return <nav className="section-nav" aria-label={`${label.toLowerCase()} sections`}>
    <span className="section-label">{label}</span>
    <div>{tabs.map(([href, text], i) => <Link key={href} href={href} aria-current={active(href) ? 'page' : undefined}>
      <small>{String(i + 1).padStart(2, '0')}</small>{text}</Link>)}</div>
  </nav>;
}

type Store = { ok: boolean; ms: number };
const clock = (zone: string) => new Date().toLocaleTimeString('en-GB', { timeZone: zone, hour12: false });

/** Bottom instrument strip: UTC/IST clocks, the signed-in role, and each database's health. */
export function StatusBar({ role }: { role: string }) {
  const [now, setNow] = useState<{ utc: string; ist: string } | null>(null);
  const [stores, setStores] = useState<Record<string, Store> | null>(null);
  useEffect(() => {
    const tick = () => setNow({ utc: clock('UTC'), ist: clock('Asia/Kolkata').slice(0, 5) });
    tick();
    const timer = setInterval(tick, 1000);
    let live = true;
    const check = () => fetch('/api/health', { cache: 'no-store' }).then(r => r.json())
      .then(d => { if (live) setStores({ PG: d.postgres, MONGO: d.mongo, NEO4J: d.neo4j }); })
      .catch(() => { if (live) setStores(null); });
    void check();
    const health = setInterval(check, 30000);
    return () => { live = false; clearInterval(timer); clearInterval(health); };
  }, []);
  return <div className="status-bar" aria-hidden="true">
    <span className="status-clock"><b>UTC</b>{now?.utc ?? '--:--:--'}<b>IST</b>{now?.ist ?? '--:--'}</span>
    <span className="status-role"><b>SESSION</b>{role || 'GUEST'}</span>
    <span className="status-stores">{(['PG', 'MONGO', 'NEO4J'] as const).map(name => {
      const s = stores?.[name];
      return <span key={name} className={s ? (s.ok ? 'up' : 'down') : ''}><i />{name}<em>{s?.ok ? `${s.ms}ms` : s ? 'DOWN' : '—'}</em></span>;
    })}</span>
  </div>;
}
