/**
 * Letters that carry a word but survive NFD intact, so the mark-strip never
 * sees them. Without this they fall through to the non-letter sweep below and
 * split the word they sit in — "Blåhaj" is one token, not "bl haj".
 */
const FOLD: Record<string, string> = {
  ø: 'o',
  đ: 'd',
  ð: 'd',
  ł: 'l',
  æ: 'ae',
  œ: 'oe',
  ß: 'ss',
  þ: 'th',
  ħ: 'h',
  ı: 'i',
};

const FOLDABLE = new RegExp(`[${Object.keys(FOLD).join('')}]`, 'g');

/** Combining marks spelled out, because they render as nothing in an editor. */
const KANA_VOICING = '\u3099\u309A';
const STRIPPABLE_MARK = new RegExp(`(?![${KANA_VOICING}])\\p{M}`, 'gu');

/**
 * Case- and diacritic-insensitive normalisation. Used for the guess-modal
 * substring search, for artist matching, and for scoring iTunes candidates —
 * they all need "Beyoncé" and "beyonce" to be the same string.
 *
 * The letter sweep is `\p{L}\p{N}`, not `a-z0-9`. A Latin-only class doesn't
 * merely degrade a Hebrew title, it erases it: every character is dropped and
 * the whole string normalises to empty, which silently took a Hebrew track out
 * of the guess search *and* out of iTunes matching (a zero-length title scores
 * 0 similarity against everything, so no candidate ever cleared the threshold).
 * Same for Cyrillic, Greek, Arabic and CJK.
 *
 * Two consequences of writing for a non-Latin script that the Latin path never
 * had to think about:
 *
 * - **Niqqud** (Hebrew vowel points) are combining marks, so the existing
 *   `\p{M}` strip already folds them away — pointed and unpointed spellings of
 *   the same word land on the same string, exactly like é and e. Cantillation
 *   marks go the same way.
 * - **Geresh and gershayim** (׳ ״), which punctuate Hebrew acronyms and
 *   loanwords, join the apostrophe list rather than the sweep: they have to
 *   vanish without leaving a space, or one word becomes two.
 *
 * Bidi and joiner controls (U+200E/U+200F and friends) are format characters
 * that ride along invisibly in metadata copied out of an RTL editor. They are
 * deleted outright — sweeping them to a space would split a word on a
 * character nobody can see.
 *
 * The one mark held back from the strip is kana voicing (U+3099/U+309A): が is
 * a different letter from か, not an accented one, so folding them together
 * would collapse songs that aren't the same. NFC puts it back on its base
 * character afterwards, since a bare combining mark would only get swept into
 * a space and split the word.
 */
export function normalize(input: string): string {
  return input
    .normalize('NFD')
    .toLowerCase()
    .replace(STRIPPABLE_MARK, '')
    .normalize('NFC')
    .replace(/\p{Cf}/gu, '')
    .replace(/['‘’`´ʼ׳״]/g, '')
    .replace(FOLDABLE, (char) => FOLD[char])
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
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
