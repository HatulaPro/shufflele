import type { Artist, Track } from './types';

/**
 * The offline half of the app.
 *
 * Shufflele leans on five services it does not own — Spotify (through a
 * borrowed token, behind a Cloudflare check), iTunes, Replicate's GPUs,
 * YouTube and lyrics.ovh — and between the credentials, the quota gates and
 * the TLS fingerprinting, none of them can be counted on from a laptop. That
 * made the game effectively untestable locally: a round died at the first
 * ingest, and a change to the ladder or the Rush board could only be checked
 * by deploying it.
 *
 * With `SHUFFLELE_MOCK=1` every one of those is answered from here instead,
 * and nothing else in the app changes shape: the ingest returns real `Track`s,
 * the separation goes through the same prediction state machine, and the audio
 * is real audio that the browser decodes and the silence check measures. Redis
 * is deliberately *not* mocked — the DB is reachable locally, and the lobby
 * state machine it holds is most of what there is to test.
 *
 * Each provider's mock lives behind the front door of its own module
 * (`ingestPlaylist`, `findItunesMatch`, `createSeparation`, `findPlayCount`,
 * `findFullTrackVideo`, `findLyricHint`), so every route, hook and component
 * is untouched by it, and there is exactly one branch per service to find.
 *
 * Everything here is deterministic in its input: the same playlist slug always
 * yields the same playlist, and the same track always sounds the same and
 * shows the same cover. A bug reproduces on the second run.
 */

/**
 * Read on every call rather than captured at import, so a test can flip it,
 * and refused outright on a Vercel production deployment — the whole point of
 * this module is that it fabricates data, which is a thing to be very sure
 * about not shipping.
 *
 * The `NEXT_PUBLIC_` spelling is the one to set: the reveal screen has to know
 * too (a fabricated Spotify id has no embed to show), and a public variable is
 * the only kind the browser bundle can see. The private spelling is accepted
 * as well for a server-only run.
 */
export function mockEnabled(): boolean {
  if (process.env.VERCEL_ENV === 'production') return false;
  return process.env.NEXT_PUBLIC_SHUFFLELE_MOCK === '1' || process.env.SHUFFLELE_MOCK === '1';
}

/**
 * Where the mock media routes live. Same rule as `baseUrl` in lib/replicate.ts,
 * and deliberately not imported from it: that module imports this one, and a
 * four-line duplicate is a better trade than a cycle between them.
 */
function origin(): string {
  const explicit = process.env.NEXT_PUBLIC_BASE_URL;
  if (explicit) return explicit.replace(/\/$/, '');
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return 'http://localhost:3000';
}

// --- deterministic randomness ----------------------------------------------

/** FNV-1a. Any stable 32-bit hash would do; this one is four lines. */
export function seedOf(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** mulberry32 — a small, well-behaved PRNG we can re-seed at will. */
export function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(items: readonly T[], random: () => number): T {
  return items[Math.floor(random() * items.length)]!;
}

function shuffle<T>(items: readonly T[], random: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

// --- the catalogue ---------------------------------------------------------

/**
 * A fictional catalogue, wide enough to exercise the parts of the game that
 * care about the *shape* of a pool rather than its contents:
 *
 * - popularity spans 4–96, so par lands on every difficulty tier and the
 *   selection weighting in lib/select.ts has a real gradient to work on;
 * - artists own several songs each, so the `artist` guess tier fires;
 * - one album is shared by two artists' worth of songs and several titles
 *   carry decorations (`- Remastered`, `(feat. …)`, `- Live`), which is what
 *   `coreTitle` and the iTunes-style suspect-word rules are written against;
 * - three titles are in Hebrew, because a Latin-only pool hides every bug in
 *   `normalize` and in the guess search.
 *
 * Nothing here is a real recording, and nothing here needs to be: the audio is
 * synthesised (lib/mockaudio.ts) and the covers are drawn (/api/mock/art).
 */
type CatalogueEntry = {
  title: string;
  artist: string;
  album: string;
  year: number;
  popularity: number;
  durationMs: number;
};

const C = (
  title: string,
  artist: string,
  album: string,
  year: number,
  popularity: number,
  seconds: number,
): CatalogueEntry => ({ title, artist, album, year, popularity, durationMs: seconds * 1000 });

const CATALOGUE: readonly CatalogueEntry[] = [
  C('Paper Satellites', 'The Wandering Hours', 'Paper Satellites', 2019, 91, 214),
  C('Neon Weather', 'The Wandering Hours', 'Paper Satellites', 2019, 78, 197),
  C('Low Tide Radio', 'The Wandering Hours', 'Long Way Round', 2021, 64, 243),
  C('Half a Mile of Rope', 'The Wandering Hours', 'Long Way Round', 2021, 31, 268),
  C('Everything Is Fine - Remastered', 'The Wandering Hours', 'Early Rooms', 2014, 12, 189),

  C('Static Bloom', 'Marla Vane', 'Static Bloom', 2022, 96, 178),
  C('Cassette Sunrise', 'Marla Vane', 'Static Bloom', 2022, 84, 205),
  C('Telephone Wires', 'Marla Vane', 'Static Bloom', 2022, 57, 231),
  C('Ninety-Nine Degrees (feat. Rook & Ivy)', 'Marla Vane', 'Singles', 2023, 73, 186),
  C('Hollow Season', 'Marla Vane', 'Nightshift', 2017, 22, 254),

  C('Diesel Heart', 'Foxglove County', 'Diesel Heart', 2016, 68, 226),
  C('Barnwood Chapel', 'Foxglove County', 'Diesel Heart', 2016, 44, 259),
  C('The Long Drive Home', 'Foxglove County', 'Porchlight', 2020, 35, 288),
  C('Seventeen Winters', 'Foxglove County', 'Porchlight', 2020, 9, 241),

  C('Concrete Garden', 'Halvard', 'Concrete Garden', 2023, 88, 203),
  C('Blue Hour Traffic', 'Halvard', 'Concrete Garden', 2023, 61, 219),
  C('Undertow', 'Halvard', 'Concrete Garden', 2023, 40, 274),
  C('Glass Elevator', 'Halvard', 'Ways to Disappear', 2018, 17, 312),

  C('Supercollider', 'PLASTIC HOURS', 'Supercollider', 2024, 93, 168),
  C('Dial Tone', 'PLASTIC HOURS', 'Supercollider', 2024, 80, 175),
  C('Vending Machine Blues', 'PLASTIC HOURS', 'Supercollider', 2024, 52, 192),
  C('Nightbus', 'PLASTIC HOURS', 'Demos', 2022, 26, 158),
  C('Backup Dancer', 'PLASTIC HOURS', 'Demos', 2022, 6, 143),

  C('Salt and Cedar', 'Iona Brill', 'Salt and Cedar', 2015, 71, 236),
  C('Winter Kitchen', 'Iona Brill', 'Salt and Cedar', 2015, 49, 264),
  C('A Small Fire', 'Iona Brill', 'The Quiet Part', 2019, 28, 298),
  C('Letters I Never Sent', 'Iona Brill', 'The Quiet Part', 2019, 14, 321),

  C('Bandwidth', 'Null Object', 'Bandwidth', 2021, 66, 221),
  C('Cold Boot', 'Null Object', 'Bandwidth', 2021, 38, 248),
  C('Packet Loss', 'Null Object', 'Kernel Panic', 2023, 20, 199),
  C('Garbage Collection', 'Null Object', 'Kernel Panic', 2023, 4, 302),

  C('Mango Weather', 'Sundial Club', 'Mango Weather', 2020, 86, 187),
  C('Two Left Feet', 'Sundial Club', 'Mango Weather', 2020, 59, 204),
  C('Rooftop Season', 'Sundial Club', 'Late Checkout', 2022, 33, 216),
  C('Espresso Martini Sunday', 'Sundial Club', 'Late Checkout', 2022, 11, 229),

  C('ערב אחרון', 'נועה שקד', 'ערב אחרון', 2021, 63, 213),
  C('שמש של יולי', 'נועה שקד', 'ערב אחרון', 2021, 41, 194),
  C('כביש חוף', 'נועה שקד', 'סינגלים', 2023, 19, 227),

  C('Ferris Wheel', 'The Understudies', 'Ferris Wheel', 2018, 75, 209),
  C('Understudy', 'The Understudies', 'Ferris Wheel', 2018, 46, 233),
  C('Curtain Call - Live', 'The Understudies', 'Ferris Wheel', 2018, 24, 281),
  C('Matinee', 'The Understudies', 'Second Billing', 2013, 8, 197),
] as const;

const PLAYLIST_NAMES = [
  'songs for the drive',
  'kitchen radio',
  'stuff i keep coming back to',
  'late shift',
  'the good ones',
  'summer, allegedly',
  'headphones only',
  'volume up',
] as const;

/**
 * A Spotify id is 22 base62 characters, and several things downstream want a
 * stable opaque id rather than a readable one — it is a Redis key fragment, a
 * dedupe key, and the value the guess routes compare. Derived from the
 * catalogue index, so the same song carries the same id in every playlist it
 * appears in. That is exactly the real behaviour the "same song, two players"
 * tier and the candidate dedupe are written against.
 */
function trackId(index: number): string {
  return `mock${String(index).padStart(4, '0')}${'x'.repeat(14)}`;
}

function catalogueIndex(spotifyId: string): number | null {
  const match = /^mock(\d{4})x{14}$/.exec(spotifyId);
  if (!match) return null;
  const index = Number.parseInt(match[1]!, 10);
  return index >= 0 && index < CATALOGUE.length ? index : null;
}

export function mockArtUrl(spotifyId: string): string {
  return `${origin()}/api/mock/art?t=${encodeURIComponent(spotifyId)}`;
}

/** `stem` is a stem name, or `mix` for the full thing a preview stands in for. */
export function mockAudioUrl(spotifyId: string, stem = 'mix'): string {
  return `${origin()}/api/mock/audio?t=${encodeURIComponent(spotifyId)}&s=${encodeURIComponent(stem)}`;
}

function toTrack(index: number, playlistId: string, contributor: string): Track {
  const entry = CATALOGUE[index]!;
  const spotifyId = trackId(index);
  const artists: Artist[] = entry.artist
    .split(' & ')
    .map((name) => ({ id: `mockartist${seedOf(name).toString(36)}`, name }));

  return {
    spotifyId,
    title: entry.title,
    artists,
    albumArt: mockArtUrl(spotifyId),
    releaseYear: entry.year,
    popularity: entry.popularity,
    explicit: index % 7 === 0,
    durationMs: entry.durationMs,
    albumName: entry.album,
    albumType: entry.album === 'Singles' ? 'single' : 'album',
    // Left null on purpose: the mocked iTunes match is the single source of
    // preview audio here, exactly as it is the preferred one in production.
    previewUrl: null,
    playlistId,
    contributor,
  };
}

// --- the mocked providers --------------------------------------------------

/**
 * Anything at all identifies a playlist here, so a tester can type "rock" —
 * but a real Spotify link still parses to its real id first (lib/spotify.ts),
 * so a link pasted off a phone works too and simply yields a fabricated
 * playlist under that id.
 */
export function mockPlaylistId(input: string): string | null {
  const slug = input
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}-]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return slug ? `mock-${slug}` : null;
}

/**
 * A fabricated playlist: 12–26 of the catalogue, drawn deterministically from
 * the id. Two different ids overlap in songs the way two people's playlists
 * do, which is what the "same song from two playlists" paths need to see.
 */
export function mockIngest(
  playlistId: string,
  contributor: string,
): { playlistId: string; playlistName: string; tracks: Track[] } {
  const random = rng(seedOf(playlistId));
  const size = 12 + Math.floor(random() * 15);
  const indices = shuffle(
    CATALOGUE.map((_, i) => i),
    random,
  ).slice(0, Math.min(size, CATALOGUE.length));

  return {
    playlistId,
    playlistName: pick(PLAYLIST_NAMES, random),
    tracks: indices.map((index) => toTrack(index, playlistId, contributor)),
  };
}

/** The iTunes stand-in: always a match, always a full-length mock preview. */
export function mockItunesMatch(track: Track): {
  previewUrl: string;
  albumArt: string | null;
  releaseYear: number | null;
} {
  return {
    previewUrl: mockAudioUrl(track.spotifyId),
    albumArt: mockArtUrl(track.spotifyId),
    releaseYear: track.releaseYear,
  };
}

/**
 * A plausible play count: log-uniform between ~50k and ~900M, anchored on
 * popularity so the number on screen agrees with the difficulty beside it.
 */
export function mockPlayCount(track: Track): number {
  const random = rng(seedOf(`plays:${track.spotifyId}`));
  const popularity = typeof track.popularity === 'number' ? track.popularity : 50;
  const exponent = 4.7 + (popularity / 100) * 4.2 + (random() - 0.5) * 0.6;
  return Math.round(10 ** exponent);
}

/**
 * Stand-in lyrics. Written to be usable as a final-row hint for *any* song —
 * evocative, generic, and sharing no distinctive word with any title in the
 * catalogue, since `findLyricHint`'s give-away filter still runs over these
 * and a line it rejects costs the round its hint.
 */
const MOCK_LYRICS = [
  'I counted every streetlight on the way back down',
  'you said it like a question but you meant it like a promise',
  'nobody told the morning that we were still awake',
  'there is a version of me that took the earlier train',
  'we were louder than the room and half as brave',
  'I keep your handwriting in a drawer I never open',
  'the forecast was wrong about tomorrow again',
  'and I am learning how to leave a light on',
  'they built a bridge and called it a decision',
  'you can hear the whole thing if you hold it wrong',
  'I am not the storm, I am the walk home after',
  'we spent the whole year saying almost',
] as const;

export function mockLyrics(track: Track): string {
  return shuffle(MOCK_LYRICS, rng(seedOf(`lyrics:${track.spotifyId}`))).join('\n');
}

// --- the mocked separation -------------------------------------------------

/**
 * How long a fake Demucs job "runs". Long enough that the preparing screen and
 * its loading quips actually render and can be looked at, short enough that
 * nobody testing a ladder change waits on it. The round route polls at most
 * once every 3s, so the wait in practice is one poll.
 */
const MOCK_SEPARATION_MS = 2_000;

const PREDICTION_PREFIX = 'mock-prediction:';

/**
 * The fake prediction carries its own state: when it started, and what it was
 * given. Nothing is written to Redis for it, so a restarted dev server
 * resolves a prediction it never created — which is also what makes the poll
 * fallback in the round route work unchanged.
 */
export function mockPredictionId(audioUrl: string): string {
  return `${PREDICTION_PREFIX}${Date.now()}:${Buffer.from(audioUrl).toString('base64url')}`;
}

export function isMockPredictionId(id: string): boolean {
  return id.startsWith(PREDICTION_PREFIX);
}

/**
 * Resolves a fake prediction. `processing` until the fake job's time is up,
 * then the four stems — in the object-keyed-by-stem-name shape the real
 * wrappers use, so `parseStems`, the byte-size guard and `applyPrediction` are
 * all exercised rather than bypassed.
 */
export function mockPrediction(id: string): {
  status: 'processing' | 'succeeded';
  output?: Record<string, string>;
} {
  const [startedAt, encoded] = id.slice(PREDICTION_PREFIX.length).split(':');
  const started = Number.parseInt(startedAt ?? '', 10);
  if (Number.isFinite(started) && Date.now() - started < MOCK_SEPARATION_MS) {
    return { status: 'processing' };
  }

  let audioUrl = '';
  try {
    audioUrl = Buffer.from(encoded ?? '', 'base64url').toString();
  } catch {
    // Falls through to the unrecognised case below.
  }

  const spotifyId = trackIdFromAudioUrl(audioUrl);
  if (!spotifyId) {
    // Nothing to split — a lobby carrying tracks from before mock mode, say.
    // Handing the mix back under every stem still produces a playable,
    // non-silent round rather than a failed one.
    return {
      status: 'succeeded',
      output: { drums: audioUrl, bass: audioUrl, other: audioUrl, vocals: audioUrl },
    };
  }

  return {
    status: 'succeeded',
    output: {
      drums: mockAudioUrl(spotifyId, 'drums'),
      bass: mockAudioUrl(spotifyId, 'bass'),
      other: mockAudioUrl(spotifyId, 'other'),
      vocals: mockAudioUrl(spotifyId, 'vocals'),
    },
  };
}

function trackIdFromAudioUrl(audioUrl: string): string | null {
  try {
    const url = new URL(audioUrl);
    if (!url.pathname.startsWith('/api/mock/audio')) return null;
    const id = url.searchParams.get('t');
    return id && catalogueIndex(id) !== null ? id : null;
  } catch {
    return null;
  }
}

// --- what the mock media routes need to know about a track -----------------

export type MockTrackInfo = CatalogueEntry & { spotifyId: string };

export function mockTrackInfo(spotifyId: string): MockTrackInfo | null {
  const index = catalogueIndex(spotifyId);
  return index === null ? null : { ...CATALOGUE[index]!, spotifyId };
}

/**
 * A stable colour pair for a cover. The hue is drawn from the id, so two songs
 * on the same screen are reliably told apart at a glance — which is most of
 * what album art is doing in a mock.
 */
export function mockCoverPalette(spotifyId: string): { from: string; to: string; ink: string } {
  const random = rng(seedOf(`art:${spotifyId}`));
  const hue = Math.floor(random() * 360);
  const spread = 25 + Math.floor(random() * 60);
  const dark = random() < 0.5;
  return {
    from: `hsl(${hue} 72% ${dark ? 30 : 64}%)`,
    to: `hsl(${(hue + spread) % 360} 68% ${dark ? 12 : 42}%)`,
    ink: dark ? 'rgba(255,255,255,0.92)' : 'rgba(14,10,22,0.88)',
  };
}
