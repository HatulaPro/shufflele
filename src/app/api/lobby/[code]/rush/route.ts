import type { NextRequest, NextResponse } from 'next/server';
import { fail, json } from '@/lib/http';
import { requireHost, saveLobby } from '@/lib/lobby';
import { toPublicRush } from '@/lib/rush';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ code: string }> };

/**
 * The Rush game as the client may see it, for the host screen's resume path.
 * A refresh mid-game lands back on the song on air; a refresh past the clock
 * lands on the finish screen. The answer is never included — see the guess route.
 */
export async function GET(_req: NextRequest, ctx: Ctx): Promise<NextResponse> {
  const { code } = await ctx.params;
  const auth = await requireHost(code);
  if (!auth.ok) return fail(auth.error, auth.status);

  if (!auth.lobby.rush) return fail('No rush game has been started.', 404);
  return json(toPublicRush(auth.lobby.rush));
}

/**
 * Discards the Rush game, putting the host screen back in the lobby.
 *
 * The host screen resumes from the lobby's `rushActive` flag, which is just
 * "a rush game exists" — so a finished run left in place means every later
 * refresh landing back on the same spent summary with no way out of it. The
 * finish screen's "Back to lobby" clears it here rather than only in local
 * state, and the summary survives a refresh right up until they do.
 *
 * Unconditional: only the host can reach this, and abandoning a run mid-clock
 * is their call as much as abandoning a finished one.
 */
export async function DELETE(_req: NextRequest, ctx: Ctx): Promise<NextResponse> {
  const { code } = await ctx.params;
  const auth = await requireHost(code);
  if (!auth.ok) return fail(auth.error, auth.status);

  if (auth.lobby.rush) {
    auth.lobby.rush = null;
    await saveLobby(auth.lobby);
  }

  return json({ ok: true });
}
