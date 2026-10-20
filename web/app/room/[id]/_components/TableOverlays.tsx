'use client';
import type { HandPlayerPublic, HandStatePublic } from '@holdem/shared';
import { computeSidePots } from '@holdem/shared';

// R-1a: Current-turn indicator — a compact banner above the oval table so
// anyone (including spectators and the player whose turn it is NOT) can
// instantly see who the room is waiting on and how long is left. Deliberately
// separate from ActionBar (which only renders on your own turn).
export function TurnIndicator({
  gameState,
  myUserId,
  now,
}: {
  gameState: HandStatePublic | null;
  myUserId: string;
  now: number;
}) {
  // Nothing to indicate: no live hand, hand ended, or everyone's all-in
  // (currentPlayerSeat === null during the runout).
  if (
    !gameState ||
    gameState.phase === 'ended' ||
    gameState.currentPlayerSeat === null
  ) {
    return null;
  }
  const currentPlayer = gameState.players.find(
    (p) => p.seat === gameState.currentPlayerSeat,
  );
  if (!currentPlayer) return null;
  const isMe = currentPlayer.userId === myUserId;
  const secondsLeft = gameState.deadline
    ? Math.max(0, Math.ceil((gameState.deadline - now) / 1000))
    : null;
  const warn = secondsLeft !== null && secondsLeft <= 5;
  const toneClass = isMe
    ? 'border-brass bg-brass/10 text-brass'
    : warn
      ? 'border-loss/40 bg-loss/10 text-loss'
      : 'border-amber-900/30 bg-surface/60 text-bone/80';
  return (
    <div
      className={`mb-2 flex items-center justify-between rounded-md border px-3 py-1.5 text-sm transition-colors duration-150 sm:text-base ${toneClass}`}
      aria-live="polite"
    >
      <span className="font-semibold">
        {isMe ? '輪到你' : `輪到 ${currentPlayer.name}`}
      </span>
      {secondsLeft !== null && (
        <span className={`font-mono tabular-nums ${warn ? 'font-bold' : ''}`}>
          {secondsLeft}s
        </span>
      )}
    </div>
  );
}

// R-1b: Side-pot breakdown. The oval center always shows a single pot total
// for simplicity. When someone's all-in with a shorter stack than others,
// the pot splits into layers — only one of which the short stack can
// actually win. This panel surfaces that so no one wonders "why did Alice
// only win $200 of the $500 pot after her all-in?" post-hand.
//
// Hidden when there's ≤1 layer (the common case). Positioned under the
// oval so it never blocks the felt itself.
export function SidePotsPanel({ players }: { players: HandPlayerPublic[] }) {
  const layers = computeSidePots(players);
  if (layers.length <= 1) return null;
  return (
    <div className="mt-3 rounded-md border border-brass/30 bg-brass/5 p-2 text-xs sm:text-sm">
      <div className="mb-1 flex items-center gap-2 font-semibold text-brass">
        <span>💰 底池層次</span>
        <span className="text-[10px] font-normal text-bone/60">
          ({layers.length} 層)
        </span>
      </div>
      <ul className="flex flex-col gap-0.5 text-bone/80">
        {layers.map((layer, i) => (
          <li key={i} className="flex flex-wrap items-baseline gap-x-2">
            <span className="font-mono tabular-nums font-bold text-brass">
              {i === 0 ? '主池' : `邊池${i}`} ${layer.amount.toLocaleString()}
            </span>
            <span className="text-[11px] text-bone/60">
              可爭:
              {layer.eligibleNames.length > 0
                ? ' ' + layer.eligibleNames.join('、')
                : ' 無(全棄牌)'}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
