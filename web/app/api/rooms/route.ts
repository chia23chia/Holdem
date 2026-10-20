import { NextResponse } from 'next/server';
import { prisma } from '@holdem/db';
import { auth } from '@/lib/auth';

// GET /api/rooms — list open rooms with player counts.
export async function GET() {
  const rooms = await prisma.room.findMany({
    where: { status: { in: ['waiting', 'playing'] } },
    orderBy: { createdAt: 'desc' },
    include: {
      owner: { select: { name: true, nickname: true } },
      _count: { select: { memberships: true } },
    },
  });

  return NextResponse.json({
    rooms: rooms.map((r) => ({
      id: r.id,
      name: r.name,
      ownerName: r.owner.nickname ?? r.owner.name ?? 'unknown',
      roomType: r.roomType,
      maxPlayers: r.maxPlayers,
      currentPlayers: r._count.memberships,
      smallBlind: r.smallBlind,
      bigBlind: r.bigBlind,
      buyIn: r.buyIn,
      status: r.status,
      sessionMinutes: r.sessionMinutes,
      sessionEndsAt: r.sessionEndsAt?.toISOString() ?? null,
      actionTimeoutSeconds: r.actionTimeoutSeconds,
      blindLevelMinutes: r.blindLevelMinutes,
      tournamentClockStartedAt: r.tournamentClockStartedAt?.toISOString() ?? null,
    })),
  });
}

const VALID_ROOM_TYPES = new Set(['cash', 'tournament']);
const VALID_SESSION_MINUTES = new Set([30, 60, 90, 120]);
const VALID_ACTION_TIMEOUTS = new Set([15, 30, 60]);
const VALID_BLIND_LEVEL_MINUTES = new Set([5, 10, 15, 20]);

// Per-user cooldown for room creation (A-C2). Prevents unbounded DB growth
// from a scripted client. Friends-only scale (~10 users) so a plain Map is
// fine — no eviction needed. In-memory, resets on server restart.
const ROOM_CREATE_COOLDOWN_MS = 30_000;
const lastRoomCreateByUser = new Map<string, number>();

// POST /api/rooms — create a new room (auth required).
export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthenticated' }, { status: 401 });
  }

  const now = Date.now();
  const lastAt = lastRoomCreateByUser.get(session.user.id);
  if (lastAt !== undefined && now - lastAt < ROOM_CREATE_COOLDOWN_MS) {
    const retryAfterSec = Math.ceil(
      (ROOM_CREATE_COOLDOWN_MS - (now - lastAt)) / 1000,
    );
    return NextResponse.json(
      { error: `建房太頻繁,請等 ${retryAfterSec} 秒再試` },
      { status: 429, headers: { 'Retry-After': String(retryAfterSec) } },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const {
    name,
    roomType = 'cash',
    maxPlayers = 9,
    smallBlind = 5,
    bigBlind = 10,
    buyIn = 1000,
    sessionMinutes = 30,
    actionTimeoutSeconds = 30,
    blindLevelMinutes = 15,
  } = (body ?? {}) as Record<string, unknown>;

  if (typeof name !== 'string' || !name.trim()) {
    return NextResponse.json({ error: 'name required' }, { status: 400 });
  }
  if (!VALID_ROOM_TYPES.has(roomType as string)) {
    return NextResponse.json({ error: 'roomType must be cash or tournament' }, { status: 400 });
  }
  const isTournament = roomType === 'tournament';

  const mp = Number(maxPlayers);
  const sb = Number(smallBlind);
  const bb = Number(bigBlind);
  const bi = Number(buyIn);
  if (!Number.isInteger(mp) || mp < 2 || mp > 10) {
    return NextResponse.json({ error: 'maxPlayers must be 2-10' }, { status: 400 });
  }
  if (!(sb > 0 && bb >= sb * 2 && bi >= bb * 20)) {
    return NextResponse.json(
      { error: 'blind/buyIn invalid (bb >= 2*sb, buyIn >= 20*bb)' },
      { status: 400 },
    );
  }

  let sm: number | null = null;
  let blm: number | null = null;
  if (isTournament) {
    blm = Number(blindLevelMinutes);
    if (!VALID_BLIND_LEVEL_MINUTES.has(blm)) {
      return NextResponse.json(
        { error: 'blindLevelMinutes must be 5/10/15/20' },
        { status: 400 },
      );
    }
  } else {
    sm = Number(sessionMinutes);
    if (!VALID_SESSION_MINUTES.has(sm)) {
      return NextResponse.json(
        { error: 'sessionMinutes must be 30/60/90/120' },
        { status: 400 },
      );
    }
  }

  const at = Number(actionTimeoutSeconds);
  if (!VALID_ACTION_TIMEOUTS.has(at)) {
    return NextResponse.json(
      { error: 'actionTimeoutSeconds must be 15/30/60' },
      { status: 400 },
    );
  }

  // sessionEndsAt / tournamentClockStartedAt are left null; server sets
  // them when the owner first starts a hand.
  const room = await prisma.room.create({
    data: {
      name: name.trim().slice(0, 40),
      ownerId: session.user.id,
      roomType: roomType as 'cash' | 'tournament',
      maxPlayers: mp,
      smallBlind: sb,
      bigBlind: bb,
      buyIn: bi,
      sessionMinutes: sm,
      actionTimeoutSeconds: at,
      blindLevelMinutes: blm,
    },
  });

  lastRoomCreateByUser.set(session.user.id, now);
  return NextResponse.json({ id: room.id }, { status: 201 });
}
