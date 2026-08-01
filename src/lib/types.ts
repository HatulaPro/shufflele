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
  /** Album cover, ~300px. See `pickArtwork`. */
  albumArt: string | null;
  /** From the album's release date. */
  releaseYear: number | null;
  /**
   * Spotify's own popularity, 0–100. Drives par (lib/par.ts) and the selection
   * weighting (lib/select.ts). Null only for a track whose payload omitted it.
   */
  popularity: number | null;
  /**
   * The rest of what the playlist payload hands back for free — no extra
   * request, and it all feeds the loading-screen lines (lib/quips.ts).
   *
   * Null on every track ingested before these fields existed, so read them with
   * a `typeof` guard — a live lobby's pool sits in Redis under its own TTL.
   */
  explicit: boolean | null;
  durationMs: number | null;
  albumName: string | null;
  /** `album` | `single` | `compilation`. */
  albumType: string | null;
  /**
   * Spotify's own preview, where the catalogue has one. A fallback only — its
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
  /**
   * First round this playlist is eligible for. 1 for anyone in before the game
   * started, otherwise the round after whichever one was in play when they
   * joined — a roster change never disturbs the song already on air.
   *
   * The three fields below are absent on players stored before mid-game roster
   * changes existed, so read them through `playsIn`: those players have been in
   * since round 1, are not leaving, and are owed nothing.
   */
  activeFrom?: number;
  /** Last round they stay in, set when the host removes them. */
  removedAfter?: number | null;
  /**
   * Rounds credited at join time, so the fairness draw doesn't treat a late
   * joiner as owed every round the room already played. See `joinCredit`.
   */
  creditedRounds?: number;
};

export type Lobby = {
  code: string;
  hostToken: string;
  createdAt: number;
  players: Player[];
  /**
   * The player the host phone added for itself, once it has. They run the game
   * from that phone, so they are the one player nobody can remove — including
   * themselves, which would otherwise be one tap from leaving the room with a
   * game it can't be thrown out of. Absent until they add a playlist, and on
   * lobbies stored before this was recorded.
   */
  hostPlayerId?: string | null;
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
  /**
   * YouTube views on the secret track, resolved once at pick time. Null when
   * there's no API key, no match, or the lookup failed. See lib/youtube.ts.
   */
  playCount?: number | null;
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
   * one row before the final row unlocks. Absent = not fetched yet. When
   * lyrics.ovh has nothing usable this holds a joke line instead, so the row is
   * never blank; null only appears on rounds stored before that was true.
   * Never carries the title — safe to serve.
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
  /** YouTube views on the secret track. Null hides the chip. See lib/youtube.ts. */
  playCount: number | null;
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

export type PublicPlayer = {
  id: string;
  name: string;
  trackCount: number;
  /** The host's own playlist. Can't be removed by anyone. */
  isHost: boolean;
  /**
   * `joining` — added while a song was on air, in from the next one.
   * `leaving` — the host removed them, out from the next one.
   */
  status: 'in' | 'joining' | 'leaving';
};

export type PublicLobby = {
  code: string;
  isHost: boolean;
  players: PublicPlayer[];
  /** Only what the round in play draws from — a joiner's tracks aren't counted yet. */
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
