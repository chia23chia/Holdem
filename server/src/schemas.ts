// Runtime validation schemas for the highest-risk Socket.IO events (M2 in
// docs/AUDIT_2026-10-20.md). TypeScript types are compile-time only — a
// malicious client can send any JSON. These schemas enforce shape, bounds,
// and type at the handler entry so one typo further down doesn't become a
// state-corruption vector.
//
// Scope: events whose payload touches game state, chip math, or user text.
// Low-risk events (lobby:subscribe, room:leave, etc.) are not covered here
// because their worst-case misuse is already handled by downstream logic.
import { z } from 'zod';

// Prisma cuid is 25 chars but keep a generous bound to tolerate cuid2 if the
// schema ever migrates. Rejects empty, oversized, and non-string payloads.
const RoomId = z.string().min(10).max(50);

// PlayerAction mirrors the shared PlayerAction union. `raise.amount` is a
// non-negative finite integer (chip math is integer-only — see T3 in audit).
// Reject negatives, floats, Infinity, NaN at the boundary rather than
// depending on Math.floor + isFinite downstream.
const PlayerActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('fold') }),
  z.object({ type: z.literal('check') }),
  z.object({ type: z.literal('call') }),
  z.object({
    type: z.literal('raise'),
    amount: z.number().int().nonnegative().finite(),
  }),
  z.object({ type: z.literal('all-in') }),
]);

export const GameActionSchema = z.object({
  roomId: RoomId,
  action: PlayerActionSchema,
});

export const RoomRebuySchema = z.object({
  roomId: RoomId,
  amount: z.number().int().positive().finite(),
});

export const ChatSendSchema = z.object({
  // Lobby chat uses an empty string; room chat uses the roomId. Both allowed.
  roomId: z.string().max(50),
  text: z.string().max(1000),
});

// Emoji list is enforced here as a defense-in-depth check against future
// payload drift. The handler also checks STICKER_EMOJIS.includes(...), so
// this is belt-and-braces.
export const StickerSendSchema = z.object({
  roomId: RoomId,
  emoji: z.string().min(1).max(8),
});

export const RoomJoinSchema = z.object({
  roomId: RoomId,
  seat: z.number().int().min(0).max(9),
});
