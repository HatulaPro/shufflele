import crypto from 'node:crypto';
import { findItunesMatch } from './itunes';
import { loadLobby, loadTracks, poolFor, saveLobby } from './lobby';
import { artistsLabel } from './round';
import { pickSecret } from './select';
import { findFullTrackVideo } from './ytmusic';
import { MIN_RUSH_POOL, RUSH_BONUS_MS } from './types';
import type {
  Lobby,
  PublicRush,
  PublicRushDeal,
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
 * Selection reuses the classic draw when more than one playlist is in the pool
 * (least-served first, popularity-weighted inside their tracks, lib/select.ts)
 * and goes fully uniform when there's only one, where the fairness machinery
 * has nobody to be fair to and popularity weighting would just shrink the
 * game.
 *
 * Songs may repeat freely — over a 60-second clock the pool is effectively
 * bottomless, and an exclusion list would only add state to forget.
 */

export const MAX_RUSH_LIVES = 3;
/** The board. Kept in step with `MIN_RUSH_POOL` — a board is exactly one pool's
    worth of rows, which is why the minimum is the board size and not a number
    of its own. */
const OPTIONS_COUNT = MIN_RUSH_POOL;
const MAX_PICK_ATTEMPTS = 8;

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
    previewUrl: null,
    videoId: null,
    options: [],
    next: null,
    history: [],
  };
}

/**
 * Starts the clock. Called when the first song actually goes on air, not when
 * the game is dealt — the ready screen and the ready-set-go beats sit between
 * the two, and on a one-minute control that gap is a real slice of it.
 *
 * Idempotent: a refresh mid-run re-arms the same screen and must not push the
 * deadline out.
 */
export function beginRush(state: RushState, now = Date.now()): void {
  if (state.begunAt !== null) return;
  state.begunAt = now;
  state.endsAt = state.timeControl === null ? null : now + state.timeControl * 1000;
}

/**
 * Pushes the deadline out by the correct-guess bonus. Mutates `state`. The
 * clock is a deadline rather than a tick (see `rushOver`), so a bonus is just a
 * later deadline — nothing accumulates, and nothing has to be replayed to know
 * how much time is left.
 *
 * A no-op on an infinite control, which has no deadline to push, and on a run
 * that has not begun — `endsAt` is null in both cases and the bonus would have
 * nothing to attach to. (A guess before `beginRush` isn't reachable through the
 * UI, but the rule holds either way: `beginRush` stamps the full control from
 * the moment the first song goes on air, so time banked before then would be
 * silently thrown away rather than added.)
 */
export function awardRushTime(state: RushState): void {
  if (state.endsAt === null) return;
  state.endsAt += RUSH_BONUS_MS;
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
 * One secret-track draw. Uniform over the whole pool when the lobby has a
 * single playlist in it; otherwise the classic bag shuffle with the popularity
 * weighting, which is what "more popular songs, re-prioritised players" means
 * here.
 *
 * The test is on playlists rather than contributor names because a name is the
 * wrong unit at both ends: two guests who both typed "Dan" are two playlists
 * that deserve the fair draw, and one playlist pasted by two people is still
 * one playlist, where weighting only shrinks the game.
 */
function pickRushTrack(pool: Track[], state: RushState): Track {
  const solo = new Set(pool.map((t) => t.playlistId)).size <= 1;
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
 * Picks a song and builds its board. Every track tried with nothing at all to
 * play comes back marked unusable so the caller can retire it: mid-run those
 * lookups are dead clock, and unrecorded they would be paid again on every
 * single deal for the rest of the lobby's life.
 *
 * `unusable` is what *Rush* can't play — neither source resolved. `previewless`
 * is the weaker fact that iTunes had no match, which retires the track from
 * classic mode only. Reporting them separately is the whole point: a track can
 * be dead to classic and perfectly fine here.
 */
async function buildDeal(
  state: RushState,
  candidates: Track[],
): Promise<{ deal: RushDeal | null; unusable: string[]; previewless: string[] }> {
  const unusable: string[] = [];
  const previewless: string[] = [];
  if (candidates.length < MIN_LIVE_POOL) return { deal: null, unusable, previewless };

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
    if (!preview) previewless.push(track.spotifyId);

    // Either source is a playable song. Gating this on the preview alone —
    // which is what it used to do — threw away tracks whose YouTube master had
    // already been found and was the thing Rush would actually have played,
    // purely because iTunes' matcher couldn't clear its threshold on the
    // title. That fell hardest on non-Latin and remix-heavy catalogues, and
    // since the rejects were retired for the lobby's whole life it quietly
    // sanded every pool down toward the mainstream.
    if (video || preview) {
      secret = { ...track, albumArt: track.albumArt ?? match?.albumArt ?? null };
      previewUrl = preview;
      videoId = video;
      break;
    }
    unusable.push(track.spotifyId);
  }

  if (!secret) return { deal: null, unusable, previewless };

  // Distractors come from anywhere in the pool — the answer's own playlist
  // included, which is the fun kind of hard.
  const others = shuffled(candidates.filter((t) => t.spotifyId !== secret!.spotifyId)).slice(
    0,
    Math.min(OPTIONS_COUNT, candidates.length) - 1,
  );
  return {
    deal: { secret, previewUrl, videoId, options: shuffled([secret, ...others]) },
    unusable,
    previewless,
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
 *
 * `unusable` in and out is Rush's own list (`rushUnusableTrackIds`), never the
 * classic one — see the field's note in lib/types.ts. `previewless` rides along
 * for the caller to fold into the classic list.
 */
export async function dealRushSong(
  state: RushState,
  pool: Track[],
  unusable: Iterable<string> = [],
): Promise<{ ok: boolean; unusable: string[]; previewless: string[] }> {
  const queued = state.next;
  if (queued) {
    state.next = null;
    applyDeal(state, queued);
    return { ok: true, unusable: [], previewless: [] };
  }

  const result = await buildDeal(state, rushCandidates(pool, unusable));
  if (result.deal) applyDeal(state, result.deal);
  return { ok: result.deal !== null, unusable: result.unusable, previewless: result.previewless };
}

/**
 * Files what a deal learned onto the lobby, into the two lists that mean
 * different things: `unusable` retires a track from Rush, `previewless` from
 * classic. Both are deduped, since a warm-up and an inline deal can report the
 * same id.
 *
 * Rush's list starts empty on lobbies that predate it, which also disposes of
 * the tracks the old preview-only gate wrongly retired — they were filed under
 * the classic list, where the judgement is still true.
 */
export function retire(lobby: Lobby, unusable: Iterable<string>, previewless: Iterable<string>): void {
  const rush = (lobby.rushUnusableTrackIds ??= []);
  const seenRush = new Set(rush);
  for (const id of unusable) {
    if (!seenRush.has(id)) {
      seenRush.add(id);
      rush.push(id);
    }
  }

  const seenClassic = new Set(lobby.unusableTrackIds);
  for (const id of previewless) {
    if (!seenClassic.has(id)) {
      seenClassic.add(id);
      lobby.unusableTrackIds.push(id);
    }
  }
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

    // The same round the run was dealt from — see the start route.
    const pool = poolFor(lobby, await loadTracks(code), lobby.currentRound + 1);
    const { deal, unusable, previewless } = await buildDeal(
      rush,
      rushCandidates(pool, lobby.rushUnusableTrackIds ?? []),
    );

    // Merge into a fresh read rather than the copy above: a guess may well have
    // landed while the lookup ran, and this write must not roll it back.
    const fresh = await loadLobby(code);
    if (!fresh?.rush) return;

    retire(fresh, unusable, previewless);
    if (deal && !fresh.rush.next && !rushOver(fresh.rush)) fresh.rush.next = deal;

    await saveLobby(fresh);
  } catch {
    // Warming is best-effort by design; the guess route deals inline without it.
  }
}

/**
 * Files the song still on air as a miss. The clock can expire (or the player
 * can quit) with a song dealt and unguessed, and that song never passed
 * through the guess route — without this it vanishes from the finish screen's
 * missed list entirely. No life is charged: the run is over either way.
 *
 * Idempotent, and a no-op once the board is cleared, so a second finish call
 * can't file the same song twice.
 */
export function recordUnguessedRushSong(state: RushState): void {
  if (!state.secret?.spotifyId) return;
  state.history.push({ song: rushSongRef(state.secret), correct: false });
  state.secret = {} as Track;
  state.previewUrl = null;
  state.videoId = null;
  state.options = [];
}

function publicOption(track: Track): RushOption {
  return {
    spotifyId: track.spotifyId,
    title: track.title,
    artist: artistsLabel(track),
    albumArt: track.albumArt,
  };
}

/**
 * A warmed deal, ready for the client to put on air itself. Carries the answer
 * for the same reason the song on air does — see `answerId` in lib/types.ts —
 * and the server re-judges the guess regardless.
 */
function publicDeal(deal: RushDeal): PublicRushDeal {
  return {
    answerId: deal.secret.spotifyId,
    previewUrl: deal.previewUrl,
    videoId: deal.videoId,
    options: deal.options.map(publicOption),
  };
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
    // Stamped as late as possible: the client pairs it with its own clock to
    // work out the offset between the two, so the less of this request's own
    // handling sits between the two readings, the smaller the error.
    now: Date.now(),
    lives: Math.max(0, state.lives),
    maxLives: MAX_RUSH_LIVES,
    score: state.score,
    over,
    previewUrl: over ? null : state.previewUrl,
    videoId: over ? null : state.videoId,
    options: over ? [] : state.options.map(publicOption),
    answerId: over ? null : (state.secret?.spotifyId ?? null),
    // Withheld once the run is over: the finish screen has no board to play,
    // and a spent run shouldn't leave a song queued in the client.
    next: over || !state.next ? null : publicDeal(state.next),
    summary,
  };
}
