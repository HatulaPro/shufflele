import crypto from 'node:crypto';
import { cookies } from 'next/headers';
import type { NextRequest, NextResponse } from 'next/server';
import { fail, json } from '@/lib/http';
import {
  hostCookieName,
  joinCredit,
  loadLobby,
  loadTracks,
  rosterFor,
  saveLobby,
  saveTracks,
} from '@/lib/lobby';
import { IngestError, ingestPlaylist, parsePlaylistId } from '@/lib/spotify';
import type { Player } from '@/lib/types';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const MAX_PLAYERS = 16;

type Ctx = { params: Promise<{ code: string }> };

/**
 * Name + playlist URL from a guest phone. Ingests, then adds the player.
 *
 * Open for the whole life of the lobby, not just before the first song — a
 * latecomer to the party is still a player. What they can't do is change the
 * song already on air, so they come in from the next round. See lib/lobby.ts.
 */
export async function POST(req: NextRequest, ctx: Ctx): Promise<NextResponse> {
  const { code } = await ctx.params;
  const lobby = await loadLobby(code);
  if (!lobby) return fail('That lobby has expired or never existed.', 404);

  let body: { name?: unknown; playlistUrl?: unknown };
  try {
    body = await req.json();
  } catch {
    return fail('Malformed request.', 400);
  }

  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const playlistUrl = typeof body.playlistUrl === 'string' ? body.playlistUrl : '';

  if (name.length < 1 || name.length > 24) {
    return fail('Enter a name between 1 and 24 characters.', 400);
  }
  // Counted over the round they'd be joining, so a seat the host just freed is
  // usable immediately even though the player holding it is still on the list
  // until this song ends.
  if (rosterFor(lobby, lobby.currentRound + 1).length >= MAX_PLAYERS) {
    return fail(`This lobby is full (${MAX_PLAYERS} playlists).`, 400);
  }

  const playlistId = parsePlaylistId(playlistUrl);
  if (!playlistId) {
    return fail("That doesn't look like a Spotify playlist link.", 400);
  }
  if (lobby.players.some((p) => p.playlistId === playlistId)) {
    return fail('That playlist is already in this game.', 400);
  }

  let ingested;
  try {
    ingested = await ingestPlaylist(playlistId, name);
  } catch (error) {
    if (error instanceof IngestError) return fail(error.message, error.status);
    return fail('Could not read that playlist.', 502);
  }

  // Re-read the lobby: two phones can submit at the same moment.
  const fresh = (await loadLobby(code)) ?? lobby;
  if (fresh.players.some((p) => p.playlistId === playlistId)) {
    return fail('That playlist is already in this game.', 400);
  }

  const pool = await loadTracks(code);
  const player: Player = {
    id: crypto.randomUUID(),
    name,
    playlistId,
    playlistName: ingested.playlistName,
    trackCount: ingested.tracks.length,
    joinedAt: Date.now(),
    // Pre-game this is round 1, which is the next round to start anyway — so
    // "from the next song" and "right now" are the same statement.
    activeFrom: fresh.currentRound + 1,
    removedAfter: null,
    // Measured before they're on the list, against the pool as it stands.
    creditedRounds: joinCredit(fresh, pool),
  };

  // The host adds their own playlist through this same route, from the phone
  // running the game. That's where the lobby learns which player is theirs, and
  // therefore which row nobody gets to remove.
  const jar = await cookies();
  if (jar.get(hostCookieName(code))?.value === fresh.hostToken) {
    fresh.hostPlayerId = player.id;
  }

  await saveTracks(code, [...pool, ...ingested.tracks]);

  fresh.players.push(player);
  await saveLobby(fresh);

  return json({
    ok: true,
    playlistName: ingested.playlistName,
    trackCount: ingested.tracks.length,
    /** Their tracks are in from the next song rather than this one. */
    pending: fresh.currentRound > 0,
  });
}
