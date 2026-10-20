// Unit tests for the pure-function heart of the hand engine (O4 in
// docs/AUDIT_2026-10-20.md).
//
// Scope: side-pot math and blind escalation — the two places where a silent
// regression would quietly make a player feel cheated. endWithShowdown
// integration coverage is deferred (needs real card fixtures + pokersolver).
import { describe, expect, it } from 'vitest';
import { blindsForLevel } from '@holdem/shared';
import { buildSidePots, type Player } from './hands.js';
import type { Card } from '@holdem/shared';

// Minimal player builder — only the fields buildSidePots actually reads.
// All other fields are placeholders; chips/hole cards are irrelevant here.
const DUMMY_CARD: Card = { rank: '2', suit: 'S' };
function p(
  userId: string,
  totalBet: number,
  status: Player['status'] = 'active',
  seat = 0,
): Player {
  return {
    seat,
    userId,
    name: userId,
    chips: 0,
    startingChips: 0,
    bet: 0,
    totalBet,
    status,
    holeCards: [DUMMY_CARD, DUMMY_CARD],
  };
}

describe('buildSidePots', () => {
  it('returns no layers when no one contributed', () => {
    const layers = buildSidePots([p('a', 0), p('b', 0)]);
    expect(layers).toEqual([]);
  });

  it('single layer when all contributors matched to showdown', () => {
    const layers = buildSidePots([p('a', 100), p('b', 100)]);
    expect(layers).toHaveLength(1);
    expect(layers[0].amount).toBe(200);
    expect(layers[0].eligible.map((e) => e.userId)).toEqual(['a', 'b']);
  });

  it('folded contributor pays into the pot but is not eligible to win', () => {
    const layers = buildSidePots([
      p('a', 50, 'active'),
      p('b', 50, 'folded'),
      p('c', 50, 'active'),
    ]);
    expect(layers).toHaveLength(1);
    expect(layers[0].amount).toBe(150);
    expect(layers[0].eligible.map((e) => e.userId)).toEqual(['a', 'c']);
  });

  it('splits into two layers for a short-stack all-in with deeper callers', () => {
    const layers = buildSidePots([
      p('short', 50, 'all-in'),
      p('deep1', 150),
      p('deep2', 150),
    ]);
    expect(layers).toHaveLength(2);
    // Layer 1 (first 50 from each of 3 players): short can still win this.
    expect(layers[0].amount).toBe(150);
    expect(layers[0].eligible.map((e) => e.userId).sort()).toEqual(
      ['deep1', 'deep2', 'short'],
    );
    // Layer 2 (100 extra from the two deep stacks): short is NOT eligible.
    expect(layers[1].amount).toBe(200);
    expect(layers[1].eligible.map((e) => e.userId).sort()).toEqual([
      'deep1',
      'deep2',
    ]);
  });

  it('nested all-ins create three stacked layers', () => {
    const layers = buildSidePots([
      p('p1', 50, 'all-in'),
      p('p2', 100, 'all-in'),
      p('p3', 200),
    ]);
    expect(layers.map((l) => l.amount)).toEqual([150, 100, 100]);
    expect(layers[0].eligible.map((e) => e.userId).sort()).toEqual([
      'p1',
      'p2',
      'p3',
    ]);
    expect(layers[1].eligible.map((e) => e.userId).sort()).toEqual(['p2', 'p3']);
    expect(layers[2].eligible.map((e) => e.userId)).toEqual(['p3']);
    // Pot zero-sum: layers sum to total contributions.
    const totalPot = layers.reduce((s, l) => s + l.amount, 0);
    expect(totalPot).toBe(50 + 100 + 200);
  });

  it('fold-to-blinds hand: SB and UTG fold preflop, only BB eligible', () => {
    const layers = buildSidePots([
      p('sb', 5, 'folded'),
      p('bb', 10, 'active'),
      p('utg', 0, 'folded'),
    ]);
    expect(layers.map((l) => l.amount)).toEqual([10, 5]);
    expect(layers.every((l) => l.eligible.every((e) => e.userId === 'bb'))).toBe(
      true,
    );
    // Total pot still 15 — folded contributors still paid in.
    expect(layers.reduce((s, l) => s + l.amount, 0)).toBe(15);
  });
});

describe('blindsForLevel', () => {
  it('level <= 1 echoes the base blinds verbatim', () => {
    expect(blindsForLevel(5, 10, 1)).toEqual({ smallBlind: 5, bigBlind: 10 });
    expect(blindsForLevel(5, 10, 0)).toEqual({ smallBlind: 5, bigBlind: 10 });
    expect(blindsForLevel(25, 50, 1)).toEqual({ smallBlind: 25, bigBlind: 50 });
  });

  it('level 2 applies the 1.5x BB formula rounded to 5 (floored by +5)', () => {
    // base BB=10 → next = max(10+5, round5(15)=15) = 15
    expect(blindsForLevel(5, 10, 2)).toEqual({ smallBlind: 10, bigBlind: 15 });
  });

  it('later levels escalate monotonically with at least +5 per level', () => {
    let prevBB = 10;
    for (let lvl = 2; lvl <= 15; lvl += 1) {
      const { bigBlind, smallBlind } = blindsForLevel(5, 10, lvl);
      expect(bigBlind).toBeGreaterThanOrEqual(prevBB + 5);
      expect(bigBlind % 5).toBe(0);
      expect(smallBlind % 5).toBe(0);
      expect(smallBlind).toBeGreaterThanOrEqual(5);
      expect(smallBlind).toBeLessThan(bigBlind);
      prevBB = bigBlind;
    }
  });

  it('small blind never drops below 5 even for small base blinds', () => {
    // Even if base inputs would mathematically give SB < 5, output clamps.
    const { smallBlind } = blindsForLevel(5, 10, 10);
    expect(smallBlind).toBeGreaterThanOrEqual(5);
  });
});
