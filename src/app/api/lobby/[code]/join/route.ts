import crypto from 'node:crypto';
import type { NextRequest, NextResponse } from 'next/server';
import { fail, json } from '@/lib/http';
import { loadLobby, saveLobby } from '@/lib/lobby';
import type { Player } from '@/lib/types';

export const dynamic = 'force-dynamic';

const MAX_PLAYERS = 16;

type Ctx = { params: Promise<{ code: string }> };

/**
 * A name from a guest phone. Guests no longer bring playlists: Spotify only
 * serves a playlist's contents to the account that owns it, so the pool is
 * built by the host. See README § Spotify authorization.
 */
export async function POST(req: NextRequest, ctx: Ctx): Promise<NextResponse> {
  const { code } = await ctx.params;
  const lobby = await loadLobby(code);
  if (!lobby) return fail('That lobby has expired or never existed.', 404);

  let body: { name?: unknown };
  try {
    body = await req.json();
  } catch {
    return fail('Malformed request.', 400);
  }

  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (name.length < 1 || name.length > 24) {
    return fail('Enter a name between 1 and 24 characters.', 400);
  }

  // Re-read: two phones can submit at the same moment.
  const fresh = (await loadLobby(code)) ?? lobby;
  if (fresh.players.length >= MAX_PLAYERS) {
    return fail(`This lobby is full (${MAX_PLAYERS} players).`, 400);
  }
  if (fresh.players.some((p) => p.name.toLowerCase() === name.toLowerCase())) {
    return fail('Someone already took that name — pick another.', 400);
  }

  const player: Player = {
    id: crypto.randomUUID(),
    name,
    joinedAt: Date.now(),
  };

  fresh.players.push(player);
  await saveLobby(fresh);

  return json({ ok: true, name });
}
