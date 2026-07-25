export const PLAYABLE_STEMS = ['drums', 'bass', 'other'] as const;
export type PlayableStem = (typeof PLAYABLE_STEMS)[number];
/** `vocals` is separated but never leaves the server. See SPEC §3.3. */
export type StemName = PlayableStem | 'vocals';

export const STEM_LABEL: Record<PlayableStem, string> = {
  drums: 'Drums',
  bass: 'Bass',
  other: 'Melody',
};

export type Artist = { id: string | null; name: string };

export type Track = {
  spotifyId: string;
  title: string;
  artists: Artist[];
  /** Null at ingest — filled from the iTunes match when picked. See lib/itunes.ts. */
  albumArt: string | null;
  /**
   * From the album's release date at ingest, and overwritten by the iTunes match
   * when the track is picked (iTunes knows single releases better). Null when the
   * app has no Spotify credentials — then only the picked track ever has a year.
   */
  releaseYear: number | null;
  /**
   * Popularity 0–100. Sourced from Deezer's `rank` and mapped onto Spotify's
   * old scale (lib/deezer.ts) — Spotify itself stopped returning the field.
   * Only ever filled for pooled tracks, and null when Deezer had no match.
   * Drives par.
   */
  popularity: number | null;
  /**
   * Whether this track can be drawn as a secret. The pool is sampled once, at
   * the first round, across all playlists — see `samplePool`. Everything else
   * stays in Redis unpooled: it still shows up in the guess-modal search, so
   * the search box never doubles as the answer set.
   */
  pooled: boolean;
  /**
   * The rest of what `GET /v1/tracks` hands back for free alongside popularity —
   * no extra request, and it all feeds the loading-screen lines (lib/quips.ts).
   * `audio_features` would be the interesting one (energy, tempo, danceability)
   * but Spotify closed that endpoint to new apps in November 2024, so there is no
   * way to know how loud or fast anybody's taste is.
   *
   * Null on every track pooled before these fields existed, so read them with a
   * `typeof` guard — a live lobby's pool sits in Redis under its own TTL.
   */
  explicit: boolean | null;
  durationMs: number | null;
  albumName: string | null;
  /** `album` | `single` | `compilation`. */
  albumType: string | null;
  /**
   * Spotify's own preview, when the embed carried one. A fallback only — its
   * length is inconsistent (often well under 30s), so iTunes wins. See the
   * pick loop in the start route.
   */
  previewUrl: string | null;
  playlistId: string;
  /** Name of the player whose playlist this came from. */
  contributor: string;
};

export type Player = {
  id: string;
  name: string;
  playlistId: string;
  playlistName: string;
  trackCount: number;
  joinedAt: number;
};

export type Lobby = {
  code: string;
  hostToken: string;
  createdAt: number;
  players: Player[];
  /** 0 while nobody has started a round yet. */
  currentRound: number;
  /** Secret tracks already used, so a lobby never repeats a song. */
  usedTrackIds: string[];
  /** Tracks with no usable iTunes preview — skipped by future picks. */
  unusableTrackIds: string[];
};

export type RoundState =
  /** Demucs prediction created, waiting on the webhook. */
  | 'preparing'
  /** Stems landed; the client still has to run the silence check. */
  | 'ready'
  /** Ladder finalised, guessing is open. */
  | 'playing'
  | 'won'
  | 'lost'
  | 'failed';

export type GuessTier = 'correct' | 'artist' | 'playlist' | 'none';

export type GuessLog = {
  /** 1-based index of the row this guess burned. */
  row: number;
  kind: 'guess' | 'skip';
  title: string | null;
  artist: string | null;
  tier: GuessTier | null;
  /** Only set for the `playlist` tier: who contributed that playlist. */
  contributor: string | null;
  trackId: string | null;
};

export type LadderRow = { kind: 'stem'; stem: PlayableStem } | { kind: 'final' };

export type Round = {
  code: string;
  n: number;
  state: RoundState;
  error: string | null;
  /** Never serialised to the client. */
  secret: Track;
  /** Both null when the secret track has no popularity. See lib/par.ts. */
  par: number | null;
  difficulty: string | null;
  previewUrl: string;
  predictionId: string | null;
  /** Unguessable component of the webhook callback URL. */
  webhookKey: string;
  stems: Partial<Record<StemName, string>>;
  /** Stems the client's RMS check rejected. */
  silentStems: PlayableStem[];
  /** null until the silence check finalises it. */
  ladder: LadderRow[] | null;
  /** 1-based index of the row awaiting a guess. */
  currentRow: number;
  /**
   * Lyric hint shown on the final row: a random line from the song sharing no
   * distinctive word with the title or artist (lib/lyrics.ts). Fetched once,
   * one row before the final row unlocks. Absent = not fetched yet; null =
   * lyrics.ovh had nothing usable. Never carries the title — safe to serve.
   */
  hint?: string | null;
  guesses: GuessLog[];
  createdAt: number;
  /** Last time we polled Replicate directly (webhook fallback). */
  polledAt: number;
};

// --- client-facing shapes ---

export type PublicRow = {
  index: number;
  kind: 'stem' | 'final';
  label: string;
  /** What you hear once this row is unlocked. */
  sub: string;
  state: 'burned' | 'active' | 'locked';
  guess: GuessLog | null;
};

export type PublicRound = {
  n: number;
  state: RoundState;
  error: string | null;
  releaseYear: number | null;
  /** Clamped to the round's actual ladder length. Null hides the header. */
  par: number | null;
  difficulty: string | null;
  currentRow: number;
  totalRows: number;
  rows: PublicRow[];
  /** Stem URLs the client is allowed to have right now. Never includes vocals. */
  stems: { stem: PlayableStem; url: string }[];
  /** Of those, the ones that should currently be audible. */
  activeStems: PlayableStem[];
  guessedTrackIds: string[];
  reveal: {
    spotifyId: string;
    title: string;
    artist: string;
    albumArt: string | null;
    contributor: string;
    releaseYear: number | null;
  } | null;
};

export type PublicLobby = {
  code: string;
  isHost: boolean;
  players: { id: string; name: string; trackCount: number }[];
  trackCount: number;
  currentRound: number;
  canStart: boolean;
};

export type Candidate = {
  id: string;
  title: string;
  artist: string;
  /** Pre-normalised `title artist`, so the client can substring-match directly. */
  search: string;
};
