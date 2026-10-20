'use client';
import { useEffect, useState } from 'react';
import type { PlayerAction } from '@holdem/shared';
import { useEscape } from '@/lib/useEscape';

// Small keyboard-shortcut badge; desktop-only so phones aren't littered
// with hints they can't press. `dark` variant for use on amber buttons.
function KbdHint({ k, dark = false }: { k: string; dark?: boolean }) {
  return (
    <span
      className={`ml-2 hidden rounded border px-1 text-[10px] sm:inline-block ${
        dark
          ? 'border-slate-700 text-slate-700'
          : 'border-slate-500 text-slate-400'
      }`}
    >
      {k}
    </span>
  );
}

// Raise amount is chosen in its own confirm step (preset fraction, All-in,
// or a typed number) so a misclick can't fire off an all-in immediately —
// the player always has to review the amount and press 送出.
function RaiseModal({
  minTotalRaise,
  maxTotal,
  currentBet,
  pot,
  myChips,
  onCancel,
  onConfirm,
}: {
  minTotalRaise: number;
  maxTotal: number;
  currentBet: number;
  pot: number;
  myChips: number;
  onCancel: () => void;
  onConfirm: (amount: number) => void;
}) {
  const [raiseInput, setRaiseInput] = useState(
    String(Math.min(minTotalRaise, maxTotal)),
  );
  useEscape(onCancel);

  function presetFraction(fraction: number) {
    // "1/3 pot" means raise TO currentBet + pot*fraction.
    const target = Math.min(
      maxTotal,
      Math.max(minTotalRaise, currentBet + Math.floor(pot * fraction)),
    );
    setRaiseInput(String(target));
  }

  function presetAllIn() {
    setRaiseInput(String(maxTotal));
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const n = Number(raiseInput);
    if (!Number.isFinite(n)) return;
    onConfirm(Math.floor(n));
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <form
        onSubmit={handleSubmit}
        role="dialog"
        aria-modal="true"
        aria-labelledby="raise-modal-title"
        className="w-full max-w-sm rounded-lg border border-slate-700 bg-slate-900 p-6"
      >
        <h2 id="raise-modal-title" className="mb-3 text-lg font-bold">加註金額</h2>
        <div className="mb-3 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => presetFraction(1 / 3)}
            className="rounded border border-slate-600 px-3 py-1.5 text-xs hover:bg-slate-800"
          >
            1/3 底池
          </button>
          <button
            type="button"
            onClick={() => presetFraction(0.5)}
            className="rounded border border-slate-600 px-3 py-1.5 text-xs hover:bg-slate-800"
          >
            1/2 底池
          </button>
          <button
            type="button"
            onClick={() => presetFraction(2 / 3)}
            className="rounded border border-slate-600 px-3 py-1.5 text-xs hover:bg-slate-800"
          >
            2/3 底池
          </button>
          <button
            type="button"
            onClick={presetAllIn}
            className="rounded border border-red-700 px-3 py-1.5 text-xs text-red-300 hover:bg-red-950"
          >
            All-in
          </button>
        </div>
        <input
          type="number"
          inputMode="numeric"
          pattern="[0-9]*"
          autoFocus
          className="mb-1 w-full rounded border border-slate-700 bg-slate-950 px-3 py-2 text-lg"
          value={raiseInput}
          onChange={(e) => setRaiseInput(e.target.value)}
          min={minTotalRaise}
          max={maxTotal}
        />
        <div className="mb-4 text-[10px] text-slate-500">
          最少加到 {minTotalRaise} · 底池 {pot} · 你手上 {myChips}
        </div>
        <div className="flex justify-end gap-2 text-sm">
          <button
            type="button"
            onClick={onCancel}
            className="rounded border border-slate-700 px-4 py-2 hover:bg-slate-800"
          >
            取消
          </button>
          <button
            type="submit"
            className="rounded bg-amber-600 px-4 py-2 font-semibold text-slate-950 hover:bg-amber-500"
          >
            送出
          </button>
        </div>
      </form>
    </div>
  );
}

export function ActionBar({
  secondsLeft,
  extended,
  currentBet,
  minRaise,
  pot,
  myBet,
  myChips,
  onAction,
}: {
  secondsLeft: number | null;
  // True after the player pressed 延時 on this turn — just changes color
  // to signal the countdown is now in extended-time territory.
  extended: boolean;
  currentBet: number;
  minRaise: number;
  pot: number;
  myBet: number;
  myChips: number;
  onAction: (a: PlayerAction) => void;
}) {
  const toCall = Math.max(0, currentBet - myBet);
  const canCheck = toCall === 0;
  const minTotalRaise = currentBet + minRaise;
  const maxTotal = myBet + myChips; // = all-in
  const [showRaiseModal, setShowRaiseModal] = useState(false);

  // Desktop hotkeys (U-3 D): F = fold, C = check/call, R = open raise.
  // Only active while ActionBar is mounted (which is only when it's your
  // turn) so there's no "fired at wrong moment" concern. Ignored while
  // typing in a chat input or when the raise modal is already open.
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const el = document.activeElement as HTMLElement | null;
      if (el && ['INPUT', 'TEXTAREA'].includes(el.tagName)) return;
      if (showRaiseModal) return;
      const key = e.key.toLowerCase();
      if (key === 'f') {
        e.preventDefault();
        onAction({ type: 'fold' });
      } else if (key === 'c') {
        e.preventDefault();
        onAction(canCheck ? { type: 'check' } : { type: 'call' });
      } else if (key === 'r') {
        e.preventDefault();
        setShowRaiseModal(true);
      }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onAction, canCheck, showRaiseModal]);

  return (
    <div className="mt-4 rounded-lg border border-amber-900/30 bg-surface/60 p-3 shadow-sm">
      <div className="mb-2 flex items-center justify-between text-xs">
        <span className={extended ? 'font-bold text-brass' : 'text-brass/90'}>
          {extended ? '⚡ 時間銀行' : '輪到你行動'}
        </span>
        {typeof secondsLeft === 'number' && (
          <span
            className={`font-bold ${
              extended
                ? 'text-brass'
                : secondsLeft <= 5
                  ? 'text-red-400'
                  : 'text-amber-300'
            }`}
          >
            剩 {secondsLeft}s
          </span>
        )}
      </div>
      {/* U-4: visual weight re-balanced — Fold least prominent (ghost),
          Call/Check medium (felt green), Raise hero (brass). All three
          hit the 44pt mobile-thumb minimum via min-h-[48px]. */}
      <div className="flex flex-wrap gap-2">
        <button
          onClick={() => onAction({ type: 'fold' })}
          className="min-h-[48px] rounded border border-bone/20 bg-transparent px-4 py-2.5 text-base font-semibold text-bone/70 transition-colors duration-150 hover:bg-white/5"
        >
          棄牌
          <KbdHint k="F" />
        </button>
        {canCheck ? (
          <button
            onClick={() => onAction({ type: 'check' })}
            className="min-h-[48px] rounded bg-felt px-4 py-2.5 text-base font-semibold text-bone transition-colors duration-150 hover:bg-felt/80"
          >
            過牌
            <KbdHint k="C" />
          </button>
        ) : (
          <button
            onClick={() => onAction({ type: 'call' })}
            className="min-h-[48px] rounded bg-felt px-4 py-2.5 text-base font-semibold text-bone transition-colors duration-150 hover:bg-felt/80"
          >
            跟注 {toCall}
            <KbdHint k="C" />
          </button>
        )}
        <button
          onClick={() => setShowRaiseModal(true)}
          className="min-h-[48px] rounded bg-brass px-4 py-2.5 text-base font-bold text-rail shadow-lg transition-colors duration-150 hover:bg-brass/90"
        >
          加註
          <KbdHint k="R" dark />
        </button>
      </div>

      {showRaiseModal && (
        <RaiseModal
          minTotalRaise={minTotalRaise}
          maxTotal={maxTotal}
          currentBet={currentBet}
          pot={pot}
          myChips={myChips}
          onCancel={() => setShowRaiseModal(false)}
          onConfirm={(amount) => {
            setShowRaiseModal(false);
            onAction({ type: 'raise', amount });
          }}
        />
      )}
    </div>
  );
}
