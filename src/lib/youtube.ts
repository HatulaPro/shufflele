import { coreTitle, looseSimilarity, normalize, plainTitle } from './normalize';
import type { Track } from './types';

/**
 * YouTube view count for the secret track, shown on the guess screen next to
 * par — the other stat the round knows about the song. SPEC §1.2.
 *
 * Spotify's API has no stream count at any tier, so "plays" has to come from
 * somewhere else, and YouTube is the only free source that reports a real
 * number rather than a rank. It measures something different from Spotify
 * streams and always will: a song can be huge on radio and thin on YouTube.
 * That's fine for what it is — a rough sense of scale, not a chart position.
 *
 * Needs YOUTUBE_API_KEY. With no key, no match, or any error at all, this is
 * null and the chip simply doesn't render — same as par does without
 * popularity. Nothing here is ever allowed to fail a round.
 */
const SEARCH = 'https://www.googleapis.com/youtube/v3/search';
const VIDEOS = 'https://www.googleapis.com/youtube/v3/videos';

/** Runs inside the start route, which is already waiting on iTunes and Replicate. */
const TIMEOUT_MS = 3500;

/** search.list costs 100 quota units against a 10k/day default, so keep it to one. */
const CANDIDATES = 5;

/**
 * A title has to look like the song and the artist has to appear somewhere —
 * in the video title or the channel name, since "Artist - Topic" uploads put
 * it only in the latter. Loose, because uploads decorate titles endlessly
 * ("(Official Video)", "[4K Remaster]", "HD").
 */
function matches(track: Track, videoTitle: string, channel: string): boolean {
  const artist = normalize(track.artists[0]?.name ?? '');
  if (!artist) return false;

  const haystack = `${normalize(videoTitle)} ${normalize(channel)}`;
  if (!haystack.includes(artist)) return false;

  return looseSimilarity(normalize(videoTitle), coreTitle(track.title)) >= 0.45;
}

async function get(url: URL): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(url, {
      cache: 'no-store',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

type SearchItem = { id?: { videoId?: unknown } };
type VideoItem = {
  id?: unknown;
  snippet?: { title?: unknown; channelTitle?: unknown };
  statistics?: { viewCount?: unknown };
};

/**
 * Views on the biggest matching upload. A song's views are split across the
 * official video, the audio upload, the Topic channel and a pile of lyric
 * videos, and there is no principled way to add those up — the same recording
 * would be counted three times, and the reuploads are not all the same song.
 * The largest single upload is the honest answer to "how much has this been
 * watched", and it's stable between lookups in a way that a sum is not.
 */
export async function findPlayCount(track: Track): Promise<number | null> {
  const key = process.env.YOUTUBE_API_KEY;
  const artist = track.artists[0]?.name;
  if (!key || !artist) return null;

  const search = new URL(SEARCH);
  search.searchParams.set('part', 'id');
  search.searchParams.set('type', 'video');
  search.searchParams.set('maxResults', String(CANDIDATES));
  // Decorations stripped: "- Radio Edit" and "(feat. …)" are noise to YouTube's
  // relevance ranking and can push the official upload out of the top few.
  search.searchParams.set('q', `${artist} ${plainTitle(track.title)}`);
  search.searchParams.set('key', key);

  const found = await get(search);
  const ids = (Array.isArray(found?.items) ? (found.items as SearchItem[]) : [])
    .map((item) => item.id?.videoId)
    .filter((id): id is string => typeof id === 'string');
  if (ids.length === 0) return null;

  // search.list doesn't carry statistics, so the ids have to be looked up
  // again. One extra call, one quota unit.
  const videos = new URL(VIDEOS);
  videos.searchParams.set('part', 'snippet,statistics');
  videos.searchParams.set('id', ids.join(','));
  videos.searchParams.set('key', key);

  const detail = await get(videos);
  const items = Array.isArray(detail?.items) ? (detail.items as VideoItem[]) : [];

  let best: number | null = null;
  for (const item of items) {
    const title = typeof item.snippet?.title === 'string' ? item.snippet.title : '';
    const channel = typeof item.snippet?.channelTitle === 'string' ? item.snippet.channelTitle : '';
    if (!matches(track, title, channel)) continue;

    // viewCount arrives as a string, and is absent on videos with stats hidden.
    const views = Number(item.statistics?.viewCount);
    if (!Number.isFinite(views) || views <= 0) continue;
    if (best === null || views > best) best = views;
  }

  return best;
}
