import type { NextRequest, NextResponse } from 'next/server';
import { fail, json } from '@/lib/http';
import { loadRound, requireHost, saveRound } from '@/lib/lobby';
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
