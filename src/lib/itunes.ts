import { coreTitle, looseSimilarity, normalize } from './normalize';
import type { Track } from './types';

/**
 * Words that mean "this is not the recording we're looking for". Only counted
 * against a candidate when the *query* title doesn't contain them too — a song
 * genuinely called "Live Forever" shouldn't be punished.
 */
const SUSPECT = [
  'live',
  'karaoke',
  'tribute',
  'cover',
  'covers',
  'remix',
  'instrumental',
  'acoustic',
  'demo',
  'made famous by',
  'originally performed',
  'in the style of',
  'workout',
  'lullaby',
];

type ItunesResult = {
  trackName?: string;
  artistName?: string;
  collectionName?: string;
  previewUrl?: string;
  artworkUrl100?: string;
  releaseDate?: string;
};

export type ItunesMatch = {
  previewUrl: string;
  albumArt: string | null;
  releaseYear: number | null;
};

/**
 * Best iTunes match for a track. Returns null when nothing scores high enough.
 *
 * This exists for one thing: a reliably 30-second preview mp3 (SPEC §3.2).
 * Spotify's own preview is inconsistent in length and absent for roughly one
 * track in seven, so it is only the fallback. The album art and release year
 * below are a leftover convenience — the tracklist supplies both now, and the
 * start route prefers Spotify's.
 */
export async function findItunesMatch(track: Track): Promise<ItunesMatch | null> {
  const artist = track.artists[0]?.name ?? '';
  const term = `${artist} ${track.title}`;
  const url =
    'https://itunes.apple.com/search?media=music&entity=song&limit=10&term=' +
    encodeURIComponent(term);

  let results: ItunesResult[];
  try {
    const res = await fetch(url, {
      cache: 'no-store',
      headers: { 'User-Agent': 'shufflele/0.1 (+party game, personal project)' },
    });
    if (!res.ok) return null;
    // iTunes serves this as text/javascript, so parse the text ourselves.
    const body = (await res.json()) as { results?: ItunesResult[] };
    results = body.results ?? [];
  } catch {
    return null;
  }

  const wantTitle = coreTitle(track.title);
  const wantTitleFull = normalize(track.title);
  const wantArtist = normalize(artist);
  const wantAll = normalize(track.title);

  let best: { score: number; result: ItunesResult } | null = null;

  for (const r of results) {
    if (!r.previewUrl || !r.trackName || !r.artistName) continue;

    const gotTitle = coreTitle(r.trackName);
    const gotTitleFull = normalize(r.trackName);
    const gotArtist = normalize(r.artistName);

    const titleSim = Math.max(
      looseSimilarity(wantTitle, gotTitle),
      looseSimilarity(wantTitleFull, gotTitleFull),
    );
    const artistSim = looseSimilarity(wantArtist, gotArtist);

    const haystack = `${gotTitleFull} ${normalize(r.collectionName ?? '')}`;
    const suspect = SUSPECT.some(
      (word) => haystack.includes(word) && !wantAll.includes(word),
    );

    let score = 0.62 * titleSim + 0.38 * artistSim;
    if (suspect) score -= 0.25;

    // Thresholds keep "Live at Wembley" and karaoke covers out. SPEC §3.2.
    if (titleSim < 0.7 || artistSim < 0.5 || score < 0.68) continue;

    if (!best || score > best.score) best = { score, result: r };
  }

  if (!best?.result.previewUrl) return null;

  const year = Number.parseInt((best.result.releaseDate ?? '').slice(0, 4), 10);

  return {
    previewUrl: best.result.previewUrl,
    // 100px is what the search API hands back; the reveal renders it at 2x on a
    // small tile, and iTunes serves the larger sizes off the same path.
    albumArt: best.result.artworkUrl100?.replace('100x100bb', '300x300bb') ?? null,
    releaseYear: Number.isFinite(year) ? year : null,
  };
}
