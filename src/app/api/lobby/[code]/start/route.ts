import type { NextRequest, NextResponse } from 'next/server';
import { fail, json } from '@/lib/http';
import { findItunesMatch } from '@/lib/itunes';
import { loadTracks, randomToken, requireHost, saveLobby, saveRound } from '@/lib/lobby';
import { parFor } from '@/lib/par';
import { consumeGameCredit, refundGameCredit } from '@/lib/ratelimit';
import { baseUrl, createSeparation } from '@/lib/replicate';
import { pickSecret } from '@/lib/select';
import type { Round, Track } from '@/lib/types';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const MAX_PICK_ATTEMPTS = 8;

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

  // Selection and preview resolution are one loop, because a picked track may
  // have neither a Spotify preview nor an iTunes match. SPEC §3.2.
  const excluded = new Set([...lobby.usedTrackIds, ...lobby.unusableTrackIds]);
  let chosen: Track | null = null;
  let previewUrl: string | null = null;

  for (let attempt = 0; attempt < MAX_PICK_ATTEMPTS; attempt++) {
    const eligible = pool.filter((t) => !excluded.has(t.spotifyId));
    if (eligible.length === 0) break;

    // Playlist-uniform, then popularity-weighted inside it. See lib/select.ts.
    const track = pickSecret(eligible);
    if (!track) break;

    // iTunes is the preview source, and now the only thing it is asked for.
    // Spotify's own preview is the exact recording, which is tempting, but its
    // length is wildly inconsistent — sampled across two playlists, only a
    // third run the full ~30s and a third are under 20s (16s for Architects'
    // "Curse"). A short clip makes for a bad round, so it's kept only as a
    // fallback for tracks iTunes can't match at all, where the alternative is
    // skipping the track entirely. Roughly one track in seven has no Spotify
    // preview either, and those are the ones a missed match costs us.
    //
    // Album art and release year used to come from here too. They arrive with
    // the tracklist now, so a track iTunes fluffs still reveals properly.
    const match = await findItunesMatch(track);
    const preview = match?.previewUrl ?? track.previewUrl ?? null;

    if (preview) {
      chosen = {
        ...track,
        albumArt: track.albumArt ?? match?.albumArt ?? null,
        releaseYear: track.releaseYear ?? match?.releaseYear ?? null,
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
