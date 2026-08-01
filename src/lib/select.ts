import crypto from 'node:crypto';
import type { Track } from './types';

/**
 * Secret-track selection. SPEC §3.2.
 *
 * Three stages: a contributor drawn from whoever has had the fewest rounds so
 * far, then a popularity-weighted track inside their tracks, then a small
 * uniform escape hatch so the tail stays reachable. Nothing here is persisted —
 * the picker's whole memory is the exclusion set and the used-track list the
 * start route already keeps on the lobby, both passed in as arguments.
 *
 * Every ingested track is a candidate. There used to be a sampling stage here
 * that marked a subset of the pool drawable, because popularity cost a Deezer
 * search per track and the budget only stretched so far; the Web API hands
 * popularity over with the tracklist, so there is nothing left to ration.
 * Pool size needs no cap either — `pickSecret` draws the contributor before it
 * ever looks at tracks, so a 500-song playlist is heard exactly as often as a
 * 30-song one.
 */

/**
 * Every constant is a dial on "how strongly does popularity decide this".
 * Sharper bias means lowering TEMPERATURE, not raising anything else.
 */
const TEMPERATURE = 6;
const MAX_DEFICIT = 50;
const UNIFORM_MIX = 0.07;
const REF_QUANTILE = 0.86;

/**
 * Uniform in [0, 1). Six bytes is 2^48 buckets — far more resolution than the
 * widest weight ratio here (~4200:1) can use, and it divides exactly, so there's
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
 *   only e^2.5 ≈ 12x behind the top — still a broad draw;
 * - an alternative playlist spans 5–65, so its deep cuts sit 50 points down
 *   and get crushed by orders of magnitude.
 *
 * The reference point is the 86th percentile rather than the max, so the whole
 * top seventh ties for maximum weight. A 200-song playlist therefore has a head
 * of ~28 songs, not one mega-hit that flattens everything under it — and a
 * single outlier smash in an otherwise niche playlist stays harmless.
 */
function weightsFor(playlist: Track[]): number[] {
  const known = playlist
    .map((t) => t.popularity)
    .filter((p): p is number => typeof p === 'number')
    .sort((a, b) => a - b);

  // A playlist Spotify scored nothing in degenerates to a uniform draw, which
  // is the right fallback — it should still be playable, just unweighted.
  if (known.length === 0) return playlist.map(() => 1);

  const ref = quantile(known, REF_QUANTILE);
  // An unknown popularity is treated as typical for its playlist, not as zero
  // — otherwise a track the payload happened to omit the field for becomes
  // unpickable rather than merely unlabelled.
  const fallback = quantile(known, 0.5);

  return playlist.map((track) => {
    const p = typeof track.popularity === 'number' ? track.popularity : fallback;
    // Clamped so nothing is more than e^8.3 ≈ 4200x behind the head. At this
    // temperature the clamp no longer does much on its own — what actually
    // keeps the bottom of a wide playlist reachable is UNIFORM_MIX.
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

/**
 * Fairness is per *contributor*, not per playlist. The thing that feels bad at
 * a party is one person's music playing three rounds running while someone
 * else's never comes up, and a player who submitted two playlists is still one
 * person — giving them two entries in the draw would recreate exactly the
 * problem this exists to fix.
 *
 * Grouping on the display name has one honest failure: two guests who both
 * typed "Dan" share a turn. That is rarer than one person adding a second
 * playlist, and it errs toward under-representing rather than over-, which is
 * the cheaper mistake.
 */
function contributorKey(track: Track): string {
  return track.contributor;
}

function groupBy(tracks: Track[], key: (t: Track) => string): Map<string, Track[]> {
  const groups = new Map<string, Track[]>();
  for (const track of tracks) {
    const group = groups.get(key(track));
    if (group) group.push(track);
    else groups.set(key(track), [track]);
  }
  return groups;
}

/**
 * Contributors tied for the fewest rounds played so far. This is the whole bag
 * shuffle: draw only from the least-served, and the bag refills itself the
 * moment everyone is level, with no explicit refill branch to get wrong.
 *
 * A contributor whose tracks are all used up simply stops appearing in
 * `groups`, so the others' minimum keeps advancing rather than the draw
 * deadlocking on someone with nothing left to give.
 */
function leastServed(groups: Map<string, Track[]>, played: Map<string, number>): Track[][] {
  let fewest = Infinity;
  let winners: Track[][] = [];

  for (const [key, tracks] of groups) {
    const count = played.get(key) ?? 0;
    if (count < fewest) {
      fewest = count;
      winners = [tracks];
    } else if (count === fewest) {
      winners.push(tracks);
    }
  }

  return winners;
}

/**
 * One secret-track draw from the already-filtered eligible pool.
 *
 * Contributor-first is what gives every player the same chance no matter how
 * many tracks they contributed — a 30-song playlist matters exactly as much as
 * a 300-song one, with no size normalisation anywhere.
 *
 * `alreadyPlayed` is the tracks that became real rounds, which the lobby
 * already stores as `usedTrackIds`; passing them makes the outer draw a bag
 * shuffle instead of sixteen independent coin flips. It is optional because
 * the draw is still correct without it, just memoryless.
 *
 * Memoryless is worse than it sounds. Simulated over six contributors: with a
 * uniform draw, six rounds leave *somebody* with nothing 98% of the time, and
 * even ten rounds — the whole daily cap — do it 72% of the time. The bag takes
 * both to zero, with at most one round between the busiest and quietest
 * player, and without shifting anyone's long-run share off 1/n.
 *
 * Only tracks that made it to air count. A track drawn and then discarded for
 * having no preview (see the start route's retry loop) must not spend its
 * contributor's turn — they'd be punished for a gap in Apple's catalogue.
 *
 * The alternative considered was soft weighting — `exp(-times_used)` — which
 * keeps repeats possible rather than forbidding them. The bag won on being
 * exactly checkable: every contributor is heard once before anyone is heard
 * twice, full stop, which is the promise worth making to a room.
 *
 * Cost is O(n) to group plus O(m log m) to sort the one chosen group, so a
 * 1000-track pool is well under a millisecond and the start route can afford
 * to call this once per retry attempt.
 */
export function pickSecret(eligible: Track[], alreadyPlayed: Track[] = []): Track | null {
  if (eligible.length === 0) return null;

  const groups = groupBy(eligible, contributorKey);

  const played = new Map<string, number>();
  for (const track of alreadyPlayed) {
    const key = contributorKey(track);
    played.set(key, (played.get(key) ?? 0) + 1);
  }

  const playlist = pickUniform(leastServed(groups, played));

  // Roughly one round in fourteen ignores popularity entirely. This is the
  // answer to "don't play the same handful of songs out of a 200-song
  // playlist" that doesn't cost any state: within a lobby the exclusion already
  // drains the head, and across lobbies this keeps the head from being the
  // only thing anyone ever hears.
  if (randomFloat() < UNIFORM_MIX) return pickUniform(playlist);

  return weightedPick(playlist, weightsFor(playlist));
}
