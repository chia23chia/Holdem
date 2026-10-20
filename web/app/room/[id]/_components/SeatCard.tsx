'use client';
import type { ActionLogEntry, Card } from '@holdem/shared';
import { CardView } from './CardView';
import { chineseHandRank } from '../_lib/utils';

export function SeatCard({
  seatNum,
  name,
  chips,
  bet,
  status,
  eliminated,
  positionLabel,
  isMe,
  isActive,
  isDealer,
  isRevealingRiver,
  lastActionType,
  reveal,
  revealHandRank,
  secondsLeft,
  timeBankMs,
  extended,
}: {
  seatNum: number;
  name: string;
  chips: number;
  bet?: number;
  status?: 'active' | 'folded' | 'all-in';
  eliminated?: boolean;
  positionLabel: string | null;
  isMe: boolean;
  isActive: boolean;
  isDealer: boolean;
  isRevealingRiver?: boolean;
  lastActionType?: ActionLogEntry['actionType'];
  reveal: [Card, Card] | null;
  revealHandRank: string | null;
  secondsLeft: number | null;
  // Time bank remaining for this player (ms). Undefined = no active hand,
  // don't render the TB indicator.
  timeBankMs?: number;
  // True when this player has activated their time bank on the CURRENT
  // turn — timer display switches to brass to signal it's the extended
  // portion, not the base window.
  extended?: boolean;
}) {
  const isFolded = status === 'folded';
  const isAllIn = status === 'all-in';
  const border = isRevealingRiver
    ? 'border-red-500 ring-2 ring-red-500/60 animate-pulse'
    : isActive
      ? 'border-amber-400 ring-2 ring-amber-400/50'
      : isMe
        ? 'border-emerald-500'
        : 'border-slate-700';
  const bg = eliminated
    ? 'bg-slate-950 opacity-40'
    : isFolded
      ? 'bg-slate-950 opacity-50'
      : isMe
        ? 'bg-emerald-950'
        : 'bg-slate-900';
  return (
    <div
      className={`relative w-16 rounded border p-1 shadow sm:w-24 sm:p-2 ${border} ${bg}`}
    >
      <div className="flex justify-between text-[9px] text-slate-500 sm:text-[10px]">
        <span>
          #{seatNum}
          {isDealer && <span className="ml-1 text-amber-400">D</span>}
        </span>
        {positionLabel && (
          <span className="font-bold text-amber-300">{positionLabel}</span>
        )}
      </div>
      <div className="truncate text-[11px] font-semibold sm:text-sm">
        {name}
      </div>
      <div className="font-mono text-[11px] font-bold tabular-nums text-brass sm:text-sm">
        {chips.toLocaleString()}
      </div>
      {typeof bet === 'number' && bet > 0 && (
        <div
          className={`text-[9px] font-bold sm:text-[10px] ${
            lastActionType === 'raise' || lastActionType === 'all-in'
              ? 'text-red-400'
              : 'text-emerald-300'
          }`}
        >
          bet {bet}
        </div>
      )}
      {lastActionType === 'check' && (
        <div className="text-[9px] font-bold text-slate-400 sm:text-[10px]">
          過牌
        </div>
      )}
      {eliminated && (
        <div className="text-[9px] font-bold text-slate-500 sm:text-[10px]">
          已淘汰
        </div>
      )}
      {isFolded && (
        <div className="text-[9px] text-slate-500 sm:text-[10px]">FOLD</div>
      )}
      {isAllIn && (
        <div className="text-[9px] font-bold text-red-400 sm:text-[10px]">
          ALL-IN
        </div>
      )}
      {isRevealingRiver && (
        <div className="text-[9px] font-bold text-red-400 sm:text-[10px]">
          翻牌中...
        </div>
      )}
      {reveal && (
        <div className="mt-0.5 flex gap-0.5">
          <CardView card={reveal[0]} size="sm" />
          <CardView card={reveal[1]} size="sm" />
        </div>
      )}
      {revealHandRank && (
        <div className="mt-0.5 text-[9px] font-bold text-amber-300 sm:text-[10px]">
          {chineseHandRank(revealHandRank)}
        </div>
      )}
      {typeof timeBankMs === 'number' && !eliminated && !isFolded && (
        <div
          className={`text-[9px] sm:text-[10px] ${
            timeBankMs === 0 ? 'text-slate-600' : 'text-slate-500'
          }`}
        >
          TB {Math.ceil(timeBankMs / 1000)}s
        </div>
      )}
      {typeof secondsLeft === 'number' && (
        <div
          className={`mt-0.5 text-[10px] font-bold sm:text-xs ${
            extended
              ? 'text-brass'
              : secondsLeft <= 5
                ? 'text-red-400'
                : 'text-amber-300'
          }`}
        >
          {extended ? '⚡' : '⏱'} {secondsLeft}s
        </div>
      )}
    </div>
  );
}
