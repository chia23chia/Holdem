import { NextResponse } from 'next/server';
import { prisma, Prisma } from '@holdem/db';
import { auth } from '@/lib/auth';

const MAX_LEN = 100;

export async function PATCH(req: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthenticated' }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const raw = (body as { nickname?: unknown })?.nickname;
  if (typeof raw !== 'string') {
    return NextResponse.json({ error: 'nickname required' }, { status: 400 });
  }
  const nickname = raw.trim();
  if (!nickname) {
    return NextResponse.json({ error: '暱稱不可空白' }, { status: 400 });
  }
  if (nickname.length > MAX_LEN) {
    return NextResponse.json(
      { error: `暱稱長度上限 ${MAX_LEN} 字元` },
      { status: 400 },
    );
  }

  try {
    await prisma.user.update({
      where: { id: session.user.id },
      data: { nickname },
    });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      return NextResponse.json({ error: '這個暱稱已被使用' }, { status: 409 });
    }
    throw e;
  }

  return NextResponse.json({ nickname });
}
