// Structured logger (O1 in docs/AUDIT_2026-10-20.md). Replaces free-form
// console.log so that prod incidents can be grepped by roomId / userId /
// event / handNumber instead of string-matching.
//
// Thin wrapper over pino. In production the output is single-line JSON per
// event, which pipes well into docker logs → journald → eventual log
// aggregator. In dev we keep it human-readable.
//
// Usage:
//   log.info({ roomId, userId }, 'seat taken');
//   log.error({ roomId, err }, 'persistHandResult failed');
//
// Keep plain console.* only for the startup banners and anywhere a
// one-line human readable line beats JSON structure (none, currently).
import { pino } from 'pino';

const isProd = process.env.NODE_ENV === 'production';

export const log = pino({
  level: process.env.LOG_LEVEL ?? (isProd ? 'info' : 'debug'),
  // In dev, pretty-print to stdout (pino-pretty is a devDep we don't want
  // to require); use JSON everywhere for consistency. docker logs handles
  // the volume. If we ever add pino-pretty, switch here under !isProd.
  base: { service: 'holdem-server' },
  timestamp: pino.stdTimeFunctions.isoTime,
});

// Convenience factory for a scoped child logger when a function cluster
// shares a context (e.g. one hand's lifecycle).
export function withRoom(roomId: string, extra?: Record<string, unknown>) {
  return log.child({ roomId, ...extra });
}
