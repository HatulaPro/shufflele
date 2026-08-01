import type { NextRequest, NextResponse } from 'next/server';
import { fail, json } from '@/lib/http';
import {
  loadTracks,
  playsIn,
  requireHost,
  saveLobby,
  saveTracks,
  toPublicLobby,
} from '@/lib/lobby';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ code: string; id: string }> };

/**
 * The host removing a player. Allowed at any point in the game, but it lands on
 * the next round rather than this one: a playlist that is part of the song
 * currently on air stays in the guess list until that song is done, and only
 * then do they and their tracks leave the pool. See lib/lobby.ts.
 *
 * Returns the lobby as it now reads, so the panel that fired this doesn't have
 * to wait for its next poll to redraw.
 */
export async function DELETE(_req: NextRequest, ctx: Ctx): Promise<NextResponse> {
  const { code, id } = await ctx.params;
  const auth = await requireHost(code);
  if (!auth.ok) return fail(auth.error, auth.status);
  const lobby = auth.lobby;

  const player = lobby.players.find((p) => p.id === id);
  if (!player) return fail('That player has already left the lobby.', 404);

  // The host is a player like everyone else, with one exception: the game runs
  // on their phone, so they are the one person who can't be taken out of it.
  if (player.id === lobby.hostPlayerId) {
    return fail("That's your own playlist — ending the game is the way out.", 400);
  }

  const n = lobby.currentRound;

  // A running game has to have something to play next. An empty lobby is fine
  // before the first song — it's where every lobby starts, and the host can
  // read the code out again — but emptying one mid-game leaves nothing for
  // "Next song" to draw from.
  if (n > 0 && !lobby.players.some((p) => p.id !== id && playsIn(p, n + 1))) {
    return fail(
      "That's the last playlist in the game — add another one before removing it.",
      400,
    );
  }

  if (playsIn(player, n)) {
    player.removedAfter = n;
    await saveLobby(lobby);
  } else {
    // Nothing on air is looking at their tracks: either the game hasn't started
    // or they were still waiting for the next song. They go now, and their
    // playlist is free to be added again.
    lobby.players = lobby.players.filter((p) => p.id !== id);
    const pool = await loadTracks(code);
    await saveTracks(
      code,
      pool.filter((track) => track.playlistId !== player.playlistId),
    );
    await saveLobby(lobby);
  }

  return json(toPublicLobby(lobby, true));
}
