// pokersolver is CommonJS; Node ESM doesn't surface its `Hand` as a named export.
// Import the whole module then destructure.
import pokersolver from 'pokersolver';
const { Hand: PokerHand } = pokersolver;
import type {
  Card,
  HandEndResult,
  HandHistoryEntry,
  HandLogData,
  HandPlayerPublic,
  HandStatePrivate,
  HandStatePublic,
  PlayerAction,
} from '@holdem/shared';
import { newShuffledDeck } from './deck.js';

// ============================================================
// Types
// ============================================================

interface Player {
  seat: number;
  userId: string;
  name: string;
  chips: number;              // Remaining stack (mutates)
  startingChips: number;      // Snapshot at hand start (immutable) — for HandLog
  bet: number;                // Committed this betting round
  totalBet: number;           // Committed this whole hand
  status: 'active' | 'folded' | 'all-in';
  holeCards: [Card, Card];
}

interface HandState {
  handNumber: number;         // Server-assigned sequential number within room
  phase: 'preflop' | 'flop' | 'turn' | 'river' | 'showdown' | 'ended';
  deck: Card[];
  community: Card[];
  players: Player[];          // Sorted by seat ASC — index used everywhere
  dealerIdx: number;
  smallBlind: number;
  bigBlind: number;
  minRaise: number;           // Simplified per user's choice = bigBlind
  currentBet: number;         // Highest bet this round
  pot: number;
  currentPlayerIdx: number | null;
  // Idxs of active players who still owe a decision this round. Empty = round closes.
  // Reset on new street. On raise, all other active players are re-added.
  toAct: Set<number>;
  actionTimeoutSeconds: number;
  deadline: number | null; // Epoch ms; null when no current turn (ended / all-in)
  endResult: HandEndResult | null;
  startedAt: number;       // Epoch ms — hand start time for HandLog
  history: HandHistoryEntry[]; // Accumulated log for persistence
}

// Recompute deadline based on current turn. Call after every mutation that
// might change currentPlayerIdx.
function refreshDeadline(hand: HandState): void {
  hand.deadline =
    hand.currentPlayerIdx !== null && hand.phase !== 'ended'
      ? Date.now() + hand.actionTimeoutSeconds * 1000
      : null;
}

// ============================================================
// Module state
// ============================================================

const hands = new Map<string, HandState>();
// Preserved across hands so dealer button rotates. Wiped by clearRoomState.
const lastDealerByRoom = new Map<string, number>();

// ============================================================
// Public accessors
// ============================================================

export function getHand(roomId: string): HandState | undefined {
  return hands.get(roomId);
}

// True while a hand is present AND not yet ended (owner can't game:start).
// game:end clears entirely; naturally ended hands stay in memory as 'ended'
// until owner starts next one OR game:end is called.
export function hasActiveHand(roomId: string): boolean {
  const h = hands.get(roomId);
  return !!h && h.phase !== 'ended';
}

// Isolated in its own function so TS re-checks the full `phase` union instead
// of the narrowed-to-exclude-'ended' type callers get after their own earlier
// `phase !== 'ended'` guard — advanceAfterAction can still set it to 'ended'.
function isEnded(hand: HandState): boolean {
  return hand.phase === 'ended';
}

export function endHand(roomId: string): void {
  hands.delete(roomId);
}

export function clearRoomState(roomId: string): void {
  hands.delete(roomId);
  lastDealerByRoom.delete(roomId);
}

// ============================================================
// Dealer rotation
// ============================================================

function pickNextDealerSeat(
  prev: number | undefined,
  seatsSortedAsc: number[],
): number {
  if (seatsSortedAsc.length === 0) throw new Error('no seats');
  if (prev === undefined) return seatsSortedAsc[0];
  for (const s of seatsSortedAsc) if (s > prev) return s;
  return seatsSortedAsc[0];
}

// ============================================================
// Start a hand
// ============================================================

export interface StartHandInput {
  seat: number;
  userId: string;
  name: string;
  chipsAtTable: number;
}

export function startHand(
  roomId: string,
  seatedPlayers: StartHandInput[],
  smallBlind: number,
  bigBlind: number,
  actionTimeoutSeconds: number,
  handNumber: number,
): HandState {
  if (seatedPlayers.length < 2) {
    throw new Error('startHand: need at least 2 seated players');
  }

  const sorted = [...seatedPlayers].sort((a, b) => a.seat - b.seat);
  const seatsSorted = sorted.map((p) => p.seat);
  const dealerSeat = pickNextDealerSeat(lastDealerByRoom.get(roomId), seatsSorted);
  lastDealerByRoom.set(roomId, dealerSeat);
  const dealerIdx = sorted.findIndex((p) => p.seat === dealerSeat);

  // Round-robin deal starting from player after dealer (standard).
  const deck = newShuffledDeck();
  const hole: Card[][] = sorted.map(() => []);
  for (let round = 0; round < 2; round++) {
    for (let i = 0; i < sorted.length; i++) {
      const idx = (dealerIdx + 1 + i) % sorted.length;
      const c = deck.pop();
      if (!c) throw new Error('startHand: deck underflow');
      hole[idx].push(c);
    }
  }

  const players: Player[] = sorted.map((p, i) => ({
    seat: p.seat,
    userId: p.userId,
    name: p.name,
    chips: p.chipsAtTable,
    startingChips: p.chipsAtTable,
    bet: 0,
    totalBet: 0,
    status: 'active',
    holeCards: [hole[i][0], hole[i][1]],
  }));

  const hand: HandState = {
    handNumber,
    phase: 'preflop',
    deck,
    community: [],
    players,
    dealerIdx,
    smallBlind,
    bigBlind,
    minRaise: bigBlind,
    currentBet: 0,
    pot: 0,
    currentPlayerIdx: null,
    toAct: new Set(),
    actionTimeoutSeconds,
    deadline: null,
    endResult: null,
    startedAt: Date.now(),
    history: [],
  };

  // Post blinds. Heads-up: dealer is SB. 3+: SB = player left of dealer.
  const isHeadsUp = players.length === 2;
  const sbIdx = isHeadsUp ? dealerIdx : nextOccupiedIdx(hand, dealerIdx);
  const bbIdx = nextOccupiedIdx(hand, sbIdx);
  postBlind(hand, sbIdx, smallBlind);
  postBlind(hand, bbIdx, bigBlind);
  hand.currentBet = players[bbIdx].bet; // usually bigBlind; less if short-stack

  // All active players owe an action this round.
  for (let i = 0; i < players.length; i++) {
    if (players[i].status === 'active') hand.toAct.add(i);
  }

  // First-to-act preflop:
  //   Heads-up: dealer (SB) acts first
  //   3+: player left of BB (UTG)
  hand.currentPlayerIdx = isHeadsUp
    ? dealerIdx
    : nextActiveIdx(hand, bbIdx);

  // If everyone is somehow already all-in from blinds (very short stacks),
  // skip straight to run-out.
  maybeAdvanceIfNoAction(hand);

  refreshDeadline(hand);
  hands.set(roomId, hand);
  return hand;
}

// ============================================================
// Player action
// ============================================================

export type AppliedActionLog = {
  seat: number;
  userId: string;
  name: string;
  phase: 'preflop' | 'flop' | 'turn' | 'river';
  actionType: 'fold' | 'check' | 'call' | 'raise' | 'all-in';
  amount?: number; // Chips added to pot by this action
};

export type ApplyActionOutcome =
  | { ok: true; ended: boolean; log: AppliedActionLog }
  | { ok: false; error: string };

// Applies an action from the player whose turn it currently is.
// Returns whether the hand transitioned to phase='ended'.
export function applyAction(
  roomId: string,
  userId: string,
  action: PlayerAction,
): ApplyActionOutcome {
  const hand = hands.get(roomId);
  if (!hand) return { ok: false, error: '沒有進行中的牌局' };
  if (hand.phase === 'ended') return { ok: false, error: '牌局已結束' };
  if (hand.currentPlayerIdx === null) {
    return { ok: false, error: '目前無人可行動' };
  }
  const cur = hand.players[hand.currentPlayerIdx];
  if (cur.userId !== userId) {
    return { ok: false, error: '還沒輪到你' };
  }
  if (cur.status !== 'active') {
    return { ok: false, error: '你已無法行動' };
  }

  // Snapshot BEFORE any state change — used to build the action log entry.
  const logSeat = cur.seat;
  const logName = cur.name;
  const logPhase = hand.phase as AppliedActionLog['phase'];
  const betBefore = cur.bet;

  switch (action.type) {
    case 'fold':
      cur.status = 'folded';
      break;
    case 'check':
      if (cur.bet < hand.currentBet) {
        return { ok: false, error: '無法過牌,還有下注要跟' };
      }
      break;
    case 'call': {
      const toCall = Math.min(hand.currentBet - cur.bet, cur.chips);
      if (toCall <= 0) return { ok: false, error: '無需跟注' };
      commitBet(cur, hand, toCall);
      break;
    }
    case 'raise': {
      const totalTarget = Math.floor(action.amount);
      if (!Number.isFinite(totalTarget)) {
        return { ok: false, error: '加注金額無效' };
      }
      const additional = totalTarget - cur.bet;
      if (additional <= 0) return { ok: false, error: '加注金額太小' };
      if (additional > cur.chips) return { ok: false, error: '籌碼不足' };
      // Min raise = currentBet + minRaise increment.
      // Exception: all-in for less is legal but doesn't reopen action.
      const isAllIn = additional === cur.chips;
      const minTotalRaise = hand.currentBet + hand.minRaise;
      if (!isAllIn && totalTarget < minTotalRaise) {
        return { ok: false, error: `最少加到 ${minTotalRaise}` };
      }
      commitBet(cur, hand, additional);
      if (totalTarget > hand.currentBet) {
        const isFullRaise = additional >= hand.minRaise;
        hand.currentBet = totalTarget;
        if (isFullRaise) reopenActionExcept(hand, hand.currentPlayerIdx!);
      }
      break;
    }
    case 'all-in': {
      const additional = cur.chips;
      if (additional <= 0) return { ok: false, error: '無籌碼可下' };
      commitBet(cur, hand, additional);
      if (cur.bet > hand.currentBet) {
        const isFullRaise = cur.bet - hand.currentBet >= hand.minRaise;
        hand.currentBet = cur.bet;
        if (isFullRaise) reopenActionExcept(hand, hand.currentPlayerIdx!);
      }
      break;
    }
  }

  // Build log entry BEFORE advancing (which might change hand.phase).
  const amountAdded = cur.bet - betBefore; // chips actually put in this action
  const log: AppliedActionLog = {
    seat: logSeat,
    userId,
    name: logName,
    phase: logPhase,
    actionType: action.type,
    amount: amountAdded > 0 ? amountAdded : undefined,
  };
  // Persist into the hand's own history (for HandLog snapshot at end).
  hand.history.push({
    kind: 'action',
    entry: {
      roomId,
      seat: logSeat,
      name: logName,
      phase: logPhase,
      actionType: action.type,
      amount: amountAdded > 0 ? amountAdded : undefined,
      ts: Date.now(),
    },
  });

  // Current player is done for this round (unless a raise reopened them,
  // which the branch above handles by NOT re-adding themselves).
  hand.toAct.delete(hand.currentPlayerIdx);

  advanceAfterAction(hand);
  refreshDeadline(hand);
  return { ok: true, ended: isEnded(hand), log };
}

// After a full raise, every OTHER active player must decide again.
function reopenActionExcept(hand: HandState, raiserIdx: number): void {
  for (let i = 0; i < hand.players.length; i++) {
    if (i === raiserIdx) continue;
    if (hand.players[i].status === 'active') hand.toAct.add(i);
  }
}

function commitBet(player: Player, hand: HandState, amount: number): void {
  const paid = Math.min(amount, player.chips);
  player.chips -= paid;
  player.bet += paid;
  player.totalBet += paid;
  hand.pot += paid;
  if (player.chips === 0) player.status = 'all-in';
}

function postBlind(hand: HandState, idx: number, amount: number): void {
  commitBet(hand.players[idx], hand, amount);
}

// ============================================================
// Round / phase advancement
// ============================================================

function advanceAfterAction(hand: HandState): void {
  // 1. Fold-out check: only 1 non-folded → wins immediately.
  const remaining = hand.players.filter((p) => p.status !== 'folded');
  if (remaining.length === 1) {
    endWithFoldout(hand, remaining[0]);
    return;
  }

  // 2. Round closed when nobody is still owing an action.
  if (hand.toAct.size === 0) {
    advancePhase(hand);
    return;
  }

  // 3. Move to next player who still owes action.
  const nextIdx = nextIdxInToAct(hand, hand.currentPlayerIdx!);
  hand.currentPlayerIdx = nextIdx;
}

// Next idx (clockwise, wrapping) that's in toAct. Returns null if empty.
function nextIdxInToAct(hand: HandState, fromIdx: number): number | null {
  const n = hand.players.length;
  for (let step = 1; step <= n; step++) {
    const idx = (fromIdx + step) % n;
    if (hand.toAct.has(idx)) return idx;
  }
  return null;
}

function advancePhase(hand: HandState): void {
  // Reset per-round bets, keep currentBet=0 for next round.
  for (const p of hand.players) p.bet = 0;
  hand.currentBet = 0;
  hand.minRaise = hand.bigBlind;
  hand.toAct.clear();

  const nextPhase = ({
    preflop: 'flop',
    flop: 'turn',
    turn: 'river',
    river: 'showdown',
    showdown: 'ended',
    ended: 'ended',
  } as const)[hand.phase];
  hand.phase = nextPhase;

  if (nextPhase === 'flop') dealCommunity(hand, 3);
  else if (nextPhase === 'turn') dealCommunity(hand, 1);
  else if (nextPhase === 'river') dealCommunity(hand, 1);

  if (
    nextPhase === 'flop' ||
    nextPhase === 'turn' ||
    nextPhase === 'river'
  ) {
    hand.history.push({
      kind: 'street',
      phase: nextPhase,
      cards: hand.community.slice(),
    });
  }

  if (nextPhase === 'showdown') {
    endWithShowdown(hand);
    return;
  }

  // Every active player owes an action this new round.
  for (let i = 0; i < hand.players.length; i++) {
    if (hand.players[i].status === 'active') hand.toAct.add(i);
  }
  // First to act post-flop: first active seat left of dealer.
  hand.currentPlayerIdx = nextActiveIdx(hand, hand.dealerIdx);

  // If everyone remaining is all-in → run out board + showdown.
  maybeAdvanceIfNoAction(hand);
}

// Fast-forward through remaining streets when no player can act (everyone all-in
// or only 1 non-folded — but that's caught earlier).
function maybeAdvanceIfNoAction(hand: HandState): void {
  while (
    hand.phase !== 'ended' &&
    hand.phase !== 'showdown' &&
    hand.players.filter((p) => p.status === 'active').length <= 1
  ) {
    const active = hand.players.filter((p) => p.status === 'active');
    // If 1 active player still, they auto-check to end of hand (no raise possible
    // when everyone else is all-in, since betting can't reopen).
    // Just advance phase without further actions.
    for (const p of hand.players) p.bet = 0;
    hand.currentBet = 0;
    const nextPhase = ({
      preflop: 'flop',
      flop: 'turn',
      turn: 'river',
      river: 'showdown',
      showdown: 'ended',
      ended: 'ended',
    } as const)[hand.phase];
    hand.phase = nextPhase;

    if (nextPhase === 'flop') dealCommunity(hand, 3);
    else if (nextPhase === 'turn') dealCommunity(hand, 1);
    else if (nextPhase === 'river') dealCommunity(hand, 1);
    if (
      nextPhase === 'flop' ||
      nextPhase === 'turn' ||
      nextPhase === 'river'
    ) {
      hand.history.push({
        kind: 'street',
        phase: nextPhase,
        cards: hand.community.slice(),
      });
    }
    if (nextPhase === 'showdown') {
      endWithShowdown(hand);
      return;
    }
    // Loop again in case we're still in "no action possible" state.
    // (active length still <=1 across streets → keep advancing)
    if (active.length === 1) {
      // The lone active can technically bet, but with no callers there's no
      // point. Just fast-forward — this matches standard "run it out" behavior.
      continue;
    }
  }
  // Otherwise leave currentPlayerIdx as set by caller.
}

function dealCommunity(hand: HandState, count: number): void {
  for (let i = 0; i < count; i++) {
    const c = hand.deck.pop();
    if (!c) throw new Error('dealCommunity: deck underflow');
    hand.community.push(c);
  }
}

// ============================================================
// Hand endings
// ============================================================

function endWithFoldout(hand: HandState, winner: Player): void {
  winner.chips += hand.pot;
  hand.endResult = {
    reason: 'fold-out',
    winners: [
      { userId: winner.userId, name: winner.name, amount: hand.pot },
    ],
    revealedHoles: [],
  };
  hand.pot = 0;
  hand.currentPlayerIdx = null;
  hand.phase = 'ended';
}

function endWithShowdown(hand: HandState): void {
  const contenders = hand.players.filter((p) => p.status !== 'folded');
  const boardStrs = hand.community.map(cardToStr);

  const solved = contenders.map((p) => {
    const cards = [...p.holeCards.map(cardToStr), ...boardStrs];
    return { player: p, hand: PokerHand.solve(cards) };
  });
  const winners = PokerHand.winners(solved.map((s) => s.hand));
  const winnerPlayers = solved
    .filter((s) => winners.includes(s.hand))
    .map((s) => s.player);

  // Simplified pot split: divide pot equally among winners. Side pots (2.2c)
  // will make this correct for all-in scenarios.
  const share = Math.floor(hand.pot / winnerPlayers.length);
  const remainder = hand.pot - share * winnerPlayers.length;

  const winnerResults: HandEndResult['winners'] = winnerPlayers.map(
    (p, i) => {
      const amount = share + (i === 0 ? remainder : 0);
      p.chips += amount;
      const solvedForP = solved.find((s) => s.player === p)!;
      return {
        userId: p.userId,
        name: p.name,
        amount,
        // Short name (e.g. "Two Pair") — client translates to Chinese.
        handRank: solvedForP.hand.name,
      };
    },
  );

  hand.endResult = {
    reason: 'showdown',
    winners: winnerResults,
    revealedHoles: contenders.map((p) => {
      const solvedForP = solved.find((s) => s.player === p)!;
      return {
        userId: p.userId,
        holeCards: p.holeCards,
        handRank: solvedForP.hand.name,
      };
    }),
  };
  hand.pot = 0;
  hand.currentPlayerIdx = null;
  hand.phase = 'ended';
}

// ============================================================
// Player iteration
// ============================================================

// Next occupied index (any status) after `fromIdx`, wrapping.
function nextOccupiedIdx(hand: HandState, fromIdx: number): number {
  return (fromIdx + 1) % hand.players.length;
}

// Next player still able to act (status === 'active') after `fromIdx`,
// wrapping. Returns `fromIdx` itself if nobody else qualifies.
function nextActiveIdx(hand: HandState, fromIdx: number): number {
  const n = hand.players.length;
  for (let step = 1; step <= n; step++) {
    const idx = (fromIdx + step) % n;
    if (hand.players[idx].status === 'active') return idx;
  }
  return fromIdx;
}

// ============================================================
// Serialization
// ============================================================

function toPublicPlayer(p: Player): HandPlayerPublic {
  return {
    seat: p.seat,
    userId: p.userId,
    name: p.name,
    chips: p.chips,
    bet: p.bet,
    totalBet: p.totalBet,
    status: p.status,
  };
}

export function toPublicState(hand: HandState): HandStatePublic {
  return {
    handNumber: hand.handNumber,
    phase: hand.phase,
    community: hand.community,
    pot: hand.pot,
    currentBet: hand.currentBet,
    minRaise: hand.minRaise,
    dealerSeat: hand.players[hand.dealerIdx].seat,
    currentPlayerSeat:
      hand.currentPlayerIdx !== null
        ? hand.players[hand.currentPlayerIdx].seat
        : null,
    actionTimeoutSeconds: hand.actionTimeoutSeconds,
    deadline: hand.deadline,
    players: hand.players.map(toPublicPlayer),
  };
}

export function getPrivateFor(
  hand: HandState,
  userId: string,
): HandStatePrivate | null {
  const p = hand.players.find((pl) => pl.userId === userId);
  if (!p) return null;
  return {
    holeCards: p.holeCards,
    handRank: evalHandRank(p.holeCards, hand.community),
  };
}

// Compute pokersolver `name` for hole + community. Preflop (0 community cards)
// falls back to a 2-card check because pokersolver requires ≥5 cards.
function evalHandRank(hole: [Card, Card], community: Card[]): string {
  if (community.length === 0) {
    return hole[0].rank === hole[1].rank ? 'Pair' : 'High Card';
  }
  const cards = [...hole.map(cardToStr), ...community.map(cardToStr)];
  return PokerHand.solve(cards).name;
}

// Access the end-of-hand result (winners + reveals) if the hand ended.
export function getEndResult(hand: HandState): HandEndResult | null {
  return hand.endResult;
}

// Serialise an ended hand into the JSON blob persisted in HandLog.data.
// Must be called after phase === 'ended' — throws otherwise.
export function buildHandLogData(hand: HandState): HandLogData {
  if (hand.phase !== 'ended' || !hand.endResult) {
    throw new Error('buildHandLogData: hand not ended');
  }
  return {
    startedAt: hand.startedAt,
    endedAt: Date.now(),
    dealerSeat: hand.players[hand.dealerIdx].seat,
    smallBlind: hand.smallBlind,
    bigBlind: hand.bigBlind,
    actionTimeoutSeconds: hand.actionTimeoutSeconds,
    players: hand.players.map((p) => ({
      seat: p.seat,
      userId: p.userId,
      name: p.name,
      startingChips: p.startingChips,
      finalChips: p.chips,
    })),
    history: hand.history,
    endResult: hand.endResult,
  };
}

// Voluntary reveal after a hand ends. Any player who was in the hand
// (folded, all-in, or still active) can choose to show their cards, unless
// they've already been revealed (either by showdown or a prior reveal).
// Idempotent — returns false if not eligible / already revealed.
export function applyReveal(roomId: string, requesterId: string): boolean {
  const hand = hands.get(roomId);
  if (!hand || hand.phase !== 'ended' || !hand.endResult) return false;
  const player = hand.players.find((p) => p.userId === requesterId);
  if (!player) return false;
  if (hand.endResult.revealedHoles.some((r) => r.userId === requesterId)) {
    return false;
  }
  hand.endResult.revealedHoles.push({
    userId: requesterId,
    holeCards: player.holeCards,
    handRank: evalHandRank(player.holeCards, hand.community),
  });
  return true;
}

// Read final chips-per-player so caller can persist to Membership.chipsAtTable.
export function chipsSnapshot(
  hand: HandState,
): Array<{ userId: string; chips: number }> {
  return hand.players.map((p) => ({ userId: p.userId, chips: p.chips }));
}

// ============================================================
// Helpers
// ============================================================

function cardToStr(c: Card): string {
  // pokersolver expects rank + lowercase suit, e.g. "As", "Td", "9h", "2c"
  return `${c.rank}${c.suit.toLowerCase()}`;
}
