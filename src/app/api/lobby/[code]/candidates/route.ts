import type { NextRequest, NextResponse } from 'next/server';
import { fail, json } from '@/lib/http';
import { liveRound, loadTracks, poolFor, requireHost } from '@/lib/lobby';
import { normalize } from '@/lib/normalize';
import { artistsLabel } from '@/lib/round';
import type { Candidate } from '@/lib/types';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ code: string }> };

/**
 * Every track from every playlist, for the guess modal's client-side search.
 * A few thousand rows at most. The modal shows nothing until the user types,
 * so the list itself never leaks the answer set on screen. SPEC §1.4.
 */
export async function GET(_req: NextRequest, ctx: Ctx): Promise<NextResponse> {
  const { code } = await ctx.params;
  const auth = await requireHost(code);
  if (!auth.ok) return fail(auth.error, auth.status);

  // The roster the round in play was drawn from, not the roster right now: a
  // playlist added mid-song must not quietly widen the answer set, and one the
  // host removed has to stay guessable until the song is over.
  const pool = poolFor(auth.lobby, await loadTracks(code), liveRound(auth.lobby));
  const seen = new Set<string>();
  const candidates: Candidate[] = [];

  for (const track of pool) {
    if (seen.has(track.spotifyId)) continue;
    seen.add(track.spotifyId);

    const artist = artistsLabel(track);
    candidates.push({
      id: track.spotifyId,
      title: track.title,
      artist,
      // Matching is against title and artist both. SPEC §1.4.
      search: `${normalize(track.title)} ${normalize(artist)}`,
    });
  }

  candidates.sort((a, b) => a.title.localeCompare(b.title));
  return json({ candidates });
}
