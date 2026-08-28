import { mockEnabled } from './mock';
import { coreTitle, looseSimilarity, normalize, plainTitle } from './normalize';
import { keys, redis, YT_VIDEO_MISS_TTL_SECONDS, YT_VIDEO_TTL_SECONDS } from './redis';
import type { Track } from './types';

/**
 * Finds the YouTube video that *is* a track, so Rush can play a song from its
 * real beginning. SPEC §1.2 covers the play-count chip; this is a different
 * job with a different failure mode, hence a separate module from
 * lib/youtube.ts.
 *
 * Why this exists at all: a preview URL — Apple's or Spotify's — is a
 * pre-cut ~30s excerpt taken from the middle of the recording. It is a file,
 * not a stream, so there is no offset to pass and no way to ask for the top.
 * The only way to hear bar one is a full-length source, and the only one that
 * needs neither a per-player login nor a Premium subscription is YouTube,
 * played client-side in an iframe (lib/../components/RushGame.tsx).
 *
 * Two things make this cheap where the Data API is not:
 *
 * - **No key, no quota.** `search.list` costs 100 units against a 10,000/day
 *   default — 100 lookups a day for the entire deployment, which one Rush run
 *   can eat a sixth of. The endpoint below is the one music.youtube.com calls
 *   for its own search box. It takes no key and has no published ceiling.
 * - **Songs, not videos.** The `params` blob is YouTube Music's "Songs" filter,
 *   so results are catalogue entries rather than uploads. In practice they come
 *   back as `MUSIC_VIDEO_TYPE_ATV` — an *art track*, the auto-generated
 *   art-and-audio upload for a catalogue recording. That type is the whole
 *   point: an art track is the master, so it starts on the first bar. An
 *   official music video (`OMV`) routinely opens with a film intro, dialogue or
 *   a cold open, which is precisely the thing we are trying to get away from.
 *
 * Being an undocumented endpoint, it is treated as best-effort throughout: any
 * failure returns null and Rush falls back to the preview clip it plays today.
 * See `resolveFullTrack` in lib/rush.ts.
 */
const SEARCH = 'https://music.youtube.com/youtubei/v1/search?prettyPrint=false';

/**
 * YouTube Music's "Songs" tab, as the web client sends it. Opaque protobuf,
 * copied from the real request — without it the response mixes albums,
 * playlists and artist cards into the same shelf and the top hit is often not
 * a track at all.
 */
const SONGS_FILTER = 'EgWKAQIIAWoKEAkQBRAKEAMQBA==';

/** The client identity the endpoint expects. Nothing here is account-bound. */
const CLIENT = { clientName: 'WEB_REMIX', clientVersion: '1.20240401.01.00', hl: 'en', gl: 'US' };

/**
 * Deals block on this, so it is held well under the iTunes timeout. A miss
 * costs a preview-clip fallback, not a stalled run.
 */
const TIMEOUT_MS = 3000;

/** Rows to score. The Songs shelf puts the catalogue entry in the first few. */
const CANDIDATES = 8;

/** Below this a candidate is a different song, whatever else lines up. */
const MIN_TITLE_SIMILARITY = 0.5;

/**
 * How far a candidate's runtime may sit from Spotify's before it stops being
 * the same recording. Masters and encodes disagree by a second or two; a radio
 * edit, an extended mix or a live take disagree by far more, and those are
 * exactly the rows that look right on title alone.
 */
const DURATION_TOLERANCE_MS = 10_000;

/** Near-exact runtime is the strongest single signal that this is the master. */
const DURATION_EXACT_MS = 2_500;

/**
 * Words that mean "not the recording we want". Only held against a candidate
 * when the track's own title doesn't contain them — a song actually called
 * "Live Forever" must not be punished for it. Mirrors lib/itunes.ts.
 */
const SUSPECT = [
  'live',
  'karaoke',
  'tribute',
  'cover',
  'remix',
  'instrumental',
  'acoustic',
  'demo',
  'sped up',
  'slowed',
  'reverb',
  'mashup',
  'edit',
];

type Row = {
  videoId: string;
  musicVideoType: string | null;
  title: string;
  /** The artist • album • duration line, split on its separators. */
  details: string[];
};

// --- response walking ------------------------------------------------------

/**
 * The payload is a deep tree of renderer objects whose exact nesting is not
 * ours to rely on — it is an internal UI description and it moves. Everything
 * below searches by key rather than by path, so a layout change costs nothing
 * as long as the field names survive.
 */
function collectRenderers(node: unknown, out: Record<string, unknown>[]): void {
  if (Array.isArray(node)) {
    for (const child of node) collectRenderers(child, out);
    return;
  }
  if (!node || typeof node !== 'object') return;

  const record = node as Record<string, unknown>;
  const item = record.musicResponsiveListItemRenderer;
  if (item && typeof item === 'object') out.push(item as Record<string, unknown>);

  for (const value of Object.values(record)) collectRenderers(value, out);
}

/** First value for `key` anywhere beneath `node`. */
function findKey(node: unknown, key: string): unknown {
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findKey(child, key);
      if (hit !== undefined) return hit;
    }
    return undefined;
  }
  if (!node || typeof node !== 'object') return undefined;

  const record = node as Record<string, unknown>;
  if (key in record) return record[key];

  for (const value of Object.values(record)) {
    const hit = findKey(value, key);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

/** The `runs` texts of one flex column, which is how every label is spelled. */
function columnRuns(column: unknown): string[] {
  const runs = findKey(column, 'runs');
  if (!Array.isArray(runs)) return [];
  return runs
    .map((run) => (run as { text?: unknown }).text)
    .filter((text): text is string => typeof text === 'string');
}

function parseRows(payload: unknown): Row[] {
  const renderers: Record<string, unknown>[] = [];
  collectRenderers(payload, renderers);

  const rows: Row[] = [];
  for (const renderer of renderers) {
    const videoId = findKey(renderer, 'videoId');
    if (typeof videoId !== 'string' || !videoId) continue;

    const columns = Array.isArray(renderer.flexColumns) ? renderer.flexColumns : [];
    const title = columnRuns(columns[0]).join('').trim();
    if (!title) continue;

    const musicVideoType = findKey(renderer, 'musicVideoType');
    rows.push({
      videoId,
      musicVideoType: typeof musicVideoType === 'string' ? musicVideoType : null,
      title,
      // The separator runs are bullets padded with spaces; dropping the blanks
      // leaves artist, album and duration as their own entries.
      details: columnRuns(columns[1])
        .map((run) => run.trim())
        .filter((run) => run && run !== '•'),
    });
  }
  return rows;
}

/** "5:21" and "1:02:33" both, in ms. Null for anything else. */
function parseDuration(label: string): number | null {
  if (!/^\d{1,2}(:\d{2}){1,2}$/.test(label)) return null;
  const parts = label.split(':').map(Number);
  const seconds = parts.reduce((total, part) => total * 60 + part, 0);
  return seconds > 0 ? seconds * 1000 : null;
}

function rowDuration(row: Row): number | null {
  for (const detail of row.details) {
    const ms = parseDuration(detail);
    if (ms !== null) return ms;
  }
  return null;
}

// --- scoring ---------------------------------------------------------------

/**
 * How well one row matches the track, or null to reject it.
 *
 * The artist is deliberately *not* required. YouTube Music romanises names —
 * a Spotify track credited "עומר אדם" comes back as "Omer Adam", and the same
 * goes for Japanese, Cyrillic and Korean catalogue — so demanding an artist
 * match would reject every non-Latin track outright, which is the bug
 * `normalize` was widened to fix in the first place. Instead the artist is one
 * of three corroborating signals, and a row needs any one of them on top of a
 * title that already looks right.
 */
function scoreRow(track: Track, row: Row): number | null {
  // An art track is the master recording. Anything else — official video, live
  // upload, user content — has no promise about where the audio starts, which
  // is the only reason we are here.
  if (row.musicVideoType !== 'MUSIC_VIDEO_TYPE_ATV') return null;

  const wantTitle = coreTitle(track.title);
  const gotTitle = coreTitle(row.title);
  const titleSimilarity = Math.max(
    looseSimilarity(wantTitle, gotTitle),
    looseSimilarity(normalize(track.title), normalize(row.title)),
  );
  if (titleSimilarity < MIN_TITLE_SIMILARITY) return null;

  const haystack = normalize(row.details.join(' '));
  const wantArtist = normalize(track.artists[0]?.name ?? '');
  const artistMatches = wantArtist.length > 0 && haystack.includes(wantArtist);

  const wantAlbum = normalize(track.albumName ?? '');
  const albumMatches = wantAlbum.length > 0 && haystack.includes(wantAlbum);

  const gotDuration = rowDuration(row);
  const delta =
    typeof track.durationMs === 'number' && gotDuration !== null
      ? Math.abs(track.durationMs - gotDuration)
      : null;

  // A runtime we can check and that disagrees is a different cut of the song,
  // however well the words line up.
  if (delta !== null && delta > DURATION_TOLERANCE_MS) return null;

  const durationMatches = delta !== null && delta <= DURATION_EXACT_MS;
  if (!artistMatches && !albumMatches && !durationMatches) return null;

  let score = titleSimilarity;
  if (artistMatches) score += 0.6;
  if (albumMatches) score += 0.3;
  if (durationMatches) score += 0.5;
  else if (delta !== null) score += 0.25 * (1 - delta / DURATION_TOLERANCE_MS);

  // Decorations the track itself doesn't claim. A remaster is still the master
  // we want, so it is not on the list; a "sped up" upload is not.
  const gotFull = normalize(row.title);
  const wantFull = normalize(track.title);
  for (const word of SUSPECT) {
    if (gotFull.includes(word) && !wantFull.includes(word)) score -= 0.5;
  }

  return score;
}

// --- lookup ----------------------------------------------------------------

async function search(term: string): Promise<Row[]> {
  try {
    const res = await fetch(SEARCH, {
      method: 'POST',
      cache: 'no-store',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://music.youtube.com',
        // Sent as a browser because that is what this endpoint serves. A
        // datacenter IP with no UA is the shape most likely to be bot-checked,
        // and Vercel's functions are exactly that.
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      },
      body: JSON.stringify({ context: { client: CLIENT }, query: term, params: SONGS_FILTER }),
    });
    if (!res.ok) return [];
    return parseRows(await res.json());
  } catch {
    return [];
  }
}

/**
 * The video id for a track's master recording, or null when nothing convincing
 * came back.
 *
 * Cached in Redis by Spotify id, because the pool is small and repeats hard:
 * Rush deals from the same few hundred tracks all night and songs may repeat
 * within a single run. Misses are cached too, on a shorter clock — a track with
 * no art track today still has none in an hour, and re-searching it on every
 * deal would spend the run's clock discovering that.
 */
export async function findFullTrackVideo(track: Track): Promise<string | null> {
  // Nothing to mock: a video id is only useful to YouTube's own iframe, and a
  // fabricated one would put the player on a dead embed. Null is the answer
  // this function already gives when it finds nothing, and Rush's fallback
  // takes over — which offline is the right sound anyway, since a synthesised
  // preview starts at its own first bar rather than mid-song.
  if (mockEnabled()) return null;

  const cacheKey = keys.ytVideo(track.spotifyId);

  try {
    const cached = await redis().get<string>(cacheKey);
    // Empty string is the recorded miss; null is a cold key.
    if (typeof cached === 'string') return cached || null;
  } catch {
    // A cache that isn't answering is not a reason to skip the lookup.
  }

  const artist = track.artists[0]?.name ?? '';
  // Decorations are noise to a search box and push the catalogue row down.
  const rows = (await search(`${artist} ${plainTitle(track.title)}`)).slice(0, CANDIDATES);

  let best: { score: number; videoId: string } | null = null;
  for (const row of rows) {
    const score = scoreRow(track, row);
    if (score === null) continue;
    if (!best || score > best.score) best = { score, videoId: row.videoId };
  }

  const videoId = best?.videoId ?? null;
  try {
    await redis().set(cacheKey, videoId ?? '', {
      ex: videoId ? YT_VIDEO_TTL_SECONDS : YT_VIDEO_MISS_TTL_SECONDS,
    });
  } catch {
    // Best-effort; the lookup already succeeded.
  }

  return videoId;
}
