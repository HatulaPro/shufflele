import crypto from 'node:crypto';
import type { Track } from './types';

/**
 * Secret-track selection. SPEC §3.2.
 *
 * Three stages: a playlist uniformly at random, then a popularity-weighted
 * track inside it, then a small uniform escape hatch so the tail stays
 * reachable. Nothing here is persisted — the only memory the picker has is the
 * exclusion set the start route already keeps on the lobby.
 */

/**
 * Every constant is a dial on "how strongly does popularity decide this".
 * Sharper bias means lowering TEMPERATURE, not raising anything else.
 */
const TEMPERATURE = 8;
const MAX_DEFICIT = 50;
const UNIFORM_MIX = 0.07;
const REF_QUANTILE = 0.9;

/**
 * How many *Deezer lookups* the whole lobby spends, split evenly across
 * playlists. This is a budget on work, not on pool size: a track whose
 * popularity is already in the cross-lobby cache (lib/deezer.ts) costs
 * nothing and is always pooled, so a lobby full of playlists that have been
 * played before pools everything for the same 25s ceiling.
 *
 * Pool size itself needs no cap: `pickSecret` draws the playlist uniformly
 * before it ever looks at tracks, so a fully-pooled playlist is heard no more
 * often than a thinly-sampled one.
 *
 * Fixed in total rather than per playlist because the cost this bounds is per
 * lobby, not per player. A two-player lobby would otherwise pay a fifth of
 * what a ten-player one does for the same budget.
 *
 * 150 is set by the lookup budget, not by the game: the paced Deezer fleet
 * resolves ~8 tracks a second, so a cold pool lands in ~18s against a 25s
 * ceiling. At 5 rounds a day it is more secrets than a lobby can ever spend.
 */
const LOOKUP_TOTAL = 150;
const LOOKUP_MAX_PER_PLAYLIST = 50;

/**
 * Uniform in [0, 1). Six bytes is 2^48 buckets — far more resolution than the
 * widest weight ratio here (~90:1) can use, and it divides exactly, so there's
 * no modulo bias to argue about.
 */
function randomFloat(): number {
  return crypto.randomBytes(6).readUIntBE(0, 6) / 2 ** 48;
}

function pickUniform<T>(items: T[]): T {
  return items[crypto.randomInt(items.length)];
}

/** Linear-interpolated quantile over an ascending array. */
function quantile(sortedAsc: number[], q: number): number {
  if (sortedAsc.length === 1) return sortedAsc[0];
  const pos = (sortedAsc.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (pos - lo);
}

/**
 * Weight a track by how far its popularity sits *below its own playlist's*
 * head, never by the raw 0–100 score. That one choice is what makes the same
 * formula behave differently per playlist without any per-playlist tuning:
 *
 * - a playlist of global hits spans maybe 75–92, so the least likely song is
 *   only e^1.7 ≈ 5x behind the top — effectively a fair draw;
 * - an alternative playlist spans 5–65, so its deep cuts sit 50 points down
 *   and get crushed by orders of magnitude.
 *
 * The reference point is the 90th percentile rather than the max, so the whole
 * top decile ties for maximum weight. A 200-song playlist therefore has a head
 * of ~20 songs, not one mega-hit that flattens everything under it — and a
 * single outlier smash in an otherwise niche playlist stays harmless.
 */
function weightsFor(playlist: Track[]): number[] {
  const known = playlist
    .map((t) => t.popularity)
    .filter((p): p is number => typeof p === 'number')
    .sort((a, b) => a - b);

  // A playlist Spotify never answered for degenerates to a uniform draw, which
  // is the right fallback: popularity is fetched best-effort (lib/spotify.ts).
  if (known.length === 0) return playlist.map(() => 1);

  const ref = quantile(known, REF_QUANTILE);
  // An unknown popularity is treated as typical for its playlist, not as zero
  // — otherwise a partial Spotify outage silently makes those tracks
  // unpickable rather than merely unlabelled.
  const fallback = quantile(known, 0.5);

  return playlist.map((track) => {
    const p = typeof track.popularity === 'number' ? track.popularity : fallback;
    // Clamped so nothing is more than e^6.25 ≈ 518x behind the head. Without the
    // cap the bottom of a wide playlist is reachable only in theory.
    const deficit = Math.min(Math.max(ref - p, 0), MAX_DEFICIT);
    return Math.exp(-deficit / TEMPERATURE);
  });
}

function weightedPick(playlist: Track[], weights: number[]): Track {
  let total = 0;
  for (const w of weights) total += w;

  let r = randomFloat() * total;
  for (let i = 0; i < playlist.length; i++) {
    r -= weights[i];
    if (r < 0) return playlist[i];
  }
  // Only reachable through float drift on the last bucket.
  return playlist[playlist.length - 1];
}

/** Fisher–Yates over a copy, using the same CSPRNG as every other draw here. */
function shuffled<T>(items: T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Mark the tracks the lobby will actually draw secrets from, in place.
 *
 * `resolved` holds the ids whose popularity the cross-lobby cache already
 * answered (see `applyCachedPopularity`). Those tracks cost no Deezer lookup,
 * so every one of them is pooled unconditionally; the lookup quota is spent
 * only on tracks that still need a search. With an empty set this degrades to
 * exactly the old behaviour: quota tracks per playlist, all needing lookups.
 *
 * Sampling is uniform inside each playlist; the popularity weighting in
 * `pickSecret` then applies within the sample.
 *
 * Called once, at the first round, because the per-playlist quota can't be
 * known at join time: players arrive one at a time and the divisor is how many
 * of them there turn out to be.
 *
 * Returns the pooled tracks; the ones not in `resolved` are the ones worth
 * sending to Deezer.
 */
export function samplePool(tracks: Track[], resolved: ReadonlySet<string>): Track[] {
  const byPlaylist = new Map<string, Track[]>();
  for (const track of tracks) {
    track.pooled = false;
    const group = byPlaylist.get(track.playlistId);
    if (group) group.push(track);
    else byPlaylist.set(track.playlistId, [track]);
  }

  if (byPlaylist.size === 0) return [];

  const lookupQuota = Math.min(
    LOOKUP_MAX_PER_PLAYLIST,
    Math.max(1, Math.floor(LOOKUP_TOTAL / byPlaylist.size)),
  );

  const pooled: Track[] = [];
  for (const group of byPlaylist.values()) {
    let lookups = 0;

    for (const track of shuffled(group)) {
      const needsLookup = !resolved.has(track.spotifyId);
      if (needsLookup) {
        // Over the lookup budget: skip, but keep scanning — a resolved track
        // further down the shuffle still rides for free.
        if (lookups >= lookupQuota) continue;
        lookups++;
      }

      track.pooled = true;
      pooled.push(track);
    }
  }

  return pooled;
}

/**
 * One secret-track draw from the already-filtered eligible pool.
 *
 * Playlist-first is what gives every player's playlist the same chance no
 * matter how many tracks it contributed — a 30-song playlist matters exactly
 * as much as a 300-song one, with no size normalisation anywhere.
 *
 * Cost is O(n) to group plus O(m log m) to sort the one chosen playlist, so a
 * 1000-track pool is well under a millisecond and the start route can afford
 * to call this once per retry attempt.
 */
export function pickSecret(eligible: Track[]): Track | null {
  if (eligible.length === 0) return null;

  const byPlaylist = new Map<string, Track[]>();
  for (const track of eligible) {
    const group = byPlaylist.get(track.playlistId);
    if (group) group.push(track);
    else byPlaylist.set(track.playlistId, [track]);
  }

  const playlist = pickUniform([...byPlaylist.values()]);

  // Roughly one round in fourteen ignores popularity entirely. This is the answer to
  // "don't play the same handful of songs out of a 200-song playlist" that
  // doesn't cost any state: within a lobby the used-track exclusion already
  // drains the head, and across lobbies this keeps the head from being the
  // only thing anyone ever hears.
  if (randomFloat() < UNIFORM_MIX) return pickUniform(playlist);

  return weightedPick(playlist, weightsFor(playlist));
}
