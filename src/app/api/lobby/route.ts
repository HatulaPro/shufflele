import { NextResponse } from 'next/server';
import { fail } from '@/lib/http';
import { createLobby, hostCookieName } from '@/lib/lobby';
import { LOBBY_TTL_SECONDS } from '@/lib/redis';
import { isLobbyMode } from '@/lib/types';
import type { LobbyMode } from '@/lib/types';

export const dynamic = 'force-dynamic';

/** Create a lobby (either game mode), return its code, and set the host token cookie. */
export async function POST(req: Request): Promise<NextResponse> {
  let mode: LobbyMode = 'classic';
  try {
    const body = (await req.json()) as { mode?: unknown };
    if (isLobbyMode(body.mode)) mode = body.mode;
  } catch {
    // No body at all means classic — the original flow.
  }

  try {
    const lobby = await createLobby(mode);

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
