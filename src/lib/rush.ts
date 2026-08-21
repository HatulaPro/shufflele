import crypto from 'node:crypto';
import { findItunesMatch } from './itunes';
import { loadLobby, loadTracks, poolFor, saveLobby } from './lobby';
import { artistsLabel } from './round';
import { pickSecret } from './select';
import { findFullTrackVideo } from './ytmusic';
import type {
  PublicRush,
  RushDeal,
  RushOption,
  RushSongRef,
  RushState,
  RushTimeControl,
  Track,
} from './types';

/**
 * Rush mode: guess as many songs as you can against the clock, three lives.
 *
 * Nothing here touches Replicate — a song costs a couple of metadata lookups
 * and nothing else.
 *
 * Songs play from their first bar, which a preview clip cannot do: Apple's and
 * Spotify's previews are pre-cut excerpts from the middle of a recording, with
 * no offset to pass. So each deal also resolves the track's YouTube art track
 * (lib/ytmusic.ts), which the client streams from t=0 in a hidden iframe.
 * That lookup is allowed to fail — `videoId` is then null and the client plays
 * the preview clip exactly as it always did. Classic mode is untouched and
 * stays on previews throughout.
 *
 * Selection reuses the classic draw when more than one contributor is in the
 * pool (least-served first, popularity-weighted inside their tracks,
 * lib/select.ts) and goes fully uniform when there's only one, where the
 * fairness machinery has nobody to be fair to and popularity weighting would
 * just shrink the game.
 *
 * Songs may repeat freely — over a 60-second clock the pool is effectively
 * bottomless, and an exclusion list would only add state to forget.
 */

export const MAX_RUSH_LIVES = 3;
const OPTIONS_COUNT = 10;
const MAX_PICK_ATTEMPTS = 8;

/**
 * A half-empty board is a giveaway, and a pool of one is a row that's correct
 * every time — free score forever. Rush wants a full board to start with.
 */
export const MIN_RUSH_POOL = OPTIONS_COUNT;

/** Below this the board stops being a guess at all, so the run ends instead. */
const MIN_LIVE_POOL = 2;

export function freshRush(timeControl: RushTimeControl, now = Date.now()): RushState {
  return {
    timeControl,
    startedAt: now,
    begunAt: null,
    endsAt: null,
    lives: MAX_RUSH_LIVES,
    score: 0,
    over: false,
    secret: {} as Track,
    previewUrl: '',
    videoId: null,
    options: [],
    next: null,
    history: [],
  };
}

/**
 * Starts the clock. Called when the first song actually goes on air, not when
 * the game is dealt — the ready screen and the ready-set-go beats sit between
 * the two, and on a 30-second control that gap is a tenth of the game.
 *
 * Idempotent: a refresh mid-run re-arms the same screen and must not push the
 * deadline out.
 */
export function beginRush(state: RushState, now = Date.now()): void {
  if (state.begunAt !== null) return;
  state.begunAt = now;
  state.endsAt = state.timeControl === null ? null : now + state.timeControl * 1000;
}

/** The clock is a deadline, not a tick — expiry is derived, never polled. */
export function rushOver(state: RushState, now = Date.now()): boolean {
  return state.over || (state.endsAt !== null && now >= state.endsAt);
}

export function rushSongRef(track: Track): RushSongRef {
  return {
    title: track.title,
    artist: artistsLabel(track),
    albumArt: track.albumArt,
    contributor: track.contributor,
  };
}

/**
 * Rounds on air per contributor, from the history alone — every entry carries
 * the name, so the pool never has to be consulted. Namesakes share a count,
 * exactly as the classic draw treats them (lib/select.ts).
 */
function playedByContributor(state: RushState): Map<string, number> {
  const counts = new Map<string, number>();
  for (const { song } of state.history) {
    counts.set(song.contributor, (counts.get(song.contributor) ?? 0) + 1);
  }
  return counts;
}

/**
 * One secret-track draw. Uniform over the whole pool for a lone contributor;
 * otherwise the classic bag shuffle with the popularity weighting, which is
 * what "more popular songs, re-prioritised players" means here.
 */
function pickRushTrack(pool: Track[], state: RushState): Track {
  const solo = new Set(pool.map((t) => t.contributor)).size <= 1;
  if (solo) return pool[crypto.randomInt(pool.length)];
  return pickSecret(pool, playedByContributor(state)) ?? pool[crypto.randomInt(pool.length)];
}

/**
 * The pool a board can be built from. Distinct songs only — two rows sharing
 * an id would be one song with two ways to be right, or worse, two ways to be
 * wrong. Tracks already known to have no preview drop out here rather than
 * being rediscovered a lookup at a time, the same bookkeeping the classic
 * start route does with the lobby's unusable list.
 */
export function rushCandidates(pool: Track[], unusable: Iterable<string> = []): Track[] {
  const dead = new Set(unusable);
  const seen = new Set<string>();
  const unique: Track[] = [];
  for (const track of pool) {
    if (seen.has(track.spotifyId) || dead.has(track.spotifyId)) continue;
    seen.add(track.spotifyId);
    unique.push(track);
  }
  return unique;
}

function shuffled<T>(items: T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Picks a song and builds its board. Every track tried without a playable
 * preview comes back marked unusable so the caller can retire it: mid-run
 * those lookups are dead clock, and unrecorded they would be paid again on
 * every single deal for the rest of the lobby's life.
 */
async function buildDeal(
  state: RushState,
  candidates: Track[],
): Promise<{ deal: RushDeal | null; unusable: string[] }> {
  const unusable: string[] = [];
  if (candidates.length < MIN_LIVE_POOL) return { deal: null, unusable };

  const tried = new Set<string>();
  let secret: Track | null = null;
  let previewUrl: string | null = null;
  let videoId: string | null = null;

  for (let attempt = 0; attempt < MAX_PICK_ATTEMPTS && candidates.length > tried.size; attempt++) {
    const eligible = candidates.filter((t) => !tried.has(t.spotifyId));
    const track = pickRushTrack(eligible, state);
    tried.add(track.spotifyId);

    // Both lookups at once: the preview is the fallback source and has to be
    // resolved either way, so paying for them in sequence would put an
    // avoidable round trip on the clock.
    const [match, video] = await Promise.all([
      findItunesMatch(track).catch(() => null),
      findFullTrackVideo(track).catch(() => null),
    ]);

    const preview = match?.previewUrl ?? track.previewUrl ?? null;
    if (preview) {
      secret = { ...track, albumArt: track.albumArt ?? match?.albumArt ?? null };
      previewUrl = preview;
      videoId = video;
      break;
    }
    unusable.push(track.spotifyId);
  }

  if (!secret || !previewUrl) return { deal: null, unusable };

  // Distractors come from anywhere in the pool — the answer's own playlist
  // included, which is the fun kind of hard.
  const others = shuffled(candidates.filter((t) => t.spotifyId !== secret!.spotifyId)).slice(
    0,
    Math.min(OPTIONS_COUNT, candidates.length) - 1,
  );
  return {
    deal: { secret, previewUrl, videoId, options: shuffled([secret, ...others]) },
    unusable,
  };
}

function applyDeal(state: RushState, deal: RushDeal): void {
  state.secret = deal.secret;
  state.previewUrl = deal.previewUrl;
  state.videoId = deal.videoId;
  state.options = deal.options;
}

/**
 * Puts the next song on air: secret, preview, ten options with the secret
 * among them. Mutates `state`. Takes the warmed deal when one is waiting —
 * that is the whole point of warmNextRushSong — and otherwise falls back to a
 * synchronous pick. `ok` is false when the pool has nothing playable left, so
 * the game can end on the score it has rather than sit wedged.
 */
export async function dealRushSong(
  state: RushState,
  pool: Track[],
  unusable: Iterable<string> = [],
): Promise<{ ok: boolean; unusable: string[] }> {
  const queued = state.next;
  if (queued) {
    state.next = null;
    applyDeal(state, queued);
    return { ok: true, unusable: [] };
  }

  const result = await buildDeal(state, rushCandidates(pool, unusable));
  if (result.deal) applyDeal(state, result.deal);
  return { ok: result.deal !== null, unusable: result.unusable };
}

/**
 * Deals the song *after* the one on air, so the next guess is answered from
 * memory instead of from iTunes. Fired from `after()`: the player's response
 * never waits on it, and a failure is a silent fall-through to the inline pick
 * in the guess route. Same idea as lib/prefetch.ts, minus the GPU.
 */
export async function warmNextRushSong(code: string): Promise<void> {
  try {
    const lobby = await loadLobby(code);
    const rush = lobby?.rush;
    if (!lobby || !rush || rush.next || rushOver(rush)) return;

    const pool = poolFor(lobby, await loadTracks(code), Math.max(lobby.currentRound, 1));
    const { deal, unusable } = await buildDeal(rush, rushCandidates(pool, lobby.unusableTrackIds));

    // Merge into a fresh read rather than the copy above: a guess may well have
    // landed while the lookup ran, and this write must not roll it back.
    const fresh = await loadLobby(code);
    if (!fresh?.rush) return;

    const seen = new Set(fresh.unusableTrackIds);
    for (const id of unusable) {
      if (!seen.has(id)) fresh.unusableTrackIds.push(id);
    }
    if (deal && !fresh.rush.next && !rushOver(fresh.rush)) fresh.rush.next = deal;

    await saveLobby(fresh);
  } catch {
    // Warming is best-effort by design; the guess route deals inline without it.
  }
}

/** The client never learns which option is the answer — see the guess route. */
function publicOptions(state: RushState): RushOption[] {
  return state.options.map((t) => ({
    spotifyId: t.spotifyId,
    title: t.title,
    artist: artistsLabel(t),
    albumArt: t.albumArt,
  }));
}

/**
 * The public view. `over` folds in clock expiry so a client that polls past
 * the deadline sees the finish screen even before anything marks it stored;
 * the finish route does the marking.
 */
export function toPublicRush(state: RushState): PublicRush {
  const over = rushOver(state);
  const summary = over
    ? {
        correct: state.history.filter((h) => h.correct).map((h) => h.song),
        wrong: state.history.filter((h) => !h.correct).map((h) => h.song),
      }
    : null;

  return {
    timeControl: state.timeControl,
    endsAt: state.endsAt,
    lives: Math.max(0, state.lives),
    maxLives: MAX_RUSH_LIVES,
    score: state.score,
    over,
    previewUrl: over ? null : state.previewUrl,
    videoId: over ? null : state.videoId,
    options: over ? [] : publicOptions(state),
    summary,
  };
}
