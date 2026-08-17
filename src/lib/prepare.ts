import { findItunesMatch } from './itunes';
import { randomToken, saveRound } from './lobby';
import { parFor } from './par';
import { consumeGameCredit, refundGameCredit } from './ratelimit';
import { baseUrl, createSeparation } from './replicate';
import { pickSecret } from './select';
import type { Round, Track } from './types';
import { findPlayCount } from './youtube';

const MAX_PICK_ATTEMPTS = 8;

/**
 * Everything the caller needs to reconcile the lobby afterwards, without this
 * module ever writing the lobby itself. Two callers share the pick: the start
 * route (synchronous, the host is waiting) and the prefetch that runs while a
 * song is on air (see lib/prefetch.ts). Only the start route may advance
 * `currentRound` or spend a track's turn in `usedTrackIds`, so both of those
 * stay with the caller; the tracks found unusable along the way come back in
 * `unusable` for the caller to merge in.
 */
export type PrepareResult =
  | { ok: true; round: Round; unusable: string[] }
  | { ok: false; reason: 'limit'; limit: number; unusable: string[] }
  | { ok: false; reason: 'no-track'; unusable: string[] }
  | { ok: false; reason: 'separation'; message: string; unusable: string[] };

/**
 * Rate-limit check, pick a track, kick off Demucs, save the round. Returns as
 * soon as the prediction exists — completion arrives via the webhook (or the
 * round route's poll fallback). SPEC §3.3.
 */
export async function prepareRound(
  code: string,
  n: number,
  pool: Track[],
  excludedIds: Iterable<string>,
  played: Map<string, number>,
  opts: { prefetched?: boolean } = {},
): Promise<PrepareResult> {
  const unusable: string[] = [];

  const limit = await consumeGameCredit();
  if (!limit.allowed) {
    return { ok: false, reason: 'limit', limit: limit.limit, unusable };
  }

  // Selection and preview resolution are one loop, because a picked track may
  // have neither a Spotify preview nor an iTunes match. SPEC §3.2.
  const excluded = new Set(excludedIds);

  let chosen: Track | null = null;
  let previewUrl: string | null = null;

  for (let attempt = 0; attempt < MAX_PICK_ATTEMPTS; attempt++) {
    const eligible = pool.filter((t) => !excluded.has(t.spotifyId));
    if (eligible.length === 0) break;

    // Least-served contributor, then popularity-weighted inside their tracks.
    // See lib/select.ts.
    const track = pickSecret(eligible, played);
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

    // The one place a track silently leaves the game. Worth a line in the logs:
    // "that playlist never comes up" is indistinguishable from bad luck without
    // it, and a run of rejections all from one contributor is the tell.
    console.warn(
      `[prepare] ${code}: dropped "${track.title}" from ${track.contributor} — ` +
        `no iTunes match and no Spotify preview ` +
        `(attempt ${attempt + 1}/${MAX_PICK_ATTEMPTS})`,
    );

    excluded.add(track.spotifyId);
    unusable.push(track.spotifyId);
  }

  if (!chosen || !previewUrl) {
    await refundGameCredit();
    return { ok: false, reason: 'no-track', unusable };
  }

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
    return {
      ok: false,
      reason: 'separation',
      message: error instanceof Error ? error.message : 'Could not start the separation job.',
      unusable,
    };
  }

  const scoring = parFor(chosen.popularity);

  // Resolved here rather than lazily like the lyric hint: this is header
  // metadata, so it has to be there from the first row, and the round is about
  // to sit in Demucs for a minute anyway. Capped internally, null on failure.
  const playCount = await findPlayCount(chosen);

  const round: Round = {
    code,
    n,
    state: 'preparing',
    error: null,
    secret: chosen,
    par: scoring?.par ?? null,
    difficulty: scoring?.difficulty ?? null,
    playCount,
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
    ...(opts.prefetched ? { prefetched: true } : {}),
  };

  await saveRound(round);
  return { ok: true, round, unusable };
}
