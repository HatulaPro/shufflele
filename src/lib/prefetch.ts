import { contributorCounts, loadLobby, loadRound, loadTracks, poolFor, saveLobby } from './lobby';
import { prepareRound } from './prepare';
import { keys, redis } from './redis';

/**
 * Starts separating the next song while the current one is still on air, so
 * the wait between songs is mostly gone by the time the host taps "Next".
 * Fired from the ladder route the moment a round reaches `playing`, via
 * `after()` — the host's response never waits on any of this.
 *
 * Deliberately invisible: nothing here reaches the UI, and every failure is a
 * silent fall-through to the start route's normal synchronous pick. The rules
 * are the start route's rules — same fairness draw, same exclusions, same
 * daily limit (a day at its cap simply doesn't prefetch) — with one accepted
 * looseness: the roster is read as it stands mid-round, so a player who joins
 * after this fires waits one extra song, and a player removed after it fires
 * is caught by the validity check in the start route instead.
 *
 * The round is written under `n + 1` with `currentRound` untouched, which is
 * what keeps it invisible: nothing reads a round ahead of `currentRound`, and
 * the webhook addresses rounds by number, so completion lands in the right
 * place whether or not the round ever airs.
 */
export async function prefetchNextRound(code: string, current: number): Promise<void> {
  const next = current + 1;

  try {
    // NX lock so a double-posted ladder can't buy two predictions for one slot.
    const lock = await redis().set(keys.prefetchLock(code, next), 1, { nx: true, ex: 300 });
    if (lock !== 'OK') return;

    const lobby = await loadLobby(code);
    // `currentRound` moved (or the lobby closed) while this was queued — the
    // slot this was going to fill no longer exists.
    if (!lobby || lobby.currentRound !== current) return;
    if (await loadRound(code, next)) return;

    const pool = poolFor(lobby, await loadTracks(code), next);
    if (pool.length === 0) return;

    const played = contributorCounts(lobby, pool, next);
    const result = await prepareRound(
      code,
      next,
      pool,
      [...lobby.usedTrackIds, ...lobby.unusableTrackIds],
      played,
      { prefetched: true },
    );

    // Merge the unusable marks into a fresh read rather than the copy above:
    // joins and guesses may have written the lobby while the pick ran, and
    // this write must not roll them back.
    if (result.unusable.length > 0) {
      const fresh = await loadLobby(code);
      if (fresh) {
        const seen = new Set(fresh.unusableTrackIds);
        for (const id of result.unusable) {
          if (!seen.has(id)) fresh.unusableTrackIds.push(id);
        }
        await saveLobby(fresh);
      }
    }

    if (!result.ok && result.reason !== 'limit') {
      console.warn(`[prefetch] ${code}: round ${next} not prefetched (${result.reason})`);
    }
  } catch (error) {
    console.warn(`[prefetch] ${code}: round ${next} prefetch failed`, error);
  }
}
