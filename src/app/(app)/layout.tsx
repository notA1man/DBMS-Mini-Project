import Link from 'next/link';
import { auth, signOut } from '@/auth';

// Application shell for every page except the landing (/). Header/footer by Aiman; operations,
// crew and admin links (Aditya) appear by role.
export default async function AppLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const session = await auth();
  const role = session?.user.role ?? '';
  const staff = ['ADMIN', 'OPS'].includes(role);
  return (
    <div className="app-shell">
      <header><Link className="brand" href="/">SKY<span>OPS</span><small>AIRLINE OPERATIONS</small></Link>
        <nav aria-label="Main navigation">
          <Link href="/search">Find flights</Link><Link href="/board">Departures</Link><Link href="/policies">Policies</Link>
          {(!role || role === 'PASSENGER') && <Link href="/trips">My Trips</Link>}
          {staff && <><Link href="/ops">Ops console</Link><Link href="/ops/schedule">Schedule</Link>
            <Link href="/ops/disruptions">Disruptions</Link><Link href="/ops/passengers">Passengers</Link></>}
          {role === 'CREW' && <Link href="/crew">My roster</Link>}
          {role === 'ADMIN' && <><Link href="/admin">Admin</Link><Link href="/admin/users">Users</Link></>}
          <Link href="/showcase">DB Showcase</Link>
          {session ? <form action={async () => { 'use server'; await signOut({ redirectTo: '/' }); }}><button className="subtle">Sign out</button></form>
            : <Link className="button" href="/login">Sign in</Link>}
        </nav></header>
      <main className="container">{children}</main>
      <footer><strong>SKYOPS</strong><p>Airline operations & ticketing · DBMS project</p><small>Demo service. Payments and refunds are simulated.</small></footer>
    </div>
  );
}
