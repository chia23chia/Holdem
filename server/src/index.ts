import { createServer } from 'node:http';
import { Server } from 'socket.io';
import type {
  ClientToServerEvents,
  ServerToClientEvents,
} from '@holdem/shared';
import { authMiddleware, getUser } from './auth.js';
import {
  buildOwnerCloseSettlement,
  closeRoom,
  countHandLogs,
  deleteHandLogsForRoom,
  findExpiredRooms,
  getRoomDetail,
  listRoomSummaries,
  ownerCloseRoom,
  persistHandLog,
  persistHandResult,
  rebuyChips,
  seatUser,
  setRoomStatus,
  snapshotSeatedPlayers,
  startSessionIfNeeded,
  systemCloseRoomWithSettlement,
  unseatUser,
  updateHandLogEndResult,
} from './rooms.js';
import {
  applyAction,
  applyReveal,
  buildHandLogData,
  chipsSnapshot,
  clearRoomState,
  endHand,
  getEndResult,
  getHand,
  getPrivateFor,
  hasActiveHand,
  startHand,
  toPublicState,
  type AppliedActionLog,
} from './hands.js';
import type { PlayerAction } from '@holdem/shared';

const PORT = Number(process.env.SERVER_PORT ?? 3001);
const CORS_ORIGIN = process.env.CORS_ORIGIN ?? 'http://localhost:3000';
const SESSION_EXPIRY_SCAN_MS = 30_000;

const httpServer = createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', ts: Date.now() }));
    return;
  }
  res.writeHead(404);
  res.end();
});

const io = new Server<ClientToServerEvents, ServerToClientEvents>(httpServer, {
  cors: { origin: CORS_ORIGIN, credentials: true },
});

io.use(authMiddleware);

const LOBBY_ROOM = 'lobby';
const roomChannel = (roomId: string) => `room:${roomId}`;

async function broadcastLobbyList() {
  const rooms = await listRoomSummaries();
  io.to(LOBBY_ROOM).emit('lobby:rooms', rooms);
}

async function broadcastRoomDetail(roomId: string) {
  const detail = await getRoomDetail(roomId);
  if (detail) {
    io.to(roomChannel(roomId)).emit('room:detail', detail);
    io.to(LOBBY_ROOM).emit('lobby:room-updated', detail);
  } else {
    io.to(LOBBY_ROOM).emit('lobby:room-removed', { roomId });
  }
}

// Called after any unseat that might have emptied the room.
// If empty → close + kick all subscribers (including spectators).
// Otherwise → broadcast new detail and lobby list.
async function finalizeRoomState(roomId: string, empty: boolean) {
  if (empty) {
    cancelAutoAction(roomId);
    clearRoomState(roomId);
    lastHandLogIdByRoom.delete(roomId);
    pendingRebuysByRoom.delete(roomId);
    await deleteHandLogsForRoom(roomId);
    await closeRoom(roomId);
    io.to(roomChannel(roomId)).emit('room:closed', { roomId });
    io.to(LOBBY_ROOM).emit('lobby:room-removed', { roomId });
  } else {
    await broadcastRoomDetail(roomId);
    await broadcastLobbyList();
  }
}

// ============================================================
// Auto-action timer (Milestone 2.4)
// ============================================================

const autoActionTimers = new Map<string, NodeJS.Timeout>();
// Latest persisted HandLog row id per room; used to patch endResult when a
// voluntary reveal fires after the hand was already persisted.
const lastHandLogIdByRoom = new Map<string, string>();

// Rebuy queue: mid-hand rebuy requests wait here. Applied to Membership
// after the hand ends, before the next one starts. Value = the requested
// amount (re-validated against the zero-chips + chip-leader-cap rule in
// `rebuyChips` at apply time, so a stale/no-longer-valid request is rejected
// rather than silently over-granting). A later request from the same player
// overwrites an earlier one — only their latest choice matters.
const pendingRebuysByRoom = new Map<string, Map<string, number>>();

function queuePendingRebuy(roomId: string, userId: string, amount: number): void {
  let byUser = pendingRebuysByRoom.get(roomId);
  if (!byUser) {
    byUser = new Map();
    pendingRebuysByRoom.set(roomId, byUser);
  }
  byUser.set(userId, amount);
}

async function drainPendingRebuys(roomId: string): Promise<void> {
  const byUser = pendingRebuysByRoom.get(roomId);
  if (!byUser || byUser.size === 0) return;
  const entries = [...byUser.entries()];
  byUser.clear();
  for (const [userId, amount] of entries) {
    try {
      await rebuyChips(userId, roomId, amount);
    } catch (err) {
      console.error('[server] drain rebuy error', err);
    }
  }
}


function cancelAutoAction(roomId: string): void {
  const t = autoActionTimers.get(roomId);
  if (t) {
    clearTimeout(t);
    autoActionTimers.delete(roomId);
  }
}

// Schedule an auto-action timer based on the hand's current deadline.
// Called after every state-mutating event that could change whose turn it is.
function rescheduleAutoAction(roomId: string): void {
  cancelAutoAction(roomId);
  const hand = getHand(roomId);
  if (!hand || hand.phase === 'ended' || hand.deadline === null) return;
  const delay = Math.max(0, hand.deadline - Date.now());
  const handle = setTimeout(() => {
    autoActionTimers.delete(roomId);
    void runAutoAction(roomId);
  }, delay);
  autoActionTimers.set(roomId, handle);
}

// Called when a player's action deadline expires. Auto-check if legal, else fold.
async function runAutoAction(roomId: string): Promise<void> {
  const hand = getHand(roomId);
  if (!hand || hand.phase === 'ended' || hand.currentPlayerIdx === null) return;
  const cur = hand.players[hand.currentPlayerIdx];
  if (cur.status !== 'active') return;
  const canCheck = cur.bet === hand.currentBet;
  const action: PlayerAction = canCheck ? { type: 'check' } : { type: 'fold' };
  const outcome = applyAction(roomId, cur.userId, action);
  if (!outcome.ok) return;
  const phaseBefore = hand.phase; // captured before applyAction re-entered
  await broadcastAfterAction(roomId, outcome.log, phaseBefore, outcome.ended);
}

// Shared post-action broadcast: action-log + state + optional phase re-emit
// of game:hole + hand-end persistence + timer reschedule. Called from both
// the game:action socket handler and runAutoAction.
async function broadcastAfterAction(
  roomId: string,
  log: AppliedActionLog,
  phaseBefore: string | undefined,
  ended: boolean,
): Promise<void> {
  const hand = getHand(roomId);
  if (!hand) return;

  io.to(roomChannel(roomId)).emit('game:action-log', {
    roomId,
    seat: log.seat,
    name: log.name,
    phase: log.phase,
    actionType: log.actionType,
    amount: log.amount,
    ts: Date.now(),
  });
  io.to(roomChannel(roomId)).emit('game:state', toPublicState(hand));

  // Below this point, every step is wrapped individually: a transient
  // failure (DB hiccup, slow socket under lag, etc.) in any one of them must
  // NOT stop the others from running — and must never skip the final
  // `rescheduleAutoAction` at the bottom. Losing that reschedule kills the
  // room's auto-fold/auto-check safety net permanently: the client's
  // countdown is computed locally from the last `deadline` it received, so
  // it keeps visually ticking while the server has actually given up and
  // nothing will ever deal the next card.
  if (phaseBefore && hand.phase !== phaseBefore) {
    try {
      const roomSockets = await io.in(roomChannel(roomId)).fetchSockets();
      for (const rs of roomSockets) {
        const rsUser = rs.data.user as { userId: string } | undefined;
        if (!rsUser) continue;
        const priv = getPrivateFor(hand, rsUser.userId);
        if (priv) rs.emit('game:hole', priv);
      }
    } catch (err) {
      console.error('[server] game:hole broadcast error', err);
    }
  }

  if (ended) {
    try {
      const snap = chipsSnapshot(hand);
      await persistHandResult(roomId, snap);
    } catch (err) {
      console.error('[server] persistHandResult error', err);
    }
    const result = getEndResult(hand);
    // Persist the completed hand to HandLog for later review / cross-session.
    try {
      const logData = buildHandLogData(hand);
      const { id: handLogId } = await persistHandLog(
        roomId,
        hand.handNumber,
        logData,
      );
      lastHandLogIdByRoom.set(roomId, handLogId);
    } catch (err) {
      console.error('[server] persistHandLog error', err);
    }
    // Flip room back to 'waiting' — owner can now close between hands.
    try {
      await setRoomStatus(roomId, 'waiting');
    } catch (err) {
      console.error('[server] setRoomStatus error', err);
    }
    // Apply any queued rebuys BEFORE broadcasting so clients see the updated
    // chipsAtTable in the same room:detail push.
    try {
      await drainPendingRebuys(roomId);
    } catch (err) {
      console.error('[server] drainPendingRebuys error', err);
    }
    // Always tell clients the hand ended, even if persistence above failed —
    // otherwise their UI stays frozen on the last in-progress state forever.
    io.to(roomChannel(roomId)).emit('game:ended', {
      roomId,
      result: result ?? undefined,
    });
    try {
      await broadcastRoomDetail(roomId);
    } catch (err) {
      console.error('[server] broadcastRoomDetail error', err);
    }
  }

  rescheduleAutoAction(roomId);
}

type StartHandOutcome =
  | { ok: true }
  | { ok: false; error: string; needsRebuy?: true };

// Core hand-start logic: validates funded-player count, deals a new hand,
// and broadcasts it. Shared by the owner-triggered `game:start` handler and
// the auto-resume-after-rebuy path below, so a room doesn't need the owner
// to manually retry once a busted player has rebought in.
async function startHandForRoom(roomId: string): Promise<StartHandOutcome> {
  const detail = await getRoomDetail(roomId);
  if (!detail) return { ok: false, error: '房間不存在' };
  if (hasActiveHand(roomId)) return { ok: false, error: '已在牌局中' };
  // Players with 0 chips sit out (need a rebuy) — they aren't dealt in,
  // otherwise they'd be stuck unable to check or call every hand.
  const playersWithChips = detail.seats.filter((s) => s.chipsAtTable > 0);
  if (playersWithChips.length < 2) {
    return {
      ok: false,
      error: '需要至少 2 位有籌碼的玩家(0 籌碼玩家請先加值)',
      needsRebuy: true,
    };
  }

  // Wipe any prior ended-hand state before starting fresh.
  endHand(roomId);
  // Determine the next hand number now (server authoritative) so the
  // HandStatePublic broadcast and the eventual HandLog write agree.
  const priorCount = await countHandLogs(roomId);
  const hand = startHand(
    roomId,
    playersWithChips.map((s) => ({
      seat: s.seat,
      userId: s.userId,
      name: s.name,
      chipsAtTable: s.chipsAtTable,
    })),
    detail.smallBlind,
    detail.bigBlind,
    detail.actionTimeoutSeconds,
    priorCount + 1,
  );

  // Flip room to 'playing' — blocks ownerCloseRoom until the hand ends.
  await setRoomStatus(roomId, 'playing');
  // First hand ever also sets sessionEndsAt.
  await startSessionIfNeeded(roomId);
  // Broadcast for both status flip AND (possibly) session start.
  await broadcastRoomDetail(roomId);

  // Public state → all subscribers (players + spectators).
  io.to(roomChannel(roomId)).emit('game:started', toPublicState(hand));

  // Private hole cards → each seated player's socket(s) only.
  const roomSockets = await io.in(roomChannel(roomId)).fetchSockets();
  for (const rs of roomSockets) {
    const rsUser = rs.data.user as { userId: string } | undefined;
    if (!rsUser) continue;
    const priv = getPrivateFor(hand, rsUser.userId);
    if (priv) rs.emit('game:hole', priv);
  }

  // Start the auto-action timer for the first player's turn.
  rescheduleAutoAction(roomId);
  return { ok: true };
}

io.on('connection', (socket) => {
  const user = getUser(socket);
  console.log(`[connect] ${socket.id} user=${user.userId} name=${user.name}`);
  socket.emit('connection:ok', { userId: user.userId, name: user.name });

  // Track which room this socket is subscribed to for cleanup on disconnect.
  let subscribedRoomId: string | null = null;

  // ---- Lobby ----
  socket.on('lobby:subscribe', async () => {
    await socket.join(LOBBY_ROOM);
    const rooms = await listRoomSummaries();
    socket.emit('lobby:rooms', rooms);
  });
  socket.on('lobby:unsubscribe', async () => {
    await socket.leave(LOBBY_ROOM);
  });

  // ---- Rooms ----
  socket.on('room:join', async ({ roomId, seat }, cb) => {
    const outcome = await seatUser(user.userId, roomId, seat);
    if (!outcome.ok) {
      cb({ ok: false, error: outcome.error });
      return;
    }
    cb({ ok: true });
    await broadcastLobbyList();
    await broadcastRoomDetail(roomId);
  });

  socket.on('room:subscribe', async ({ roomId }) => {
    if (subscribedRoomId && subscribedRoomId !== roomId) {
      await socket.leave(roomChannel(subscribedRoomId));
    }
    await socket.join(roomChannel(roomId));
    subscribedRoomId = roomId;
    const detail = await getRoomDetail(roomId);
    if (detail) socket.emit('room:detail', detail);
    else socket.emit('room:error', { message: '房間不存在' });

    // Catch up newly-subscribed client to any hand already in memory.
    const hand = getHand(roomId);
    if (hand) {
      socket.emit('game:started', toPublicState(hand));
      const priv = getPrivateFor(hand, user.userId);
      if (priv) socket.emit('game:hole', priv);
      if (hand.phase === 'ended') {
        const result = getEndResult(hand);
        socket.emit('game:ended', {
          roomId,
          result: result ?? undefined,
        });
      }
    }
  });

  // Milestone 2.5 model: "leave room" is navigation only — the player keeps
  // their seat + chipsAtTable so they can return to the same room later within
  // the session. They only actually unseat via `room:standup` (between hands)
  // or when the session closes (settlement).
  socket.on('room:leave', async ({ roomId }) => {
    if (subscribedRoomId === roomId) {
      await socket.leave(roomChannel(roomId));
      subscribedRoomId = null;
    }
  });

  // Standup: unseat + refund, keep subscription so user remains a spectator.
  // Does NOT depend on any socket-local seated-room cache — a fresh socket
  // after reconnect might not have that cached, but their Membership
  // persists in DB.
  socket.on('room:standup', async ({ roomId }) => {
    if (hasActiveHand(roomId)) {
      socket.emit('room:error', {
        message: '牌局進行中無法站起,請等這手結束',
      });
      return;
    }
    const { empty } = await unseatUser(user.userId, roomId);
    await finalizeRoomState(roomId, empty);
  });

  socket.on('room:close', async ({ roomId }, cb) => {
    // Snapshot memberships BEFORE close so settlement has chip data.
    const players = await snapshotSeatedPlayers(roomId);
    const outcome = await ownerCloseRoom(user.userId, roomId);
    if (!outcome.ok) {
      cb({ ok: false, error: outcome.error });
      return;
    }
    cancelAutoAction(roomId);
    clearRoomState(roomId);
    lastHandLogIdByRoom.delete(roomId);
    pendingRebuysByRoom.delete(roomId);
    await deleteHandLogsForRoom(roomId);
    const settlement = await buildOwnerCloseSettlement(roomId, players);
    cb({ ok: true });
    io.to(roomChannel(roomId)).emit('room:closed', {
      roomId,
      settlement: settlement ?? undefined,
    });
    io.to(LOBBY_ROOM).emit('lobby:room-removed', { roomId });
  });

  // Rebuy: only allowed once chipsAtTable hits 0; caller picks the amount,
  // capped at the chip leader's stack rounded to 500 (see rebuyChips for the
  // exact rule). Mid-hand → queued for hand end. Between-hand → applied
  // immediately.
  socket.on('room:rebuy', async ({ roomId, amount }, cb) => {
    if (hasActiveHand(roomId)) {
      queuePendingRebuy(roomId, user.userId, amount);
      cb({ ok: true });
      return;
    }
    const outcome = await rebuyChips(user.userId, roomId, amount);
    if (!outcome.ok) return cb({ ok: false, error: outcome.error });
    cb({ ok: true });
    await broadcastRoomDetail(roomId);

    // A between-hand rebuy might be exactly what was blocking the next hand
    // from starting (e.g. a busted-out player topping back up). Auto-resume
    // instead of making the owner click "開始牌局" again. Gated on at least
    // one prior hand so this never hijacks the room's very first hand start,
    // which the owner should still trigger explicitly.
    const priorHands = await countHandLogs(roomId);
    if (priorHands > 0) await startHandForRoom(roomId);
  });

  // ---- Game (Phase 2) ----
  socket.on('game:start', async ({ roomId }, cb) => {
    const detail = await getRoomDetail(roomId);
    if (!detail) return cb({ ok: false, error: '房間不存在' });
    if (detail.ownerId !== user.userId) {
      return cb({ ok: false, error: '只有房主可以開牌局' });
    }
    const outcome = await startHandForRoom(roomId);
    cb(outcome);
    // Let everyone (not just the owner) know why nothing's happening —
    // the busted-out player specifically needs to see this to know to rebuy.
    if (!outcome.ok && outcome.needsRebuy) {
      io.to(roomChannel(roomId)).emit('room:error', { message: outcome.error });
    }
  });

  socket.on('game:end', async ({ roomId }, cb) => {
    const detail = await getRoomDetail(roomId);
    if (!detail) return cb({ ok: false, error: '房間不存在' });
    if (detail.ownerId !== user.userId) {
      return cb({ ok: false, error: '只有房主可以結束牌局' });
    }
    cancelAutoAction(roomId);
    endHand(roomId);
    await setRoomStatus(roomId, 'waiting');
    cb({ ok: true });
    io.to(roomChannel(roomId)).emit('game:ended', { roomId });
    await broadcastRoomDetail(roomId);
  });

  socket.on('game:action', async ({ roomId, action }, cb) => {
    const phaseBefore = getHand(roomId)?.phase;
    const outcome = applyAction(roomId, user.userId, action);
    if (!outcome.ok) return cb({ ok: false, error: outcome.error });
    cb({ ok: true });
    await broadcastAfterAction(roomId, outcome.log, phaseBefore, outcome.ended);
  });

  // Voluntary reveal — any player still recorded in this ended hand.
  socket.on('game:show-cards', async ({ roomId }) => {
    const ok = applyReveal(roomId, user.userId);
    if (!ok) return;
    const hand = getHand(roomId);
    if (!hand?.endResult) return;
    // Re-emit so clients refresh their history/settlement view with the
    // newly-revealed cards.
    io.to(roomChannel(roomId)).emit('game:ended', {
      roomId,
      result: hand.endResult,
    });
    // Patch the persisted HandLog so refreshed clients see the reveal too.
    const handLogId = lastHandLogIdByRoom.get(roomId);
    if (handLogId) {
      try {
        await updateHandLogEndResult(handLogId, hand.endResult);
      } catch (err) {
        console.error('[server] updateHandLogEndResult error', err);
      }
    }
  });

  // ---- Chat ----
  socket.on('chat:send', ({ roomId, text }) => {
    const clean = String(text ?? '').trim().slice(0, 500);
    if (!clean) return;
    const payload = {
      from: user.name,
      userId: user.userId,
      text: clean,
      ts: Date.now(),
    };
    if (roomId) {
      io.to(roomChannel(roomId)).emit('chat:message', payload);
    } else {
      io.to(LOBBY_ROOM).emit('chat:message', payload);
    }
  });

  // ---- Cleanup ----
  socket.on('disconnect', async (reason) => {
    console.log(`[disconnect] ${socket.id} reason=${reason}`);
    // Milestone 2.5 model: don't unseat on disconnect. The seat + chipsAtTable
    // are preserved until the session settles. If it's the player's turn mid-
    // hand, `runAutoAction` (deadline timer) will auto-fold/check on their
    // behalf. Socket.IO auto-removes the socket from all its channels.
  });
});

// Periodic scan: session-expired rooms → auto-close with settlement.
// If a hand is in progress we wait (skip this scan; the next one after
// game:ended will find it still expired and close).
async function scanExpiredSessions() {
  try {
    const expired = await findExpiredRooms();
    for (const { id: roomId } of expired) {
      if (hasActiveHand(roomId)) continue; // wait for hand to end
      const settlement = await systemCloseRoomWithSettlement(
        roomId,
        'session-expired',
      );
      if (!settlement) continue;
      cancelAutoAction(roomId);
      clearRoomState(roomId);
      lastHandLogIdByRoom.delete(roomId);
      await deleteHandLogsForRoom(roomId);
      io.to(roomChannel(roomId)).emit('room:closed', {
        roomId,
        settlement,
      });
      io.to(LOBBY_ROOM).emit('lobby:room-removed', { roomId });
      console.log(`[server] auto-closed expired room ${roomId}`);
    }
  } catch (err) {
    console.error('[server] scanExpiredSessions error', err);
  }
}
setInterval(scanExpiredSessions, SESSION_EXPIRY_SCAN_MS);

httpServer.listen(PORT, () => {
  console.log(`[server] Socket.IO listening on http://localhost:${PORT}`);
  console.log(`[server] CORS origin: ${CORS_ORIGIN}`);
  // Kick off initial scan in case server restarted with already-expired rooms.
  scanExpiredSessions();
});
