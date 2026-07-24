import jwt from 'jsonwebtoken';
import type { Socket } from 'socket.io';
import type { SocketTokenPayload } from '@holdem/shared';

const SECRET = process.env.NEXTAUTH_SECRET;
if (!SECRET) {
  throw new Error('NEXTAUTH_SECRET is required (must match web)');
}

export interface AuthedUser {
  userId: string;
  name: string;
}

// Socket.IO middleware: verifies the JWT from client handshake and attaches user info.
export function authMiddleware(
  socket: Socket,
  next: (err?: Error) => void,
): void {
  const token = (socket.handshake.auth as { token?: string } | undefined)?.token;
  if (!token) {
    return next(new Error('No token'));
  }
  try {
    const payload = jwt.verify(token, SECRET!) as SocketTokenPayload;
    if (!payload.sub) return next(new Error('Bad token payload'));
    socket.data.user = { userId: payload.sub, name: payload.name };
    next();
  } catch (err) {
    next(new Error(`Invalid token: ${(err as Error).message}`));
  }
}

export function getUser(socket: Socket): AuthedUser {
  const u = socket.data.user as AuthedUser | undefined;
  if (!u) throw new Error('Socket has no authed user');
  return u;
}
