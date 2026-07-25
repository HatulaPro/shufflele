import type { NextRequest, NextResponse } from 'next/server';
import { fail, json } from '@/lib/http';
import { loadLobby, loadTracks, requireHost, saveLobby, saveTracks } from '@/lib/lobby';
import { IngestError, ingestPlaylist, listOwnPlaylists } from '@/lib/spotify';
import type { OwnedPlaylist, PlaylistSource } from '@/lib/types';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const MAX_SOURCES = 8;

type Ctx = { params: Promise<{ code: string }> };

/** The host's own playlists, for the picker. Host only. */
export async function GET(_req: NextRequest, ctx: Ctx): Promise<NextResponse> {
  const { code } = await ctx.params;
  const auth = await requireHost(code);
  if (!auth.ok) return fail(auth.error, auth.status);

  let owned;
  try {
    owned = await listOwnPlaylists();
  } catch (error) {
    if (error instanceof IngestError) return fail(error.message, error.status);
    return fail('Could not read your Spotify playlists.', 502);
  }

  const added = new Set(auth.lobby.sources.map((s) => s.playlistId));
  const body: OwnedPlaylist[] = owned.map((p) => ({
    id: p.id,
    name: p.name,
    trackCount: p.trackCount,
    image: p.image,
    added: added.has(p.id),
  }));

  return json(body);
}

/** Ingest one of the host's playlists into the pool. Host only. */
export async function POST(req: NextRequest, ctx: Ctx): Promise<NextResponse> {
  const { code } = await ctx.params;
  const auth = await requireHost(code);
  if (!auth.ok) return fail(auth.error, auth.status);

  let body: { playlistId?: unknown };
  try {
    body = await req.json();
  } catch {
    return fail('Malformed request.', 400);
  }

  const playlistId = typeof body.playlistId === 'string' ? body.playlistId.trim() : '';
  if (!/^[A-Za-z0-9]{16,30}$/.test(playlistId)) {
    return fail('That is not a playlist id.', 400);
  }
  if (auth.lobby.sources.length >= MAX_SOURCES) {
    return fail(`That's ${MAX_SOURCES} playlists — plenty for one game.`, 400);
  }
  if (auth.lobby.sources.some((s) => s.playlistId === playlistId)) {
    return fail('That playlist is already in this game.', 400);
  }

  let ingested;
  try {
    ingested = await ingestPlaylist(playlistId);
  } catch (error) {
    if (error instanceof IngestError) return fail(error.message, error.status);
    return fail('Could not read that playlist.', 502);
  }

  // Re-read: the host could have tapped twice.
  const fresh = (await loadLobby(code)) ?? auth.lobby;
  if (fresh.sources.some((s) => s.playlistId === playlistId)) {
    return fail('That playlist is already in this game.', 400);
  }

  const source: PlaylistSource = {
    playlistId,
    playlistName: ingested.playlistName,
    trackCount: ingested.tracks.length,
    addedAt: Date.now(),
  };

  // Tracks already pooled from another playlist win — a song in two playlists
  // is attributed to whichever was added first, and never duplicated.
  const pool = await loadTracks(code);
  const known = new Set(pool.map((t) => t.spotifyId));
  const fresh_tracks = ingested.tracks.filter((t) => !known.has(t.spotifyId));
  await saveTracks(code, [...pool, ...fresh_tracks]);

  fresh.sources.push({ ...source, trackCount: fresh_tracks.length });
  await saveLobby(fresh);

  return json({
    ok: true,
    playlistName: ingested.playlistName,
    trackCount: fresh_tracks.length,
    duplicates: ingested.tracks.length - fresh_tracks.length,
  });
}
