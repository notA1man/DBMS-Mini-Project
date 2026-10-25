import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import Link from 'next/link';
import { auth,signOut } from '@/auth';

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "SkyOps | Your journey, together",
  description: "Airline booking, check-in and journey management. A DBMS demonstration project.",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const session=await auth();
  return (
    <html lang="en">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        <header><Link className="brand" href="/">SKY<span>OPS</span><small>AIRLINE OPERATIONS</small></Link>
          <nav aria-label="Main navigation"><Link href="/">Find flights</Link><Link href="/policies">Policies</Link><Link href="/trips">My Trips</Link><Link href="/showcase">DB Showcase</Link>
            {['ADMIN','OPS'].includes(session?.user.role || '') && <><Link href="/ops/passengers">Passengers</Link><Link href="/ops/complaints">Complaints</Link></>}
            {session?.user.role==='ADMIN' && <Link href="/admin/users">Users</Link>}
            {session?<form action={async()=>{'use server';await signOut({redirectTo:'/'});}}><button className="subtle">Sign out</button></form>:<Link className="button" href="/login">Sign in</Link>}
          </nav></header>
        <main className="container">{children}</main>
        <footer><strong>SKYOPS</strong><p>Airline operations & ticketing · DBMS project</p><small>Demo service. Payments and refunds are simulated.</small></footer>
      </body>
    </html>
  );
}
