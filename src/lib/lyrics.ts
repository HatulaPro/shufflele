import { coreTitle, normalize } from './normalize';
import type { Track } from './types';

/**
 * lyrics.ovh needs no token, but it can hang for ten seconds on a miss, and
 * this runs inside the guess route — so each attempt is capped hard and a
 * timeout is just "no hint".
 */
const ATTEMPT_TIMEOUT_MS = 3500;

/**
 * Title words too common to disqualify a line over — banning every line that
 * contains "the" would leave nothing for a song called "The Man". Only the
 * distinctive words of the title give the song away.
 */
const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'de', 'do', 'dont',
  'for', 'from', 'i', 'if', 'im', 'in', 'is', 'it', 'its', 'la', 'me', 'my',
  'no', 'not', 'of', 'oh', 'on', 'or', 'so', 'that', 'the', 'this', 'to',
  'was', 'we', 'with', 'you', 'your',
]);

/**
 * Words that would give the song away if the hint contained them: the title's
 * distinctive words, plus the primary artist's name (a name-drop in the lyric
 * is as much of a tell as the chorus).
 */
function bannedWords(track: Track): string[] {
  const words = new Set<string>();
  for (const source of [coreTitle(track.title), normalize(track.artists[0]?.name ?? '')]) {
    for (const word of source.split(' ')) {
      if (word && !STOPWORDS.has(word)) words.add(word);
    }
  }
  return [...words];
}

/** Prefix match on longer words so "Summer" also bans "summers" and "summertime". */
function givesAway(line: string, banned: string[]): boolean {
  const words = normalize(line).split(' ');
  return words.some((word) =>
    banned.some((b) => word === b || (b.length >= 3 && word.startsWith(b))),
  );
}

/** "(feat. X)" / " - 2011 Remaster" decorations, kept out of the lookup path. */
function plainTitle(title: string): string {
  const stripped = title
    .replace(/\s*[([][^)\]]*[)\]]\s*/g, ' ')
    .replace(/\s+-\s+.*$/, '')
    .trim();
  return stripped || title;
}

async function fetchLyrics(artist: string, title: string): Promise<string | null> {
  const url = `https://api.lyrics.ovh/v1/${encodeURIComponent(artist)}/${encodeURIComponent(title)}`;
  try {
    const res = await fetch(url, {
      cache: 'no-store',
      signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { lyrics?: unknown };
    return typeof body.lyrics === 'string' && body.lyrics.trim() ? body.lyrics : null;
  } catch {
    return null;
  }
}

/**
 * A random lyric line usable as a final-row hint: long enough to say
 * something, and sharing no distinctive word with the title or artist, so it
 * narrows the song without naming it. Null when lyrics.ovh has no match or
 * every line would give the song away.
 */
export async function findLyricHint(track: Track): Promise<string | null> {
  const artist = track.artists[0]?.name;
  if (!artist) return null;

  let lyrics = await fetchLyrics(artist, track.title);
  const stripped = plainTitle(track.title);
  if (!lyrics && stripped !== track.title) lyrics = await fetchLyrics(artist, stripped);
  if (!lyrics) return null;

  const banned = bannedWords(track);
  const seen = new Set<string>();
  const lines = lyrics
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => {
      if (!line || /^\[.*\]$/.test(line)) return false; // [Chorus]-style markers
      // lyrics.ovh prepends "Paroles de la chanson <title> par <artist>".
      if (/^paroles de la chanson/i.test(line)) return false;
      const key = normalize(line);
      if (!key || seen.has(key)) return false; // choruses repeat
      seen.add(key);
      if (key.split(' ').length < 4) return false; // "Oh oh oh" hints at nothing
      return !givesAway(line, banned);
    });

  if (lines.length === 0) return null;
  return lines[Math.floor(Math.random() * lines.length)] ?? null;
}
