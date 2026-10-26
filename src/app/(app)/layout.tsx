import Link from 'next/link';
import { auth, signOut } from '@/auth';
import { NavLink } from '@/components/nav-link';
import { AppAtmosphere, AppPage } from '@/components/app-experience';

// Application shell for every page except the landing (/). Header/footer by Aiman; operations,
// crew and admin links (Aditya) appear by role.
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
          <NavLink href="/search">Find flights</NavLink><NavLink href="/board">Departures</NavLink><NavLink href="/policies">Policies</NavLink>
          {(!role || role === 'PASSENGER') && <NavLink href="/trips">My Trips</NavLink>}
          {staff && <><NavLink href="/ops">Ops console</NavLink><NavLink href="/ops/schedule">Schedule</NavLink>
            <NavLink href="/ops/disruptions">Disruptions</NavLink><NavLink href="/ops/passengers">Passengers</NavLink></>}
          {role === 'CREW' && <NavLink href="/crew">My roster</NavLink>}
          {role === 'ADMIN' && <><NavLink href="/admin">Admin</NavLink><NavLink href="/admin/users">Users</NavLink></>}
          <NavLink href="/showcase">DB Showcase</NavLink>
          {session ? <form action={async () => { 'use server'; await signOut({ redirectTo: '/' }); }}><button className="subtle">Sign out</button></form>
            : <NavLink className="nav-signin" href="/login">Sign in</NavLink>}
        </nav></header>
      <main id="main-content" tabIndex={-1} className="container"><AppPage>{children}</AppPage></main>
      <footer className="app-footer">
        <div><Link className="brand" href="/">SKYOPS</Link><p>Every journey, connected.</p></div>
        <div><div className="footer-links"><Link href="/search">Find flights</Link><Link href="/trips">My Trips</Link><Link href="/policies">Travel policies</Link></div>
          <small>Demo service. Payments and refunds are simulated.</small></div>
      </footer>
    </div>
  );
}
