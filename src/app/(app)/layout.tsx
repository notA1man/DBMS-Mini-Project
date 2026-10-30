import Link from 'next/link';
import { auth, signOut } from '@/auth';
import { NavLink } from '@/components/nav-link';
import { AppAtmosphere, AppPage } from '@/components/app-experience';
import { SectionNav, StatusBar } from '@/components/app-chrome';

// Application shell for every page except the landing (/). Header/footer by Aiman; operations,
// crew and admin areas (Aditya) appear by role, with their own numbered section tabs.
export default async function AppLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const session = await auth();
  const role = session?.user.role ?? '';
  const staff = ['ADMIN', 'OPS'].includes(role);
  return (
    <div className="app-shell">
      <AppAtmosphere />
      <a className="skip-link" href="#main-content">Skip to content</a>
      <header className="app-header"><Link className="brand" href="/" aria-label="SkyOps home">
        <svg viewBox="0 0 20 20" width="14" height="14" aria-hidden="true"><path d="M10 1 L19 10 L10 19 L1 10 Z" fill="none" stroke="currentColor" strokeWidth="1.6"/><circle cx="10" cy="10" r="2.2" fill="currentColor"/></svg>SKYOPS</Link>
        <nav aria-label="Main navigation">
          <NavLink href="/search">Flights</NavLink><NavLink href="/board">Departures</NavLink><NavLink href="/policies">Policies</NavLink>
          {(!role || role === 'PASSENGER') && <NavLink href="/trips">My Trips</NavLink>}
          {staff && <NavLink href="/ops">Operations</NavLink>}
          {role === 'CREW' && <NavLink href="/crew">My roster</NavLink>}
          {role === 'ADMIN' && <NavLink href="/admin">Admin</NavLink>}
          <NavLink href="/showcase">DB Showcase</NavLink>
        </nav>
        <div className="account">
          {session ? <>
            <span className="account-id"><b>{role}</b><span>{session.user.email}</span></span>
            <form action={async () => { 'use server'; await signOut({ redirectTo: '/' }); }}><button className="nav-signin">Sign out</button></form>
          </> : <NavLink className="nav-signin" href="/login">Sign in</NavLink>}
        </div>
      </header>
      <SectionNav role={role} />
      <main id="main-content" tabIndex={-1} className="container"><AppPage>{children}</AppPage></main>
      <footer className="app-footer">
        <div className="footer-grid">
          <div>
            <Link className="footer-word" href="/">SKYOPS</Link>
            <p className="footer-note">Disruption-aware airline operations &amp; ticketing.<br />PostgreSQL · Neo4j · MongoDB · pgvector</p>
          </div>
          <nav className="footer-cols" aria-label="Footer">
            <div><span>FLY</span><Link href="/search">Flight search</Link><Link href="/board">Live departures</Link>
              <Link href="/policies">Policy assistant</Link><Link href="/trips">My Trips</Link></div>
            <div><span>STAFF</span><Link href="/ops">Ops console</Link><Link href="/crew">Crew portal</Link><Link href="/admin">Admin</Link></div>
            <div><span>PROJECT</span><Link href="/showcase">DB showcase</Link><a href="/api/health">System health</a></div>
          </nav>
        </div>
        <div className="footer-base"><span>DBMS MINI PROJECT · PES UNIVERSITY · 2026</span><span>AIMAN A NAWAB · ADITYA VATS</span>
          <span>DEMO SERVICE · PAYMENTS AND REFUNDS ARE SIMULATED</span></div>
      </footer>
      <StatusBar role={role} />
    </div>
  );
}
