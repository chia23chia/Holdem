// SNG tournament elimination + finish logic. Every entry point here no-ops
// immediately for cash-game rooms (checked first thing), so this module has
// zero effect on the cash-game path — see broadcastAfterAction / room:standup
// in index.ts for the call sites.
import { prisma, Prisma } from '@holdem/db';
import type { SettlementSummary } from '@holdem/shared';
import { displayName } from './rooms.js';

// Sets the blind-escalation clock's zero point the first time a hand is
// dealt in a tournament room. No-op for cash rooms or if already started —
// safe to call on every hand start (mirrors startSessionIfNeeded's pattern).
export async function startTournamentClockIfNeeded(roomId: string): Promise<void> {
  const room = await prisma.room.findUnique({
    where: { id: roomId },
    select: { roomType: true, tournamentClockStartedAt: true },
  });
  if (!room || room.roomType !== 'tournament' || room.tournamentClockStartedAt) return;
  await prisma.room.update({
    where: { id: roomId },
    data: { tournamentClockStartedAt: new Date() },
  });
}

interface MembershipRow {
  id: string;
  userId: string;
  finishRank: number | null;
  chipsAtTable: number;
  totalBuyIn: number;
  user: { name: string | null; nickname: string | null };
}

// If exactly one funded, unranked player remains, crowns them champion
// (finishRank=1), builds the settlement from every membership's finishRank,
// then deletes all memberships and closes the room — mirrors
// systemCloseRoomWithSettlement's build-then-teardown shape in rooms.ts.
// Returns null if the tournament isn't over yet.
async function maybeFinishTournament(
  tx: Prisma.TransactionClient,
  roomId: string,
  memberships: MembershipRow[],
): Promise<SettlementSummary | null> {
  const stillRunning = memberships.filter(
    (m) => m.finishRank === null && m.chipsAtTable > 0,
  );
  if (stillRunning.length !== 1) return null;
  const champ = stillRunning[0];

  const room = await tx.room.findUnique({
    where: { id: roomId },
    select: { id: true, name: true },
  });
  if (!room) return null;

  const players = memberships.map((m) => ({
    userId: m.userId,
    name: displayName(m.user),
    chipsAtTable: m.chipsAtTable,
    totalBuyIn: m.totalBuyIn,
    finishRank: m.id === champ.id ? 1 : m.finishRank!,
  }));

  await tx.membership.deleteMany({ where: { roomId } });
  await tx.room.update({ where: { id: roomId }, data: { status: 'closed' } });

  return { roomId: room.id, roomName: room.name, reason: 'tournament-finished', players };
}

export type TournamentHandEndOutcome =
  | { finished: false }
  | { finished: true; settlement: SettlementSummary };

// Called once per ended hand, after chip results are persisted — no-op for
// cash rooms. Assigns finishRank to anyone who just busted (chipsAtTable<=0,
// not yet ranked); rank = however many tournament participants were still
// unranked going into this hand (so 6 starters, down to 4 unranked, one
// busts -> they finish 4th). Simultaneous multi-bust in the same hand ties
// at the same rank — no same-hand stack-based tiebreak (documented v1
// simplification).
export async function processTournamentHandEnd(
  roomId: string,
): Promise<TournamentHandEndOutcome> {
  const meta = await prisma.room.findUnique({
    where: { id: roomId },
    select: { roomType: true },
  });
  if (!meta || meta.roomType !== 'tournament') return { finished: false };

  return prisma.$transaction(async (tx) => {
    const memberships = await tx.membership.findMany({
      where: { roomId },
      include: { user: { select: { name: true, nickname: true } } },
    });
    const stillRanked = memberships.filter((m) => m.finishRank === null);
    const activeCountBefore = stillRanked.length;
    const newlyBusted = stillRanked.filter((m) => m.chipsAtTable <= 0);

    if (newlyBusted.length > 0) {
      await tx.membership.updateMany({
        where: { id: { in: newlyBusted.map((m) => m.id) } },
        data: { finishRank: activeCountBefore },
      });
      for (const m of newlyBusted) m.finishRank = activeCountBefore;
    }

    const settlement = await maybeFinishTournament(tx, roomId, memberships);
    return settlement ? { finished: true, settlement } : { finished: false };
  });
}

export type StandupEliminationOutcome =
  | { removed: false }
  | { removed: true; finished: false }
  | { removed: true; finished: true; settlement: SettlementSummary };

// Voluntary room:standup in a tournament = elimination at the player's
// current position, not a silent delete. Chips are zeroed (removed from
// play, same as busting) so the existing chipsAtTable>0 filter that
// startHandForRoom uses to decide who's dealt in keeps excluding them with
// no extra finishRank checks needed anywhere else. Membership row is kept
// (not deleted) so the eventual settlement can still read their finishRank.
export async function eliminateStandingPlayer(
  userId: string,
  roomId: string,
): Promise<StandupEliminationOutcome> {
  return prisma.$transaction(async (tx) => {
    const memberships = await tx.membership.findMany({
      where: { roomId },
      include: { user: { select: { name: true, nickname: true } } },
    });
    const mine = memberships.find((m) => m.userId === userId);
    if (!mine) return { removed: false };

    if (mine.finishRank === null) {
      const activeCountBefore = memberships.filter((m) => m.finishRank === null).length;
      await tx.membership.update({
        where: { id: mine.id },
        data: { finishRank: activeCountBefore, chipsAtTable: 0 },
      });
      mine.finishRank = activeCountBefore;
      mine.chipsAtTable = 0;
    }

    const settlement = await maybeFinishTournament(tx, roomId, memberships);
    return settlement
      ? { removed: true, finished: true, settlement }
      : { removed: true, finished: false };
  });
}
