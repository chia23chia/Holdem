import { prisma, Prisma } from '@holdem/db';
import type {
  HandEndResult,
  HandLogData,
  RoomDetail,
  RoomStatus,
  RoomSummary,
  RoomType,
  SettlementSummary,
} from '@holdem/shared';

export const displayName = (u: { nickname: string | null; name: string | null }) =>
  u.nickname ?? u.name ?? 'unknown';

export async function listRoomSummaries(): Promise<RoomSummary[]> {
  const rooms = await prisma.room.findMany({
    where: { status: { in: ['waiting', 'playing'] } },
    orderBy: { createdAt: 'desc' },
    include: {
      owner: { select: { name: true, nickname: true } },
      _count: { select: { memberships: { where: { seat: { not: null } } } } },
    },
  });
  return rooms.map((r) => ({
    id: r.id,
    name: r.name,
    ownerName: displayName(r.owner),
    roomType: r.roomType as RoomType,
    maxPlayers: r.maxPlayers,
    currentPlayers: r._count.memberships,
    smallBlind: r.smallBlind,
    bigBlind: r.bigBlind,
    buyIn: r.buyIn,
    status: r.status as RoomStatus,
    sessionMinutes: r.sessionMinutes,
    sessionEndsAt: r.sessionEndsAt?.toISOString() ?? null,
    actionTimeoutSeconds: r.actionTimeoutSeconds,
    blindLevelMinutes: r.blindLevelMinutes,
    tournamentClockStartedAt: r.tournamentClockStartedAt?.toISOString() ?? null,
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
    roomType: room.roomType as RoomType,
    maxPlayers: room.maxPlayers,
    currentPlayers: room.memberships.filter((m) => m.seat !== null).length,
    smallBlind: room.smallBlind,
    bigBlind: room.bigBlind,
    buyIn: room.buyIn,
    status: room.status as RoomStatus,
    sessionMinutes: room.sessionMinutes,
    sessionEndsAt: room.sessionEndsAt?.toISOString() ?? null,
    actionTimeoutSeconds: room.actionTimeoutSeconds,
    blindLevelMinutes: room.blindLevelMinutes,
    tournamentClockStartedAt: room.tournamentClockStartedAt?.toISOString() ?? null,
    // Temporarily-standing players (seat === null) aren't shown as
    // occupying a seat — their Membership row just holds their chips
    // until they sit back down.
    seats: room.memberships
      .filter((m): m is typeof m & { seat: number } => m.seat !== null)
      .map((m) => ({
        seat: m.seat,
        userId: m.userId,
        name: displayName(m.user),
        image: m.user.image,
        chipsAtTable: m.chipsAtTable,
        finishRank: m.finishRank,
      })),
    // Standings include everyone (seated + 暫離). Sorted by net DESC on
    // server so all clients render the same order without extra work.
    standings: room.memberships
      .map((m) => ({
        userId: m.userId,
        name: displayName(m.user),
        seat: m.seat,
        chipsAtTable: m.chipsAtTable,
        totalBuyIn: m.totalBuyIn,
        finishRank: m.finishRank,
      }))
      .sort(
        (a, b) =>
          b.chipsAtTable - b.totalBuyIn - (a.chipsAtTable - a.totalBuyIn),
      ),
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
// If already seated, returns success with their existing seat. If they have
// a Membership row but are temporarily standing (seat === null, see
// unseatUser), re-seats them WITHOUT touching chipsAtTable/totalBuyIn — they
// resume their prior stack instead of a fresh buy-in.
export async function seatUser(
  userId: string,
  roomId: string,
  desiredSeat?: number,
): Promise<SeatOutcome> {
  return prisma.$transaction(async (tx) => {
    const room = await tx.room.findUnique({
      where: { id: roomId },
      include: { memberships: { select: { id: true, seat: true, userId: true } } },
    });
    if (!room) return { ok: false, error: '房間不存在' };
    if (room.status === 'closed') return { ok: false, error: '房間已關閉' };

    const existing = room.memberships.find((m) => m.userId === userId);
    if (existing && existing.seat !== null) {
      return { ok: true, seat: existing.seat };
    }

    if (room.roomType === 'tournament' && room.tournamentClockStartedAt) {
      return { ok: false, error: '錦標賽已開始,無法加入' };
    }

    const seatedMemberships = room.memberships.filter((m) => m.seat !== null);
    if (seatedMemberships.length >= room.maxPlayers) {
      return { ok: false, error: '房間已滿' };
    }

    const taken = new Set(seatedMemberships.map((m) => m.seat as number));
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

    if (existing) {
      // Re-seating after a temporary standup — keep their prior stack.
      await tx.membership.update({
        where: { id: existing.id },
        data: { seat },
      });
    } else {
      await tx.membership.create({
        data: {
          userId,
          roomId,
          seat,
          chipsAtTable: room.buyIn,
          totalBuyIn: room.buyIn,
        },
      });
    }
    return { ok: true, seat };
  });
}

// Rounds down to the nearest 500: 1999 -> 1500, 601 -> 500, 2500 -> 2500.
// Used to cap rebuys below the table's chip leader (see rebuyChips).
function roundDownTo500(n: number): number {
  return Math.max(0, Math.floor(n / 500) * 500);
}

// Rebuy rules (play-money, no chipsBalance deduction):
//  - Only allowed once a seat's chips hit exactly 0 — no topping up a
//    non-zero stack, however small.
//  - Caller picks the amount, but it must be a multiple of 500 and can't
//    exceed the table's current chip leader: if the leader's stack exceeds
//    the room's buyIn, the cap rounds DOWN to the nearest 500 (leader 1999
//    -> pick 500/1000/1500); if the leader is at or below buyIn (e.g. the
//    original leader stood up and left with their stack), the cap is buyIn
//    rounded down to 500 — picking the top tier makes this player the new
//    leader.
// Caller decides whether to apply immediately (between hands) or defer via
// in-memory queue (mid-hand); either way this is the single authoritative
// check, so a queued rebuy that's no longer eligible/valid by the time the
// hand ends (e.g. the player didn't actually bust, or the cap shrank) safely
// gets rejected here instead of silently over-granting.
export async function rebuyChips(
  userId: string,
  roomId: string,
  amount: number,
): Promise<
  { ok: true; amount: number; chipsAtTable: number } | { ok: false; error: string }
> {
  return prisma.$transaction(async (tx) => {
    const room = await tx.room.findUnique({
      where: { id: roomId },
      select: { buyIn: true, roomType: true },
    });
    if (!room) return { ok: false, error: '房間不存在' };
    if (room.roomType === 'tournament') {
      return { ok: false, error: '錦標賽模式不可加碼' };
    }
    const membership = await tx.membership.findUnique({
      where: { userId_roomId: { userId, roomId } },
    });
    if (!membership) return { ok: false, error: '你不在此房間' };
    if (membership.chipsAtTable > 0) {
      return { ok: false, error: '籌碼歸零才能加碼' };
    }
    if (!Number.isInteger(amount) || amount <= 0 || amount % 500 !== 0) {
      return { ok: false, error: '加碼金額必須是 500 的倍數' };
    }

    const { _max } = await tx.membership.aggregate({
      where: { roomId },
      _max: { chipsAtTable: true },
    });
    const leader = _max.chipsAtTable ?? 0;
    const cap = roundDownTo500(leader > room.buyIn ? leader : room.buyIn);
    if (amount > cap) {
      return { ok: false, error: `加碼上限為 ${cap}` };
    }

    const updated = await tx.membership.update({
      where: { id: membership.id },
      data: {
        chipsAtTable: { increment: amount },
        totalBuyIn: { increment: amount },
      },
    });
    return { ok: true, amount, chipsAtTable: updated.chipsAtTable };
  });
}

// Temporarily stands the player up — frees their seat for someone else but
// keeps the Membership row (chipsAtTable/totalBuyIn intact) so sitting back
// down later in the same room session resumes their same stack instead of a
// fresh buy-in. The row only actually disappears when the room itself
// settles/closes (owner-close / session-expire), which still refunds
// nothing per the play-money model — this just stops "stand up, sit back
// down" from silently wiping out someone's stack.
// Idempotent: safe to call twice concurrently.
export async function unseatUser(
  userId: string,
  roomId: string,
): Promise<{ empty: boolean }> {
  return prisma.$transaction(async (tx) => {
    await tx.membership.updateMany({
      where: { userId, roomId },
      data: { seat: null },
    });
    const remaining = await tx.membership.count({
      where: { roomId, seat: { not: null } },
    });
    return { empty: remaining === 0 };
  });
}

// Used for the "everyone stood up / room went empty" auto-close path.
// "Empty" means no one is currently SEATED, but standing players keep
// their Membership row (see unseatUser) — clean those up too since a
// closed room can never be rejoined (seatUser rejects closed rooms), so
// there's no reason to keep their preserved chip counts around.
export async function closeRoom(roomId: string): Promise<void> {
  await prisma.$transaction([
    prisma.membership.deleteMany({ where: { roomId } }),
    prisma.room.update({ where: { id: roomId }, data: { status: 'closed' } }),
  ]);
}

// Cheap lookup used to gate rebuy/standup/rooms behavior by room type
// without fetching the full room detail.
export async function getRoomType(roomId: string): Promise<RoomType | null> {
  const room = await prisma.room.findUnique({
    where: { id: roomId },
    select: { roomType: true },
  });
  return (room?.roomType as RoomType) ?? null;
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
