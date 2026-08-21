import type { NextRequest, NextResponse } from 'next/server';
import { fail, json } from '@/lib/http';
import { requireHost } from '@/lib/lobby';
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
