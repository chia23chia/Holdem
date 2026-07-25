import { prisma, Prisma } from '@holdem/db';
import type {
  HandEndResult,
  HandLogData,
  RoomDetail,
  RoomStatus,
  RoomSummary,
  SettlementSummary,
} from '@holdem/shared';

const displayName = (u: { nickname: string | null; name: string | null }) =>
  u.nickname ?? u.name ?? 'unknown';

export async function listRoomSummaries(): Promise<RoomSummary[]> {
  const rooms = await prisma.room.findMany({
    where: { status: { in: ['waiting', 'playing'] } },
    orderBy: { createdAt: 'desc' },
    include: {
      owner: { select: { name: true, nickname: true } },
      _count: { select: { memberships: true } },
    },
  });
  return rooms.map((r) => ({
    id: r.id,
    name: r.name,
    ownerName: displayName(r.owner),
    maxPlayers: r.maxPlayers,
    currentPlayers: r._count.memberships,
    smallBlind: r.smallBlind,
    bigBlind: r.bigBlind,
    buyIn: r.buyIn,
    status: r.status as RoomStatus,
    sessionMinutes: r.sessionMinutes,
    sessionEndsAt: r.sessionEndsAt?.toISOString() ?? null,
    actionTimeoutSeconds: r.actionTimeoutSeconds,
  }));
}

export async function getRoomDetail(roomId: string): Promise<RoomDetail | null> {
  const room = await prisma.room.findUnique({
    where: { id: roomId },
    include: {
      owner: { select: { name: true, nickname: true } },
      memberships: {
        include: {
          user: { select: { id: true, name: true, nickname: true, image: true } },
        },
        orderBy: { seat: 'asc' },
      },
    },
  });
  if (!room) return null;
  return {
    id: room.id,
    name: room.name,
    ownerId: room.ownerId,
    ownerName: displayName(room.owner),
    maxPlayers: room.maxPlayers,
    currentPlayers: room.memberships.length,
    smallBlind: room.smallBlind,
    bigBlind: room.bigBlind,
    buyIn: room.buyIn,
    status: room.status as RoomStatus,
    sessionMinutes: room.sessionMinutes,
    sessionEndsAt: room.sessionEndsAt?.toISOString() ?? null,
    actionTimeoutSeconds: room.actionTimeoutSeconds,
    seats: room.memberships.map((m) => ({
      seat: m.seat,
      userId: m.userId,
      name: displayName(m.user),
      image: m.user.image,
      chipsAtTable: m.chipsAtTable,
    })),
  };
}

// Finds the lowest unoccupied seat number in [1..maxPlayers]. Returns null if full.
function firstFreeSeat(taken: Set<number>, maxPlayers: number): number | null {
  for (let i = 1; i <= maxPlayers; i++) {
    if (!taken.has(i)) return i;
  }
  return null;
}

export type SeatOutcome =
  | { ok: true; seat: number }
  | { ok: false; error: string };

// Atomically seats user at a free seat. Play-money model — chips are given
// out of thin air (no chipsBalance deduction). totalBuyIn tracks cumulative
// chips brought in for settlement's win/loss display.
// If user already seated in the room, returns success with their existing seat.
export async function seatUser(
  userId: string,
  roomId: string,
  desiredSeat?: number,
): Promise<SeatOutcome> {
  return prisma.$transaction(async (tx) => {
    const room = await tx.room.findUnique({
      where: { id: roomId },
      include: { memberships: { select: { seat: true, userId: true } } },
    });
    if (!room) return { ok: false, error: '房間不存在' };
    if (room.status === 'closed') return { ok: false, error: '房間已關閉' };

    const existing = room.memberships.find((m) => m.userId === userId);
    if (existing) return { ok: true, seat: existing.seat };

    if (room.memberships.length >= room.maxPlayers) {
      return { ok: false, error: '房間已滿' };
    }

    const taken = new Set(room.memberships.map((m) => m.seat));
    let seat: number | null;
    if (desiredSeat) {
      if (desiredSeat < 1 || desiredSeat > room.maxPlayers) {
        return { ok: false, error: '座位號碼無效' };
      }
      if (taken.has(desiredSeat)) {
        return { ok: false, error: '該座位已被佔用' };
      }
      seat = desiredSeat;
    } else {
      seat = firstFreeSeat(taken, room.maxPlayers);
      if (seat === null) return { ok: false, error: '房間已滿' };
    }

    await tx.membership.create({
      data: {
        userId,
        roomId,
        seat,
        chipsAtTable: room.buyIn,
        totalBuyIn: room.buyIn,
      },
    });
    return { ok: true, seat };
  });
}

// Rebuy: add another buyIn to this seat's stack + cumulative totalBuyIn.
// Play-money model — no chipsBalance deduction. Caller decides whether to
// apply immediately (between hands) or defer via in-memory queue (mid-hand).
export async function rebuyChips(
  userId: string,
  roomId: string,
): Promise<
  { ok: true; amount: number; chipsAtTable: number } | { ok: false; error: string }
> {
  return prisma.$transaction(async (tx) => {
    const room = await tx.room.findUnique({
      where: { id: roomId },
      select: { buyIn: true },
    });
    if (!room) return { ok: false, error: '房間不存在' };
    const membership = await tx.membership.findUnique({
      where: { userId_roomId: { userId, roomId } },
    });
    if (!membership) return { ok: false, error: '你不在此房間' };
    const updated = await tx.membership.update({
      where: { id: membership.id },
      data: {
        chipsAtTable: { increment: room.buyIn },
        totalBuyIn: { increment: room.buyIn },
      },
    });
    return { ok: true, amount: room.buyIn, chipsAtTable: updated.chipsAtTable };
  });
}

// Removes user from room. Play-money model — chips vanish (no chipsBalance
// refund; settlement was already shown for display purposes).
// Idempotent: safe to call twice concurrently.
export async function unseatUser(
  userId: string,
  roomId: string,
): Promise<{ empty: boolean }> {
  return prisma.$transaction(async (tx) => {
    const membership = await tx.membership.findUnique({
      where: { userId_roomId: { userId, roomId } },
    });
    if (membership) {
      await tx.membership.deleteMany({ where: { id: membership.id } });
    }
    const remaining = await tx.membership.count({ where: { roomId } });
    return { empty: remaining === 0 };
  });
}

export async function closeRoom(roomId: string): Promise<void> {
  await prisma.room.update({
    where: { id: roomId },
    data: { status: 'closed' },
  });
}

// Set Room.status. Used by hand-start / hand-end transitions to toggle
// waiting↔playing. Idempotent — writes even if same value (cost negligible).
export async function setRoomStatus(
  roomId: string,
  status: 'waiting' | 'playing' | 'closed',
): Promise<void> {
  await prisma.room.update({
    where: { id: roomId },
    data: { status },
  });
}

export type CloseOutcome =
  | { ok: true; kickedUserIds: string[] }
  | { ok: false; error: string };

// Owner-initiated close: refunds all seated players and marks room closed.
// Rejects if a hand is in progress (status === 'playing').
// Idempotent for already-closed rooms.
export async function ownerCloseRoom(
  requesterId: string,
  roomId: string,
): Promise<CloseOutcome> {
  return prisma.$transaction(async (tx) => {
    const room = await tx.room.findUnique({
      where: { id: roomId },
      include: { memberships: true },
    });
    if (!room) return { ok: false, error: '房間不存在' };
    if (room.ownerId !== requesterId) {
      return { ok: false, error: '只有房主可以關閉房間' };
    }
    if (room.status === 'closed') return { ok: true, kickedUserIds: [] };
    if (room.status === 'playing') {
      return { ok: false, error: '房間進行中,無法關閉' };
    }

    const kickedUserIds: string[] = [];
    for (const m of room.memberships) {
      const { count } = await tx.membership.deleteMany({
        where: { id: m.id },
      });
      if (count === 1) kickedUserIds.push(m.userId);
    }
    await tx.room.update({
      where: { id: roomId },
      data: { status: 'closed' },
    });
    return { ok: true, kickedUserIds };
  });
}

// Builds a settlement snapshot from the CURRENT memberships then refunds +
// closes. Distinct from ownerCloseRoom because system callers (session expiry)
// don't have an authenticated requesterId.
export async function systemCloseRoomWithSettlement(
  roomId: string,
  reason: SettlementSummary['reason'],
): Promise<SettlementSummary | null> {
  return prisma.$transaction(async (tx) => {
    const room = await tx.room.findUnique({
      where: { id: roomId },
      include: {
        memberships: {
          include: {
            user: { select: { name: true, nickname: true } },
          },
        },
      },
    });
    if (!room) return null;
    if (room.status === 'closed') return null;

    const players = room.memberships.map((m) => ({
      userId: m.userId,
      name: displayName(m.user),
      chipsAtTable: m.chipsAtTable,
      totalBuyIn: m.totalBuyIn,
    }));

    for (const m of room.memberships) {
      await tx.membership.deleteMany({ where: { id: m.id } });
    }
    await tx.room.update({
      where: { id: roomId },
      data: { status: 'closed' },
    });

    return {
      roomId: room.id,
      roomName: room.name,
      reason,
      players,
    };
  });
}

// Builds a settlement snapshot for owner close (memberships are already gone
// by the time this runs — caller must invoke BEFORE ownerCloseRoom, or pass
// pre-fetched data).
export async function buildOwnerCloseSettlement(
  roomId: string,
  players: SettlementSummary['players'],
): Promise<SettlementSummary | null> {
  const room = await prisma.room.findUnique({
    where: { id: roomId },
    select: { id: true, name: true },
  });
  if (!room) return null;
  return {
    roomId: room.id,
    roomName: room.name,
    reason: 'owner-closed',
    players,
  };
}

// Convenience: read room + memberships to snapshot BEFORE ownerCloseRoom.
export async function snapshotSeatedPlayers(
  roomId: string,
): Promise<SettlementSummary['players']> {
  const memberships = await prisma.membership.findMany({
    where: { roomId },
    include: { user: { select: { name: true, nickname: true } } },
  });
  return memberships.map((m) => ({
    userId: m.userId,
    name: displayName(m.user),
    chipsAtTable: m.chipsAtTable,
    totalBuyIn: m.totalBuyIn,
  }));
}

// Starts the session countdown by writing sessionEndsAt = now + sessionMinutes.
// No-op if session already started (sessionEndsAt already set) or sessionMinutes
// is null (unlimited — unreachable currently but future-safe).
// Returns true iff DB was updated (caller can broadcast fresh room detail).
export async function startSessionIfNeeded(roomId: string): Promise<boolean> {
  const room = await prisma.room.findUnique({
    where: { id: roomId },
    select: { sessionMinutes: true, sessionEndsAt: true },
  });
  if (!room?.sessionMinutes || room.sessionEndsAt) return false;
  const endsAt = new Date(Date.now() + room.sessionMinutes * 60_000);
  await prisma.room.update({
    where: { id: roomId },
    data: { sessionEndsAt: endsAt },
  });
  return true;
}

// After a hand ends, sync each seated player's chipsAtTable to the in-memory
// hand result. Called before broadcasting a fresh room:detail.
export async function persistHandResult(
  roomId: string,
  snapshot: Array<{ userId: string; chips: number }>,
): Promise<void> {
  await prisma.$transaction(
    snapshot.map((s) =>
      prisma.membership.updateMany({
        where: { roomId, userId: s.userId },
        data: { chipsAtTable: s.chips },
      }),
    ),
  );
}

// Persist a completed hand's snapshot with a caller-supplied handNumber.
// Caller obtains the next number via countHandLogs BEFORE startHand so the
// HandState broadcast and this write agree on the number.
export async function persistHandLog(
  roomId: string,
  handNumber: number,
  data: HandLogData,
): Promise<{ id: string }> {
  const row = await prisma.handLog.create({
    data: {
      roomId,
      handNumber,
      startedAt: new Date(data.startedAt),
      endedAt: new Date(data.endedAt),
      data: data as unknown as Prisma.InputJsonValue,
    },
    select: { id: true },
  });
  return row;
}

// Count existing hands so caller can compute the next handNumber before
// startHand — keeps handNumber consistent between HandState broadcast and
// eventual persistHandLog write.
export async function countHandLogs(roomId: string): Promise<number> {
  return prisma.handLog.count({ where: { roomId } });
}

// Wipe all HandLog rows for a room. Called on room close (owner-close /
// session-expired / empty-room auto-close) — per user's preference the
// per-hand history exists only for the duration of a room session and is
// not kept indefinitely.
export async function deleteHandLogsForRoom(roomId: string): Promise<void> {
  await prisma.handLog.deleteMany({ where: { roomId } });
}

// After a voluntary post-hand reveal, patch the log's endResult.
export async function updateHandLogEndResult(
  handLogId: string,
  endResult: HandEndResult,
): Promise<void> {
  const row = await prisma.handLog.findUnique({
    where: { id: handLogId },
    select: { data: true },
  });
  if (!row) return;
  const data = row.data as unknown as HandLogData;
  data.endResult = endResult;
  await prisma.handLog.update({
    where: { id: handLogId },
    data: { data: data as unknown as Prisma.InputJsonValue },
  });
}

export interface HandLogRow {
  id: string;
  handNumber: number;
  startedAt: string; // ISO
  endedAt: string;   // ISO
  data: HandLogData;
}

// List past hands for a room, newest first (client can sort ascending after).
export async function listHandLogs(
  roomId: string,
  limit = 200,
): Promise<HandLogRow[]> {
  const rows = await prisma.handLog.findMany({
    where: { roomId },
    orderBy: { handNumber: 'desc' },
    take: limit,
  });
  return rows.map((r) => ({
    id: r.id,
    handNumber: r.handNumber,
    startedAt: r.startedAt.toISOString(),
    endedAt: r.endedAt.toISOString(),
    data: r.data as unknown as HandLogData,
  }));
}

// Returns rooms with a non-null sessionEndsAt in the past that aren't yet closed.
export async function findExpiredRooms(): Promise<Array<{ id: string }>> {
  return prisma.room.findMany({
    where: {
      status: { in: ['waiting', 'playing'] },
      sessionEndsAt: { lte: new Date() },
    },
    select: { id: true },
  });
}
