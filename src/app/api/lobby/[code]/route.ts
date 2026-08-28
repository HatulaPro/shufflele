import { cookies } from 'next/headers';
import type { NextRequest, NextResponse } from 'next/server';
import { fail, json } from '@/lib/http';
import {
  deleteLobby,
  hostCookieName,
  loadLobby,
  requireHost,
  saveLobby,
  switchMode,
  toPublicLobby,
} from '@/lib/lobby';
import { isLobbyMode } from '@/lib/types';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ code: string }> };

/** Lobby status and player list. The host polls this every 2s. */
export async function GET(_req: NextRequest, ctx: Ctx): Promise<NextResponse> {
  const { code } = await ctx.params;
  const lobby = await loadLobby(code);
  if (!lobby) return fail('That lobby has expired or never existed.', 404);

  const jar = await cookies();
  const isHost = jar.get(hostCookieName(code))?.value === lobby.hostToken;

  return json(toPublicLobby(lobby, isHost));
}

/**
 * Switches the lobby between the two game modes.
 *
 * A room that wants to move from one mode to the other keeps its code, its
 * roster and its pooled music — nobody re-joins and nobody re-pastes a
 * playlist. All this ends is whichever mode had a screen open; see
 * `switchMode` in lib/lobby.ts for what that costs and what survives.
 *
 * Idempotent, so the two-button toggle on the host screen can be tapped twice
 * without a second thought.
 */
export async function PATCH(req: NextRequest, ctx: Ctx): Promise<NextResponse> {
  const { code } = await ctx.params;
  const auth = await requireHost(code);
  if (!auth.ok) return fail(auth.error, auth.status);

  let body: { mode?: unknown };
  try {
    body = await req.json();
  } catch {
    return fail('Malformed request.', 400);
  }

  if (!isLobbyMode(body.mode)) {
    return fail('Pick either the classic game or rush.', 400);
  }

  if (switchMode(auth.lobby, body.mode)) await saveLobby(auth.lobby);

  return json(toPublicLobby(auth.lobby, true));
}

/** The host ending the game. Closes the lobby and drops the host cookie. */
export async function DELETE(_req: NextRequest, ctx: Ctx): Promise<NextResponse> {
  const { code } = await ctx.params;
  const auth = await requireHost(code);
  if (!auth.ok) return fail(auth.error, auth.status);

  await deleteLobby(auth.lobby);
  const jar = await cookies();
  jar.delete(hostCookieName(code));

  return json({ ok: true });
}
