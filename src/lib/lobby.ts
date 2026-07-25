import crypto from 'node:crypto';
import { cookies } from 'next/headers';
import { LOBBY_TTL_SECONDS, keys, redis } from './redis';
import type { Lobby, Round, Track } from './types';

export function randomToken(): string {
  return crypto.randomBytes(24).toString('base64url');
}

export function hostCookieName(code: string): string {
  return `sh_host_${code}`;
}

/**
 * Creates a lobby under a free 6-digit code. Collisions are resolved by the
 * atomic `SET … NX`, never by a read-then-write race. SPEC §2.2.
 */
export async function createLobby(): Promise<Lobby> {
  const hostToken = randomToken();

  for (let attempt = 0; attempt < 12; attempt++) {
    const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
    const lobby: Lobby = {
      code,
      hostToken,
      createdAt: Date.now(),
      players: [],
      sources: [],
      currentRound: 0,
      usedTrackIds: [],
      unusableTrackIds: [],
    };

    const result = await redis().set(keys.lobby(code), lobby, {
      nx: true,
      ex: LOBBY_TTL_SECONDS,
    });

    if (result === 'OK') return lobby;
  }

  throw new Error('Could not find a free lobby code. Try again in a moment.');
}

export async function loadLobby(code: string): Promise<Lobby | null> {
  if (!/^\d{6}$/.test(code)) return null;
  return (await redis().get<Lobby>(keys.lobby(code))) ?? null;
}

export async function saveLobby(lobby: Lobby): Promise<void> {
  await redis().set(keys.lobby(lobby.code), lobby, { ex: LOBBY_TTL_SECONDS });
}

export async function loadTracks(code: string): Promise<Track[]> {
  return (await redis().get<Track[]>(keys.tracks(code))) ?? [];
}

export async function saveTracks(code: string, tracks: Track[]): Promise<void> {
  await redis().set(keys.tracks(code), tracks, { ex: LOBBY_TTL_SECONDS });
}

export async function loadRound(code: string, n: number): Promise<Round | null> {
  return (await redis().get<Round>(keys.round(code, n))) ?? null;
}

export async function saveRound(round: Round): Promise<void> {
  await redis().set(keys.round(round.code, round.n), round, { ex: LOBBY_TTL_SECONDS });
}

export type HostAuth =
  | { ok: true; lobby: Lobby }
  | { ok: false; status: number; error: string };

/**
 * Mutating routes require the opaque host token set as an httpOnly cookie at
 * lobby creation. Guests only ever need the code. SPEC §2.2.
 */
export async function requireHost(code: string): Promise<HostAuth> {
  const lobby = await loadLobby(code);
  if (!lobby) return { ok: false, status: 404, error: 'That lobby has expired or never existed.' };

  const jar = await cookies();
  const presented = jar.get(hostCookieName(code))?.value;
  if (!presented || !safeEqual(presented, lobby.hostToken)) {
    return { ok: false, status: 403, error: 'Only the host phone can do that.' };
  }

  return { ok: true, lobby };
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
}
