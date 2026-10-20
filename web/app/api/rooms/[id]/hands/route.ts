import { NextResponse } from 'next/server';
import { prisma } from '@holdem/db';
import { auth } from '@/lib/auth';
import type { HandLogData } from '@holdem/shared';

// GET /api/rooms/:id/hands — return persisted hand history for a room.
// Auth required. Returns newest first. Client-side merges with any live
// hands not yet persisted.
export async function GET(
  _req: Request,
  { params }: { params: { id: string } },
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthenticated' }, { status: 401 });
  }

  const roomId = params.id;

  // Only room members can read hand history (prevents hole-card IDOR via
  // guessed/scraped roomIds — showdown.revealedHoles would otherwise leak).
  const membership = await prisma.membership.findFirst({
    where: { roomId, userId: session.user.id },
    select: { id: true },
  });
  if (!membership) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const rows = await prisma.handLog.findMany({
    where: { roomId },
    orderBy: { handNumber: 'desc' },
    take: 200,
  });

  return NextResponse.json({
    hands: rows.map((r) => ({
      id: r.id,
      handNumber: r.handNumber,
      startedAt: r.startedAt.toISOString(),
      endedAt: r.endedAt.toISOString(),
      data: r.data as unknown as HandLogData,
    })),
  });
}
