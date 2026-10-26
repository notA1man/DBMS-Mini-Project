import NextAuth from 'next-auth';
import { NextResponse } from 'next/server';
import authConfig from './auth.config';

// First enforcement layer (route groups). API handlers re-check roles from the database, and
// PostgreSQL RLS is the last line of defence.
export default NextAuth(authConfig).auth(request=>{
  if(!request.auth) return NextResponse.redirect(new URL('/login',request.url));
  const role=request.auth.user.role;
  const path=request.nextUrl.pathname;
  const denied=(path.startsWith('/admin') && role!=='ADMIN') ||
    (path.startsWith('/ops') && !['ADMIN','OPS'].includes(role)) ||
    (path.startsWith('/crew') && !['CREW','ADMIN','OPS'].includes(role)) ||
    ((path.startsWith('/trips') || path.startsWith('/book')) && ['CREW'].includes(role));
  if(denied) return NextResponse.redirect(new URL(role==='CREW'?'/crew':['ADMIN','OPS'].includes(role)?'/ops':'/trips',request.url));
});
export const config = { runtime:'nodejs',matcher: ['/trips/:path*','/book/:path*','/admin/:path*','/ops/:path*','/crew/:path*'] };
