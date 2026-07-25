import type { NextRequest, NextResponse } from 'next/server';
import { fail, json } from '@/lib/http';
import { loadRound, requireHost, saveRound } from '@/lib/lobby';
import { buildLadder, toPublicRound } from '@/lib/round';
import { missingStems } from '@/lib/separation';
import { PLAYABLE_STEMS, type PlayableStem } from '@/lib/types';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ code: string; n: string }> };

/**
 * Finalises the ladder from the host browser's silence check.
 *
 * The check itself has to happen client-side: the stems are constant-bitrate
 * mp3, so file size says nothing about loudness, and there is no audio decoder
 * in a Vercel function. The browser decodes each stem, measures RMS, and posts
 * back the ones below the floor; a rejected stem's row is dropped before the
 * guess screen renders. SPEC §3.3.
 *
 * Idempotent — once the round is playing this just returns current state.
 */
export async function POST(req: NextRequest, ctx: Ctx): Promise<NextResponse> {
  const { code, n } = await ctx.params;
  const auth = await requireHost(code);
  if (!auth.ok) return fail(auth.error, auth.status);

  const roundNumber = Number.parseInt(n, 10);
  const round = await loadRound(code, roundNumber);
  if (!round) return fail('No such round.', 404);

  if (round.state !== 'ready') return json(toPublicRound(round));

  let reported: PlayableStem[] = [];
  try {
    const body = (await req.json()) as { silent?: unknown };
    if (Array.isArray(body.silent)) {
      reported = body.silent.filter((s): s is PlayableStem =>
        PLAYABLE_STEMS.includes(s as PlayableStem),
      );
    }
  } catch {
    // A missing or malformed body just means "nothing was silent".
  }

  // Stems Demucs never produced are silent by definition.
  const silent = Array.from(new Set([...reported, ...missingStems(round)]));
  const ladder = buildLadder(silent);

  if (!ladder.some((row) => row.kind === 'stem')) {
    round.state = 'failed';
    round.error = 'Every separated stem came back silent. Try another song.';
  } else {
    round.silentStems = silent;
    round.ladder = ladder;
    round.currentRow = 1;
    round.state = 'playing';
  }

  await saveRound(round);
  return json(toPublicRound(round));
}
