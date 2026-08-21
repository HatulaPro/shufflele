import type { NextRequest, NextResponse } from 'next/server';
import { fail, json } from '@/lib/http';
import { requireHost, saveLobby } from '@/lib/lobby';
import { recordUnguessedRushSong, rushOver, toPublicRush } from '@/lib/rush';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ code: string }> };

/**
 * Ends the Rush game and returns the finish-screen summary. Called when the
 * clock runs out or the player quits early — the server freezes the state so
 * a later poll can't serve a fresh song over a finished run.
 */
export async function POST(_req: NextRequest, ctx: Ctx): Promise<NextResponse> {
  const { code } = await ctx.params;
  const auth = await requireHost(code);
  if (!auth.ok) return fail(auth.error, auth.status);

  const rush = auth.lobby.rush;
  if (!rush) return fail('No rush game has been started.', 404);

  // The song on air when the clock ran out — or when the player quit — was
  // never guessed, so it belongs on the missed list. `over` is what tells the
  // two apart from a run that already ended on a guess: out of lives or out of
  // pool, the board was cleared then and there is nothing pending here.
  if (!rush.over) {
    recordUnguessedRushSong(rush);
    rush.over = true;
    if (rush.endsAt !== null) rush.endsAt = Math.min(rush.endsAt, Date.now());
    await saveLobby(auth.lobby);
  }

  return json(toPublicRush(rush));
}
