import { artistKey } from './normalize';
import {
  PLAYABLE_STEMS,
  STEM_LABEL,
  type GuessTier,
  type LadderRow,
  type PlayableStem,
  type PublicRound,
  type PublicRow,
  type Round,
  type Track,
} from './types';

/**
 * One row per usable stem, plus a final row. A stem the silence check rejected
 * drops its row entirely — the ladder length is never hardcoded. SPEC §1.3.
 */
export function buildLadder(silent: PlayableStem[]): LadderRow[] {
  const surviving = PLAYABLE_STEMS.filter((stem) => !silent.includes(stem));
  const rows: LadderRow[] = surviving.map((stem) => ({ kind: 'stem', stem }));
  rows.push({ kind: 'final' });
  return rows;
}

export function stemsUpTo(ladder: LadderRow[], row: number): PlayableStem[] {
  return ladder
    .slice(0, row)
    .filter((r): r is { kind: 'stem'; stem: PlayableStem } => r.kind === 'stem')
    .map((r) => r.stem);
}

export type TierResult = { tier: GuessTier; contributor: string | null };

/**
 * Feedback tier for a guessed track. Artist match outranks playlist match —
 * if a guess is both, the artist colour wins. SPEC §1.5.
 *
 * `pool` may hold the same track more than once (two players, one song), so
 * every entry for the guessed id is considered.
 */
export function tierFor(guessedId: string, secret: Track, pool: Track[]): TierResult | null {
  const entries = pool.filter((t) => t.spotifyId === guessedId);
  if (entries.length === 0) return null;

  if (guessedId === secret.spotifyId) return { tier: 'correct', contributor: null };

  const secretArtist = secret.artists[0] ? artistKey(secret.artists[0]) : null;
  if (
    secretArtist &&
    entries.some((e) => e.artists[0] && artistKey(e.artists[0]) === secretArtist)
  ) {
    return { tier: 'artist', contributor: null };
  }

  if (entries.some((e) => e.playlistId === secret.playlistId)) {
    // Name the player, not the playlist's title. SPEC §1.5.
    return { tier: 'playlist', contributor: secret.contributor };
  }

  return { tier: 'none', contributor: null };
}

export function artistsLabel(track: Track): string {
  return track.artists.map((a) => a.name).join(', ');
}

function rowLabel(row: LadderRow, index: number): { label: string; sub: string } {
  if (row.kind === 'final') return { label: 'Final guess', sub: 'last chance' };
  return {
    label: index === 0 ? STEM_LABEL[row.stem] : `+ ${STEM_LABEL[row.stem]}`,
    sub: '',
  };
}

function rowsFor(round: Round, ladder: LadderRow[]): PublicRow[] {
  const over = round.state === 'won' || round.state === 'lost';
  const heard: string[] = [];

  return ladder.map((row, i) => {
    const index = i + 1;
    const { label } = rowLabel(row, i);

    let sub: string;
    if (row.kind === 'stem') {
      heard.push(STEM_LABEL[row.stem].toLowerCase());
      sub = heard.length === PLAYABLE_STEMS.length ? 'full instrumental' : heard.join(' + ');
    } else {
      sub = rowLabel(row, i).sub;
    }

    const guess = round.guesses.find((g) => g.row === index) ?? null;
    const state: PublicRow['state'] = guess
      ? 'burned'
      : !over && round.state === 'playing' && index === round.currentRow
        ? 'active'
        : 'locked';

    // The final row does get one new thing after all: a lyric hint, revealed
    // only once the row is live. The hint never contains a title word
    // (lib/lyrics.ts), so serving it leaks nothing the reveal wouldn't.
    if (row.kind === 'final' && state === 'active' && round.hint) {
      sub = `Hint: “${round.hint}”`;
    }

    return { index, kind: row.kind, label, sub, state, guess };
  });
}

/**
 * The client never receives the secret track id — the host is playing on a
 * phone in front of an audience that can see the screen, so the answer must
 * not be one devtools tab away. SPEC §3.5.
 */
export function toPublicRound(round: Round): PublicRound {
  const ladder = round.ladder;
  const over = round.state === 'won' || round.state === 'lost';
  const rows = ladder ? rowsFor(round, ladder) : [];

  // While the ladder is still pending the client needs every playable stem so
  // it can run the silence check (SPEC §3.3). Once the ladder is fixed it only
  // gets the stems it has actually unlocked.
  let stems: { stem: PlayableStem; url: string }[] = [];
  let activeStems: PlayableStem[] = [];

  if (round.state === 'ready') {
    stems = PLAYABLE_STEMS.flatMap((stem) => {
      const url = round.stems[stem];
      return url ? [{ stem, url }] : [];
    });
  } else if (ladder && (round.state === 'playing' || over)) {
    activeStems = over ? stemsUpTo(ladder, ladder.length) : stemsUpTo(ladder, round.currentRow);
    stems = activeStems.flatMap((stem) => {
      const url = round.stems[stem];
      return url ? [{ stem, url }] : [];
    });
  }

  // A silence-shortened ladder can be worth fewer rows than par asks for. The
  // `typeof` guard is for rounds already in Redis from before par existed:
  // those carry no such field, and Math.min(undefined, …) renders as "par NaN".
  const par =
    typeof round.par !== 'number' ? null : ladder ? Math.min(round.par, ladder.length) : round.par;

  return {
    n: round.n,
    state: round.state,
    error: round.error,
    releaseYear: round.secret.releaseYear,
    par,
    difficulty: round.difficulty ?? null,
    currentRow: round.currentRow,
    totalRows: ladder ? ladder.length : 0,
    rows,
    stems,
    activeStems,
    guessedTrackIds: round.guesses.map((g) => g.trackId).filter((id): id is string => Boolean(id)),
    reveal: over
      ? {
          spotifyId: round.secret.spotifyId,
          title: round.secret.title,
          artist: artistsLabel(round.secret),
          albumArt: round.secret.albumArt,
          contributor: round.secret.contributor,
          releaseYear: round.secret.releaseYear,
        }
      : null,
  };
}
