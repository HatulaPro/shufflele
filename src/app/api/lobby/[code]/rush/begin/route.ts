import type { NextRequest, NextResponse } from 'next/server';
import { fail, json } from '@/lib/http';
import { requireHost, saveLobby } from '@/lib/lobby';
import { beginRush, rushOver, toPublicRush } from '@/lib/rush';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ code: string }> };

/**
 * Starts the clock, called the moment the first song goes on air. The start
 * route only deals the game — between the two sit the ready screen, which the
 * player can sit on for as long as they like, and the ready-set-go beats.
 *
 * Idempotent, because a refresh mid-run re-arms the same screen: the deadline
 * is stamped once and never pushed out.
 */
export async function POST(_req: NextRequest, ctx: Ctx): Promise<NextResponse> {
  const { code } = await ctx.params;
  const auth = await requireHost(code);
  if (!auth.ok) return fail(auth.error, auth.status);

  const rush = auth.lobby.rush;
  if (!rush) return fail('No rush game has been started.', 404);
  if (rushOver(rush)) return fail('This rush game is over.', 409);

  if (rush.begunAt === null) {
    beginRush(rush);
    await saveLobby(auth.lobby);
  }

  return json(toPublicRush(rush));
}
