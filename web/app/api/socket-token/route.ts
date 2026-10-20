import { NextResponse } from 'next/server';
import jwt from 'jsonwebtoken';
import { auth } from '@/lib/auth';

// Issues a short-lived JWT the client hands to the Socket.IO server on handshake.
// Server verifies with the same SOCKET_JWT_SECRET. Kept separate from
// NEXTAUTH_SECRET so a leak of either doesn't compromise the other channel.
export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthenticated' }, { status: 401 });
  }

  const secret = process.env.SOCKET_JWT_SECRET;
  if (!secret) {
    return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });
  }

  const token = jwt.sign(
    { sub: session.user.id, name: session.user.name ?? 'unknown' },
    secret,
    { algorithm: 'HS256', expiresIn: '60s' },
  );

  return NextResponse.json({ token });
}
