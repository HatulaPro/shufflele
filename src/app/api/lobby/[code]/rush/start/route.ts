import { after } from 'next/server';
import type { NextRequest, NextResponse } from 'next/server';
import { fail, json } from '@/lib/http';
import { requireHost, saveLobby, settleRoster } from '@/lib/lobby';
import { claimRushStart, consumeRushCredit, refundRushCredit } from '@/lib/ratelimit';
import {
  dealRushSong,
  freshRush,
  retire,
  rushCandidates,
  toPublicRush,
  warmNextRushSong,
} from '@/lib/rush';
import { MIN_RUSH_POOL } from '@/lib/types';
import type { RushTimeControl } from '@/lib/types';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ code: string }> };

/**
 * Starts (or restarts) the Rush game. No GPU time is spent, so the classic
 * mode's daily cap doesn't apply — but Rush has two limits of its own, for a
 * different reason. Every song dealt is an iTunes lookup plus an undocumented
 * YouTube Music search, and what those can cost is the deployment's standing
 * with endpoints it does not own. So: a short per-lobby cooldown, which is the
 * one that actually stops a start-and-abandon loop, and a deliberately roomy
 * daily counter behind it as a circuit breaker (lib/ratelimit.ts).
 *
 * `timeControl` arrives as seconds; 0 means infinite. The clock itself doesn't
 * start here: the begin route stamps it once the first song is audible.
 */
export async function POST(req: NextRequest, ctx: Ctx): Promise<NextResponse> {
  const { code } = await ctx.params;
  const auth = await requireHost(code);
  if (!auth.ok) return fail(auth.error, auth.status);
  const lobby = auth.lobby;

  // Before anything is read or dealt: a caller in a loop should cost one Redis
  // round trip, not a roster settle and a pair of outbound lookups.
  if (!(await claimRushStart(code))) {
    return fail('That was quick — give it a few seconds before starting another run.', 429);
  }

  if (lobby.mode !== 'rush') {
    // Not "this lobby was created for classic": the mode is a setting a room
    // can change (see the PATCH in ../../route.ts), so the only way to get
    // here is a host tapping start as another tab flips the toggle.
    return fail('This lobby is set to the classic game right now.', 409);
  }

  let body: { timeControl?: unknown };
  try {
    body = await req.json();
  } catch {
    return fail('Malformed request.', 400);
  }

  const raw = typeof body.timeControl === 'number' ? body.timeControl : NaN;
  if (raw !== 0 && raw !== 60 && raw !== 120) {
    return fail('Pick a time control: one minute, two minutes, or infinite.', 400);
  }
  const timeControl: RushTimeControl = raw === 0 ? null : (raw as 60 | 120);

  // The round a run belongs to is the *next* one, exactly as in the classic
  // start route — not `currentRound`, which names the song that already
  // played. The distinction was academic while a lobby was one mode for life,
  // since `currentRound` was then always 0 here; now that a room can arrive
  // from a classic game it decides real things, and reading it the old way
  // would deal a board that still contains a removed player's music and none
  // of a player who joined during the last song.
  const pool = await settleRoster(lobby, lobby.currentRound + 1);
  if (pool.length === 0) {
    return fail('Nobody has added a playlist yet.', 400);
  }

  // A board of ten is the game. Anything less and the wrong answers run out
  // before the clock does — at the limit, every row is the right one.
  const candidates = rushCandidates(pool, lobby.rushUnusableTrackIds ?? []);
  if (candidates.length < MIN_RUSH_POOL) {
    return fail(
      `Rush needs at least ${MIN_RUSH_POOL} different songs to fill a board, and this pool has ${candidates.length}. Add another playlist.`,
      400,
    );
  }

  // Charged here rather than at the top: everything above rejects without
  // spending a lookup, and a malformed body shouldn't eat the day's budget.
  const credit = await consumeRushCredit();
  if (!credit.allowed) {
    return fail(
      `Rush has hit its limit of ${credit.limit} games for today. It resets at midnight UTC.`,
      429,
    );
  }

  const rush = freshRush(timeControl);
  const dealt = await dealRushSong(rush, pool, lobby.rushUnusableTrackIds ?? []);
  retire(lobby, dealt.unusable, dealt.previewless);
  if (!dealt.ok) {
    // Never got a song on air, so it wasn't a game — hand the credit back.
    await refundRushCredit();
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
