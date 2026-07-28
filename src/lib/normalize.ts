/**
 * Case- and diacritic-insensitive normalisation. Used for the guess-modal
 * substring search, for artist matching, and for scoring iTunes candidates —
 * they all need "Beyoncé" and "beyonce" to be the same string.
 */
export function normalize(input: string): string {
  return input
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/['‘’`´]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Drops the decorations record labels love: "(feat. X)", "[Live]",
 * " - 2011 Remaster". Only used for *scoring*, never for display.
 */
export function coreTitle(title: string): string {
  const stripped = title
    .replace(/\s*[([][^)\]]*[)\]]\s*/g, ' ')
    .replace(/\s+-\s+.*$/, '');
  const normalized = normalize(stripped);
  return normalized || normalize(title);
}

/**
 * `coreTitle`'s decoration-stripping without the normalisation, for the lookups
 * that hand a title to someone else's search box: "Song (feat. X) - 2011
 * Remaster" becomes "Song". Falls back to the original rather than returning
 * empty, for a title that is *only* a parenthetical.
 */
export function plainTitle(title: string): string {
  const stripped = title
    .replace(/\s*[([][^)\]]*[)\]]\s*/g, ' ')
    .replace(/\s+-\s+.*$/, '')
    .trim();
  return stripped || title;
}

/** Sørensen–Dice over character bigrams. Cheap and forgiving of word order. */
export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;

  const bigrams = new Map<string, number>();
  for (let i = 0; i < a.length - 1; i++) {
    const gram = a.slice(i, i + 2);
    bigrams.set(gram, (bigrams.get(gram) ?? 0) + 1);
  }

  let hits = 0;
  for (let i = 0; i < b.length - 1; i++) {
    const gram = b.slice(i, i + 2);
    const count = bigrams.get(gram) ?? 0;
    if (count > 0) {
      bigrams.set(gram, count - 1);
      hits++;
    }
  }

  return (2 * hits) / (a.length - 1 + b.length - 1);
}

/** Dice, but a clean containment ("radiohead" in "radiohead thom yorke") also scores full. */
export function looseSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return 0.95;
  return similarity(a, b);
}

/**
 * Identity used for the `artist` feedback tier: Spotify's artist id when we
 * have one, normalised name otherwise. Compared on the *primary* artist only,
 * so a shared featured guest doesn't read as "so close". SPEC §1.5.
 */
export function artistKey(artist: { id: string | null; name: string }): string {
  return artist.id ? `id:${artist.id}` : `name:${normalize(artist.name)}`;
}
