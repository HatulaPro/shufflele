import { cookies } from 'next/headers';
import type { NextRequest, NextResponse } from 'next/server';
import { fail, json } from '@/lib/http';
import { deleteLobby, hostCookieName, loadLobby, requireHost } from '@/lib/lobby';
import type { PublicLobby } from '@/lib/types';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ code: string }> };

/** Lobby status and player list. The host polls this every 2s. */
export async function GET(_req: NextRequest, ctx: Ctx): Promise<NextResponse> {
  const { code } = await ctx.params;
  const lobby = await loadLobby(code);
  if (!lobby) return fail('That lobby has expired or never existed.', 404);

  const jar = await cookies();
  const isHost = jar.get(hostCookieName(code))?.value === lobby.hostToken;
  const trackCount = lobby.players.reduce((sum, p) => sum + p.trackCount, 0);

  const body: PublicLobby = {
    code: lobby.code,
    isHost,
    // The playlist's name never reaches the host screen — an audience can read
    // that screen, and a playlist title is a giveaway. SPEC §1.5.
    players: lobby.players.map((p) => ({
      id: p.id,
      name: p.name,
      trackCount: p.trackCount,
    })),
    trackCount,
    currentRound: lobby.currentRound,
    canStart: trackCount > 0,
  };

  return json(body);
}

/** The host ending the game. Closes the lobby and drops the host cookie. */
export async function DELETE(_req: NextRequest, ctx: Ctx): Promise<NextResponse> {
  const { code } = await ctx.params;
  const auth = await requireHost(code);
  if (!auth.ok) return fail(auth.error, auth.status);

  await deleteLobby(auth.lobby);
  const jar = await cookies();
  jar.delete(hostCookieName(code));

  return json({ ok: true });
}
