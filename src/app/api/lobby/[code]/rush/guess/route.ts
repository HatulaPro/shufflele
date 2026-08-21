import { after } from 'next/server';
import type { NextRequest, NextResponse } from 'next/server';
import { fail, json } from '@/lib/http';
import { loadTracks, requireHost, saveLobby } from '@/lib/lobby';
import {
  awardRushTime,
  dealRushSong,
  retire,
  rushOver,
  rushSongRef,
  toPublicRush,
  warmNextRushSong,
} from '@/lib/rush';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ code: string }> };

/**
 * Click one of the ten songs. Judged server-side — the client is never told
 * which option is the answer, same rule as the classic mode's guess route,
 * because the host plays on a phone the room can see.
 *
 * Either way the game moves straight on: a hit scores, buys a couple of
 * seconds of clock, and deals the next song; a miss costs a life and deals the
 * next song. Out of lives ends it here; out
 * of clock is the finish route's job. The next song is normally already warm
 * (lib/rush.ts), so this response doesn't spend the player's clock on a lookup.
 */
export async function POST(req: NextRequest, ctx: Ctx): Promise<NextResponse> {
  const { code } = await ctx.params;
  const auth = await requireHost(code);
  if (!auth.ok) return fail(auth.error, auth.status);
  const lobby = auth.lobby;
  const rush = lobby.rush;

  if (!rush) return fail('No rush game has been started.', 404);
  if (rushOver(rush)) return fail('This rush game is over.', 409);

  let body: { trackId?: unknown };
  try {
    body = await req.json();
  } catch {
    return fail('Malformed request.', 400);
  }

  const trackId = typeof body.trackId === 'string' ? body.trackId : '';
  if (!trackId) return fail('No song was given.', 400);
  if (!rush.options.some((t) => t.spotifyId === trackId)) {
    return fail('That song is not on the board.', 400);
  }

  const correct = trackId === rush.secret.spotifyId;
  rush.history.push({ song: rushSongRef(rush.secret), correct });

  if (correct) {
    rush.score += 1;
    // Time is scored server-side off the stored deadline, exactly like the
    // score: the client posts a track id and nothing else, so there is no
    // number here it could have supplied.
    awardRushTime(rush);
  } else {
    rush.lives -= 1;
  }

  if (rush.lives <= 0) {
    rush.over = true;
  } else {
    const dealt = await dealRushSong(
      rush,
      await loadTracks(code),
      lobby.rushUnusableTrackIds ?? [],
    );
    retire(lobby, dealt.unusable, dealt.previewless);
    if (!dealt.ok) {
      // The pool ran dry of anything playable mid-run. End on the score they
      // have rather than serving a screen with nothing on it.
      rush.over = true;
    }
  }

  await saveLobby(lobby);
  if (!rush.over) after(() => warmNextRushSong(code));
  return json(toPublicRush(rush));
}
