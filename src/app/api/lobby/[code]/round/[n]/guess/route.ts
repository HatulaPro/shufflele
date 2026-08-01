import type { NextRequest, NextResponse } from 'next/server';
import { fail, json } from '@/lib/http';
import { loadRound, loadTracks, requireHost, saveRound } from '@/lib/lobby';
import { findLyricHint, noLyricLine } from '@/lib/lyrics';
import { artistsLabel, buildLadder, tierFor, toPublicRound } from '@/lib/round';
import { missingStems } from '@/lib/separation';
import type { GuessLog } from '@/lib/types';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ code: string; n: string }> };

/**
 * Submit a guess or a skip. Guessing is validated server-side and the response
 * carries only a feedback tier — the client never learns the secret track id.
 * SPEC §3.5.
 */
export async function POST(req: NextRequest, ctx: Ctx): Promise<NextResponse> {
  const { code, n } = await ctx.params;
  const auth = await requireHost(code);
  if (!auth.ok) return fail(auth.error, auth.status);

  const roundNumber = Number.parseInt(n, 10);
  const round = await loadRound(code, roundNumber);
  if (!round) return fail('No such round.', 404);

  // Safety net: if the browser never posted a silence check, play the full
  // ladder rather than leaving the round wedged.
  if (round.state === 'ready' && !round.ladder) {
    round.ladder = buildLadder(missingStems(round));
    round.currentRow = 1;
    round.state = 'playing';
  }

  if (round.state !== 'playing' || !round.ladder) {
    return fail('This round is not accepting guesses.', 409);
  }

  let body: { trackId?: unknown; skip?: unknown };
  try {
    body = await req.json();
  } catch {
    return fail('Malformed request.', 400);
  }

  const row = round.currentRow;
  let entry: GuessLog;

  if (body.skip === true) {
    entry = {
      row,
      kind: 'skip',
      title: null,
      artist: null,
      tier: null,
      contributor: null,
      trackId: null,
    };
  } else {
    const trackId = typeof body.trackId === 'string' ? body.trackId : '';
    if (!trackId) return fail('No track was given.', 400);
    if (round.guesses.some((g) => g.trackId === trackId)) {
      return fail('That track has already been guessed.', 400);
    }

    const pool = await loadTracks(code);
    const guessed = pool.find((t) => t.spotifyId === trackId);
    const result = tierFor(trackId, round.secret, pool);
    if (!guessed || !result) return fail('That track is not in this game.', 400);

    entry = {
      row,
      kind: 'guess',
      title: guessed.title,
      artist: artistsLabel(guessed),
      tier: result.tier,
      contributor: result.contributor,
      trackId,
    };
  }

  round.guesses.push(entry);

  if (entry.tier === 'correct') {
    round.state = 'won';
  } else if (row >= round.ladder.length) {
    round.state = 'lost';
  } else {
    // Burning a row unlocks the next one, adding another stem to the mix.
    round.currentRow = row + 1;
  }

  // The final row shows a lyric hint (SPEC §1.3). Fetched one row early so the
  // guess that unlocks the final row doesn't wait on lyrics.ovh, and stored on
  // the round so it never changes between polls.
  //
  // A miss (no match, timeout, every line gives the song away) substitutes a
  // joke line rather than leaving the row bare — an empty final row looks like
  // the app failed. The substitution happens here, at store time, and not in
  // the renderer, for the same reason the real hint is stored: the host polls
  // this round several times a second and the line has to sit still.
  if (
    round.state === 'playing' &&
    round.hint === undefined &&
    round.currentRow >= round.ladder.length - 1
  ) {
    round.hint = (await findLyricHint(round.secret)) ?? noLyricLine();
  }

  await saveRound(round);
  return json(toPublicRound(round));
}
