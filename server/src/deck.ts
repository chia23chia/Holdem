import { randomInt } from 'node:crypto';
import type { Card, Rank, Suit } from '@holdem/shared';

const SUITS: Suit[] = ['S', 'H', 'D', 'C'];
const RANKS: Rank[] = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];

export function newDeck(): Card[] {
  const deck: Card[] = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) deck.push({ suit, rank });
  }
  return deck;
}

// Fisher-Yates in-place shuffle using crypto.randomInt (unbiased, unlike
// randomBytes % n). Returns a new array; input is not mutated.
export function shuffle(deck: Card[]): Card[] {
  const arr = [...deck];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = randomInt(0, i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

export function newShuffledDeck(): Card[] {
  return shuffle(newDeck());
}
