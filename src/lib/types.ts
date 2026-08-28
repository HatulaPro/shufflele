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

export const LOBBY_MODES = ['classic', 'rush'] as const;
export type LobbyMode = (typeof LOBBY_MODES)[number];

export function isLobbyMode(value: unknown): value is LobbyMode {
  return typeof value === 'string' && (LOBBY_MODES as readonly string[]).includes(value);
}

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
  /** `classic` is the stem-ladder party game; `rush` is the beat-the-clock one. */
  mode: LobbyMode;
  players: Player[];
  /**
   * The player the host phone added for itself, once it has. They run the game
   * from that phone, so they are the one player nobody can remove — including
   * themselves, which would otherwise be one tap from leaving the room with a
   * game it can't be thrown out of. Absent until they add a playlist, and on
   * lobbies stored before this was recorded.
   */
  hostPlayerId?: string | null;
  /**
   * 0 while nobody has started a round yet. Monotonic: it counts the songs this
   * lobby has put on air and never goes back down, including while the host is
   * sitting in the lobby between them.
   */
  currentRound: number;
  /**
   * The round the host screen is *inside*, so a refresh mid-song lands back on
   * it. Null means they're in the lobby, which `currentRound` cannot say on its
   * own — it stays set once a song has played, and reading it as "on screen"
   * is what would bounce a host straight back into a song they just left.
   *
   * The exact counterpart of `rush` below: both mean "this mode has a screen
   * open", both are cleared on the way back to the lobby, and switching mode
   * clears whichever one is set. Leaving a classic round is final for that
   * round — the next start draws a new song (usually the prefetched one).
   */
  activeRound: number | null;
  /** Secret tracks already used, so a lobby never repeats a song. */
  usedTrackIds: string[];
  /** Tracks with no usable iTunes preview — skipped by future picks. */
  unusableTrackIds: string[];
  /**
   * Tracks Rush found nothing to play at all: no YouTube match *and* no
   * preview. Kept apart from `unusableTrackIds` because the two modes ask
   * different questions — classic needs a preview, Rush prefers the YouTube
   * master and only falls back to one — so a track that is dead to classic is
   * routinely still playable here. Absent on lobbies stored before Rush
   * stopped sharing the classic list; read it as empty.
   */
  rushUnusableTrackIds?: string[];
  /**
   * Live Rush game, present only once the host starts one. Absent on lobbies
   * stored before Rush existed, and on classic lobbies always.
   */
  rush?: RushState | null;
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
  /**
   * Created ahead of time while the previous song was on air, and not yet
   * claimed by the start route. A prefetched round sits under `currentRound + 1`
   * with the lobby unaware of it; only the start route may put it on air, after
   * re-checking its secret against the settled roster. See lib/prefetch.ts.
   */
  prefetched?: boolean;
  guesses: GuessLog[];
  createdAt: number;
  /** Last time we polled Replicate directly (webhook fallback). */
  polledAt: number;
};

// --- rush ------------------------------------------------------------------
//
// The beat-the-clock mode. One phone plays; the pool is everyone's playlists,
// but nothing here needs Demucs — songs play from t=0 off their preview, so a
// Rush game is cheap in exactly the way a classic round is not.

/** Seconds on the clock. Null = infinite. */
export type RushTimeControl = 60 | 120 | null;

/**
 * What a correct guess buys you, in ms. Lives here rather than in lib/rush.ts
 * because both sides need the number — the server to move the deadline, the
 * play screen to label the bump beside the score — and lib/rush.ts pulls in
 * node:crypto and the lobby store, so a client component cannot import from it.
 */
export const RUSH_BONUS_MS = 2000;

/**
 * Songs a pool needs before Rush will deal from it — one full board. A
 * half-empty board is a giveaway, and a pool of one is a row that's correct
 * every time.
 *
 * Here rather than in lib/rush.ts for the same reason as the bonus above: the
 * lobby screen greys the Rush option out below this number, and lib/rush.ts
 * pulls in node:crypto and the lobby store, so a client component cannot
 * import from it.
 */
export const MIN_RUSH_POOL = 8;

/** A finished song, as the finish screen lists it. */
export type RushSongRef = {
  title: string;
  artist: string;
  albumArt: string | null;
  contributor: string;
};

/**
 * A clickable option on the Rush screen. Unmarked in itself — the answer rides
 * beside the board on `PublicRush.answerId` rather than on any one row, so a
 * row can be rendered without knowing whether it is the right one.
 */
export type RushOption = {
  spotifyId: string;
  title: string;
  artist: string;
  albumArt: string | null;
};

/** A song ready to go on air: the answer, where it plays from, and the board. */
export type RushDeal = {
  secret: Track;
  /** Fallback clip, null when the deal is riding on `videoId` alone. */
  previewUrl: string | null;
  /**
   * YouTube art-track id, so Rush can play the song from its first bar rather
   * than from the middle of a preview clip. Null when no convincing match came
   * back, which is the signal to fall back to `previewUrl`. See lib/ytmusic.ts.
   */
  videoId: string | null;
  options: Track[];
};

export type RushState = {
  timeControl: RushTimeControl;
  /** When the game was dealt. The clock does not run from here — see `begunAt`. */
  startedAt: number;
  /**
   * When the player actually started playing, i.e. when the first song went on
   * air. Null until then: a run sitting on the ready screen must not burn clock.
   */
  begunAt: number | null;
  /**
   * Epoch ms the clock runs out at. Null = infinite, or not begun yet. Moves
   * later on every correct guess — see `awardRushTime` in lib/rush.ts.
   */
  endsAt: number | null;
  lives: number;
  score: number;
  over: boolean;
  /** The song on air. Never serialised with its id during play. */
  secret: Track;
  /**
   * Where the song on air plays from when there is no `videoId`. Null when
   * iTunes had no match for it — playable all the same, on the YouTube master.
   */
  previewUrl: string | null;
  /** Preferred source for the song on air: the master, played from t=0. */
  videoId: string | null;
  /** Ten candidates, the secret among them. Stored whole so roster changes can't reshuffle a live screen. */
  options: Track[];
  /**
   * The song after this one, dealt in the background while this one plays, so
   * a guess never waits on an iTunes lookup with the clock running. Null when
   * the warm-up hasn't landed yet — the guess route then deals inline.
   */
  next: RushDeal | null;
  history: { song: RushSongRef; correct: boolean }[];
};

/**
 * A deal as the client may see it: the board, both playback sources, and the
 * answer. The client holds one of these for the song on air (flattened into
 * `PublicRush`) and, when the warm-up has landed, one for the song after it —
 * which is what lets a guess be judged and the next song started without
 * waiting on the round trip. See the guess route for why shipping the answer
 * costs nothing.
 */
export type PublicRushDeal = {
  answerId: string;
  previewUrl: string | null;
  videoId: string | null;
  options: RushOption[];
};

export type PublicRush = {
  timeControl: RushTimeControl;
  endsAt: number | null;
  /**
   * The server's clock at the moment this response was built. `endsAt` is
   * stamped from the server's clock, so a client that counts down against its
   * own `Date.now()` is wrong by however far its device clock is off. The
   * client subtracts this to work in server time instead. See lib/rush.ts.
   */
  now: number;
  lives: number;
  maxLives: number;
  score: number;
  over: boolean;
  /** Null once the game is over — there's nothing left to play. */
  previewUrl: string | null;
  /**
   * When set, the client plays this from t=0 in a hidden YouTube iframe and
   * ignores `previewUrl`. It does name the song to anyone reading the network
   * tab, which `previewUrl`'s opaque filename does not — an accepted trade for
   * a party game, and the reason the player stays hidden rather than embedded.
   */
  videoId: string | null;
  options: RushOption[];
  /**
   * Which of `options` is playing. Null once the run is over, when there is no
   * song on air to name.
   *
   * The client judges its own guesses off this and paints the verdict on the
   * tap rather than on the response, which is the difference between the board
   * feeling instant and feeling like a form submission. The server still judges
   * every guess for real — this is a mirror of its answer, never the authority
   * (see the guess route). And it gives nothing away that `videoId` above,
   * which names the song outright to anyone reading the network tab, had not
   * already given away.
   */
  answerId: string | null;
  /**
   * The song after this one, when the background warm-up has landed. The client
   * puts it on air the instant a guess is made, so the next song starts with
   * the verdict instead of a round trip later. Null when the warm-up hasn't
   * landed yet — the client then waits for the guess response, as it always
   * did. See `warmNextRushSong` in lib/rush.ts.
   */
  next: PublicRushDeal | null;
  /** Only when over: what the finish screen collapses out. */
  summary: { correct: RushSongRef[]; wrong: RushSongRef[] } | null;
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
  mode: LobbyMode;
  players: PublicPlayer[];
  /** Only what the round in play draws from — a joiner's tracks aren't counted yet. */
  trackCount: number;
  currentRound: number;
  /** Non-null while a classic song is on the host's screen — the resume path. */
  activeRound: number | null;
  canStart: boolean;
  /** A Rush game exists — the host screen resumes into it, finish screen included. */
  rushActive: boolean;
};

export type Candidate = {
  id: string;
  title: string;
  artist: string;
  /** Pre-normalised `title artist`, so the client can substring-match directly. */
  search: string;
};
