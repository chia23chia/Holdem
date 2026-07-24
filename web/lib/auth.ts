import NextAuth from 'next-auth';
import { PrismaAdapter } from '@auth/prisma-adapter';
import { prisma } from '@holdem/db';
import authConfig from './auth.config';

// Full auth config for Node runtime (API routes / server components).
// Middleware uses `./auth.config` directly to stay Edge-compatible.
export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  adapter: PrismaAdapter(prisma),
  callbacks: {
    // Refetches DB on every JWT read so nickname changes propagate immediately.
    // Cost: one query per session read — fine for a private friends app.
    // Only runs in Node runtime; middleware jwt uses default no-op callback.
    async jwt({ token, user }) {
      if (user) {
        token.sub = user.id;
      }
      const id = user?.id ?? token.sub;
      if (id) {
        const dbUser = await prisma.user.findUnique({
          where: { id },
          select: { name: true, nickname: true },
        });
        if (dbUser) {
          token.name = dbUser.nickname ?? dbUser.name ?? token.name;
        }
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        if (token.sub) session.user.id = token.sub;
        if (token.name) session.user.name = token.name;
      }
      return session;
    },
  },
});
