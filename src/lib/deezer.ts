import { coreTitle, looseSimilarity, normalize } from './normalize';
import {
  POPULARITY_MISS_TTL_SECONDS,
  POPULARITY_TTL_SECONDS,
  keys,
  redis,
} from './redis';
import type { Track } from './types';

/**
 * Popularity, from Deezer, because Spotify no longer gives us any.
 *
 * `GET /v1/tracks` returns 403 for a Client Credentials app, and even the
 * single-track endpoint that *does* answer omits `popularity` entirely — the
 * field is gone from the payload for apps without extended quota mode, which
 * needs a company and a review. Deezer's search carries a `rank` per track,
 * needs no key at all, and is the only free source verified to cover deep
 * catalogue rather than a current top-100.
 *
 * A track that can't be matched keeps `popularity: null`, which every consumer
 * already handles: `parFor` hides the difficulty header, and `weightsFor`
 * treats the track as typical for its playlist rather than unpickable.
 */

/** Deezer's `rank` is 0–1,000,000, so a search hit near the top is ~950k+. */
const DEEZER_SEARCH = 'https://api.deezer.com/search';

/**
 * Deezer allows ~50 requests per 5s per IP. On Vercel Hobby the egress IP is
 * shared with other tenants (static IPs are a Pro feature), so that bucket is
 * not ours alone — hence pacing well under the ceiling, and treating a quota
 * refusal as a soft miss rather than an error.
 */
const SPACING_MS = 120;
const CONCURRENCY = 6;

/** Quota refusals come back as HTTP 200 with this in the body. `res.ok` is a lie. */
const QUOTA_CODE = 4;
const QUOTA_BACKOFF_MS = 1200;

/**
 * Same shape of judgement as the iTunes matcher: a loose query plus fuzzy
 * scoring. Deezer's own field syntax (`artist:"…" track:"…"`) is not usable —
 * it returns nothing for tracks that plainly exist, Taylor Swift's "Cruel
 * Summer" among them.
 */
const MIN_TITLE_SIM = 0.7;
const MIN_ARTIST_SIM = 0.5;
const MIN_SCORE = 0.68;

type DeezerTrack = {
  title?: string;
  rank?: number;
  artist?: { name?: string };
};

type DeezerSearch = {
  data?: DeezerTrack[];
  error?: { code?: number; message?: string };
};

/**
 * Rank onto Spotify's old 0–100 scale, so `parFor`, `weightsFor` and the
 * loading-screen lines all keep the units they were written against.
 *
 * Piecewise-linear rather than a formula because rank is badly compressed at
 * the top — the gap between a global smash and a well-known album track is a
 * few percent of the range, while the entire long tail lives under 500k. The
 * anchors come from a sampled spread: Creep 978k, Tame Impala's "The Less I
 * Know The Better" 941k, HUMBLE. 814k, Sufjan 634k, Snail Mail 315k, black
 * midi 158k.
 */
const CURVE: [rank: number, score: number][] = [
  [0, 0],
  [100_000, 12],
  [300_000, 30],
  [500_000, 45],
  [650_000, 55],
  [800_000, 68],
  [900_000, 78],
  [950_000, 88],
  [1_000_000, 100],
];

export function scoreForRank(rank: number): number {
  if (!Number.isFinite(rank) || rank <= 0) return 0;

  for (let i = 1; i < CURVE.length; i++) {
    const [hiRank, hiScore] = CURVE[i];
    if (rank > hiRank) continue;

    const [loRank, loScore] = CURVE[i - 1];
    const t = (rank - loRank) / (hiRank - loRank);
    return Math.round(loScore + t * (hiScore - loScore));
  }

  return 100;
}

/** Best-scoring Deezer hit for a track, or null when nothing clears the bars. */
function bestMatch(track: Track, results: DeezerTrack[]): number | null {
  const artist = track.artists[0]?.name ?? '';

  const wantTitle = coreTitle(track.title);
  const wantTitleFull = normalize(track.title);
  const wantArtist = normalize(artist);

  let best: { score: number; rank: number } | null = null;

  for (const r of results) {
    if (typeof r.rank !== 'number' || !r.title || !r.artist?.name) continue;

    const titleSim = Math.max(
      looseSimilarity(wantTitle, coreTitle(r.title)),
      looseSimilarity(wantTitleFull, normalize(r.title)),
    );
    const artistSim = looseSimilarity(wantArtist, normalize(r.artist.name));

    if (titleSim < MIN_TITLE_SIM || artistSim < MIN_ARTIST_SIM) continue;

    const score = 0.62 * titleSim + 0.38 * artistSim;
    if (score < MIN_SCORE) continue;

    if (!best || score > best.score) best = { score, rank: r.rank };
  }

  return best?.rank ?? null;
}

/**
 * One search. Returns the rank, 'unmatched' when Deezer answered but nothing
 * cleared the similarity bars, or null for "no usable answer" — a quota
 * refusal that survived its retry, or a network blip.
 *
 * Downstream both non-ranks leave `popularity` null; the split only matters to
 * the cache, which may remember a real absence but not a bad second.
 */
async function rankFor(track: Track, signal: AbortSignal): Promise<number | 'unmatched' | null> {
  const artist = track.artists[0]?.name ?? '';
  const url = `${DEEZER_SEARCH}?limit=5&q=${encodeURIComponent(`${artist} ${track.title}`)}`;

  for (let attempt = 0; attempt < 2; attempt++) {
    if (signal.aborted) return null;

    let body: DeezerSearch;
    try {
      const res = await fetch(url, { cache: 'no-store', signal });
      if (!res.ok) return null;
      body = (await res.json()) as DeezerSearch;
    } catch {
      return null;
    }

    if (body.error?.code === QUOTA_CODE) {
      // One backoff, then give up on this track rather than spending the
      // budget queueing behind a bucket we don't control.
      if (attempt === 0) await sleep(QUOTA_BACKOFF_MS);
      continue;
    }

    return bestMatch(track, body.data ?? []) ?? 'unmatched';
  }

  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- cross-lobby cache -------------------------------------------------------

/**
 * Scores are global facts about a track, not lobby state, so they're cached in
 * Redis across lobbies: the second game to pool a song skips its Deezer search
 * entirely. A confirmed miss is stored as -1 (with a much shorter TTL) so a
 * track Deezer doesn't know isn't re-searched by every lobby that pools it.
 *
 * Both helpers swallow Redis errors — the cache losing a round means a slower
 * start, never a failed one.
 */
const MISS = -1;

/**
 * Apply cached scores to the given tracks, in place, and return the ids the
 * cache had an answer for — including known misses, since those tracks need no
 * Deezer search either (a lookup would just fail again).
 *
 * This runs over the *whole* tracklist, before pooling, precisely so pooling
 * can treat resolved tracks as free: the Deezer budget caps lookups, and a
 * cache hit isn't one. One MGET regardless of size.
 */
export async function applyCachedPopularity(tracks: Track[]): Promise<Set<string>> {
  const cached = await readPopularityCache(tracks);

  const resolved = new Set<string>();
  for (const track of tracks) {
    const score = cached.get(track.spotifyId);
    if (score === undefined) continue;
    resolved.add(track.spotifyId);
    if (score !== MISS) track.popularity = score;
  }
  return resolved;
}

async function readPopularityCache(tracks: Track[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (tracks.length === 0) return out;

  try {
    const cached = await redis().mget<(number | null)[]>(
      ...tracks.map((t) => keys.popularity(t.spotifyId)),
    );
    tracks.forEach((track, i) => {
      const value = cached[i];
      if (typeof value === 'number') out.set(track.spotifyId, value);
    });
  } catch {
    // Cold cache; every track just goes through Deezer as before.
  }

  return out;
}

async function writePopularityCache(entries: [spotifyId: string, score: number][]): Promise<void> {
  if (entries.length === 0) return;

  try {
    const pipeline = redis().pipeline();
    for (const [spotifyId, score] of entries) {
      pipeline.set(keys.popularity(spotifyId), score, {
        ex: score === MISS ? POPULARITY_MISS_TTL_SECONDS : POPULARITY_TTL_SECONDS,
      });
    }
    await pipeline.exec();
  } catch {
    // The next lobby pays for the search again. Nothing else is affected.
  }
}

/**
 * Fill `popularity` on the given tracks via Deezer, in place, within a time
 * budget. The caller is expected to have run `applyCachedPopularity` first and
 * to pass only the tracks the cache couldn't answer for — everything given
 * here costs a real search.
 *
 * Whatever the budget doesn't cover simply stays null. That's the whole
 * failure strategy: partial data degrades the difficulty header and the
 * selection weighting for a few tracks, where a thrown error would take down
 * the round that needed them.
 */
export async function fillPopularity(tracks: Track[], budgetMs: number): Promise<number> {
  if (tracks.length === 0) return 0;

  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), budgetMs);

  let next = 0;
  let filled = 0;
  const learned: [string, number][] = [];

  const worker = async (): Promise<void> => {
    while (next < tracks.length && !controller.signal.aborted) {
      const track = tracks[next++];
      const rank = await rankFor(track, controller.signal);
      if (typeof rank === 'number') {
        track.popularity = scoreForRank(rank);
        learned.push([track.spotifyId, track.popularity]);
        filled++;
      } else if (rank === 'unmatched') {
        learned.push([track.spotifyId, MISS]);
      }
      // Paced per worker, so the fleet averages CONCURRENCY/SPACING_MS ≈ 50
      // requests per second at the ceiling — comfortably under Deezer's.
      await sleep(SPACING_MS * CONCURRENCY);
    }
  };

  try {
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  } finally {
    clearTimeout(deadline);
  }

  await writePopularityCache(learned);

  return filled;
}
