import NextAuth from 'next-auth';
import { NextResponse } from 'next/server';
import authConfig from './auth.config';

export default NextAuth(authConfig).auth(request=>{
  if(!request.auth) return NextResponse.redirect(new URL('/login',request.url));
  const role=request.auth.user.role;
  if((request.nextUrl.pathname.startsWith('/admin') && role!=='ADMIN') ||
     (request.nextUrl.pathname.startsWith('/ops') && !['ADMIN','OPS'].includes(role))) {
    return NextResponse.redirect(new URL('/trips',request.url));
  }
});
export const config = { runtime:'nodejs',matcher: ['/trips/:path*','/book/:path*','/admin/:path*','/ops/passengers/:path*','/ops/complaints/:path*'] };
