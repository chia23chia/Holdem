import { PrismaClient } from '@prisma/client';

// Global singleton to avoid exhausting Neon connection pool during Next.js hot reload.
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  });

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}

export type { User, Room, Membership, Account, Session, RoomStatus } from '@prisma/client';
export { Prisma } from '@prisma/client';
