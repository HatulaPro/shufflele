import type { NextRequest, NextResponse } from 'next/server';
import { fail, json } from '@/lib/http';
import {
  contributorCounts,
  loadRound,
  requireHost,
  saveLobby,
  settleRoster,
} from '@/lib/lobby';
import { prepareRound } from '@/lib/prepare';
import { keys, redis } from '@/lib/redis';
import type { Round } from '@/lib/types';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

type Ctx = { params: Promise<{ code: string }> };

/**
 * A prefetched round (lib/prefetch.ts) was drawn from the roster as it stood
 * mid-song, and the roster may have moved since: if the secret's playlist has
 * left the game, airing it would credit — and reveal — a departed player. The
 * settled pool is the authority. A failed prefetch is also thrown back rather
 * than shown; the host asked for a song, not for last round's bad luck.
 */
function adoptable(round: Round | null, pool: { spotifyId: string; playlistId: string }[]) {
  return Boolean(
    round?.prefetched &&
      round.state !== 'failed' &&
      pool.some(
        (t) =>
          t.spotifyId === round.secret.spotifyId && t.playlistId === round.secret.playlistId,
      ),
  );
}

/**
 * Puts the next round on air. Usually that round already exists — it was
 * prefetched while the last song played — and this just claims it; the host
 * then polls the round route, which resolves as fast as the separation is
 * done. Only when there is nothing usable to claim does this fall back to
 * picking and separating from scratch. SPEC §3.3.
 */
export async function POST(_req: NextRequest, ctx: Ctx): Promise<NextResponse> {
  const { code } = await ctx.params;
  const auth = await requireHost(code);
  if (!auth.ok) return fail(auth.error, auth.status);
  const lobby = auth.lobby;

  const n = lobby.currentRound + 1;

  // The one place the roster moves. Anyone added while the last song was on air
  // joins here, anyone the host removed leaves here, and what comes back is the
  // pool as this round sees it. See lib/lobby.ts.
  const pool = await settleRoster(lobby, n);
  if (pool.length === 0) {
    return fail('Nobody has added a playlist yet.', 400);
  }

  const prefetched = await loadRound(code, n);
  if (prefetched?.prefetched) {
    if (adoptable(prefetched, pool)) {
      // The track's turn is spent now, on air, not at prefetch time — a
      // prefetch that never airs must not count against its contributor.
      lobby.currentRound = n;
      lobby.usedTrackIds.push(prefetched.secret.spotifyId);
      await saveLobby(lobby);
      return json({ n });
    }
    // Stale or failed — clear the slot and pick fresh below. The orphaned
    // prediction's webhook finds no matching key and is ignored.
    await redis().del(keys.round(code, n));
  }

  // What each contributor has had on air, for the fairness draw. Read from
  // `usedTrackIds` only: a track that was picked and then thrown out for having
  // no preview never reached the room, so it must not count as that player's
  // turn. Resolved once — the pick loop doesn't add to it.
  const played = contributorCounts(lobby, pool, n);

  const result = await prepareRound(
    code,
    n,
    pool,
    [...lobby.usedTrackIds, ...lobby.unusableTrackIds],
    played,
  );
  lobby.unusableTrackIds.push(...result.unusable);

  if (!result.ok) {
    await saveLobby(lobby); // keep the "unusable" marks so we don't retry them
    if (result.reason === 'limit') {
      return fail(
        `Daily limit reached — Shufflele runs ${result.limit} songs a day to keep the GPU bill honest. Come back tomorrow.`,
        429,
      );
    }
    if (result.reason === 'no-track') {
      return fail(
        "Couldn't find a playable track. Every song we tried is missing a preview — add another playlist and try again.",
        503,
      );
    }
    return fail(result.message, 502);
  }

  lobby.currentRound = n;
  lobby.usedTrackIds.push(result.round.secret.spotifyId);
  await saveLobby(lobby);

  return json({ n });
}
