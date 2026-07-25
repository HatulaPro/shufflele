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
};

/**
 * Resolves a 30s preview mp3 for a track. Returns null when nothing scores
 * high enough — the caller then picks a different track. SPEC §3.2.
 */
export async function findPreviewUrl(track: Track): Promise<string | null> {
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

  let best: { score: number; previewUrl: string } | null = null;

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

    if (!best || score > best.score) best = { score, previewUrl: r.previewUrl };
  }

  return best?.previewUrl ?? null;
}
