'use client';

import { useEffect, useRef, useState } from 'react';
import { signOut, useSession } from 'next-auth/react';
import { useRouter } from 'next/navigation';
import type { RoomSummary } from '@holdem/shared';
import { connectSocket, type TypedSocket } from '@/lib/socket';

export default function LobbyPage() {
  const { data: session, status } = useSession();
  const router = useRouter();
  const [rooms, setRooms] = useState<RoomSummary[]>([]);
  const [connected, setConnected] = useState(false);
  const [creating, setCreating] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [showNickname, setShowNickname] = useState(false);
  const socketRef = useRef<TypedSocket | null>(null);

  useEffect(() => {
    if (status !== 'authenticated') return;
    let cancelled = false;

    (async () => {
      try {
        const s = await connectSocket();
        if (cancelled) {
          s.disconnect();
          return;
        }
        socketRef.current = s;

        s.on('connect', () => {
          setConnected(true);
          s.emit('lobby:subscribe');
        });
        s.on('disconnect', () => setConnected(false));
        s.on('connection:error', (e) => console.error('conn err', e.message));

        s.on('lobby:rooms', (list) => setRooms(list));
        s.on('lobby:room-updated', (room) => {
          setRooms((prev) => {
            const idx = prev.findIndex((r) => r.id === room.id);
            if (idx === -1) return [room, ...prev];
            const copy = [...prev];
            copy[idx] = room;
            return copy;
          });
        });
        s.on('lobby:room-removed', ({ roomId }) => {
          setRooms((prev) => prev.filter((r) => r.id !== roomId));
        });
      } catch (err) {
        console.error('connect failed', err);
      }
    })();

    return () => {
      cancelled = true;
      socketRef.current?.emit('lobby:unsubscribe');
      socketRef.current?.disconnect();
      socketRef.current = null;
    };
  }, [status]);

  if (status === 'loading') return null;
  if (status !== 'authenticated') return null;

  async function handleCreate(payload: CreateRoomPayload) {
    setCreating(true);
    try {
      const res = await fetch('/api/rooms', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        alert(`建房失敗: ${j.error ?? res.status}`);
        return;
      }
      const { id } = (await res.json()) as { id: string };
      setShowCreate(false);
      router.push(`/room/${id}`);
    } finally {
      setCreating(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-4xl flex-col gap-6 p-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">大廳</h1>
          <p className="text-sm text-slate-400">
            <button
              onClick={() => setShowNickname(true)}
              className="underline decoration-slate-600 decoration-dotted underline-offset-2 hover:text-slate-200"
              title="點擊修改暱稱"
            >
              {session?.user?.name}
            </button>
            <span
              className={`ml-3 inline-block rounded px-2 py-0.5 text-xs ${
                connected ? 'bg-emerald-700' : 'bg-red-700'
              }`}
            >
              {connected ? '已連線' : '連線中…'}
            </span>
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => setShowCreate(true)}
            className="rounded bg-emerald-600 px-3 py-1 text-sm font-semibold hover:bg-emerald-500"
          >
            + 建立房間
          </button>
          <button
            onClick={() => signOut({ callbackUrl: '/' })}
            className="rounded border border-slate-700 px-3 py-1 text-sm hover:bg-slate-800"
          >
            登出
          </button>
        </div>
      </header>

      <section className="rounded border border-slate-800">
        {rooms.length === 0 ? (
          <div className="p-8 text-center text-slate-500">
            {connected ? '目前沒有房間,點右上角建立一個' : '載入房間中…'}
          </div>
        ) : (
          <ul className="divide-y divide-slate-800">
            {rooms.map((r) => (
              <li
                key={r.id}
                className="flex items-center justify-between p-4 hover:bg-slate-900"
              >
                <div>
                  <div className="flex items-center gap-2 font-semibold">
                    {r.name}
                    {r.roomType === 'tournament' && (
                      <span className="rounded bg-amber-700 px-1.5 py-0.5 text-[10px] font-bold text-amber-100">
                        錦標賽
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-slate-500">
                    房主 {r.ownerName} · 盲注 {r.smallBlind}/{r.bigBlind} ·{' '}
                    {r.roomType === 'tournament' ? '起始籌碼' : '買入'} {r.buyIn}
                    {r.roomType === 'tournament'
                      ? r.blindLevelMinutes && ` · 每級 ${r.blindLevelMinutes} 分`
                      : r.sessionMinutes && ` · 時長 ${r.sessionMinutes} 分`}
                  </div>
                </div>
                <div className="flex items-center gap-4">
                  <span className="text-sm text-slate-400">
                    {r.currentPlayers}/{r.maxPlayers} 人
                  </span>
                  <button
                    onClick={() => router.push(`/room/${r.id}`)}
                    disabled={r.currentPlayers >= r.maxPlayers}
                    className="rounded bg-emerald-600 px-3 py-1 text-sm hover:bg-emerald-500 disabled:opacity-40"
                  >
                    加入
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {showCreate && (
        <CreateRoomModal
          disabled={creating}
          onCancel={() => setShowCreate(false)}
          onSubmit={handleCreate}
        />
      )}

      {showNickname && (
        <NicknameModal
          initial={session?.user?.name ?? ''}
          onCancel={() => setShowNickname(false)}
          onSaved={() => {
            // Full reload: forces JWT re-read (new nickname) + socket reconnect
            // with fresh token. Simpler than juggling useSession().update().
            window.location.reload();
          }}
        />
      )}
    </main>
  );
}

function NicknameModal({
  initial,
  onCancel,
  onSaved,
}: {
  initial: string;
  onCancel: () => void;
  onSaved: () => void | Promise<void>;
}) {
  const [nickname, setNickname] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = nickname.trim();
    if (!trimmed) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch('/api/user/nickname', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ nickname: trimmed }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setError(j.error ?? `修改失敗 (${res.status})`);
        return;
      }
      await onSaved();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div className="w-full max-w-md rounded-lg border border-slate-700 bg-slate-900 p-6">
        <h2 className="mb-4 text-lg font-bold">修改暱稱</h2>
        <form onSubmit={submit} className="flex flex-col gap-3 text-sm">
          <label className="flex flex-col gap-1">
            <span className="text-slate-300">新暱稱</span>
            <input
              className="rounded border border-slate-700 bg-slate-950 px-3 py-2"
              value={nickname}
              onChange={(e) => setNickname(e.target.value)}
              autoFocus
              required
            />
          </label>
          {error && (
            <p className="rounded border border-red-700 bg-red-950 p-2 text-xs text-red-200">
              {error}
            </p>
          )}
          <div className="mt-2 flex justify-end gap-2">
            <button
              type="button"
              onClick={onCancel}
              className="rounded border border-slate-700 px-4 py-2 hover:bg-slate-800"
            >
              取消
            </button>
            <button
              type="submit"
              disabled={saving || !nickname.trim() || nickname.trim() === initial}
              className="rounded bg-emerald-600 px-4 py-2 font-semibold hover:bg-emerald-500 disabled:opacity-40"
            >
              {saving ? '儲存中…' : '儲存'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

type CreateRoomPayload = {
  name: string;
  roomType: 'cash' | 'tournament';
  maxPlayers: number;
  smallBlind: number;
  bigBlind: number;
  buyIn: number;
  sessionMinutes?: number;      // cash only
  blindLevelMinutes?: number;   // tournament only
  actionTimeoutSeconds: number;
};

function CreateRoomModal({
  disabled,
  onCancel,
  onSubmit,
}: {
  disabled: boolean;
  onCancel: () => void;
  onSubmit: (p: CreateRoomPayload) => void;
}) {
  const [name, setName] = useState('');
  const [roomType, setRoomType] = useState<'cash' | 'tournament'>('cash');
  const [maxPlayers, setMaxPlayers] = useState(9);
  const [smallBlind, setSmallBlind] = useState(5);
  const [bigBlind, setBigBlind] = useState(10);
  const [buyIn, setBuyIn] = useState(1000);
  const [sessionMinutes, setSessionMinutes] = useState(30);
  const [blindLevelMinutes, setBlindLevelMinutes] = useState(15);
  const [actionTimeoutSeconds, setActionTimeoutSeconds] = useState(30);
  const isTournament = roomType === 'tournament';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div className="w-full max-w-md rounded-lg border border-slate-700 bg-slate-900 p-6">
        <h2 className="mb-4 text-lg font-bold">建立房間</h2>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!name.trim()) return;
            onSubmit({
              name: name.trim(),
              roomType,
              maxPlayers,
              smallBlind,
              bigBlind,
              buyIn,
              actionTimeoutSeconds,
              ...(isTournament ? { blindLevelMinutes } : { sessionMinutes }),
            });
          }}
          className="flex flex-col gap-3 text-sm"
        >
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setRoomType('cash')}
              className={`flex-1 rounded border px-3 py-2 font-semibold ${
                !isTournament
                  ? 'border-emerald-600 bg-emerald-950 text-emerald-200'
                  : 'border-slate-700 text-slate-400 hover:bg-slate-800'
              }`}
            >
              現金局
            </button>
            <button
              type="button"
              onClick={() => setRoomType('tournament')}
              className={`flex-1 rounded border px-3 py-2 font-semibold ${
                isTournament
                  ? 'border-amber-600 bg-amber-950 text-amber-200'
                  : 'border-slate-700 text-slate-400 hover:bg-slate-800'
              }`}
            >
              錦標賽
            </button>
          </div>
          <label className="flex flex-col gap-1">
            <span className="text-slate-300">房間名稱</span>
            <input
              className="rounded border border-slate-700 bg-slate-950 px-3 py-2"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={40}
              required
            />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <Field
              label="人數上限 (2-10)"
              value={maxPlayers}
              onChange={setMaxPlayers}
              min={2}
              max={10}
            />
            <Field
              label={isTournament ? '起始籌碼' : '買入 (>= 20 × 大盲)'}
              value={buyIn}
              onChange={setBuyIn}
              min={20}
            />
            <Field
              label={isTournament ? '小盲 (第一級)' : '小盲'}
              value={smallBlind}
              onChange={setSmallBlind}
              min={1}
            />
            <Field
              label={isTournament ? '大盲 (第一級,>= 2 × 小盲)' : '大盲 (>= 2 × 小盲)'}
              value={bigBlind}
              onChange={setBigBlind}
              min={2}
            />
          </div>
          {isTournament ? (
            <label className="flex flex-col gap-1">
              <span className="text-slate-300">
                每級盲注維持幾分鐘(按開始牌局才開始漲盲)
              </span>
              <select
                className="rounded border border-slate-700 bg-slate-950 px-3 py-2"
                value={blindLevelMinutes}
                onChange={(e) => setBlindLevelMinutes(Number(e.target.value))}
              >
                <option value={5}>5 分鐘</option>
                <option value={10}>10 分鐘</option>
                <option value={15}>15 分鐘</option>
                <option value={20}>20 分鐘</option>
              </select>
            </label>
          ) : (
            <label className="flex flex-col gap-1">
              <span className="text-slate-300">遊戲時長(按開始牌局才開始倒數)</span>
              <select
                className="rounded border border-slate-700 bg-slate-950 px-3 py-2"
                value={sessionMinutes}
                onChange={(e) => setSessionMinutes(Number(e.target.value))}
              >
                <option value={30}>30 分鐘</option>
                <option value={60}>60 分鐘</option>
                <option value={90}>90 分鐘</option>
                <option value={120}>120 分鐘</option>
              </select>
            </label>
          )}
          <label className="flex flex-col gap-1">
            <span className="text-slate-300">每人每手行動秒數(整局固定)</span>
            <select
              className="rounded border border-slate-700 bg-slate-950 px-3 py-2"
              value={actionTimeoutSeconds}
              onChange={(e) =>
                setActionTimeoutSeconds(Number(e.target.value))
              }
            >
              <option value={15}>15 秒</option>
              <option value={30}>30 秒</option>
              <option value={60}>60 秒</option>
            </select>
          </label>
          <div className="mt-2 flex justify-end gap-2">
            <button
              type="button"
              onClick={onCancel}
              className="rounded border border-slate-700 px-4 py-2 hover:bg-slate-800"
            >
              取消
            </button>
            <button
              type="submit"
              disabled={disabled || !name.trim()}
              className="rounded bg-emerald-600 px-4 py-2 font-semibold hover:bg-emerald-500 disabled:opacity-40"
            >
              建立
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  min,
  max,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min: number;
  max?: number;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-slate-300">{label}</span>
      <input
        type="number"
        className="rounded border border-slate-700 bg-slate-950 px-3 py-2"
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        min={min}
        max={max}
      />
    </label>
  );
}
