'use client';
import { useContext } from 'react';
import type { Card } from '@holdem/shared';
import { FourColorContext } from '../_lib/FourColorContext';

const SUIT_SYMBOL: Record<Card['suit'], string> = {
  S: '♠',
  H: '♥',
  D: '♦',
  C: '♣',
};

// Suit → tailwind text-color class. Traditional 2-color: hearts+diamonds
// red, spades+clubs near-black. 4-color: spades=black, hearts=red,
// diamonds=blue, clubs=green — easier at a glance in low-light or for
// color-blind players (common accessibility option in poker clients).
export function suitColorClass(suit: Card['suit'], fourColor: boolean): string {
  if (!fourColor) {
    return suit === 'H' || suit === 'D' ? 'text-red-600' : 'text-slate-900';
  }
  switch (suit) {
    case 'S':
      return 'text-slate-900';
    case 'H':
      return 'text-red-600';
    case 'D':
      return 'text-blue-600';
    case 'C':
      return 'text-emerald-600';
  }
}

// Big card for felt / hole display. U-2 C3 + U-4 flip-in: paper gradient +
// inset highlight + drop shadow + hairline ring + mount-time rotateY/scale
// animation (300ms, prefers-reduced-motion short-circuits via globals.css).
export function CardView({
  card,
  size = 'md',
}: {
  card: Card;
  size?: 'sm' | 'md';
}) {
  const fourColor = useContext(FourColorContext);
  const sz =
    size === 'sm'
      ? 'h-9 w-7 text-xs sm:h-10 sm:w-8 sm:text-sm'
      : 'h-14 w-10 text-lg';
  return (
    <span
      style={{ animation: 'card-flip 300ms ease-out' }}
      className={`inline-flex items-center justify-center rounded-md border border-slate-300 bg-gradient-to-b from-white to-slate-200 font-bold shadow-[0_1px_2px_rgba(0,0,0,0.5),inset_0_1px_0_rgba(255,255,255,0.9)] ring-1 ring-black/10 ${sz} ${suitColorClass(
        card.suit,
        fourColor,
      )}`}
    >
      {card.rank}
      {SUIT_SYMBOL[card.suit]}
    </span>
  );
}

// Tiny inline card for history log — smaller than the seat CardView.
export function InlineCard({ card }: { card: Card }) {
  const fourColor = useContext(FourColorContext);
  return (
    <span
      className={`inline-block rounded border border-slate-300 bg-gradient-to-b from-white to-slate-200 px-1 text-[10px] font-bold leading-tight shadow-[0_1px_1px_rgba(0,0,0,0.3)] ring-1 ring-black/10 ${suitColorClass(
        card.suit,
        fourColor,
      )}`}
    >
      {card.rank}
      {SUIT_SYMBOL[card.suit]}
    </span>
  );
}
