'use client';
import { useState } from 'react';
import { useEscape } from '@/lib/useEscape';
import { roundDownTo500 } from '../_lib/utils';

// Lets the player pick how much to rebuy (must be a multiple of 500, capped
// by the chip leader — see rebuyChips in server/src/rooms.ts). `capEstimate`
// is a client-side guess (server re-validates the real cap on submit).
export function RebuyModal({
  capEstimate,
  midHand,
  onCancel,
  onConfirm,
}: {
  capEstimate: number;
  midHand: boolean;
  onCancel: () => void;
  onConfirm: (amount: number) => void;
}) {
  const cap = Math.max(500, capEstimate);
  const [amount, setAmount] = useState(cap);
  useEscape(onCancel);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!Number.isFinite(amount) || amount <= 0 || amount % 500 !== 0) return;
    onConfirm(amount);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <form
        onSubmit={handleSubmit}
        role="dialog"
        aria-modal="true"
        aria-labelledby="rebuy-modal-title"
        className="w-full max-w-sm rounded-lg border border-slate-700 bg-slate-900 p-6"
      >
        <h2 id="rebuy-modal-title" className="mb-3 text-lg font-bold">加碼金額</h2>
        <div className="mb-3 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => setAmount(500)}
            className="rounded border border-slate-600 px-3 py-1.5 text-xs hover:bg-slate-800"
          >
            500
          </button>
          <button
            type="button"
            onClick={() => setAmount(Math.max(500, roundDownTo500(cap / 2)))}
            className="rounded border border-slate-600 px-3 py-1.5 text-xs hover:bg-slate-800"
          >
            半({Math.max(500, roundDownTo500(cap / 2))})
          </button>
          <button
            type="button"
            onClick={() => setAmount(cap)}
            className="rounded border border-emerald-700 px-3 py-1.5 text-xs text-emerald-300 hover:bg-emerald-950"
          >
            上限({cap})
          </button>
        </div>
        <input
          type="number"
          inputMode="numeric"
          pattern="[0-9]*"
          autoFocus
          step={500}
          min={500}
          max={cap}
          className="mb-1 w-full rounded border border-slate-700 bg-slate-950 px-3 py-2 text-lg"
          value={amount}
          onChange={(e) => setAmount(Number(e.target.value))}
        />
        <div className="mb-4 text-[10px] text-slate-500">
          必須是 500 的倍數,不超過目前檯面籌碼上限(≈{cap},實際以系統回應為準)
          {midHand && (
            <span className="mt-1 block text-amber-300">
              牌局進行中,將在下一手開始前才加到桌上。
            </span>
          )}
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
            className="rounded bg-emerald-600 px-4 py-2 font-semibold hover:bg-emerald-500"
          >
            確定加碼
          </button>
        </div>
      </form>
    </div>
  );
}
