// Pure helpers used across the room page's extracted components (R-3a).
// Zero React dependencies — safe to import from both server-rendered and
// client-only files.
import type { ActionLogEntry, Card, HandEndResult, HandStatePublic } from '@holdem/shared';

// Display-only estimate of the server's rebuy cap (see rebuyChips in
// server/src/rooms.ts for the authoritative rule): rounds down to the
// nearest 500 once the chip leader's stack exceeds the room's buyIn.
// 1999 -> 1500, 601 -> 500. Mid-hand this can be stale (seats reflect
// pre-hand chip counts), so it's shown as an estimate — the server
// re-validates the actual chosen amount at rebuy time.
export function roundDownTo500(n: number): number {
  return Math.max(0, Math.floor(n / 500) * 500);
}

const HAND_RANK_ZH: Record<string, string> = {
  'Royal Flush': '皇家同花順',
  'Straight Flush': '同花順',
  'Four of a Kind': '四條',
  'Full House': '葫蘆',
  Flush: '同花',
  Straight: '順子',
  'Three of a Kind': '三條',
  'Two Pair': '兩對',
  Pair: '一對',
  'High Card': '高牌',
};
export function chineseHandRank(name: string): string {
  return HAND_RANK_ZH[name] ?? name;
}

const ACTION_ZH: Record<ActionLogEntry['actionType'], string> = {
  fold: '蓋牌',
  check: '過牌',
  call: '跟注',
  raise: '加注',
  'all-in': 'All-in',
};
export function actionZh(t: ActionLogEntry['actionType']): string {
  return ACTION_ZH[t];
}

const PHASE_SHORT: Record<ActionLogEntry['phase'], string> = {
  preflop: '底牌前',
  flop: '翻牌',
  turn: '轉牌',
  river: '河牌',
};
export function phaseShort(p: ActionLogEntry['phase']): string {
  return PHASE_SHORT[p];
}

export function phaseLabel(phase: HandStatePublic['phase']): string {
  switch (phase) {
    case 'preflop':
      return '底牌前(Preflop)';
    case 'flop':
      return '翻牌(Flop)';
    case 'turn':
      return '轉牌(Turn)';
    case 'river':
      return '河牌(River)';
    case 'showdown':
      return '攤牌(Showdown)';
    case 'ended':
      return '已結束';
  }
}

// Standard poker position labels indexed from BTN clockwise. Heads-up (2)
// uses combined BTN/SB per Hold'em rules.
const POSITION_LABELS: Record<number, string[]> = {
  2: ['BTN/SB', 'BB'],
  3: ['BTN', 'SB', 'BB'],
  4: ['BTN', 'SB', 'BB', 'UTG'],
  5: ['BTN', 'SB', 'BB', 'UTG', 'CO'],
  6: ['BTN', 'SB', 'BB', 'UTG', 'HJ', 'CO'],
  7: ['BTN', 'SB', 'BB', 'UTG', 'MP', 'HJ', 'CO'],
  8: ['BTN', 'SB', 'BB', 'UTG', 'UTG+1', 'MP', 'HJ', 'CO'],
  9: ['BTN', 'SB', 'BB', 'UTG', 'UTG+1', 'MP', 'LJ', 'HJ', 'CO'],
  10: ['BTN', 'SB', 'BB', 'UTG', 'UTG+1', 'UTG+2', 'MP', 'LJ', 'HJ', 'CO'],
};

// Percentages relative to the ring container. Container scales with viewport,
// so seat positions scale with it. Seat 1 anchored at 6 o'clock (bottom, home)
// then clockwise.
export function computeRingPositionsPercent(
  count: number,
): Array<{ seat: number; xPct: number; yPct: number }> {
  const rxPct = 42;
  const ryPct = 40;
  const result: Array<{ seat: number; xPct: number; yPct: number }> = [];
  for (let i = 1; i <= count; i++) {
    const angle = Math.PI / 2 + (2 * Math.PI * (i - 1)) / count;
    result.push({
      seat: i,
      xPct: 50 + rxPct * Math.cos(angle),
      yPct: 50 + ryPct * Math.sin(angle),
    });
  }
  return result;
}

export function getPositionLabel(
  seat: number,
  dealerSeat: number,
  sortedSeatedSeats: number[],
): string | null {
  const labels = POSITION_LABELS[sortedSeatedSeats.length];
  if (!labels) return null;
  const dealerIdx = sortedSeatedSeats.indexOf(dealerSeat);
  const playerIdx = sortedSeatedSeats.indexOf(seat);
  // Dealer seat empty (mid-hand standup) → no reliable labels.
  if (dealerIdx < 0 || playerIdx < 0) return null;
  const offset =
    (playerIdx - dealerIdx + sortedSeatedSeats.length) %
    sortedSeatedSeats.length;
  return labels[offset] ?? null;
}

// Tiny deterministic hash for sticker vertical placement — same id always
// maps to the same top%, so re-renders don't jitter an in-flight sticker.
export function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i += 1) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

// Shared HistoryItem shape used by both HistoryList and the current-hand
// history preview inside RoomPage (where the live-hand log is composed).
export type HistoryItem =
  | { kind: 'action'; entry: ActionLogEntry }
  | {
      kind: 'street';
      phase: 'flop' | 'turn' | 'river';
      cards: Card[];
      trailingUserId?: string;
    };

export type HandRecord = {
  handNumber: number;
  startedAt: number;
  history: HistoryItem[];
  endResult: HandEndResult | null; // null = still in progress
};
