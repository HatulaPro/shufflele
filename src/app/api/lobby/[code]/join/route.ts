import crypto from 'node:crypto';
import type { NextRequest, NextResponse } from 'next/server';
import { fail, json } from '@/lib/http';
import { loadLobby, loadTracks, saveLobby, saveTracks } from '@/lib/lobby';
import { IngestError, ingestPlaylist, parsePlaylistId } from '@/lib/spotify';
import type { Player } from '@/lib/types';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const MAX_PLAYERS = 16;

type Ctx = { params: Promise<{ code: string }> };

/** Name + playlist URL from a guest phone. Ingests, then adds the player. */
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
  if (lobby.players.length >= MAX_PLAYERS) {
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

  const player: Player = {
    id: crypto.randomUUID(),
    name,
    playlistId,
    playlistName: ingested.playlistName,
    trackCount: ingested.tracks.length,
    joinedAt: Date.now(),
  };

  const pool = await loadTracks(code);
  await saveTracks(code, [...pool, ...ingested.tracks]);

  fresh.players.push(player);
  await saveLobby(fresh);

  return json({
    ok: true,
    playlistName: ingested.playlistName,
    trackCount: ingested.tracks.length,
  });
}
