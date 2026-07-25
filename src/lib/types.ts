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
  albumArt: string | null;
  playlistId: string;
  /** Name of the player whose playlist this came from. */
  contributor: string;
  releaseYear: number | null;
  popularity: number;
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

export type LadderRow =
  | { kind: 'stem'; stem: PlayableStem }
  | { kind: 'clue' }
  | { kind: 'final' };

export type Round = {
  code: string;
  n: number;
  state: RoundState;
  error: string | null;
  /** Never serialised to the client. */
  secret: Track;
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
  guesses: GuessLog[];
  par: number;
  difficulty: string;
  createdAt: number;
  /** Last time we polled Replicate directly (webhook fallback). */
  polledAt: number;
};

// --- client-facing shapes ---

export type PublicRow = {
  index: number;
  kind: 'stem' | 'clue' | 'final';
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
  difficulty: string;
  par: number;
  currentRow: number;
  totalRows: number;
  rows: PublicRow[];
  /** Stem URLs the client is allowed to have right now. Never includes vocals. */
  stems: { stem: PlayableStem; url: string }[];
  /** Of those, the ones that should currently be audible. */
  activeStems: PlayableStem[];
  clue: string | null;
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
  players: { id: string; name: string; playlistName: string; trackCount: number }[];
  trackCount: number;
  currentRound: number;
  canStart: boolean;
};

export type Candidate = {
  id: string;
  title: string;
  artist: string;
  albumArt: string | null;
  /** Pre-normalised `title artist`, so the client can substring-match directly. */
  search: string;
};
