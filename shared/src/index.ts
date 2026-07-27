// ============================================================
// Card / Deck domain types
// ============================================================
export type Suit = 'S' | 'H' | 'D' | 'C';
export type Rank =
  | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9'
  | 'T' | 'J' | 'Q' | 'K' | 'A';

export interface Card {
  suit: Suit;
  rank: Rank;
}

// ============================================================
// Game state (Phase 2 onward)
// ============================================================
export type GamePhase =
  | 'waiting' | 'preflop' | 'flop' | 'turn' | 'river' | 'showdown';

// Per-player state DURING a hand. Chips/bet fluctuate as bets accumulate;
// this is authoritative for stack sizes while a hand is active. Between hands
// use `RoomDetail.seats[].chipsAtTable` instead.
export interface HandPlayerPublic {
  seat: number;
  userId: string;
  name: string;
  chips: number;    // Remaining stack (not counting `bet` already in this round)
  bet: number;      // Chips committed THIS betting round
  totalBet: number; // Chips committed THIS entire hand (all rounds)
  status: 'active' | 'folded' | 'all-in';
}

// Public state visible to every subscriber of the room.
export interface HandStatePublic {
  handNumber: number;       // Server-assigned sequential number within room
  phase: 'preflop' | 'flop' | 'turn' | 'river' | 'showdown' | 'ended';
  community: Card[];        // 0/3/4/5 revealed community cards
  pot: number;              // Total pot including this-round bets
  currentBet: number;       // Highest bet to call this round
  minRaise: number;         // Minimum raise INCREMENT (simplified = big blind)
  dealerSeat: number;
  currentPlayerSeat: number | null; // Whose turn; null when hand ended / everyone all-in
  actionTimeoutSeconds: number;
  deadline: number | null;  // Epoch ms when current player's action expires; null when no turn
  players: HandPlayerPublic[];      // Ordered by seat ascending
}

// Per-player chip snapshot for one hand — everyone's stack at that point, for
// history/review. Shared shape between the live game:ended broadcast and the
// persisted HandLogData so both surface the same data without re-deriving it.
export interface HandPlayerChipSnapshot {
  seat: number;
  userId: string;
  name: string;
  startingChips: number; // Stack at the start of this hand
  finalChips: number;    // Stack after this hand's result was applied
}

// Broadcast in `game:ended.result` when a hand concludes.
export interface HandEndResult {
  reason: 'fold-out' | 'showdown';
  winners: Array<{
    userId: string;
    name: string;
    amount: number;    // Chips won from pot (summed across all side pots)
    handRank?: string; // pokersolver short name (e.g. "Two Pair") — showdown only
  }>;
  // Hole cards to reveal to all subscribers at showdown.
  // Empty on fold-out (per poker etiquette the winner doesn't have to show).
  revealedHoles: Array<{
    userId: string;
    holeCards: [Card, Card];
    handRank: string; // pokersolver short name (translated client-side to Chinese)
  }>;
  players: HandPlayerChipSnapshot[]; // Everyone's stack once this hand settled
}

// Client → server player action.
export type PlayerAction =
  | { type: 'fold' }
  | { type: 'check' }
  | { type: 'call' }
  | { type: 'raise'; amount: number } // amount = TOTAL bet this round (not delta)
  | { type: 'all-in' };

// Emitted alongside `room:closed` for auto/manual room teardown so clients
// can show a settlement screen. Milestone 2.1: chipsAtTable == buyIn (no
// betting yet), settlement is mostly informational.
export interface SettlementSummary {
  roomId: string;
  roomName: string;
  reason: 'session-expired' | 'owner-closed' | 'tournament-finished';
  players: Array<{
    userId: string;
    name: string;
    chipsAtTable: number; // Final stack when session ended
    totalBuyIn: number;   // Initial buyIn + all rebuys — for net win/loss display
    // Present only when reason === 'tournament-finished'. 1 = champion,
    // higher = eliminated earlier; ties (simultaneous bust-out) share a rank.
    finishRank?: number;
  }>;
}

// Private state pushed to a specific seated player only. `handRank` is the
// current best hand (pokersolver `name`, translated client-side) computed
// from hole + community cards; preflop uses a simple 2-card check (Pair /
// High Card).
export interface HandStatePrivate {
  holeCards: [Card, Card];
  handRank: string;
}

// Entry appended to the current hand's action log. Server emits one per
// `game:action` handled. Client resets its list on `game:started`.
export interface ActionLogEntry {
  roomId: string;
  seat: number;
  name: string;
  phase: 'preflop' | 'flop' | 'turn' | 'river';
  actionType: 'fold' | 'check' | 'call' | 'raise' | 'all-in';
  amount?: number; // Chips put in this action (call/raise/all-in). Omitted for fold/check.
  ts: number;
}

// One entry in a hand's persisted history log. Discriminated union between
// player actions and community-card reveals per street.
export type HandHistoryEntry =
  | { kind: 'action'; entry: ActionLogEntry }
  | { kind: 'street'; phase: 'flop' | 'turn' | 'river'; cards: Card[] };

// Full snapshot of a completed hand — stored in HandLog.data (jsonb).
// Used to reconstruct historic hands on client mount / refresh.
export interface HandLogData {
  startedAt: number;                     // Epoch ms
  endedAt: number;
  dealerSeat: number;
  smallBlind: number;
  bigBlind: number;
  actionTimeoutSeconds: number;
  players: HandPlayerChipSnapshot[];
  history: HandHistoryEntry[];
  endResult: HandEndResult;
}

export type GameActionResult =
  | { ok: true }
  | { ok: false; error: string };

// ============================================================
// Room / Membership (Phase 1)
// Mirrors DB shape but plain-JSON for wire transmission.
// ============================================================
export type RoomStatus = 'waiting' | 'playing' | 'closed';
export type RoomType = 'cash' | 'tournament';

export interface RoomSummary {
  id: string;
  name: string;
  ownerName: string;
  roomType: RoomType;
  maxPlayers: number;
  currentPlayers: number;
  smallBlind: number;
  bigBlind: number;
  buyIn: number;
  status: RoomStatus;
  sessionMinutes: number | null; // null = unlimited (cash only)
  sessionEndsAt: string | null;  // ISO date; null = unlimited (cash only)
  actionTimeoutSeconds: number;  // Per-hand player action time, fixed at create
  // Tournament (SNG) fields — null for cash rooms.
  blindLevelMinutes: number | null;
  tournamentClockStartedAt: string | null; // ISO date; set once, first hand dealt
}

export interface RoomSeat {
  seat: number;
  userId: string;
  name: string;
  image: string | null;
  chipsAtTable: number;
  finishRank: number | null; // tournament only: 1 = champion, higher = out earlier
}

// Live win/loss row — used by the 戰績 panel to show every member's current
// standing. Includes 暫離 members (seat === null) so their net doesn't vanish
// from the leaderboard when they step away.
export interface RoomStanding {
  userId: string;
  name: string;
  seat: number | null;         // null = 暫離
  chipsAtTable: number;
  totalBuyIn: number;
  finishRank: number | null;   // tournament: 1 = champion; higher = eliminated
}

export interface RoomDetail extends RoomSummary {
  ownerId: string;
  seats: RoomSeat[];
  // All members (seated + 暫離), sorted by net win/loss DESC. Server-computed
  // so every client shows the same order.
  standings: RoomStanding[];
}

// ============================================================
// Tournament (SNG) blind schedule — PURE functions, no I/O. Server calls
// these fresh every hand (never caches a "current level"); client ticks
// them locally off its own `now` state, exactly like the cash-game session
// countdown, so no extra socket event is needed just for the ticking.
// ============================================================

// Rounds to the nearest 5, floor of 5 (blinds should never round to 0).
function roundToNearest5(n: number): number {
  return Math.max(5, Math.round(n / 5) * 5);
}

// Level 1 = the room's configured base blinds, verbatim. Each later level's
// big blind is 1.5x the previous, rounded to the nearest 5, with a floor of
// +5 over the previous level so escalation never stalls at low stakes.
export function blindsForLevel(
  baseSmallBlind: number,
  baseBigBlind: number,
  level: number,
): { smallBlind: number; bigBlind: number } {
  if (level <= 1) return { smallBlind: baseSmallBlind, bigBlind: baseBigBlind };
  let bb = baseBigBlind;
  for (let l = 2; l <= level; l += 1) {
    bb = Math.max(bb + 5, roundToNearest5(bb * 1.5));
  }
  const sb = Math.min(roundToNearest5(bb / 2), bb - 5);
  return { smallBlind: Math.max(5, sb), bigBlind: bb };
}

// Current level number from wall-clock elapsed time since the tournament
// clock started. Returns 1 if the clock hasn't started yet.
export function currentBlindLevel(
  tournamentClockStartedAt: string | null,
  blindLevelMinutes: number,
): number {
  if (!tournamentClockStartedAt) return 1;
  const elapsedMs = Date.now() - new Date(tournamentClockStartedAt).getTime();
  if (elapsedMs <= 0) return 1;
  return Math.floor(elapsedMs / (blindLevelMinutes * 60_000)) + 1;
}

// Epoch ms when the current level ends (i.e. the next level begins). Null
// if the clock hasn't started yet.
export function nextBlindLevelAt(
  tournamentClockStartedAt: string | null,
  blindLevelMinutes: number,
): number | null {
  if (!tournamentClockStartedAt) return null;
  const level = currentBlindLevel(tournamentClockStartedAt, blindLevelMinutes);
  return (
    new Date(tournamentClockStartedAt).getTime() + level * blindLevelMinutes * 60_000
  );
}

// Live SB/BB for a room right now — cash rooms just echo their fixed
// blinds; tournament rooms compute from the blind clock. Single entry
// point shared by the server (authoritative, used when dealing a hand) and
// the client (display-only).
export function effectiveBlinds(room: {
  roomType: RoomType;
  smallBlind: number;
  bigBlind: number;
  blindLevelMinutes: number | null;
  tournamentClockStartedAt: string | null;
}): { smallBlind: number; bigBlind: number; level: number } {
  if (room.roomType !== 'tournament') {
    return { smallBlind: room.smallBlind, bigBlind: room.bigBlind, level: 1 };
  }
  const level = currentBlindLevel(
    room.tournamentClockStartedAt,
    room.blindLevelMinutes ?? 15,
  );
  return { ...blindsForLevel(room.smallBlind, room.bigBlind, level), level };
}

export interface ChatMessage {
  from: string;   // user display name
  userId: string;
  text: string;
  ts: number;
}

// Emoji reactions ("stickers") a player can fling across the room. Whitelist
// is shared so the picker options and the server-side validator stay in
// lockstep — sending anything not in this list is dropped.
export const STICKER_EMOJIS = [
  '👍',
  '😂',
  '🎉',
  '🙈',
  '💩',
  '🔥',
  '❤️',
  '😱',
] as const;
export type StickerEmoji = (typeof STICKER_EMOJIS)[number];

// Broadcast to every room subscriber when a player sends a reaction.
export interface StickerEvent {
  id: string;      // server-generated, unique per event — used as React key
  userId: string;  // sender's userId
  name: string;    // sender's display name (for accessibility labels)
  emoji: StickerEmoji;
  ts: number;      // server epoch ms
}

// ============================================================
// Socket.IO event contracts
// ============================================================
export interface ServerToClientEvents {
  'connection:ok': (data: { userId: string; name: string }) => void;
  'connection:error': (data: { message: string }) => void;

  // Lobby-wide
  'lobby:rooms': (rooms: RoomSummary[]) => void;
  'lobby:room-updated': (room: RoomSummary) => void;
  'lobby:room-removed': (data: { roomId: string }) => void;

  // Room-scoped
  'room:detail': (room: RoomDetail) => void;
  'room:error': (data: { message: string }) => void;
  'room:closed': (data: { roomId: string; settlement?: SettlementSummary }) => void;
  'chat:message': (msg: ChatMessage) => void;
  'sticker:show': (evt: StickerEvent) => void;

  // Game (Phase 2)
  'game:started': (state: HandStatePublic) => void;
  'game:state': (state: HandStatePublic) => void; // Broadcast after each action / phase change
  'game:hole': (data: HandStatePrivate) => void;   // Re-emitted per seated player after phase advances (handRank updates)
  'game:action-log': (entry: ActionLogEntry) => void; // One per player action
  'game:ended': (data: { roomId: string; result?: HandEndResult }) => void;
}

export interface ClientToServerEvents {
  'lobby:subscribe': () => void;
  'lobby:unsubscribe': () => void;

  'room:join': (data: { roomId: string; seat?: number }, cb: (res: JoinRoomResult) => void) => void;
  'room:leave': (data: { roomId: string }) => void;
  'room:subscribe': (data: { roomId: string }) => void;
  'room:standup': (data: { roomId: string }) => void;
  'room:close': (data: { roomId: string }, cb: (res: CloseRoomResult) => void) => void;
  // Rebuy — caller picks amount (must be a multiple of 500, capped by the
  // chip leader; see rebuyChips). Mid-hand → queued, applied when hand ends.
  'room:rebuy': (data: { roomId: string; amount: number }, cb: (res: GameActionResult) => void) => void;

  'chat:send': (data: { roomId: string | null; text: string }) => void;
  // Emoji reaction — server rate-limits (see STICKER_EMOJIS whitelist).
  'sticker:send': (data: { roomId: string; emoji: StickerEmoji }) => void;

  // Game (Phase 2 — owner-only)
  // actionTimeoutSeconds now lives on Room, no per-call param.
  'game:start': (
    data: { roomId: string },
    cb: (res: GameActionResult) => void,
  ) => void;
  'game:end': (data: { roomId: string }, cb: (res: GameActionResult) => void) => void;
  'game:action': (
    data: { roomId: string; action: PlayerAction },
    cb: (res: GameActionResult) => void,
  ) => void;
  // Fold-out winner can voluntarily reveal their hole cards to the room.
  'game:show-cards': (data: { roomId: string }) => void;
}

export type JoinRoomResult =
  | { ok: true }
  | { ok: false; error: string };

export type CloseRoomResult =
  | { ok: true }
  | { ok: false; error: string };

export interface SocketAuthPayload {
  token: string; // JWT signed by web at /api/socket-token, verified by server
}

// JWT payload (both web and server share this shape)
export interface SocketTokenPayload {
  sub: string;  // userId
  name: string;
  iat: number;
  exp: number;
}
