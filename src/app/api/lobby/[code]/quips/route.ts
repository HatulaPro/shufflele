import type { NextRequest, NextResponse } from 'next/server';
import { fail, json } from '@/lib/http';
import { loadTracks, requireHost } from '@/lib/lobby';
import { buildQuips } from '@/lib/quips';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ code: string }> };

/**
 * Loading-screen lines about the pooled playlists. Fetched once per round while
 * the separation runs, so the wait reads as a joke about the group rather than a
 * progress log. Nothing here identifies the secret track. SPEC §1.2.
 */
export async function GET(_req: NextRequest, ctx: Ctx): Promise<NextResponse> {
  const { code } = await ctx.params;
  const auth = await requireHost(code);
  if (!auth.ok) return fail(auth.error, auth.status);

  const pool = await loadTracks(code);
  return json({ quips: buildQuips(auth.lobby.players, pool) });
}
