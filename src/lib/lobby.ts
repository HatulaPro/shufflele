import crypto from 'node:crypto';
import { cookies } from 'next/headers';
import { LOBBY_TTL_SECONDS, keys, redis } from './redis';
import { roundsByContributor } from './select';
import type { Lobby, LobbyMode, Player, PublicLobby, Round, Track } from './types';

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
export async function createLobby(mode: LobbyMode = 'classic'): Promise<Lobby> {
  const hostToken = randomToken();

  for (let attempt = 0; attempt < 12; attempt++) {
    const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
    const lobby: Lobby = {
      code,
      hostToken,
      createdAt: Date.now(),
      mode,
      players: [],
      currentRound: 0,
      activeRound: null,
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

/**
 * Closes a lobby for good: the lobby row, its track pool and every round it
 * played. Everything would expire on its own (SPEC §2.2), but the host ending
 * the game should free the code immediately.
 */
export async function deleteLobby(lobby: Lobby): Promise<void> {
  // One past `currentRound`, because a prefetched next round may be sitting
  // there unclaimed (lib/prefetch.ts).
  const rounds = Array.from({ length: lobby.currentRound + 1 }, (_, i) =>
    keys.round(lobby.code, i + 1),
  );
  await redis().del(keys.lobby(lobby.code), keys.tracks(lobby.code), ...rounds);
}

export async function loadTracks(code: string): Promise<Track[]> {
  return (await redis().get<Track[]>(keys.tracks(code))) ?? [];
}

export async function saveTracks(code: string, tracks: Track[]): Promise<void> {
  await redis().set(keys.tracks(code), tracks, { ex: LOBBY_TTL_SECONDS });
}

// --- roster ---------------------------------------------------------------
//
// The player list is editable while a game runs, but a change never lands on
// the song already on air: that round's guess list, its fairness draw and its
// secret were all fixed the moment it started, and pulling a playlist out from
// under it would either shrink the answer set mid-guess or, if the secret was
// theirs, make the round unwinnable. So joins and removals both queue on the
// round boundary, and every read filters the pool through `playsIn`. Before the
// game starts there is no round to protect and everything applies at once —
// which falls out of the same arithmetic, since a pre-game joiner is active
// from round 1 and the first round to start is round 1.

/** Is this player's playlist part of round `n`? */
export function playsIn(player: Player, n: number): boolean {
  return (player.activeFrom ?? 1) <= n && n <= (player.removedAfter ?? Infinity);
}

/** The roster as round `n` sees it. */
export function rosterFor(lobby: Lobby, n: number): Player[] {
  return lobby.players.filter((player) => playsIn(player, n));
}

/** Of a stored pool, the tracks round `n` is allowed to draw on. */
export function poolFor(lobby: Lobby, pool: Track[], n: number): Track[] {
  const ids = new Set(rosterFor(lobby, n).map((p) => p.playlistId));
  return pool.filter((track) => ids.has(track.playlistId));
}

/**
 * The round the roster is judged against: the classic song actually on screen,
 * or — when the host is back in the lobby, which is also where a Rush run is
 * started from — the next one to go on air.
 *
 * Not `max(currentRound, 1)`. That reads the roster against the song that just
 * finished, which was right while the host could never be anywhere but inside a
 * round, and stopped being right the moment they could walk back out to the
 * lobby and start something else: it counts a departing player's tracks into
 * the pool the next game draws from, and leaves a player who joined during the
 * last song showing as still waiting when the very next thing to start already
 * includes them.
 */
export function liveRound(lobby: Lobby): number {
  return lobby.activeRound ?? lobby.currentRound + 1;
}

/**
 * Rounds on air per contributor, as the fairness draw counts them: what they
 * have played, plus whatever they were credited on arrival.
 */
export function contributorCounts(lobby: Lobby, pool: Track[], n: number): Map<string, number> {
  const credited = new Map<string, number>();
  for (const player of rosterFor(lobby, n)) {
    const credit = player.creditedRounds ?? 0;
    const current = credited.get(player.name);
    // Two guests can share a display name, and the draw already treats them as
    // one contributor (see lib/select.ts). The longest-standing one sets the
    // credit — a namesake arriving late must not push the original down the
    // queue.
    credited.set(player.name, current === undefined ? credit : Math.min(current, credit));
  }

  const played = roundsByContributor(lobby.usedTrackIds, pool);
  for (const [name, credit] of credited) {
    credited.set(name, credit + (played.get(name) ?? 0));
  }
  return credited;
}

/**
 * What a player joining right now should be credited with: the count of whoever
 * is least-served in the round they are about to enter.
 *
 * Without it the bag would read a late joiner's empty history as being owed
 * every round the room already had — join at song six and the next five songs
 * are all yours, which is worse for them than for anyone. Level with the
 * quietest player means they are in the very next draw on equal terms, and no
 * more than that. Frozen here rather than derived at draw time: the floor rises
 * as the game goes on, and a credit that drifts up with it would leave them
 * permanently over-served instead.
 *
 * Measured over the round they'll first be drawn in, not the one on air, so
 * that a player on their way out — still in the current round, never in another
 * one — can't set a floor the joiner will never actually be competing against.
 */
export function joinCredit(lobby: Lobby, pool: Track[]): number {
  let floor = Infinity;
  for (const count of contributorCounts(lobby, pool, lobby.currentRound + 1).values()) {
    if (count < floor) floor = count;
  }
  return Number.isFinite(floor) ? floor : 0;
}

/**
 * Applies the changes waiting on the boundary into round `n` and returns the
 * pool that round draws from. Anyone the host removed leaves here for good,
 * taking their tracks with them, which is also what frees their playlist to be
 * added again later.
 */
export async function settleRoster(lobby: Lobby, n: number): Promise<Track[]> {
  const stored = await loadTracks(lobby.code);
  const departed = new Set(
    lobby.players
      .filter((player) => !playsIn(player, n) && player.removedAfter != null)
      .map((player) => player.playlistId),
  );

  let pool = stored;
  if (departed.size > 0) {
    lobby.players = lobby.players.filter((player) => !departed.has(player.playlistId));
    pool = stored.filter((track) => !departed.has(track.playlistId));
    // Written before the round is picked, because a removal is the host's call
    // and stands whether or not this round ends up starting.
    await saveTracks(lobby.code, pool);
    await saveLobby(lobby);
  }

  return poolFor(lobby, pool, n);
}

/**
 * Moves a lobby to the other game mode, in place.
 *
 * Everything that makes a lobby a lobby is shared — the code, the host token,
 * the roster and the pooled tracks — so switching is only ever a matter of
 * closing whichever mode currently has a screen open. That is deliberately the
 * one destructive part: a Rush run is a live clock against an absolute
 * deadline, so it cannot be left half-played and picked up later, and a classic
 * round the host has walked out of is spent (see `activeRound` in lib/types.ts).
 *
 * What survives is everything both modes read: the pool, the roster, the two
 * used/unusable lists — which are already kept apart per mode — and any round
 * prefetched while the last song played, still sitting unclaimed under
 * `currentRound + 1` for whenever classic comes back to it.
 *
 * A no-op when the lobby is already in `mode`, so a double-tap costs nothing.
 */
export function switchMode(lobby: Lobby, mode: LobbyMode): boolean {
  if (lobby.mode === mode) return false;
  lobby.mode = mode;
  lobby.activeRound = null;
  lobby.rush = null;
  return true;
}

export function toPublicLobby(lobby: Lobby, isHost: boolean): PublicLobby {
  const n = liveRound(lobby);
  const roster = rosterFor(lobby, n);
  const trackCount = roster.reduce((sum, p) => sum + p.trackCount, 0);

  return {
    code: lobby.code,
    isHost,
    mode: lobby.mode ?? 'classic',
    // The playlist's name never reaches the host screen — an audience can read
    // that screen, and a playlist title is a giveaway. SPEC §1.5.
    players: lobby.players.map((player) => ({
      id: player.id,
      name: player.name,
      trackCount: player.trackCount,
      isHost: player.id === lobby.hostPlayerId,
      status: player.removedAfter != null ? 'leaving' : playsIn(player, n) ? 'in' : 'joining',
    })),
    trackCount,
    currentRound: lobby.currentRound,
    activeRound: lobby.activeRound,
    canStart: trackCount > 0,
    rushActive: lobby.rush != null,
  };
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
