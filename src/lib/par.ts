/**
 * Par comes from Spotify's `popularity` (0–100), fetched in bulk at ingest and
 * carried on the track object — no extra call at pick time. See
 * `fetchTrackMeta` in lib/spotify.ts.
 *
 * It's display-and-scoring only: it sets the difficulty header and what counts
 * as a good result, and never changes how many rows the round has. SPEC §1.3.
 *
 * Par tops out at 4 because a full ladder is 4 rows (three stems plus the final
 * guess), so nothing above that is reachable. Hard and Very hard therefore share
 * a par and differ only in label — an honest reading of "you get every row".
 * A round whose ladder came up short clamps further, in `toPublicRound`.
 */
export type Par = { par: number; difficulty: string };

export function parFor(popularity: number | null): Par | null {
  // No credentials configured, or Spotify didn't know the track. The round runs
  // without a difficulty header rather than showing an invented one. Checked by
  // type rather than against null: a track pooled before popularity existed is
  // still in Redis under a live lobby TTL, and has no such field at all.
  if (typeof popularity !== 'number') return null;

  if (popularity >= 75) return { par: 1, difficulty: 'Very easy' };
  if (popularity >= 60) return { par: 2, difficulty: 'Easy' };
  if (popularity >= 40) return { par: 3, difficulty: 'Medium' };
  if (popularity >= 20) return { par: 4, difficulty: 'Hard' };
  return { par: 4, difficulty: 'Very hard' };
}
