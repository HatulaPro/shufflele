/**
 * Par comes from Spotify's `popularity` (0–100), which we already have on the
 * track object from ingest — no extra call. It's display-and-scoring only: it
 * sets the difficulty header and what counts as a good result, and never
 * changes how many rows the round has. SPEC §1.3.
 */
export function parFor(popularity: number): { par: number; difficulty: string } {
  if (popularity >= 75) return { par: 1, difficulty: 'Very easy' };
  if (popularity >= 60) return { par: 2, difficulty: 'Easy' };
  if (popularity >= 40) return { par: 3, difficulty: 'Medium' };
  if (popularity >= 20) return { par: 4, difficulty: 'Hard' };
  return { par: 5, difficulty: 'Very hard' };
}
