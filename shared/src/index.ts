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

// Broadcast in `game:ended.result` when a hand concludes.
export interface HandEndResult {
  reason: 'fold-out' | 'showdown';
  winners: Array<{
    userId: string;
    name: string;
    amount: number;    // Chips won from pot
    handRank?: string; // pokersolver short name (e.g. "Two Pair") — showdown only
  }>;
  // Hole cards to reveal to all subscribers at showdown.
  // Empty on fold-out (per poker etiquette the winner doesn't have to show).
  revealedHoles: Array<{
    userId: string;
    holeCards: [Card, Card];
    handRank: string; // pokersolver short name (translated client-side to Chinese)
  }>;
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
  reason: 'session-expired' | 'owner-closed';
  players: Array<{
    userId: string;
    name: string;
    chipsAtTable: number; // Final stack when session ended
    totalBuyIn: number;   // Initial buyIn + all rebuys — for net win/loss display
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
  players: Array<{
    seat: number;
    userId: string;
    name: string;
    startingChips: number;
    finalChips: number;
  }>;
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

export interface RoomSummary {
  id: string;
  name: string;
  ownerName: string;
  maxPlayers: number;
  currentPlayers: number;
  smallBlind: number;
  bigBlind: number;
  buyIn: number;
  status: RoomStatus;
  sessionMinutes: number | null; // null = unlimited
  sessionEndsAt: string | null;  // ISO date; null = unlimited
  actionTimeoutSeconds: number;  // Per-hand player action time, fixed at create
}

export interface RoomSeat {
  seat: number;
  userId: string;
  name: string;
  image: string | null;
  chipsAtTable: number;
}

export interface RoomDetail extends RoomSummary {
  ownerId: string;
  seats: RoomSeat[];
}

export interface ChatMessage {
  from: string;   // user display name
  userId: string;
  text: string;
  ts: number;
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
  // Rebuy — always +room.buyIn. Mid-hand → queued, applied when hand ends.
  'room:rebuy': (data: { roomId: string }, cb: (res: GameActionResult) => void) => void;

  'chat:send': (data: { roomId: string | null; text: string }) => void;

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
