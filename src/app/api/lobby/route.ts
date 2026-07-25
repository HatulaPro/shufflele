import { NextResponse } from 'next/server';
import { fail } from '@/lib/http';
import { createLobby, hostCookieName } from '@/lib/lobby';
import { LOBBY_TTL_SECONDS } from '@/lib/redis';

export const dynamic = 'force-dynamic';

/** Create a lobby, return its code, and set the host token cookie. */
export async function POST(): Promise<NextResponse> {
  try {
    const lobby = await createLobby();

    const res = NextResponse.json({ code: lobby.code });
    res.cookies.set(hostCookieName(lobby.code), lobby.hostToken, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
      maxAge: LOBBY_TTL_SECONDS,
    });
    return res;
  } catch (error) {
    return fail(error instanceof Error ? error.message : 'Could not create a lobby.', 500);
  }
}
