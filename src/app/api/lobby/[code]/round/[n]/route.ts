import type { NextRequest, NextResponse } from 'next/server';
import { fail, json } from '@/lib/http';
import { loadRound, requireHost, saveLobby, saveRound } from '@/lib/lobby';
import { getPrediction } from '@/lib/replicate';
import { toPublicRound } from '@/lib/round';
import { applyPrediction } from '@/lib/separation';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ code: string; n: string }> };

const POLL_INTERVAL_MS = 3000;

/** Round state for the host's 2s poll. The vocals stem is never included. */
export async function GET(_req: NextRequest, ctx: Ctx): Promise<NextResponse> {
  const { code, n } = await ctx.params;
  const auth = await requireHost(code);
  if (!auth.ok) return fail(auth.error, auth.status);

  const roundNumber = Number.parseInt(n, 10);
  if (!Number.isFinite(roundNumber)) return fail('No such round.', 404);

  let round = await loadRound(code, roundNumber);
  if (!round) return fail('No such round.', 404);

  // Webhook fallback: while a round is preparing, ask Replicate directly if we
  // haven't heard anything recently. This is what makes local development work
  // without exposing a public callback URL, and it covers a dropped webhook in
  // production. Only runs while `preparing`, so it costs nothing afterwards.
  if (
    round.state === 'preparing' &&
    round.predictionId &&
    process.env.REPLICATE_POLL_FALLBACK !== '0' &&
    Date.now() - round.polledAt > POLL_INTERVAL_MS
  ) {
    round.polledAt = Date.now();
    const prediction = await getPrediction(round.predictionId).catch(() => null);
    if (prediction) round = await applyPrediction(round, prediction);
    await saveRound(round);
  }

  return json(toPublicRound(round));
}

/**
 * The host walking out of a song, back to the lobby.
 *
 * Only `activeRound` is cleared — the round itself stays in Redis, keeps its
 * place in `currentRound` and keeps whatever it taught the lobby about
 * unusable tracks. What it does not get is a way back in: the song is spent,
 * and the next start draws a fresh one (usually the round already prefetched
 * while this one played, so walking out early is not even wasteful). See
 * `activeRound` in lib/types.ts.
 *
 * Idempotent, and indifferent to which round is named: the host is leaving the
 * screen they are on, and there is only ever one.
 */
export async function DELETE(_req: NextRequest, ctx: Ctx): Promise<NextResponse> {
  const { code } = await ctx.params;
  const auth = await requireHost(code);
  if (!auth.ok) return fail(auth.error, auth.status);

  if (auth.lobby.activeRound !== null) {
    auth.lobby.activeRound = null;
    await saveLobby(auth.lobby);
  }

  return json({ ok: true });
}
