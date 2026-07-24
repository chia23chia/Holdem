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
