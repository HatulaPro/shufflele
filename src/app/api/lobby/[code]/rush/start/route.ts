import { after } from 'next/server';
import type { NextRequest, NextResponse } from 'next/server';
import { fail, json } from '@/lib/http';
import { requireHost, saveLobby, settleRoster } from '@/lib/lobby';
import {
  MIN_RUSH_POOL,
  dealRushSong,
  freshRush,
  rushCandidates,
  toPublicRush,
  warmNextRushSong,
} from '@/lib/rush';
import type { RushTimeControl } from '@/lib/types';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ code: string }> };

/**
 * Starts (or restarts) the Rush game. No GPU time is spent, so the daily
 * classic-mode cap doesn't apply — a Rush game costs iTunes lookups only.
 *
 * `timeControl` arrives as seconds; 0 means infinite. The clock itself doesn't
 * start here: the begin route stamps it once the first song is audible.
 */
export async function POST(req: NextRequest, ctx: Ctx): Promise<NextResponse> {
  const { code } = await ctx.params;
  const auth = await requireHost(code);
  if (!auth.ok) return fail(auth.error, auth.status);
  const lobby = auth.lobby;

  if ((lobby.mode ?? 'classic') !== 'rush') {
    return fail('This lobby was created for the classic game.', 409);
  }

  let body: { timeControl?: unknown };
  try {
    body = await req.json();
  } catch {
    return fail('Malformed request.', 400);
  }

  const raw = typeof body.timeControl === 'number' ? body.timeControl : NaN;
  if (raw !== 0 && raw !== 30 && raw !== 60) {
    return fail('Pick a time control: 30 seconds, a minute, or infinite.', 400);
  }
  const timeControl: RushTimeControl = raw === 0 ? null : (raw as 30 | 60);

  const pool = await settleRoster(lobby, Math.max(lobby.currentRound, 1));
  if (pool.length === 0) {
    return fail('Nobody has added a playlist yet.', 400);
  }

  // A board of ten is the game. Anything less and the wrong answers run out
  // before the clock does — at the limit, every row is the right one.
  const candidates = rushCandidates(pool, lobby.unusableTrackIds);
  if (candidates.length < MIN_RUSH_POOL) {
    return fail(
      `Rush needs at least ${MIN_RUSH_POOL} different songs to fill a board, and this pool has ${candidates.length}. Add another playlist.`,
      400,
    );
  }

  const rush = freshRush(timeControl);
  const dealt = await dealRushSong(rush, pool, lobby.unusableTrackIds);
  for (const id of dealt.unusable) {
    if (!lobby.unusableTrackIds.includes(id)) lobby.unusableTrackIds.push(id);
  }
  if (!dealt.ok) {
    return fail(
      "Couldn't find a playable track in that pool — every song we tried is missing a preview.",
      503,
    );
  }

  lobby.rush = rush;
  await saveLobby(lobby);
  // The second song is dealt while the player is still reading the ready
  // screen, so the first guess doesn't wait on iTunes.
  after(() => warmNextRushSong(code));
  return json(toPublicRush(rush));
}
