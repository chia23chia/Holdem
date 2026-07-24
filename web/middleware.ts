import NextAuth from 'next-auth';
import { NextResponse } from 'next/server';
import authConfig from '@/lib/auth.config';

// Middleware runs on Edge Runtime, so it uses only the Edge-safe config
// (no Prisma adapter, no DB callbacks). It just checks whether the JWT cookie
// is present and valid enough to have a session.
const { auth } = NextAuth(authConfig);

export default auth((req) => {
  const isLoggedIn = !!req.auth;
  const { pathname } = req.nextUrl;

  const isProtected =
    pathname.startsWith('/lobby') || pathname.startsWith('/room');

  if (isProtected && !isLoggedIn) {
    return NextResponse.redirect(new URL('/', req.nextUrl));
  }
  return NextResponse.next();
});

// Skip static assets, next internals, and API routes.
export const config = {
  matcher: ['/((?!api|_next/static|_next/image|favicon.ico).*)'],
};
