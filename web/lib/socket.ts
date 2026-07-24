import { io, type Socket } from 'socket.io-client';
import type {
  ClientToServerEvents,
  ServerToClientEvents,
} from '@holdem/shared';

export type TypedSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

const SOCKET_URL =
  process.env.NEXT_PUBLIC_SOCKET_URL ?? 'http://localhost:3001';

// Fetches a short-lived JWT from /api/socket-token, then opens the socket with it.
export async function connectSocket(): Promise<TypedSocket> {
  const res = await fetch('/api/socket-token');
  if (!res.ok) throw new Error(`socket-token ${res.status}`);
  const { token } = (await res.json()) as { token: string };

  return io(SOCKET_URL, {
    auth: { token },
    transports: ['websocket'],
  });
}
