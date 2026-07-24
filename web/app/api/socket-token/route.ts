import { NextResponse } from 'next/server';
import jwt from 'jsonwebtoken';
import { auth } from '@/lib/auth';

// Issues a short-lived JWT the client hands to the Socket.IO server on handshake.
// Server verifies with the same NEXTAUTH_SECRET.
export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthenticated' }, { status: 401 });
  }

  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret) {
    return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });
  }

  const token = jwt.sign(
    { sub: session.user.id, name: session.user.name ?? 'unknown' },
    secret,
    { expiresIn: '5m' },
  );

  return NextResponse.json({ token });
}
