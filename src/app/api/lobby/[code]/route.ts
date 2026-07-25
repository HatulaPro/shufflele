import { cookies } from 'next/headers';
import type { NextRequest, NextResponse } from 'next/server';
import { fail, json } from '@/lib/http';
import { hostCookieName, loadLobby } from '@/lib/lobby';
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
  const trackCount = lobby.sources.reduce((sum, s) => sum + s.trackCount, 0);

  const body: PublicLobby = {
    code: lobby.code,
    isHost,
    players: lobby.players.map((p) => ({ id: p.id, name: p.name })),
    // Guests would see the answer to the "which playlist?" guess tier.
    sources: isHost
      ? lobby.sources.map((s) => ({
          playlistId: s.playlistId,
          playlistName: s.playlistName,
          trackCount: s.trackCount,
        }))
      : [],
    trackCount,
    currentRound: lobby.currentRound,
    canStart: trackCount > 0,
  };

  return json(body);
}
