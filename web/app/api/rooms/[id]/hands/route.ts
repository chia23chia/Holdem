import { NextResponse } from 'next/server';
import { prisma } from '@holdem/db';
import { auth } from '@/lib/auth';
import { isHandLogData } from '@holdem/shared';
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

  // Filter out rows whose stored shape doesn't match current HandLogData
  // (T1 in docs/AUDIT_2026-10-20.md) — the shared type may have evolved
  // since the row was persisted; silently returning a malformed object would
  // crash the client renderer.
  return NextResponse.json({
    hands: rows
      .filter((r) => isHandLogData(r.data))
      .map((r) => ({
        id: r.id,
        handNumber: r.handNumber,
        startedAt: r.startedAt.toISOString(),
        endedAt: r.endedAt.toISOString(),
        data: r.data as unknown as HandLogData,
      })),
  });
}
