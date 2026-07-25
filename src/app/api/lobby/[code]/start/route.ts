import type { NextRequest, NextResponse } from 'next/server';
import { fail, json } from '@/lib/http';
import { findItunesMatch } from '@/lib/itunes';
import { applyCachedPopularity, fillPopularity } from '@/lib/deezer';
import { loadTracks, randomToken, requireHost, saveLobby, saveRound, saveTracks } from '@/lib/lobby';
import { parFor } from '@/lib/par';
import { consumeGameCredit, refundGameCredit } from '@/lib/ratelimit';
import { baseUrl, createSeparation } from '@/lib/replicate';
import { pickSecret, samplePool } from '@/lib/select';
import type { Round, Track } from '@/lib/types';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const MAX_PICK_ATTEMPTS = 8;

/**
 * Wall-clock ceiling on the Deezer pass. Vercel Hobby allows 300s per function
 * (fluid compute), so the limit here is the host staring at a button, not the
 * platform. Whatever doesn't resolve in time keeps a null popularity.
 */
const POPULARITY_BUDGET_MS = 25_000;

type Ctx = { params: Promise<{ code: string }> };

/**
 * Rate-limit check, pick a track, kick off Demucs. Returns as soon as the
 * prediction exists — the host then polls the round route. SPEC §3.3.
 */
export async function POST(_req: NextRequest, ctx: Ctx): Promise<NextResponse> {
  const { code } = await ctx.params;
  const auth = await requireHost(code);
  if (!auth.ok) return fail(auth.error, auth.status);
  const lobby = auth.lobby;

  const pool = await loadTracks(code);
  if (pool.length === 0) {
    return fail('Nobody has added a playlist yet.', 400);
  }

  const limit = await consumeGameCredit();
  if (!limit.allowed) {
    return fail(
      `Daily limit reached — Shufflele runs ${limit.limit} songs a day to keep the GPU bill honest. Come back tomorrow.`,
      429,
    );
  }

  // The pool is drawn once, on the first round, and reused for the rest of the
  // lobby. It can't happen at join time: the per-playlist quota is the total
  // divided by how many playlists there turn out to be, and players arrive one
  // at a time. Everything not drawn stays in Redis for the guess-modal search.
  if (!pool.some((track) => track.pooled)) {
    // Cache first, over the whole tracklist: anything a previous lobby already
    // scored gets pooled for free, and the Deezer budget is spent only on
    // tracks the cache couldn't answer. lib/deezer.ts, lib/select.ts.
    const resolved = await applyCachedPopularity(pool);
    const pooled = samplePool(pool, resolved);
    await fillPopularity(
      pooled.filter((track) => !resolved.has(track.spotifyId)),
      POPULARITY_BUDGET_MS,
    );
    await saveTracks(code, pool);
  }

  // Selection and preview resolution are one loop, because a picked track may
  // have neither a Spotify preview nor an iTunes match. SPEC §3.2.
  const excluded = new Set([...lobby.usedTrackIds, ...lobby.unusableTrackIds]);
  let chosen: Track | null = null;
  let previewUrl: string | null = null;

  for (let attempt = 0; attempt < MAX_PICK_ATTEMPTS; attempt++) {
    const eligible = pool.filter((t) => t.pooled && !excluded.has(t.spotifyId));
    if (eligible.length === 0) break;

    // Playlist-uniform, then popularity-weighted inside it. See lib/select.ts.
    const track = pickSecret(eligible);
    if (!track) break;

    // iTunes is the preview source. Spotify's own preview is the exact
    // recording, which is tempting, but its length is wildly inconsistent —
    // sampled across two playlists, only a third run the full ~30s and a third
    // are under 20s (16s for Architects' "Curse"). A short clip makes for a
    // bad round, so it's kept only as a fallback for tracks iTunes can't match
    // at all, where the alternative is skipping the track entirely.
    //
    // The lookup also carries album art and release year, which the embed has
    // no field for and this is the only place that needs.
    const match = await findItunesMatch(track);
    const preview = match?.previewUrl ?? track.previewUrl ?? null;

    if (preview) {
      chosen = {
        ...track,
        albumArt: match?.albumArt ?? track.albumArt,
        releaseYear: match?.releaseYear ?? track.releaseYear,
      };
      previewUrl = preview;
      break;
    }

    excluded.add(track.spotifyId);
    lobby.unusableTrackIds.push(track.spotifyId);
  }

  if (!chosen || !previewUrl) {
    await refundGameCredit();
    await saveLobby(lobby); // keep the "unusable" marks so we don't retry them
    return fail(
      "Couldn't find a playable track. Every song we tried is missing a preview — add another playlist and try again.",
      503,
    );
  }

  const n = lobby.currentRound + 1;
  const webhookKey = randomToken();
  const webhookUrl = `${baseUrl()}/api/replicate/webhook?code=${encodeURIComponent(
    code,
  )}&n=${n}&k=${encodeURIComponent(webhookKey)}`;

  let predictionId: string;
  try {
    const prediction = await createSeparation(previewUrl, webhookUrl);
    predictionId = prediction.id;
  } catch (error) {
    await refundGameCredit();
    await saveLobby(lobby);
    return fail(
      error instanceof Error ? error.message : 'Could not start the separation job.',
      502,
    );
  }

  const scoring = parFor(chosen.popularity);

  const round: Round = {
    code,
    n,
    state: 'preparing',
    error: null,
    secret: chosen,
    par: scoring?.par ?? null,
    difficulty: scoring?.difficulty ?? null,
    previewUrl,
    predictionId,
    webhookKey,
    stems: {},
    silentStems: [],
    ladder: null,
    currentRow: 1,
    guesses: [],
    createdAt: Date.now(),
    polledAt: 0,
  };

  await saveRound(round);

  lobby.currentRound = n;
  lobby.usedTrackIds.push(chosen.spotifyId);
  await saveLobby(lobby);

  return json({ n });
}
