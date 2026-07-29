'use client';

import { useEffect, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useSession } from 'next-auth/react';
import type {
  ActionLogEntry,
  Card,
  ChatMessage,
  HandEndResult,
  HandHistoryEntry,
  HandLogData,
  HandPlayerPublic,
  HandStatePublic,
  PlayerAction,
  RoomDetail,
  RoomStanding,
  SettlementSummary,
  StickerEmoji,
  StickerEvent,
} from '@holdem/shared';
import {
  effectiveBlinds,
  nextBlindLevelAt,
  STICKER_EMOJIS,
} from '@holdem/shared';
import { connectSocket, type TypedSocket } from '@/lib/socket';
import { isMuted, playCue, setMuted, type SoundCue } from '@/lib/sound';

// Display-only estimate of the server's rebuy cap (see rebuyChips in
// server/src/rooms.ts for the authoritative rule): rounds down to the
// nearest 500 once the chip leader's stack exceeds the room's buyIn.
// 1999 -> 1500, 601 -> 500. Mid-hand this can be stale (seats reflect
// pre-hand chip counts), so it's shown as an estimate — the server
// re-validates the actual chosen amount at rebuy time.
function roundDownTo500(n: number): number {
  return Math.max(0, Math.floor(n / 500) * 500);
}

export default function RoomPage() {
  const { data: session, status } = useSession();
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const roomId = params.id;

  const [room, setRoom] = useState<RoomDetail | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showCloseConfirm, setShowCloseConfirm] = useState(false);
  const [closing, setClosing] = useState(false);
  const [showRebuyConfirm, setShowRebuyConfirm] = useState(false);
  const [gameState, setGameState] = useState<HandStatePublic | null>(null);
  const [holeCards, setHoleCards] = useState<[Card, Card] | null>(null);
  const [handRank, setHandRank] = useState<string | null>(null);
  // Community cards actually shown on the felt — decoupled from
  // gameState.community so an all-in runout can reveal flop/turn/river one
  // street at a time instead of jumping straight to the final board. Set
  // instantly (no animation) on game:started/reconnect; staggered in by the
  // game:street-log queue below otherwise.
  const [displayedCommunity, setDisplayedCommunity] = useState<Card[]>([]);
  // Hole cards revealed early during an all-in runout (before real showdown).
  // Folded players never appear here — only players still in the hand who
  // have no more decisions left.
  const [allInReveal, setAllInReveal] = useState<Map<string, [Card, Card]>>(
    new Map(),
  );
  // userId currently shown with the river-flip highlight; auto-clears.
  const [revealingSeatUserId, setRevealingSeatUserId] = useState<
    string | null
  >(null);
  // Most recent action per seat THIS betting round — check has no bet amount
  // to display, so without this the felt shows no feedback at all when
  // someone checks. Cleared at the start of each new street/hand so a stale
  // "過牌"/"跟注" tag doesn't linger once the round moves on.
  const [lastActionBySeat, setLastActionBySeat] = useState<
    Record<number, ActionLogEntry['actionType']>
  >({});
  const [hands, setHands] = useState<HandRecord[]>([]);
  // null = follow latest hand; number = viewing a specific past hand
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null);
  const [panelTab, setPanelTab] = useState<'chat' | 'history' | 'standings'>(
    'chat',
  );
  const [chatOpen, setChatOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);
  const [settlement, setSettlement] = useState<SettlementSummary | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [autoNextIn, setAutoNextIn] = useState<number | null>(null);
  // Sticker overlay: server-broadcast reactions each auto-remove after ~3.5s
  // (animation is 3s + a tiny buffer to let the fade-out finish).
  const [stickers, setStickers] = useState<StickerEvent[]>([]);
  const [showStickerPicker, setShowStickerPicker] = useState(false);
  // Chat marquee: one message at a time scrolls across; queue drains FIFO.
  const [marqueeQueue, setMarqueeQueue] = useState<ChatMessage[]>([]);
  const [marqueeCurrent, setMarqueeCurrent] = useState<ChatMessage | null>(
    null,
  );
  // Local mute toggle (persisted to localStorage inside lib/sound). Seed from
  // storage on mount so refresh remembers the choice.
  const [muted, setMutedState] = useState(false);
  useEffect(() => {
    setMutedState(isMuted());
  }, []);
  function toggleMuted() {
    const next = !muted;
    setMuted(next);
    setMutedState(next);
  }

  // Derived at every render — safe to reference inside useEffects since it's
  // computed above them.
  const currentHand = hands.length > 0 ? hands[hands.length - 1] : null;
  const currentEndResult = currentHand?.endResult ?? null;
  const displayedHand =
    hands.length === 0
      ? null
      : selectedIdx !== null && selectedIdx >= 0 && selectedIdx < hands.length
        ? hands[selectedIdx]
        : hands[hands.length - 1];
  const displayedIdx =
    hands.length === 0
      ? -1
      : selectedIdx !== null && selectedIdx >= 0 && selectedIdx < hands.length
        ? selectedIdx
        : hands.length - 1;

  const socketRef = useRef<TypedSocket | null>(null);
  const desktopScrollRef = useRef<HTMLDivElement | null>(null);
  const mobileScrollRef = useRef<HTMLDivElement | null>(null);
  // Read latest chatOpen inside socket listener without re-registering it.
  const chatOpenRef = useRef(chatOpen);
  chatOpenRef.current = chatOpen;
  // Read latest settlement inside the auto-next-hand timer without
  // re-registering it — see the tournament-finish race note below.
  const settlementRef = useRef(settlement);
  settlementRef.current = settlement;
  // Debounces the myturn sound to only fire on the false→true transition, so
  // re-renders while it's still my turn don't spam-play the ding.
  const prevMyTurnRef = useRef(false);
  // Staggered street-reveal queue (see game:street-log handler below). Plain
  // refs, not state — the setTimeout chain reads/mutates them directly and
  // re-rendering on every queue mutation would be pointless churn.
  const streetQueueRef = useRef<
    Array<{ cards: Card[]; phase: string; trailingUserId?: string }>
  >([]);
  const streetPlayingRef = useRef(false);
  const streetTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const revealTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Pops one queued street, waits ~700ms so the previous reveal is actually
  // seen, then reveals it on the felt (+ sound, + river highlight). Keeps
  // going until the queue drains. 700ms is well under normal human action
  // pacing, so non-all-in hands don't feel artificially slowed down.
  function playNextQueuedStreet() {
    streetTimeoutRef.current = setTimeout(() => {
      const next = streetQueueRef.current.shift();
      if (!next) {
        streetPlayingRef.current = false;
        return;
      }
      // next.cards is the full cumulative board as of this street (server
      // sends hand.community.slice(), not just the newly-dealt cards) — set
      // it directly, don't append, or flop/turn/river stack on top of each
      // other into one giant duplicated row.
      setDisplayedCommunity(next.cards);
      playCue('street');
      if (next.phase === 'river' && next.trailingUserId) {
        const userId = next.trailingUserId;
        setRevealingSeatUserId(userId);
        revealTimeoutRef.current = setTimeout(() => {
          setRevealingSeatUserId((cur) => (cur === userId ? null : cur));
        }, 1800);
      }
      playNextQueuedStreet();
    }, 700);
  }

  useEffect(() => {
    if (status !== 'authenticated' || !roomId) return;
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
          s.emit('room:subscribe', { roomId });
        });
        s.on('disconnect', () => setConnected(false));
        s.on('room:detail', (detail) => setRoom(detail));
        s.on('room:error', ({ message }) => setError(message));
        s.on('room:closed', ({ settlement: s2 }) => {
          if (s2) {
            // Show settlement modal; user dismisses to lobby.
            setSettlement(s2);
          } else {
            router.replace('/lobby');
          }
        });
        s.on('chat:message', (msg) => {
          setMessages((prev) => [...prev.slice(-199), msg]);
          // Bump unread only when the mobile drawer is closed.
          // Desktop panel is always visible so we don't count there.
          if (!chatOpenRef.current) {
            setUnreadCount((n) => n + 1);
          }
          // Push to marquee queue so mobile users don't need to open chat.
          setMarqueeQueue((q) => [...q.slice(-19), msg]);
        });
        s.on('sticker:show', (evt) => {
          setStickers((prev) => [...prev, evt]);
          // Auto-remove after animation completes (3s anim + small buffer).
          window.setTimeout(() => {
            setStickers((prev) => prev.filter((x) => x.id !== evt.id));
          }, 3500);
        });
        s.on('game:started', (state) => {
          setError(null); // clear any stale "等待補值" banner now that a hand began
          setGameState(state);
          setHoleCards(null);
          setHandRank(null);
          setSelectedIdx(null); // Snap back to newest on each new hand
          // New hand: drop any leftover reveal/animation state from the
          // previous one. Community is set instantly here (not staggered) —
          // this also covers reconnect/refresh mid-hand, where the
          // game:street-log events for streets already dealt were sent to
          // OTHER clients before this socket ever connected, so there's
          // nothing to replay and showing the real current board is correct.
          if (streetTimeoutRef.current) clearTimeout(streetTimeoutRef.current);
          if (revealTimeoutRef.current) clearTimeout(revealTimeoutRef.current);
          streetQueueRef.current = [];
          streetPlayingRef.current = false;
          setDisplayedCommunity(state.community);
          setAllInReveal(new Map());
          setRevealingSeatUserId(null);
          setLastActionBySeat({});
          setHands((prev) => {
            // If already have a record for this handNumber (e.g. subscribe
            // catch-up after refresh), skip; otherwise append.
            if (prev.some((h) => h.handNumber === state.handNumber)) return prev;
            return [
              ...prev,
              {
                handNumber: state.handNumber,
                startedAt: Date.now(),
                history: [],
                endResult: null,
              },
            ];
          });
          playCue('deal');
        });
        s.on('game:state', (state) => setGameState(state));
        s.on('game:hole', ({ holeCards: cards, handRank: hr }) => {
          setHoleCards(cards);
          setHandRank(hr);
        });
        s.on('game:action-log', (entry) => {
          setHands((prev) => {
            if (prev.length === 0) return prev;
            const copy = [...prev];
            const last = copy[copy.length - 1];
            copy[copy.length - 1] = {
              ...last,
              history: [...last.history, { kind: 'action', entry }],
            };
            return copy;
          });
          // Live per-seat feedback — check has no bet amount to show, so
          // this is the only visible sign a check just happened.
          setLastActionBySeat((prev) => ({
            ...prev,
            [entry.seat]: entry.actionType,
          }));
          const cue: SoundCue | null =
            entry.actionType === 'fold'
              ? 'fold'
              : entry.actionType === 'check'
                ? 'check'
                : entry.actionType === 'call'
                  ? 'call'
                  : entry.actionType === 'raise'
                    ? 'raise'
                    : entry.actionType === 'all-in'
                      ? 'allin'
                      : null;
          if (cue) playCue(cue);
        });
        // Early hole-card reveal for everyone still in an all-in runout —
        // fires once per hand, before the delayed board catches up.
        s.on('game:allin-reveal', ({ players }) => {
          setAllInReveal(
            new Map(players.map((p) => [p.userId, p.holeCards])),
          );
        });
        // One event per community-card reveal, explicitly emitted by the
        // server (not inferred from gameState.phase) — an all-in runout can
        // fast-forward through flop+turn+river in a single broadcast, so
        // watching phase transitions alone would miss every street except
        // whichever one happened to be "current" in the final update.
        // The felt display (displayedCommunity) is staggered ~700ms/street
        // via the queue below for runout drama; the history record itself
        // still updates immediately since there's no reason to delay it.
        s.on('game:street-log', ({ phase, cards, trailingUserId }) => {
          setHands((prev) => {
            if (prev.length === 0) return prev;
            const last = prev[prev.length - 1];
            if (last.history.some((h) => h.kind === 'street' && h.phase === phase)) {
              return prev;
            }
            const copy = [...prev];
            copy[copy.length - 1] = {
              ...last,
              history: [...last.history, { kind: 'street', phase, cards, trailingUserId }],
            };
            return copy;
          });
          // New betting round — last round's check/call/raise tags are stale.
          setLastActionBySeat({});
          streetQueueRef.current.push({ cards, phase, trailingUserId });
          if (!streetPlayingRef.current) {
            streetPlayingRef.current = true;
            playNextQueuedStreet();
          }
        });
        s.on('game:ended', ({ result }) => {
          if (result) {
            // Natural end (or voluntary show re-fire) → update last hand's endResult.
            setHands((prev) => {
              if (prev.length === 0) return prev;
              const copy = [...prev];
              copy[copy.length - 1] = {
                ...copy[copy.length - 1],
                endResult: result,
              };
              return copy;
            });
            playCue('win');
          } else {
            // Manual owner debug end → clear active game display AND drop the
            // last hand record if it never finished (no natural endResult).
            setGameState(null);
            setHoleCards(null);
            setHandRank(null);
            setHands((prev) => {
              if (prev.length === 0) return prev;
              const last = prev[prev.length - 1];
              if (last.endResult) return prev; // completed → keep in history
              return prev.slice(0, -1); // drop dangling in-progress record
            });
          }
        });
      } catch (err) {
        console.error(err);
        setError('連線失敗');
      }
    })();

    return () => {
      cancelled = true;
      socketRef.current?.emit('room:leave', { roomId });
      socketRef.current?.disconnect();
      socketRef.current = null;
      if (streetTimeoutRef.current) clearTimeout(streetTimeoutRef.current);
      if (revealTimeoutRef.current) clearTimeout(revealTimeoutRef.current);
    };
  }, [status, roomId, router]);

  // Auto-scroll both chat panels (desktop always mounted, mobile only when open).
  useEffect(() => {
    desktopScrollRef.current?.scrollTo({
      top: desktopScrollRef.current.scrollHeight,
      behavior: 'smooth',
    });
    mobileScrollRef.current?.scrollTo({
      top: mobileScrollRef.current.scrollHeight,
      behavior: 'smooth',
    });
  }, [messages, chatOpen]);

  // Opening the mobile drawer clears unread count.
  useEffect(() => {
    if (chatOpen) setUnreadCount(0);
  }, [chatOpen]);

  // Fetch persisted past hands (from DB) once on room mount. Merged with any
  // live-accumulated hands so refreshing / rejoining a room keeps full history.
  useEffect(() => {
    if (!roomId || status !== 'authenticated') return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/rooms/${roomId}/hands`);
        if (!res.ok) return;
        const body = (await res.json()) as {
          hands: Array<{
            id: string;
            handNumber: number;
            startedAt: string;
            endedAt: string;
            data: HandLogData;
          }>;
        };
        if (cancelled) return;
        const past: HandRecord[] = body.hands
          .map((h) => ({
            handNumber: h.handNumber,
            startedAt: h.data.startedAt,
            history: h.data.history,
            endResult: h.data.endResult,
          }))
          .sort((a, b) => a.handNumber - b.handNumber);
        setHands((prev) => {
          const seen = new Set(prev.map((h) => h.handNumber));
          const merged = [
            ...past.filter((p) => !seen.has(p.handNumber)),
            ...prev,
          ];
          return merged.sort((a, b) => a.handNumber - b.handNumber);
        });
      } catch (err) {
        console.error('[room] fetch past hands failed', err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [roomId, status]);

  // Ticks the shared `now` state used by both session countdown and action
  // deadline. Faster interval (500ms) when an action deadline is live so the
  // seconds change smoothly; otherwise 1s for session-only.
  useEffect(() => {
    const hasSession = !!room?.sessionEndsAt;
    const hasTournamentClock =
      room?.roomType === 'tournament' && !!room.tournamentClockStartedAt;
    const hasDeadline = !!gameState?.deadline;
    if (!hasSession && !hasTournamentClock && !hasDeadline) return;
    const period = hasDeadline ? 500 : 1000;
    const id = setInterval(() => setNow(Date.now()), period);
    return () => clearInterval(id);
  }, [
    room?.sessionEndsAt,
    room?.roomType,
    room?.tournamentClockStartedAt,
    gameState?.deadline,
  ]);

  // Play a distinct "your turn" cue only when it transitions to my turn —
  // watching the derived boolean via a ref avoids replaying the sound every
  // render while it's still my turn (e.g. bet-slider re-renders).
  useEffect(() => {
    const uid = session?.user?.id;
    const isMe =
      !!gameState &&
      !!uid &&
      gameState.phase !== 'ended' &&
      gameState.players.some(
        (p) =>
          p.userId === uid &&
          p.seat === gameState.currentPlayerSeat &&
          p.status === 'active',
      );
    if (isMe && !prevMyTurnRef.current) {
      playCue('myturn');
    }
    prevMyTurnRef.current = isMe;
  }, [
    gameState?.currentPlayerSeat,
    gameState?.phase,
    gameState?.handNumber,
    session?.user?.id,
  ]);

  // After a hand ends, run an 8-second countdown visible to everyone. Only the
  // owner's client actually emits `game:start` on reaching 0; server pulls the
  // action timeout from the Room record (fixed at room-create for the whole session).
  // Key the effect on the ENDED hand's number so a subsequent voluntary
  // `game:show-cards` re-emission (which updates endResult contents but keeps
  // handNumber) does NOT reset the timer.
  const roomOwnerId = room?.ownerId;
  const currentUserId = session?.user?.id;
  const endedHandNumber = currentEndResult
    ? (currentHand?.handNumber ?? null)
    : null;
  useEffect(() => {
    if (!endedHandNumber) return;
    const iAmOwner =
      !!roomOwnerId && !!currentUserId && roomOwnerId === currentUserId;
    const startTs = Date.now();
    const AUTO_MS = 8_000;
    setAutoNextIn(Math.ceil(AUTO_MS / 1000));
    const tick = setInterval(() => {
      const remMs = Math.max(0, AUTO_MS - (Date.now() - startTs));
      setAutoNextIn(Math.ceil(remMs / 1000));
      if (remMs <= 0) {
        clearInterval(tick);
        // If a tournament just finished on this exact hand, the room is
        // already closed and `settlement` is already showing — don't also
        // fire game:start into the void (it would just broadcast a
        // confusing "房間已關閉" error right as everyone sees the champion).
        if (iAmOwner && !settlementRef.current) {
          socketRef.current?.emit('game:start', { roomId }, (res) => {
            if (!res.ok) setError(res.error);
          });
        }
      }
    }, 250);
    return () => {
      clearInterval(tick);
      setAutoNextIn(null);
    };
  }, [endedHandNumber, roomOwnerId, currentUserId, roomId]);

  function sendMessage(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = input.trim();
    if (!trimmed || !socketRef.current) return;
    socketRef.current.emit('chat:send', { roomId, text: trimmed });
    setInput('');
  }

  // Marquee: whenever nothing is currently scrolling but the queue has items,
  // pop the head and start showing it. onAnimationEnd on the marquee element
  // clears `marqueeCurrent`, which retriggers this effect for the next one.
  useEffect(() => {
    if (marqueeCurrent) return;
    if (marqueeQueue.length === 0) return;
    const [head, ...rest] = marqueeQueue;
    setMarqueeCurrent(head);
    setMarqueeQueue(rest);
  }, [marqueeCurrent, marqueeQueue]);

  function sendSticker(emoji: StickerEmoji) {
    setShowStickerPicker(false);
    if (!socketRef.current || !roomId) return;
    socketRef.current.emit('sticker:send', { roomId, emoji });
  }

  if (status !== 'authenticated') return null;

  const myUserId = session?.user?.id;
  const isOwner = !!room && !!myUserId && room.ownerId === myUserId;
  const mySeat = room?.seats.find((s) => s.userId === myUserId)?.seat ?? null;
  const iAmSeated = mySeat !== null;
  const sortedSeatedSeats = room
    ? room.seats.map((s) => s.seat).sort((a, b) => a - b)
    : [];
  const myHandPlayer =
    gameState?.players.find((p) => p.userId === myUserId) ?? null;
  const myOccupant = room?.seats.find((s) => s.userId === myUserId) ?? null;
  // Rebuy only unlocks once chips actually hit 0 — live in-hand chips take
  // priority since DB chipsAtTable doesn't sync until the hand ends.
  const myChipsNow = myHandPlayer ? myHandPlayer.chips : (myOccupant?.chipsAtTable ?? 0);
  const canRebuy = iAmSeated && myChipsNow === 0 && room?.roomType !== 'tournament';
  const liveBlinds = room ? effectiveBlinds(room) : null;
  const rebuyCapEstimate = room
    ? (() => {
        const leader = room.seats.reduce(
          (m, s) => Math.max(m, s.chipsAtTable),
          0,
        );
        return roundDownTo500(leader > room.buyIn ? leader : room.buyIn);
      })()
    : 0;
  const itsMyTurn =
    !!gameState &&
    !!myHandPlayer &&
    gameState.currentPlayerSeat === myHandPlayer.seat &&
    gameState.phase !== 'ended' &&
    myHandPlayer.status === 'active';

  function handleQuickSit() {
    setMenuOpen(false);
    if (!socketRef.current || !roomId) return;
    setError(null);
    socketRef.current.emit('room:join', { roomId }, (res) => {
      if (!res.ok) setError(res.error);
    });
  }

  function handleSitAt(seat: number) {
    if (!socketRef.current || !roomId) return;
    setError(null);
    socketRef.current.emit('room:join', { roomId, seat }, (res) => {
      if (!res.ok) setError(res.error);
    });
  }

  function handleStandup() {
    setMenuOpen(false);
    if (!socketRef.current || !roomId) return;
    setError(null);
    socketRef.current.emit('room:standup', { roomId });
  }

  function handleStartGame() {
    setMenuOpen(false);
    if (!socketRef.current || !roomId) return;
    setError(null);
    socketRef.current.emit('game:start', { roomId }, (res) => {
      if (!res.ok) setError(res.error);
    });
  }

  function handleRebuy() {
    setMenuOpen(false);
    setShowRebuyConfirm(true);
  }

  function handleRebuyConfirm(amount: number) {
    if (!socketRef.current || !roomId) return;
    setError(null);
    setShowRebuyConfirm(false);
    socketRef.current.emit('room:rebuy', { roomId, amount }, (res) => {
      if (!res.ok) setError(res.error);
    });
  }

  function handleAction(action: PlayerAction) {
    if (!socketRef.current || !roomId) return;
    setError(null);
    socketRef.current.emit('game:action', { roomId, action }, (res) => {
      if (!res.ok) setError(res.error);
    });
  }

  function handleClose() {
    if (!socketRef.current || !roomId) return;
    setClosing(true);
    setError(null);
    socketRef.current.emit('room:close', { roomId }, (res) => {
      setClosing(false);
      if (!res.ok) {
        setError(res.error);
        setShowCloseConfirm(false);
        return;
      }
    });
  }

  const canStartGame =
    isOwner && !gameState && !!room && room.currentPlayers >= 2;

  return (
    <main className="mx-auto flex min-h-screen max-w-5xl flex-col gap-4 p-4 sm:gap-6 sm:p-6">
      <header className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-xl font-bold sm:text-2xl">
            {room?.name ?? '房間'}
          </h1>
          <p className="mt-0.5 text-xs text-slate-400 sm:text-sm">
            {room && liveBlinds && (
              <>
                盲注 {liveBlinds.smallBlind}/{liveBlinds.bigBlind}
                {room.roomType === 'tournament' && ` (第${liveBlinds.level}級)`}
                {' · '}
                {room.roomType === 'tournament' ? '起始籌碼' : '買入'} {room.buyIn} ·{' '}
                {room.currentPlayers}/{room.maxPlayers} 人
              </>
            )}
            <span
              className={`ml-2 inline-block rounded px-1.5 py-0.5 text-[10px] sm:text-xs ${
                connected ? 'bg-emerald-700' : 'bg-red-700'
              }`}
            >
              {connected ? '已連線' : '連線中…'}
            </span>
            <button
              type="button"
              onClick={toggleMuted}
              className="ml-2 inline-block rounded border border-slate-700 px-1.5 py-0.5 text-[10px] hover:bg-slate-800 sm:text-xs"
              title={muted ? '目前靜音,點擊開啟音效' : '目前有音效,點擊靜音'}
              aria-label={muted ? '開啟音效' : '靜音'}
            >
              {muted ? '🔇' : '🔊'}
            </button>
            {room?.roomType === 'tournament' ? (
              <BlindLevelInfo room={room} now={now} />
            ) : room?.sessionEndsAt ? (
              <SessionCountdown endsAt={room.sessionEndsAt} now={now} />
            ) : (
              room?.sessionMinutes && (
                <span
                  className="ml-2 inline-block rounded bg-slate-700 px-1.5 py-0.5 text-[10px] font-mono text-slate-400 sm:text-xs"
                  title="按下開始牌局才會開始倒數"
                >
                  ⏱ {room.sessionMinutes}m 未開始
                </span>
              )
            )}
          </p>
        </div>

        {/* Desktop button row */}
        <div className="hidden shrink-0 gap-2 sm:flex">
          {room && !iAmSeated && (
            <button
              onClick={handleQuickSit}
              disabled={!connected || room.currentPlayers >= room.maxPlayers}
              className="rounded bg-emerald-600 px-3 py-1 text-sm font-semibold hover:bg-emerald-500 disabled:opacity-40"
            >
              快速就座
            </button>
          )}
          {iAmSeated && (
            <button
              onClick={handleStandup}
              className="rounded border border-slate-600 px-3 py-1 text-sm hover:bg-slate-800"
            >
              站起
            </button>
          )}
          {canRebuy && room && (
            <button
              onClick={handleRebuy}
              className="rounded border border-emerald-700 bg-emerald-950 px-3 py-1 text-sm text-emerald-200 hover:bg-emerald-900"
              title={
                gameState
                  ? '牌局進行中,將在下一手開始前補到桌上'
                  : '立即加碼到桌上'
              }
            >
              加碼(上限≈{rebuyCapEstimate})
            </button>
          )}
          {canStartGame && (
            <button
              onClick={handleStartGame}
              className="rounded bg-amber-600 px-3 py-1 text-sm font-semibold text-slate-950 hover:bg-amber-500"
            >
              開始牌局
            </button>
          )}
          {isOwner && !gameState && !canStartGame && (
            <button
              disabled
              className="rounded bg-amber-600 px-3 py-1 text-sm font-semibold text-slate-950 opacity-40"
            >
              開始牌局
            </button>
          )}
          {isOwner && (
            <button
              onClick={() => setShowCloseConfirm(true)}
              className="rounded border border-red-800 bg-red-950 px-3 py-1 text-sm text-red-200 hover:bg-red-900"
            >
              關閉房間
            </button>
          )}
          <button
            onClick={() => router.push('/lobby')}
            className="rounded border border-slate-700 px-3 py-1 text-sm hover:bg-slate-800"
          >
            離開房間
          </button>
        </div>

        {/* Mobile menu button */}
        <div className="relative shrink-0 sm:hidden">
          <button
            onClick={(e) => {
              e.stopPropagation();
              setMenuOpen((v) => !v);
            }}
            className="rounded border border-slate-700 px-3 py-1.5 text-lg leading-none hover:bg-slate-800"
            aria-label="選單"
          >
            ⋯
          </button>
          {menuOpen && (
            <>
              <div
                className="fixed inset-0 z-30"
                onClick={() => setMenuOpen(false)}
              />
              <div className="absolute right-0 top-full z-40 mt-1 flex w-44 flex-col rounded border border-slate-700 bg-slate-900 py-1 text-sm shadow-lg">
                {room && !iAmSeated && (
                  <MenuItem
                    onClick={handleQuickSit}
                    disabled={
                      !connected || room.currentPlayers >= room.maxPlayers
                    }
                  >
                    快速就座
                  </MenuItem>
                )}
                {iAmSeated && (
                  <MenuItem onClick={handleStandup}>站起</MenuItem>
                )}
                {canRebuy && room && (
                  <MenuItem onClick={handleRebuy}>
                    加碼(上限≈{rebuyCapEstimate})
                  </MenuItem>
                )}
                {canStartGame && (
                  <MenuItem onClick={handleStartGame} accent="amber">
                    開始牌局
                  </MenuItem>
                )}
                {isOwner && !gameState && !canStartGame && (
                  <MenuItem disabled accent="amber">
                    開始牌局(需 ≥ 2 人)
                  </MenuItem>
                )}
                {isOwner && (
                  <MenuItem
                    onClick={() => {
                      setMenuOpen(false);
                      setShowCloseConfirm(true);
                    }}
                    accent="red"
                  >
                    關閉房間
                  </MenuItem>
                )}
                <MenuItem
                  onClick={() => {
                    setMenuOpen(false);
                    router.push('/lobby');
                  }}
                >
                  離開房間
                </MenuItem>
              </div>
            </>
          )}
        </div>
      </header>

      <ChatMarquee
        current={marqueeCurrent}
        myUserId={myUserId}
        onDone={() => setMarqueeCurrent(null)}
      />

      {error && (
        <div className="rounded border border-red-700 bg-red-950 p-3 text-sm text-red-200">
          {error}
        </div>
      )}

      <div className="grid gap-4 sm:gap-6 sm:grid-cols-[2fr_1fr]">
        <section className="rounded border border-slate-800 p-3 sm:p-4">
          <div className="mb-2 flex items-center justify-between sm:mb-3">
            <h2 className="text-base font-semibold sm:text-lg">牌桌</h2>
            {gameState && (
              <span className="text-xs font-semibold text-amber-300">
                {phaseLabel(gameState.phase)}
              </span>
            )}
          </div>
          {room && !iAmSeated && !gameState && (
            <p className="mb-2 text-xs text-slate-400">
              你目前為觀戰,點空位就座(買入 {room.buyIn})
            </p>
          )}

          {room && (
            <div
              className="relative mx-auto w-full"
              style={{ maxWidth: 500, aspectRatio: '3 / 2' }}
            >
              <div className="absolute inset-[8%] rounded-[50%] border-4 border-emerald-800 bg-emerald-950/50" />

              {/* Center: community + pot, or resting label */}
              <div className="absolute left-1/2 top-1/2 flex -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-1">
                {gameState ? (
                  <>
                    <div className="flex gap-1">
                      {displayedCommunity.length === 0 ? (
                        <span className="text-[10px] text-slate-300 sm:text-xs">
                          Preflop · 尚未翻牌
                        </span>
                      ) : (
                        displayedCommunity.map((c, i) => (
                          <CardView key={i} card={c} size="sm" />
                        ))
                      )}
                    </div>
                    <div className="text-[10px] text-amber-300 sm:text-xs">
                      Pot: {gameState.pot}
                    </div>
                    <div className="text-[9px] text-slate-400 sm:text-[10px]">
                      每人 {gameState.actionTimeoutSeconds}s
                    </div>
                  </>
                ) : (
                  <div className="text-center text-[10px] text-slate-400 sm:text-xs">
                    尚未開牌
                    <br />
                    盲注 {liveBlinds?.smallBlind ?? room.smallBlind}/
                    {liveBlinds?.bigBlind ?? room.bigBlind}
                  </div>
                )}
              </div>

              {computeRingPositionsPercent(room.maxPlayers).map((pos) => {
                const seatNum = pos.seat;
                const occupant = room.seats.find((s) => s.seat === seatNum);
                const handPlayer = gameState?.players.find(
                  (p) => p.seat === seatNum,
                );
                const positionLabel =
                  occupant && gameState
                    ? getPositionLabel(
                        occupant.seat,
                        gameState.dealerSeat,
                        sortedSeatedSeats,
                      )
                    : null;
                const isActive =
                  gameState?.currentPlayerSeat === seatNum &&
                  gameState.phase !== 'ended';
                const isDealer =
                  gameState && gameState.dealerSeat === seatNum;
                // Show revealed hole cards + hand rank on seat card ONLY for
                // other players at showdown. Your own cards live in the
                // dedicated "你的手牌" area below the ring. Before real
                // showdown, an all-in runout can also reveal cards early
                // (allInReveal) — shown without a hand-rank label since we
                // don't compute hand strength client-side.
                const revealEntry =
                  occupant && occupant.userId !== myUserId
                    ? currentEndResult?.revealedHoles.find(
                        (r) => r.userId === occupant.userId,
                      )
                    : undefined;
                const reveal =
                  revealEntry?.holeCards ??
                  (occupant && occupant.userId !== myUserId
                    ? (allInReveal.get(occupant.userId) ?? null)
                    : null);
                const revealHandRank = revealEntry?.handRank ?? null;
                return (
                  <div
                    key={seatNum}
                    className="absolute"
                    style={{
                      left: `${pos.xPct}%`,
                      top: `${pos.yPct}%`,
                      transform: 'translate(-50%, -50%)',
                    }}
                  >
                    {occupant ? (
                      <SeatCard
                        seatNum={seatNum}
                        name={occupant.name}
                        chips={handPlayer?.chips ?? occupant.chipsAtTable}
                        bet={handPlayer?.bet}
                        status={handPlayer?.status}
                        eliminated={occupant.finishRank != null}
                        positionLabel={positionLabel}
                        isMe={occupant.userId === myUserId}
                        isActive={isActive}
                        isDealer={!!isDealer}
                        isRevealingRiver={
                          !!occupant && occupant.userId === revealingSeatUserId
                        }
                        lastActionType={lastActionBySeat[seatNum]}
                        reveal={reveal}
                        revealHandRank={revealHandRank}
                        secondsLeft={
                          isActive && gameState?.deadline
                            ? Math.max(
                                0,
                                Math.ceil((gameState.deadline - now) / 1000),
                              )
                            : null
                        }
                      />
                    ) : (
                      <button
                        onClick={() => handleSitAt(seatNum)}
                        disabled={iAmSeated || !connected}
                        className="w-16 rounded border border-dashed border-slate-700 p-1 text-left hover:border-emerald-600 hover:bg-slate-900/70 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-slate-700 disabled:hover:bg-transparent sm:w-24 sm:p-2"
                      >
                        <div className="text-[9px] text-slate-500 sm:text-[10px]">
                          #{seatNum}
                        </div>
                        <div className="text-[11px] text-slate-500 sm:text-sm">
                          空位
                        </div>
                        <div className="text-[9px] text-emerald-500 sm:text-[10px]">
                          {iAmSeated ? '—' : '坐這裡'}
                        </div>
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {gameState && holeCards && (
            <div className="mt-3 flex items-center justify-center gap-2 sm:mt-4 sm:gap-3">
              <span className="text-xs text-slate-400">你的手牌</span>
              <CardView card={holeCards[0]} />
              <CardView card={holeCards[1]} />
              {handRank && (
                <span className="rounded bg-amber-950 px-2 py-0.5 text-xs font-bold text-amber-300">
                  {chineseHandRank(handRank)}
                </span>
              )}
            </div>
          )}
          {gameState && !holeCards && (
            <div className="mt-3 text-center text-[11px] text-slate-500 sm:mt-4 sm:text-xs">
              (你是觀戰者,不會拿到手牌)
            </div>
          )}


          {currentEndResult && (
            <div className="mt-3 rounded border border-amber-700 bg-amber-950/40 p-3 text-sm sm:mt-4">
              <div className="mb-1 text-xs text-amber-300">
                {currentEndResult.reason === 'showdown' ? '攤牌' : '對手棄牌'}
              </div>
              {currentEndResult.winners.map((w) => (
                <div key={w.userId} className="flex justify-between">
                  <span className="font-semibold text-emerald-300">
                    {w.name} 贏得 {w.amount}
                  </span>
                  {w.handRank && (
                    <span className="text-xs text-slate-400">
                      {chineseHandRank(w.handRank)}
                    </span>
                  )}
                </div>
              ))}
              {gameState?.players.some((p) => p.userId === myUserId) &&
                !currentEndResult.revealedHoles.some(
                  (r) => r.userId === myUserId,
                ) && (
                  <button
                    onClick={() =>
                      socketRef.current?.emit('game:show-cards', { roomId })
                    }
                    className="mt-2 w-full rounded border border-amber-600 py-1 text-xs font-semibold text-amber-200 hover:bg-amber-900/50"
                  >
                    秀牌(自願給大家看)
                  </button>
                )}
              {autoNextIn !== null && autoNextIn > 0 && (
                <div className="mt-2 text-center text-xs text-slate-400">
                  下一手 {autoNextIn} 秒後自動開始
                </div>
              )}
            </div>
          )}

          {itsMyTurn && gameState && myHandPlayer && (
            <ActionBar
              secondsLeft={
                gameState.deadline
                  ? Math.max(
                      0,
                      Math.ceil((gameState.deadline - now) / 1000),
                    )
                  : null
              }
              currentBet={gameState.currentBet}
              minRaise={gameState.minRaise}
              pot={gameState.pot}
              myBet={myHandPlayer.bet}
              myChips={myHandPlayer.chips}
              onAction={handleAction}
            />
          )}
        </section>

        {/* Desktop side panel — hidden on mobile */}
        <section className="hidden flex-col gap-3 rounded border border-slate-800 p-4 sm:flex">
          <PanelTabs tab={panelTab} onChange={setPanelTab} />
          {panelTab === 'chat' ? (
            <>
              <div
                ref={desktopScrollRef}
                className="flex h-80 flex-col gap-1 overflow-y-auto rounded bg-slate-900 p-3 text-sm"
              >
                {messages.length === 0 && (
                  <p className="text-slate-500">尚無訊息</p>
                )}
                {messages.map((m, i) => (
                  <div key={i}>
                    <span
                      className={
                        m.userId === myUserId
                          ? 'text-emerald-400'
                          : 'text-sky-400'
                      }
                    >
                      {m.from}
                    </span>
                    <span className="text-slate-500">:</span> {m.text}
                  </div>
                ))}
              </div>
              <form onSubmit={sendMessage} className="flex gap-2">
                <input
                  className="flex-1 rounded border border-slate-700 bg-slate-950 px-3 py-2 text-sm"
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  placeholder="輸入訊息"
                  maxLength={500}
                />
                <button
                  type="submit"
                  disabled={!input.trim() || !connected}
                  className="rounded bg-emerald-600 px-3 py-2 text-sm font-semibold hover:bg-emerald-500 disabled:opacity-40"
                >
                  送
                </button>
              </form>
            </>
          ) : panelTab === 'history' ? (
            <div className="flex h-96 flex-col gap-1 overflow-y-auto rounded bg-slate-900 p-3 text-sm">
              <HistoryList
                hands={hands}
                displayedIdx={displayedIdx}
                onSelectIdx={setSelectedIdx}
                players={gameState?.players ?? []}
              />
            </div>
          ) : (
            <div className="flex h-96 flex-col overflow-y-auto rounded bg-slate-900 p-3">
              <StandingsList standings={room?.standings ?? []} />
            </div>
          )}
        </section>
      </div>

      {/* Sticker FAB — always visible; on mobile sits next to the chat FAB */}
      <div className="fixed bottom-4 right-4 z-30 flex flex-col items-end gap-2">
        {showStickerPicker && (
          <div className="grid grid-cols-4 gap-1 rounded-lg border border-slate-700 bg-slate-900 p-2 shadow-lg">
            {STICKER_EMOJIS.map((e) => (
              <button
                key={e}
                onClick={() => sendSticker(e)}
                className="h-10 w-10 rounded text-2xl hover:bg-slate-800"
                aria-label={`送出 ${e}`}
              >
                {e}
              </button>
            ))}
          </div>
        )}
        <div className="flex items-end gap-2">
          {/* Mobile chat FAB — hidden on desktop where the panel is always open. */}
          <button
            onClick={() => setChatOpen(true)}
            className="relative flex h-12 w-12 items-center justify-center rounded-full bg-emerald-600 text-xl shadow-lg hover:bg-emerald-500 sm:hidden"
            aria-label="開啟聊天"
          >
            💬
            {unreadCount > 0 && (
              <span className="absolute -right-1 -top-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-red-600 px-1 text-[10px] font-bold">
                {unreadCount > 99 ? '99+' : unreadCount}
              </span>
            )}
          </button>
          <button
            onClick={() => setShowStickerPicker((v) => !v)}
            className="flex h-12 w-12 items-center justify-center rounded-full bg-amber-600 text-xl shadow-lg hover:bg-amber-500"
            aria-label="送出表情"
          >
            😀
          </button>
        </div>
      </div>

      <StickerLayer stickers={stickers} />

      {/* Mobile chat drawer */}
      {chatOpen && (
        <div className="fixed inset-0 z-40 flex flex-col sm:hidden">
          <div
            className="flex-1 bg-black/70"
            onClick={() => setChatOpen(false)}
          />
          <div className="flex h-[70vh] flex-col gap-2 rounded-t-lg border-t border-slate-700 bg-slate-900 p-3">
            <div className="flex items-center justify-between gap-2">
              <PanelTabs tab={panelTab} onChange={setPanelTab} />
              <button
                onClick={() => setChatOpen(false)}
                className="rounded border border-slate-700 px-2 py-0.5 text-xs hover:bg-slate-800"
              >
                關閉
              </button>
            </div>
            {panelTab === 'chat' ? (
              <>
                <div
                  ref={mobileScrollRef}
                  className="flex flex-1 flex-col gap-1 overflow-y-auto rounded bg-slate-950 p-2 text-sm"
                >
                  {messages.length === 0 && (
                    <p className="text-slate-500">尚無訊息</p>
                  )}
                  {messages.map((m, i) => (
                    <div key={i}>
                      <span
                        className={
                          m.userId === myUserId
                            ? 'text-emerald-400'
                            : 'text-sky-400'
                        }
                      >
                        {m.from}
                      </span>
                      <span className="text-slate-500">:</span> {m.text}
                    </div>
                  ))}
                </div>
                <form onSubmit={sendMessage} className="flex gap-2">
                  <input
                    className="flex-1 rounded border border-slate-700 bg-slate-950 px-3 py-2 text-sm"
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    placeholder="輸入訊息"
                    maxLength={500}
                  />
                  <button
                    type="submit"
                    disabled={!input.trim() || !connected}
                    className="rounded bg-emerald-600 px-3 py-2 text-sm font-semibold hover:bg-emerald-500 disabled:opacity-40"
                  >
                    送
                  </button>
                </form>
              </>
            ) : panelTab === 'history' ? (
              <div className="flex flex-1 flex-col gap-1 overflow-y-auto rounded bg-slate-950 p-2 text-sm">
                <HistoryList
                  hands={hands}
                  displayedIdx={displayedIdx}
                  onSelectIdx={setSelectedIdx}
                  players={gameState?.players ?? []}
                />
              </div>
            ) : (
              <div className="flex flex-1 flex-col overflow-y-auto rounded bg-slate-950 p-2">
                <StandingsList standings={room?.standings ?? []} />
              </div>
            )}
          </div>
        </div>
      )}

      {settlement && (
        <SettlementModal
          summary={settlement}
          onDismiss={() => {
            setSettlement(null);
            router.replace('/lobby');
          }}
        />
      )}

      {showRebuyConfirm && room && (
        <RebuyModal
          capEstimate={rebuyCapEstimate}
          midHand={!!gameState}
          onCancel={() => setShowRebuyConfirm(false)}
          onConfirm={handleRebuyConfirm}
        />
      )}

      {showCloseConfirm && room && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
          <div className="w-full max-w-md rounded-lg border border-slate-700 bg-slate-900 p-6">
            <h2 className="mb-3 text-lg font-bold">關閉房間?</h2>
            <p className="mb-4 text-sm text-slate-300">
              將踢出房內 {room.currentPlayers} 位玩家,桌上籌碼會退回各自餘額。此動作無法復原。
            </p>
            <div className="flex justify-end gap-2 text-sm">
              <button
                type="button"
                onClick={() => setShowCloseConfirm(false)}
                disabled={closing}
                className="rounded border border-slate-700 px-4 py-2 hover:bg-slate-800 disabled:opacity-40"
              >
                取消
              </button>
              <button
                type="button"
                onClick={handleClose}
                disabled={closing}
                className="rounded bg-red-700 px-4 py-2 font-semibold hover:bg-red-600 disabled:opacity-40"
              >
                {closing ? '關閉中…' : '確定關閉'}
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}

// ============================================================
// Helper components
// ============================================================

type PanelTab = 'chat' | 'history' | 'standings';

function PanelTabs({
  tab,
  onChange,
}: {
  tab: PanelTab;
  onChange: (t: PanelTab) => void;
}) {
  const btn = (which: PanelTab, label: string) => (
    <button
      onClick={() => onChange(which)}
      className={`rounded-t border-b-2 px-3 py-1 text-sm font-semibold ${
        tab === which
          ? 'border-emerald-500 text-emerald-300'
          : 'border-transparent text-slate-400 hover:text-slate-200'
      }`}
    >
      {label}
    </button>
  );
  return (
    <div className="flex gap-1 border-b border-slate-800">
      {btn('chat', '聊天')}
      {btn('history', '本手紀錄')}
      {btn('standings', '戰績')}
    </div>
  );
}

function ChatMarquee({
  current,
  myUserId,
  onDone,
}: {
  current: ChatMessage | null;
  myUserId: string | undefined;
  onDone: () => void;
}) {
  // Fixed-height bar so nothing jumps when the marquee is empty. Overflow
  // hidden clips the scrolling text to the container width.
  if (!current) {
    return <div className="h-6" aria-hidden />;
  }
  // Longer messages get proportionally longer scroll duration (min 6s, ~0.25s
  // per char) so a long message doesn't blur past too fast.
  const durationSec = Math.max(6, Math.min(20, current.text.length * 0.25 + 6));
  const isMe = current.userId === myUserId;
  return (
    <div className="h-6 overflow-hidden rounded bg-slate-900/70 text-sm">
      <div
        key={current.ts + current.userId}
        onAnimationEnd={onDone}
        className="whitespace-nowrap"
        style={{
          animation: `marquee-scroll ${durationSec}s linear`,
          animationFillMode: 'forwards',
        }}
      >
        <span className={isMe ? 'text-emerald-400' : 'text-sky-400'}>
          {current.from}
        </span>
        <span className="text-slate-500">:</span>{' '}
        <span className="text-slate-200">{current.text}</span>
      </div>
    </div>
  );
}

function StickerLayer({ stickers }: { stickers: StickerEvent[] }) {
  // Full-viewport overlay. `pointer-events-none` so it never blocks clicks on
  // the felt or buttons underneath. Each sticker is absolutely-positioned by
  // a random top percentage assigned once per event id (deterministic hash so
  // re-renders don't teleport an in-flight sticker vertically).
  return (
    <div className="pointer-events-none fixed inset-0 z-40 overflow-hidden">
      {stickers.map((s) => {
        const topPct = 15 + (hashStr(s.id) % 60); // 15%..75%
        return (
          <div
            key={s.id}
            className="absolute text-5xl sm:text-6xl"
            style={{
              top: `${topPct}%`,
              left: 0,
              animation: 'sticker-fly 3s ease-out forwards',
              filter: 'drop-shadow(0 2px 4px rgba(0,0,0,0.5))',
            }}
            aria-label={`${s.name} 送出 ${s.emoji}`}
          >
            {s.emoji}
          </div>
        );
      })}
    </div>
  );
}

// Tiny deterministic hash for sticker vertical placement — same id always
// maps to the same top%, so re-renders don't jitter an in-flight sticker.
function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i += 1) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

function StandingsList({
  standings,
}: {
  standings: RoomStanding[];
}) {
  if (standings.length === 0) {
    return <p className="text-slate-500">尚無成員</p>;
  }
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b border-slate-700 text-left text-xs text-slate-400">
          <th className="py-1">玩家</th>
          <th className="py-1 text-right">買入</th>
          <th className="py-1 text-right">剩下</th>
          <th className="py-1 text-right">輸贏</th>
        </tr>
      </thead>
      <tbody>
        {standings.map((s) => {
          const net = s.chipsAtTable - s.totalBuyIn;
          const netStr = net > 0 ? `+${net}` : net < 0 ? `${net}` : '±0';
          const netColor =
            net > 0
              ? 'text-emerald-400'
              : net < 0
                ? 'text-red-400'
                : 'text-slate-500';
          const isStanding = s.seat === null && s.finishRank === null;
          const isEliminated = s.finishRank !== null;
          return (
            <tr key={s.userId} className="border-b border-slate-800">
              <td className="py-1">
                <span className={isEliminated ? 'text-slate-500' : ''}>
                  {s.name}
                </span>
                {isStanding && (
                  <span className="ml-1 text-[10px] text-slate-500">
                    (暫離)
                  </span>
                )}
                {isEliminated && (
                  <span className="ml-1 text-[10px] text-amber-400">
                    #{s.finishRank}
                  </span>
                )}
              </td>
              <td className="py-1 text-right font-mono text-slate-400">
                {s.totalBuyIn}
              </td>
              <td className="py-1 text-right font-mono">{s.chipsAtTable}</td>
              <td
                className={`py-1 text-right font-mono font-bold ${netColor}`}
              >
                {netStr}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function HistoryList({
  hands,
  displayedIdx,
  onSelectIdx,
  players,
}: {
  hands: HandRecord[];
  displayedIdx: number;
  onSelectIdx: (idx: number | null) => void;
  players: HandPlayerPublic[];
}) {
  if (hands.length === 0) {
    return <p className="text-slate-500">尚無紀錄,開始牌局後這裡會累積</p>;
  }
  const hand = hands[displayedIdx];
  const isLatest = displayedIdx === hands.length - 1;
  const inProgress = isLatest && !hand.endResult;
  const nameOf = (userId: string) =>
    players.find((p) => p.userId === userId)?.name ?? '玩家';

  return (
    <>
      <div className="mb-1 flex items-center justify-between border-b border-slate-800 pb-1">
        <button
          type="button"
          onClick={() => onSelectIdx(Math.max(0, displayedIdx - 1))}
          disabled={displayedIdx <= 0}
          className="rounded px-2 py-0.5 text-xs text-slate-300 hover:bg-slate-800 disabled:opacity-30"
        >
          ← 上一手
        </button>
        <span className="text-xs text-slate-400">
          第 {hand.handNumber} 手 / 共 {hands.length} 手
          {inProgress && (
            <span className="ml-1 text-amber-300">(進行中)</span>
          )}
        </span>
        <button
          type="button"
          onClick={() =>
            onSelectIdx(Math.min(hands.length - 1, displayedIdx + 1))
          }
          disabled={displayedIdx >= hands.length - 1}
          className="rounded px-2 py-0.5 text-xs text-slate-300 hover:bg-slate-800 disabled:opacity-30"
        >
          下一手 →
        </button>
      </div>
      {!isLatest && (
        <div className="mb-1 text-right">
          <button
            type="button"
            onClick={() => onSelectIdx(null)}
            className="text-[10px] text-emerald-400 underline hover:text-emerald-300"
          >
            回到最新
          </button>
        </div>
      )}

      {inProgress ? (
        <p className="text-slate-500">
          本手進行中,結束後這裡會顯示每個人的動作、公共牌與攤牌
        </p>
      ) : (
        <>
          {hand.history.map((item, i) =>
            item.kind === 'action' ? (
              <div key={i}>
                <span className="text-slate-500">
                  [{phaseShort(item.entry.phase)}]
                </span>{' '}
                <span className="font-semibold text-slate-200">
                  {item.entry.name}
                </span>{' '}
                <span>{actionZh(item.entry.actionType)}</span>
                {typeof item.entry.amount === 'number' && (
                  <span className="text-emerald-400"> {item.entry.amount}</span>
                )}
              </div>
            ) : (
              <div key={i} className="mt-1 border-t border-slate-800 pt-1">
                <span className="text-amber-300">
                  — {phaseShort(item.phase)} —
                </span>
                <span className="ml-2 inline-flex gap-1 align-middle">
                  {item.cards.map((c, j) => (
                    <InlineCard key={j} card={c} />
                  ))}
                </span>
              </div>
            ),
          )}
          {hand.endResult && (
            <div className="mt-2 border-t border-slate-700 pt-2">
              <div className="mb-1 text-amber-300">
                {hand.endResult.reason === 'showdown'
                  ? '— 攤牌 —'
                  : '— 對手棄牌 —'}
              </div>
              {hand.endResult.revealedHoles.length === 0 && (
                <div className="text-xs text-slate-500">(沒人秀牌)</div>
              )}
              {hand.endResult.revealedHoles.map((r) => (
                <div key={r.userId} className="flex items-center gap-2">
                  <span className="font-semibold text-slate-200">
                    {nameOf(r.userId)}
                  </span>
                  <span className="inline-flex gap-1">
                    <InlineCard card={r.holeCards[0]} />
                    <InlineCard card={r.holeCards[1]} />
                  </span>
                  <span className="text-xs text-amber-300">
                    {chineseHandRank(r.handRank)}
                  </span>
                </div>
              ))}
              {hand.endResult.winners.map((w) => (
                <div key={w.userId} className="text-emerald-300">
                  勝 · {w.name} 贏得 {w.amount}
                  {w.handRank && (
                    <span className="ml-1 text-xs text-slate-400">
                      ({chineseHandRank(w.handRank)})
                    </span>
                  )}
                </div>
              ))}
              {hand.endResult.players.length > 0 && (
                <div className="mt-2 border-t border-slate-800 pt-2 text-xs">
                  <div className="mb-1 text-slate-500">本手結束籌碼</div>
                  {hand.endResult.players.map((p) => {
                    const delta = p.finalChips - p.startingChips;
                    return (
                      <div
                        key={p.userId}
                        className="flex items-center justify-between text-slate-300"
                      >
                        <span>{p.name}</span>
                        <span>
                          {p.startingChips} → {p.finalChips}
                          <span
                            className={
                              delta > 0
                                ? 'ml-1 text-emerald-400'
                                : delta < 0
                                  ? 'ml-1 text-red-400'
                                  : 'ml-1 text-slate-500'
                            }
                          >
                            ({delta > 0 ? '+' : ''}
                            {delta})
                          </span>
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </>
      )}
    </>
  );
}

// Tiny inline card for history log — smaller than the seat CardView.
function InlineCard({ card }: { card: Card }) {
  const red = card.suit === 'H' || card.suit === 'D';
  return (
    <span
      className={`inline-block rounded border border-slate-500 bg-slate-100 px-1 text-[10px] font-bold leading-tight ${
        red ? 'text-red-600' : 'text-slate-900'
      }`}
    >
      {card.rank}
      {SUIT_SYMBOL[card.suit]}
    </span>
  );
}

function MenuItem({
  onClick,
  disabled,
  accent,
  children,
}: {
  onClick?: () => void;
  disabled?: boolean;
  accent?: 'amber' | 'red';
  children: React.ReactNode;
}) {
  const accentClass =
    accent === 'red'
      ? 'text-red-300 hover:bg-red-950'
      : accent === 'amber'
        ? 'text-amber-300 hover:bg-amber-950/50'
        : 'text-slate-200 hover:bg-slate-800';
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`px-3 py-2 text-left disabled:cursor-not-allowed disabled:opacity-40 ${accentClass}`}
    >
      {children}
    </button>
  );
}

const SUIT_SYMBOL: Record<Card['suit'], string> = {
  S: '♠',
  H: '♥',
  D: '♦',
  C: '♣',
};

function CardView({ card, size = 'md' }: { card: Card; size?: 'sm' | 'md' }) {
  const red = card.suit === 'H' || card.suit === 'D';
  const sz =
    size === 'sm'
      ? 'h-9 w-7 text-xs sm:h-10 sm:w-8 sm:text-sm'
      : 'h-14 w-10 text-lg';
  return (
    <span
      className={`inline-flex items-center justify-center rounded border border-slate-500 bg-slate-100 font-bold ${sz} ${
        red ? 'text-red-600' : 'text-slate-900'
      }`}
    >
      {card.rank}
      {SUIT_SYMBOL[card.suit]}
    </span>
  );
}

function SeatCard({
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
      <div className="text-[9px] text-slate-400 sm:text-[10px]">
        {chips}
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
      {typeof secondsLeft === 'number' && (
        <div
          className={`mt-0.5 text-[10px] font-bold sm:text-xs ${
            secondsLeft <= 5 ? 'text-red-400' : 'text-amber-300'
          }`}
        >
          ⏱ {secondsLeft}s
        </div>
      )}
    </div>
  );
}

function ActionBar({
  secondsLeft,
  currentBet,
  minRaise,
  pot,
  myBet,
  myChips,
  onAction,
}: {
  secondsLeft: number | null;
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

  return (
    <div className="mt-4 rounded border border-slate-700 bg-slate-950 p-3">
      <div className="mb-2 flex items-center justify-between text-xs">
        <span className="text-amber-300">輪到你行動</span>
        {typeof secondsLeft === 'number' && (
          <span
            className={`font-bold ${
              secondsLeft <= 5 ? 'text-red-400' : 'text-amber-300'
            }`}
          >
            剩 {secondsLeft}s
          </span>
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        <button
          onClick={() => onAction({ type: 'fold' })}
          className="rounded bg-slate-700 px-3 py-2 text-sm font-semibold hover:bg-slate-600"
        >
          棄牌
        </button>
        {canCheck ? (
          <button
            onClick={() => onAction({ type: 'check' })}
            className="rounded bg-emerald-700 px-3 py-2 text-sm font-semibold hover:bg-emerald-600"
          >
            過牌
          </button>
        ) : (
          <button
            onClick={() => onAction({ type: 'call' })}
            className="rounded bg-emerald-700 px-3 py-2 text-sm font-semibold hover:bg-emerald-600"
          >
            跟注 {toCall}
          </button>
        )}
        <button
          onClick={() => setShowRaiseModal(true)}
          className="rounded bg-amber-600 px-3 py-2 text-sm font-semibold text-slate-950 hover:bg-amber-500"
        >
          加註
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

  function submit() {
    const n = Number(raiseInput);
    if (!Number.isFinite(n)) return;
    onConfirm(Math.floor(n));
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div className="w-full max-w-sm rounded-lg border border-slate-700 bg-slate-900 p-6">
        <h2 className="mb-3 text-lg font-bold">加註金額</h2>
        <div className="mb-3 flex flex-wrap gap-2">
          <button
            onClick={() => presetFraction(1 / 3)}
            className="rounded border border-slate-600 px-3 py-1.5 text-xs hover:bg-slate-800"
          >
            1/3 底池
          </button>
          <button
            onClick={() => presetFraction(0.5)}
            className="rounded border border-slate-600 px-3 py-1.5 text-xs hover:bg-slate-800"
          >
            1/2 底池
          </button>
          <button
            onClick={() => presetFraction(2 / 3)}
            className="rounded border border-slate-600 px-3 py-1.5 text-xs hover:bg-slate-800"
          >
            2/3 底池
          </button>
          <button
            onClick={presetAllIn}
            className="rounded border border-red-700 px-3 py-1.5 text-xs text-red-300 hover:bg-red-950"
          >
            All-in
          </button>
        </div>
        <input
          type="number"
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
            type="button"
            onClick={submit}
            className="rounded bg-amber-600 px-4 py-2 font-semibold text-slate-950 hover:bg-amber-500"
          >
            送出
          </button>
        </div>
      </div>
    </div>
  );
}

// Lets the player pick how much to rebuy (must be a multiple of 500, capped
// by the chip leader — see rebuyChips in server/src/rooms.ts). `capEstimate`
// is a client-side guess (server re-validates the real cap on submit).
function RebuyModal({
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

  function submit() {
    if (!Number.isFinite(amount) || amount <= 0 || amount % 500 !== 0) return;
    onConfirm(amount);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div className="w-full max-w-sm rounded-lg border border-slate-700 bg-slate-900 p-6">
        <h2 className="mb-3 text-lg font-bold">加碼金額</h2>
        <div className="mb-3 flex flex-wrap gap-2">
          <button
            onClick={() => setAmount(500)}
            className="rounded border border-slate-600 px-3 py-1.5 text-xs hover:bg-slate-800"
          >
            500
          </button>
          <button
            onClick={() => setAmount(Math.max(500, roundDownTo500(cap / 2)))}
            className="rounded border border-slate-600 px-3 py-1.5 text-xs hover:bg-slate-800"
          >
            半({Math.max(500, roundDownTo500(cap / 2))})
          </button>
          <button
            onClick={() => setAmount(cap)}
            className="rounded border border-emerald-700 px-3 py-1.5 text-xs text-emerald-300 hover:bg-emerald-950"
          >
            上限({cap})
          </button>
        </div>
        <input
          type="number"
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
            type="button"
            onClick={submit}
            className="rounded bg-emerald-600 px-4 py-2 font-semibold hover:bg-emerald-500"
          >
            確定加碼
          </button>
        </div>
      </div>
    </div>
  );
}

function SessionCountdown({ endsAt, now }: { endsAt: string; now: number }) {
  const remaining = Math.max(0, new Date(endsAt).getTime() - now);
  const totalSec = Math.floor(remaining / 1000);
  const mm = Math.floor(totalSec / 60);
  const ss = totalSec % 60;
  const label = `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
  const color =
    totalSec < 60
      ? 'bg-red-700'
      : totalSec < 300
        ? 'bg-amber-700'
        : 'bg-slate-700';
  return (
    <span
      className={`ml-2 inline-block rounded px-1.5 py-0.5 text-[10px] font-mono sm:text-xs ${color}`}
      title="遊戲剩餘時間"
    >
      ⏱ {label}
    </span>
  );
}

// Blind-level display for tournament rooms — parallel to SessionCountdown,
// ticks locally off `now` (no extra socket event needed for the ticking).
function BlindLevelInfo({ room, now }: { room: RoomDetail; now: number }) {
  const levelMinutes = room.blindLevelMinutes ?? 15;
  const { smallBlind, bigBlind, level } = effectiveBlinds(room);
  if (!room.tournamentClockStartedAt) {
    return (
      <span
        className="ml-2 inline-block rounded bg-slate-700 px-1.5 py-0.5 text-[10px] font-mono text-slate-400 sm:text-xs"
        title="按下開始牌局才會開始漲盲"
      >
        第 1 級 {smallBlind}/{bigBlind} · 未開始
      </span>
    );
  }
  const nextAt = nextBlindLevelAt(room.tournamentClockStartedAt, levelMinutes) ?? now;
  const remaining = Math.max(0, nextAt - now);
  const totalSec = Math.floor(remaining / 1000);
  const mm = Math.floor(totalSec / 60);
  const ss = totalSec % 60;
  return (
    <span
      className="ml-2 inline-block rounded bg-amber-800 px-1.5 py-0.5 text-[10px] font-mono sm:text-xs"
      title="距離下一級盲注"
    >
      第{level}級 {smallBlind}/{bigBlind} · 下級{' '}
      {String(mm).padStart(2, '0')}:{String(ss).padStart(2, '0')}
    </span>
  );
}

function SettlementModal({
  summary,
  onDismiss,
}: {
  summary: SettlementSummary;
  onDismiss: () => void;
}) {
  if (summary.reason === 'tournament-finished') {
    const ranked = [...summary.players].sort(
      (a, b) => (a.finishRank ?? 999) - (b.finishRank ?? 999),
    );
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
        <div className="w-full max-w-md rounded-lg border border-slate-700 bg-slate-900 p-6">
          <h2 className="mb-4 text-lg font-bold">
            錦標賽結束 · {summary.roomName}
          </h2>
          <ul className="mb-4 flex flex-col gap-1 text-sm">
            {ranked.map((p) => (
              <li
                key={p.userId}
                className={`flex items-center justify-between rounded px-2 py-1.5 ${
                  p.finishRank === 1
                    ? 'bg-amber-950/60 font-bold text-amber-300'
                    : 'text-slate-300'
                }`}
              >
                <span>
                  {p.finishRank === 1 ? '🏆 冠軍' : `第 ${p.finishRank} 名`}{' '}
                  {p.name}
                </span>
                <span
                  className={
                    p.finishRank === 1 ? 'text-emerald-400' : 'text-red-400'
                  }
                >
                  {p.finishRank === 1 ? '贏得全部籌碼' : '輸掉買入'}
                </span>
              </li>
            ))}
          </ul>
          <div className="flex justify-end">
            <button
              type="button"
              onClick={onDismiss}
              className="rounded bg-emerald-600 px-4 py-2 text-sm font-semibold hover:bg-emerald-500"
            >
              回大廳
            </button>
          </div>
        </div>
      </div>
    );
  }

  const reasonLabel =
    summary.reason === 'session-expired'
      ? '遊戲時間到'
      : '房主關閉房間';
  // Ranked by net win/loss, biggest winner first.
  const rankedPlayers = [...summary.players].sort(
    (a, b) =>
      b.chipsAtTable - b.totalBuyIn - (a.chipsAtTable - a.totalBuyIn),
  );
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div className="w-full max-w-md rounded-lg border border-slate-700 bg-slate-900 p-6">
        <h2 className="mb-2 text-lg font-bold">結算 · {summary.roomName}</h2>
        <p className="mb-3 text-sm text-slate-400">{reasonLabel}</p>
        {summary.players.length === 0 ? (
          <p className="mb-4 text-sm text-slate-500">房內無人就座</p>
        ) : (
          <table className="mb-4 w-full text-sm">
            <thead>
              <tr className="border-b border-slate-700 text-left text-xs text-slate-400">
                <th className="py-1">名次</th>
                <th className="py-1">玩家</th>
                <th className="py-1 text-right">買入</th>
                <th className="py-1 text-right">剩下</th>
                <th className="py-1 text-right">輸贏</th>
              </tr>
            </thead>
            <tbody>
              {rankedPlayers.map((p, i) => {
                const net = p.chipsAtTable - p.totalBuyIn;
                const netStr =
                  net > 0 ? `+${net}` : net < 0 ? `${net}` : '±0';
                const netColor =
                  net > 0
                    ? 'text-emerald-400'
                    : net < 0
                      ? 'text-red-400'
                      : 'text-slate-500';
                return (
                  <tr key={p.userId} className="border-b border-slate-800">
                    <td className="py-1 text-slate-400">{i + 1}</td>
                    <td className="py-1">{p.name}</td>
                    <td className="py-1 text-right font-mono text-slate-400">
                      {p.totalBuyIn}
                    </td>
                    <td className="py-1 text-right font-mono">
                      {p.chipsAtTable}
                    </td>
                    <td
                      className={`py-1 text-right font-mono font-bold ${netColor}`}
                    >
                      {netStr}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        <div className="flex justify-end">
          <button
            type="button"
            onClick={onDismiss}
            className="rounded bg-emerald-600 px-4 py-2 text-sm font-semibold hover:bg-emerald-500"
          >
            回大廳
          </button>
        </div>
      </div>
    </div>
  );
}

// Translate pokersolver hand `name` (short form) into Traditional Chinese.
// Falls back to the English name if we don't recognize it.
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
function chineseHandRank(name: string): string {
  return HAND_RANK_ZH[name] ?? name;
}

type HistoryItem =
  | { kind: 'action'; entry: ActionLogEntry }
  | {
      kind: 'street';
      phase: 'flop' | 'turn' | 'river';
      cards: Card[];
      trailingUserId?: string;
    };

type HandRecord = {
  handNumber: number;
  startedAt: number;
  history: HistoryItem[];
  endResult: HandEndResult | null; // null = still in progress
};

const ACTION_ZH: Record<ActionLogEntry['actionType'], string> = {
  fold: '蓋牌',
  check: '過牌',
  call: '跟注',
  raise: '加注',
  'all-in': 'All-in',
};
function actionZh(t: ActionLogEntry['actionType']): string {
  return ACTION_ZH[t];
}

const PHASE_SHORT: Record<ActionLogEntry['phase'], string> = {
  preflop: '底牌前',
  flop: '翻牌',
  turn: '轉牌',
  river: '河牌',
};
function phaseShort(p: ActionLogEntry['phase']): string {
  return PHASE_SHORT[p];
}

function phaseLabel(phase: HandStatePublic['phase']): string {
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

// ============================================================
// Poker positions & ring geometry
// ============================================================

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
function computeRingPositionsPercent(
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

function getPositionLabel(
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
