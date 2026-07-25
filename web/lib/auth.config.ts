import type { NextAuthConfig } from 'next-auth';
import Google from 'next-auth/providers/google';

// Edge-safe subset of the NextAuth config. Middleware imports this so it can
// run under Edge Runtime (no Prisma / Node-only APIs allowed here).
// The full config in `./auth.ts` spreads this and adds the Prisma adapter +
// DB-backed callbacks.
export default {
  // Auth.js v5 refuses to serve requests from hosts it hasn't been told to
  // trust (guards against Host header injection). Behind our Caddy reverse
  // proxy on any duckdns / custom domain, we know Host is what Caddy set it to.
  trustHost: true,
  session: { strategy: 'jwt' },
  providers: [
    Google({
      clientId: process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
    }),
  ],
  pages: {
    signIn: '/',
  },
} satisfies NextAuthConfig;
