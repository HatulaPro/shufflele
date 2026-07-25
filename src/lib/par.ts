/**
 * Par used to be derived from Spotify's `popularity` (0–100) on the track
 * object. Spotify stopped serving that field entirely — it's absent from
 * /playlists/{id}/items, from /tracks/{id}, from /artists/{id}, and from
 * search results, and the batch endpoints that carried it now 403 — so there is
 * no per-track difficulty signal left to read.
 *
 * Every round therefore gets the same par until we pick a new source. Par is
 * display-and-scoring only; it never changes how many rows a round has, so a
 * flat value degrades the scoreboard rather than breaking the game. SPEC §1.3.
 *
 * TODO: replace with a real difficulty signal — release year is still
 * available, and guess data across rounds would measure actual difficulty.
 */
export function parFor(): { par: number; difficulty: string } {
  return { par: 3, difficulty: 'Standard' };
}
