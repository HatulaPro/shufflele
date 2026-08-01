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
 * Writing systems worth telling apart here. Anything not listed — including
 * every accented Latin alphabet, which `normalize` has already folded — counts
 * as Latin. Order matters only in that the first hit wins, and a title mixing
 * scripts is classified by its non-Latin half, which is the useful answer.
 */
const SCRIPTS: { name: string; pattern: RegExp; store: string }[] = [
  { name: 'hebrew', pattern: /\p{Script=Hebrew}/u, store: 'IL' },
  { name: 'cyrillic', pattern: /\p{Script=Cyrillic}/u, store: 'RU' },
  { name: 'arabic', pattern: /\p{Script=Arabic}/u, store: 'SA' },
  { name: 'greek', pattern: /\p{Script=Greek}/u, store: 'GR' },
  { name: 'japanese', pattern: /[\p{Script=Hiragana}\p{Script=Katakana}]/u, store: 'JP' },
  { name: 'korean', pattern: /\p{Script=Hangul}/u, store: 'KR' },
  { name: 'han', pattern: /\p{Script=Han}/u, store: 'CN' },
];

function scriptOf(text: string): string {
  return SCRIPTS.find(({ pattern }) => pattern.test(text))?.name ?? 'latin';
}

/**
 * Storefront to retry in when the default one produced no usable match.
 *
 * `search` takes no country parameter by default, which means the US store.
 * That store does carry non-English catalogue, so this is not about tracks
 * being missing — it's about ranking. `limit=10` is a small window, and a
 * local-language query resolves to a different ten rows depending on the
 * storefront; the home store puts the local pressing near the top where the
 * scorer can see it. Only consulted after the default store already failed, so
 * it costs a second request exactly on tracks that were returning null anyway.
 */
function fallbackStore(term: string): string | null {
  return SCRIPTS.find(({ pattern }) => pattern.test(term))?.store ?? null;
}

async function searchItunes(term: string, country: string | null): Promise<ItunesResult[]> {
  const url =
    'https://itunes.apple.com/search?media=music&entity=song&limit=10' +
    (country ? `&country=${country}` : '') +
    '&term=' +
    encodeURIComponent(term);

  try {
    const res = await fetch(url, {
      cache: 'no-store',
      headers: { 'User-Agent': 'shufflele/0.1 (+party game, personal project)' },
    });
    if (!res.ok) return [];
    // iTunes serves this as text/javascript, so parse the text ourselves.
    const body = (await res.json()) as { results?: ItunesResult[] };
    return body.results ?? [];
  } catch {
    return [];
  }
}

/**
 * Best iTunes match for a track. Returns null when nothing scores high enough.
 *
 * This exists for one thing: a reliably 30-second preview mp3 (SPEC §3.2).
 * Spotify's own preview is inconsistent in length and absent for roughly one
 * track in seven, so it is only the fallback. The album art and release year
 * below are a leftover convenience — the tracklist supplies both now, and the
 * start route prefers Spotify's.
 *
 * Titles are compared in whatever script they are written in — a Hebrew title
 * is scored against Apple's Hebrew metadata, not against a transliteration.
 * That only became possible once `normalize` stopped reducing non-Latin text
 * to an empty string; before, every Hebrew track scored 0 on title and could
 * never clear the threshold below.
 */
export async function findItunesMatch(track: Track): Promise<ItunesMatch | null> {
  const artist = track.artists[0]?.name ?? '';
  const term = `${artist} ${track.title}`;

  let best = bestMatch(track, artist, await searchItunes(term, null));

  // Retried on a failed *match*, not on an empty response: the US store
  // answering with ten irrelevant rows is the same outcome as answering with
  // none, and is the more common shape for a non-Latin query.
  if (!best) {
    const country = fallbackStore(term);
    if (country) best = bestMatch(track, artist, await searchItunes(term, country));
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

/** Highest-scoring result that clears the thresholds, or null. */
function bestMatch(
  track: Track,
  artist: string,
  results: ItunesResult[],
): { score: number; result: ItunesResult } | null {
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

    // Spotify and Apple don't always agree on which alphabet an artist's name
    // is spelled in — Spotify lists "Omer Adam", Apple lists "עומר אדם", and
    // the two share not one character. A 0 there is a fact about the alphabets,
    // not evidence of a wrong recording, so the artist gate has nothing to say
    // and applying it anyway rejects every correct match.
    //
    // The title carries the decision instead, at a higher bar and with no
    // tolerance for a suspect word — a stricter test than the normal path, not
    // a looser one, since it's the only test left.
    const crossScript = scriptOf(wantArtist) !== scriptOf(gotArtist);

    if (crossScript) {
      if (titleSim < 0.85 || suspect) continue;
      if (!best || titleSim > best.score) best = { score: titleSim, result: r };
      continue;
    }

    let score = 0.62 * titleSim + 0.38 * artistSim;
    if (suspect) score -= 0.25;

    // Thresholds keep "Live at Wembley" and karaoke covers out. SPEC §3.2.
    if (titleSim < 0.7 || artistSim < 0.5 || score < 0.68) continue;

    if (!best || score > best.score) best = { score, result: r };
  }

  return best;
}
