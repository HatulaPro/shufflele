import type { Player, Track } from './types';

/**
 * Loading-screen filler. The wait is 20–120s of nothing, so instead of narrating
 * the pipeline at people (nobody cares which stem is being separated) the screen
 * rotates through short jokes about the playlists that were actually pooled.
 * SPEC §1.2.
 *
 * Three rules hold everything here together:
 *
 * - **Short.** It renders on a phone, one line at a time. Aim under ~50
 *   characters, name a player, land the insult, stop. Nothing explains the game:
 *   the room already knows how it works.
 * - **Cheap.** One pass over the pool, plain string work, no extra network calls.
 *   It runs once per round on data already in Redis — every field it reads was
 *   filled in at ingest, for the whole tracklist, not just the sampled pool.
 * - **Non-identifying.** The host screen is visible to the whole room, so a line
 *   may never point at the secret track. Counts are shares of the pool, song
 *   titles are counted and never quoted, and a *single* release year is never
 *   attributed to a player — the guess screen shows the secret's year, and the
 *   two together would hand out the `playlist` tier for free. A wide era *range*
 *   is fine; it says almost nothing. SPEC §1.5.
 *
 * That third rule is what shapes the popularity lines, which are new: the guess
 * screen shows a difficulty label derived straight from the secret's popularity
 * (lib/par.ts), so "everything Maya brought is obscure" plus a `Very hard`
 * header is the year leak again in another costume. Pool-wide shares name
 * nobody and are safe. The one per-player popularity line is a *spread*, for
 * the same reason the era line is: a range from 4 to 88 constrains nothing.
 *
 * What still isn't here: energy, tempo and loudness. `GET /v1/audio-features`
 * would answer "how jumpy is Maya's taste" directly and the token this app now
 * runs on can reach it, but that is a second request per round for a joke, and
 * the endpoint is deprecated besides.
 */

const TARGET = 10;

/** House jokes. Also the safety net when the pool is too thin to mock. */
const FILLER = [
  "It's not Despacito by Maroon 5",
  'No penguins in this prod',
  "It's okay to give up if it's from Ron's playlist",
  "Everyone blames whoever's playlist it came from.",
  'Someone here is about to get cocky.',
  'This is the easy one, apparently.',
];

/** Aimed at a random player, no data required. Guarantees the screen has teeth. */
const TAUNTS = [
  (name: string) => `${name} is about to guess this wrong. Loudly.`,
  (name: string) => `Whatever ${name} says, it isn't that.`,
  (name: string) => `${name}, sit this one out.`,
  (name: string) => `${name} has never once recognised the drums.`,
  (name: string) => `Nobody is asking ${name}.`,
  (name: string) => `${name} is already Googling.`,
  (name: string) => `${name} will say Imagine Dragons. `,
  (name: string) => `Please take ${possessive(name)} phone away.`,
];

type Facts = ReturnType<typeof gather>;
type Quip = (f: Facts) => string | null;

export function buildQuips(players: Player[], tracks: Track[]): string[] {
  const facts = gather(players, tracks);
  const lines: string[] = [];

  for (const quip of QUIPS) {
    const line = quip(facts);
    if (line) lines.push(line);
  }

  // One taunt per player, up to four, each on a different template.
  const names = shuffle(players.map((p) => p.name)).slice(0, 4);
  const templates = shuffle([...TAUNTS]);
  names.forEach((name, i) => lines.push(templates[i % templates.length]!(name)));

  shuffle(lines);
  // Fillers go last, so a well-stocked lobby rarely reaches them.
  for (const line of shuffle([...FILLER])) {
    if (lines.length >= TARGET) break;
    lines.push(line);
  }

  return lines.slice(0, TARGET);
}

// --- the lines -----------------------------------------------------------

const QUIPS: Quip[] = [
  // --- who brought what ---

  ({ players }) => {
    if (players.length < 2) return null;
    const [small] = players; // smallest first
    return small ? `${small.trackCount} songs, ${small.name}? Weak.` : null;
  },

  ({ players }) => {
    if (players.length < 2) return null;
    const big = players[players.length - 1];
    return big ? `${big.name} brought ${big.trackCount} songs. Nobody asked.` : null;
  },

  ({ hog }) =>
    hog && hog.share >= 45 ? `${hog.share}% of this pool is ${possessive(hog.name)}. Tyrant.` : null,

  ({ players }) =>
    players.length === 1 && players[0] ? `One playlist. This is all on ${players[0].name}.` : null,

  ({ players }) => {
    if (players.length < 3) return null;
    const last = [...players].sort((a, b) => b.joinedAt - a.joinedAt)[0];
    const big = players[players.length - 1];
    return last && big && last.id === big.id
      ? `${last.name} joined last, brought most. Needy.`
      : null;
  },

  ({ twins }) =>
    twins ? `${twins.who[0]} and ${twins.who[1]} brought ${twins.count} each. Copycats.` : null,

  ({ dupes }) => (dupes > 0 ? `${dupes} songs got brought twice. Original.` : null),

  // --- taste ---

  ({ topArtist }) =>
    topArtist && topArtist.share >= 3
      ? `${topArtist.share}% of this pool is ${topArtist.name}. Grim.`
      : null,

  ({ obsessed }) =>
    obsessed
      ? `${obsessed.share}% of ${possessive(obsessed.player)} list is ${obsessed.artist}. Seek help.`
      : null,

  ({ sharedArtist }) =>
    sharedArtist
      ? `${sharedArtist.who[0]} and ${sharedArtist.who[1]} both brought ${sharedArtist.name}. Twins.`
      : null,

  ({ narrow }) =>
    narrow ? `${narrow.artists} artists across ${narrow.songs} songs, ${narrow.name}? Bleak.` : null,

  ({ albumDump }) =>
    albumDump
      ? `${albumDump.name} brought ${albumDump.count} songs off one album. Lazy.`
      : null,

  ({ singles }) =>
    singles
      ? `${singles.share}% of ${possessive(singles.name)} list is singles. No commitment.`
      : null,

  // --- language ---

  ({ explicitPlayer }) =>
    explicitPlayer
      ? `${explicitPlayer.share}% of ${possessive(explicitPlayer.name)} list is explicit. Charming.`
      : null,

  ({ cleanPlayer }) => (cleanPlayer ? `Not one swear word from ${cleanPlayer}. Sheltered.` : null),

  ({ explicitShare }) =>
    explicitShare !== null && explicitShare >= 30
      ? `${explicitShare}% of this pool has a parental advisory.`
      : null,

  // --- length ---

  ({ epic }) => (epic ? `${epic.name} pooled a ${epic.length} song. Absolutely not.` : null),

  ({ tiny }) => (tiny ? `${tiny.name} pooled a ${tiny.length} song. That's a snippet.` : null),

  ({ impatient }) =>
    impatient
      ? `${possessive(impatient.name)} songs average ${impatient.length}. Attention span.`
      : null,

  // --- eras ---

  ({ eraSpread }) =>
    eraSpread ? `${possessive(eraSpread.name)} taste spans ${eraSpread.range}. Chaos.` : null,

  ({ decade }) =>
    decade && decade.share >= 30 ? `${decade.share}% of this pool is ${decade.label}. Predictable.` : null,

  ({ bigYear }) =>
    bigYear && bigYear.share >= 12
      ? `${bigYear.share}% of this pool is ${bigYear.year} alone.`
      : null,

  ({ oldest }) => (oldest !== null ? `Something in here is from ${oldest}. Museum piece.` : null),

  ({ newest }) => (newest !== null ? `Freshest song here: ${newest}. Still damp.` : null),

  // --- popularity (pool-wide only; see the header) ---

  ({ obscureShare }) =>
    obscureShare !== null && obscureShare >= 25
      ? `${obscureShare}% of this pool nobody has heard of.`
      : null,

  ({ hitShare }) =>
    hitShare !== null && hitShare >= 30 ? `${hitShare}% of this pool is chart filler.` : null,

  ({ meanPopularity }) =>
    meanPopularity !== null && meanPopularity >= 65
      ? `This pool averages ${meanPopularity}/100. Radio.`
      : null,

  ({ meanPopularity }) =>
    meanPopularity !== null && meanPopularity <= 30
      ? `This pool averages ${meanPopularity}/100. Nobody wins.`
      : null,

  ({ ceiling }) =>
    ceiling !== null ? `Nothing in here cracks ${ceiling}/100. Deeply niche.` : null,

  ({ popSpread }) =>
    popSpread ? `${possessive(popSpread.name)} list runs ${popSpread.range}. No middle.` : null,

  // --- titles ---

  ({ titles }) => (titles.love >= 5 ? `${titles.love} songs about love. Cringe.` : null),

  ({ titles }) => (titles.remix >= 20 ? `${titles.remix} remixes in here. Why.` : null),

  ({ titles }) => (titles.xmas > 0 ? 'Somebody pooled a Christmas song. Bold.' : null),
];

// --- one pass over the pool ---------------------------------------------

/** Everything accumulated for one player's playlist. */
type Bucket = {
  songs: number;
  artists: Map<string, number>;
  albums: Map<string, number>;
  durations: number[];
  years: number[];
  popularity: number[];
  explicit: number;
  explicitKnown: number;
  singles: number;
  typeKnown: number;
};

function gather(players: Player[], tracks: Track[]) {
  const byTrackCount = [...players].sort((a, b) => a.trackCount - b.trackCount);

  // Entry counts (a song in two playlists counts twice) drive the duplicate and
  // per-player numbers; the unique set drives everything about the music itself.
  const idPlaylists = new Map<string, Set<string>>();
  const idContributors = new Map<string, Set<string>>();
  const unique = new Map<string, Track>();

  for (const track of tracks) {
    const seen = idPlaylists.get(track.spotifyId);
    if (seen) seen.add(track.playlistId);
    else idPlaylists.set(track.spotifyId, new Set([track.playlistId]));

    const names = idContributors.get(track.spotifyId);
    if (names) names.add(track.contributor);
    else idContributors.set(track.spotifyId, new Set([track.contributor]));

    if (!unique.has(track.spotifyId)) unique.set(track.spotifyId, track);
  }

  const artists = new Map<string, { name: string; count: number; who: Set<string> }>();
  const years = new Map<number, number>();
  const decades = new Map<number, number>();
  const titles = { love: 0, remix: 0, xmas: 0 };

  let oldest: number | null = null;
  let newest: number | null = null;
  let explicit = 0;
  let explicitKnown = 0;
  // Over the unique set, so a song two people brought isn't counted twice into
  // "how mainstream is this room".
  const popularity: number[] = [];

  for (const track of unique.values()) {
    const primary = track.artists[0];
    if (primary) {
      const key = primary.name.toLowerCase();
      const entry = artists.get(key) ?? { name: primary.name, count: 0, who: new Set<string>() };
      entry.count++;
      for (const who of idContributors.get(track.spotifyId) ?? []) entry.who.add(who);
      artists.set(key, entry);
    }

    if (typeof track.releaseYear === 'number') {
      const year = track.releaseYear;
      years.set(year, (years.get(year) ?? 0) + 1);
      const decade = Math.floor(year / 10) * 10;
      decades.set(decade, (decades.get(decade) ?? 0) + 1);
      oldest = oldest === null ? year : Math.min(oldest, year);
      newest = newest === null ? year : Math.max(newest, year);
    }

    if (typeof track.explicit === 'boolean') {
      explicitKnown++;
      if (track.explicit) explicit++;
    }

    if (typeof track.popularity === 'number') popularity.push(track.popularity);

    const lower = track.title.toLowerCase();
    if (lower.includes('love')) titles.love++;
    if (/remix|edit\b|rework/.test(lower)) titles.remix++;
    if (/christmas|xmas|santa|jingle|sleigh/.test(lower)) titles.xmas++;
  }

  const buckets = new Map<string, Bucket>();

  for (const track of tracks) {
    let bucket = buckets.get(track.contributor);
    if (!bucket) {
      bucket = {
        songs: 0,
        artists: new Map(),
        albums: new Map(),
        durations: [],
        years: [],
        popularity: [],
        explicit: 0,
        explicitKnown: 0,
        singles: 0,
        typeKnown: 0,
      };
      buckets.set(track.contributor, bucket);
    }

    bucket.songs++;
    const primary = track.artists[0];
    if (primary) bucket.artists.set(primary.name, (bucket.artists.get(primary.name) ?? 0) + 1);
    if (track.albumName) bucket.albums.set(track.albumName, (bucket.albums.get(track.albumName) ?? 0) + 1);
    if (typeof track.durationMs === 'number') bucket.durations.push(track.durationMs);
    if (typeof track.releaseYear === 'number') bucket.years.push(track.releaseYear);
    if (typeof track.popularity === 'number') bucket.popularity.push(track.popularity);
    if (typeof track.explicit === 'boolean') {
      bucket.explicitKnown++;
      if (track.explicit) bucket.explicit++;
    }
    if (track.albumType) {
      bucket.typeKnown++;
      if (track.albumType === 'single') bucket.singles++;
    }
  }

  const ranked = [...artists.values()].sort((a, b) => b.count - a.count);
  const top = ranked[0];
  const shared = ranked.find((a) => a.who.size >= 2 && a.count >= 2);
  // Counted from the pool itself, not from `trackCount` — the two agree in
  // production, and this way the share can never read 1500%.
  const [hog] = [...buckets.entries()].sort((a, b) => b[1].songs - a[1].songs);

  return {
    players: byTrackCount,
    dupes: [...idPlaylists.values()].filter((set) => set.size >= 2).length,
    // Raw counts lie in a lobby of 400 songs, so every "how much" is a share.
    topArtist:
      top && unique.size > 0
        ? { name: top.name, share: Math.round((top.count / unique.size) * 100) }
        : null,
    sharedArtist: shared ? { name: shared.name, who: [...shared.who].slice(0, 2) } : null,
    hog:
      players.length >= 2 && hog && tracks.length > 0
        ? { name: hog[0], share: Math.round((hog[1].songs / tracks.length) * 100) }
        : null,
    twins: twins(byTrackCount),
    explicitShare: explicitKnown >= 10 ? Math.round((explicit / explicitKnown) * 100) : null,
    oldest,
    newest,
    ...popularityFacts(popularity),
    decade: topShare(decades, unique.size),
    bigYear: bigYear(years, unique.size),
    titles,
    ...playerFacts(buckets),
    ...extremeTracks(unique),
  };
}

/**
 * How mainstream the room is, in aggregate and named to nobody. The floor of 20
 * scored tracks is there so a three-song lobby can't announce that 100% of it
 * is obscure.
 *
 * `ceiling` is the one line that quotes a bound rather than a share, and it is
 * safe in the direction that matters: it is an upper bound on *every* track in
 * the pool, so it tells the room nothing about which one is the secret beyond
 * what the difficulty header already said out loud.
 */
function popularityFacts(scores: number[]) {
  if (scores.length < 20) {
    return { obscureShare: null, hitShare: null, meanPopularity: null, ceiling: null };
  }

  const share = (n: number) => Math.round((n / scores.length) * 100);
  const max = Math.max(...scores);

  return {
    obscureShare: share(scores.filter((p) => p < 25).length),
    hitShare: share(scores.filter((p) => p >= 70).length),
    meanPopularity: Math.round(mean(scores)),
    // Rounded up to the next ten so the number reads as a bound, not as a
    // specific track's score.
    ceiling: max < 50 ? Math.ceil((max + 1) / 10) * 10 : null,
  };
}

/**
 * The per-player digs. Each one picks the *most* extreme playlist rather than the
 * first that qualifies, so the same lobby always mocks the same person for the
 * same thing — being singled out is the joke.
 */
function playerFacts(buckets: Map<string, Bucket>) {
  const rows = [...buckets.entries()].map(([name, b]) => ({ name, b }));

  const obsessed = best(rows, ({ b }) => {
    if (b.songs < 8) return null;
    const [top] = [...b.artists.entries()].sort((a, c) => c[1] - a[1]);
    if (!top) return null;
    const share = Math.round((top[1] / b.songs) * 100);
    return share >= 20 ? { score: share, artist: top[0], share } : null;
  });

  const narrow = best(rows, ({ b }) =>
    b.songs >= 15 && b.artists.size / b.songs <= 0.5
      ? { score: b.songs / b.artists.size, artists: b.artists.size, songs: b.songs }
      : null,
  );

  const albumDump = best(rows, ({ b }) => {
    const [top] = [...b.albums.entries()].sort((a, c) => c[1] - a[1]);
    return top && top[1] >= 4 ? { score: top[1], count: top[1] } : null;
  });

  const singles = best(rows, ({ b }) => {
    if (b.typeKnown < 10) return null;
    const share = Math.round((b.singles / b.typeKnown) * 100);
    return share >= 55 ? { score: share, share } : null;
  });

  const impatient = best(rows, ({ b }) => {
    if (b.durations.length < 8) return null;
    const avg = mean(b.durations);
    return avg <= 180_000 ? { score: -avg, length: clock(avg) } : null;
  });

  // A range only — a single year plus a player is a spoiler (see the header note).
  const eraSpread = best(rows, ({ b }) => {
    if (b.years.length < 10) return null;
    const lo = Math.min(...b.years);
    const hi = Math.max(...b.years);
    return hi - lo >= 30 ? { score: hi - lo, range: `${lo}–${hi}` } : null;
  });

  // A range, never a level. `${lo}–${hi}` spanning most of the scale says the
  // playlist contains both a smash and a nobody, which rules out nothing — the
  // same reasoning that makes `eraSpread` safe. See the header.
  const popSpread = best(rows, ({ b }) => {
    if (b.popularity.length < 10) return null;
    const lo = Math.min(...b.popularity);
    const hi = Math.max(...b.popularity);
    return hi - lo >= 60 ? { score: hi - lo, range: `${lo}–${hi}` } : null;
  });

  const explicitPlayer = best(rows, ({ b }) => {
    if (b.explicitKnown < 8) return null;
    const share = Math.round((b.explicit / b.explicitKnown) * 100);
    return share >= 25 ? { score: share, share } : null;
  });

  const cleanPlayer = best(rows, ({ b }) =>
    b.explicitKnown >= 10 && b.explicit === 0 ? { score: b.explicitKnown } : null,
  );

  return {
    obsessed: obsessed ? { player: obsessed.name, artist: obsessed.artist, share: obsessed.share } : null,
    narrow,
    albumDump,
    singles,
    impatient,
    eraSpread,
    popSpread,
    explicitPlayer,
    cleanPlayer: cleanPlayer?.name ?? null,
  };
}

/** The one absurdly long and the one absurdly short song in the pool. */
function extremeTracks(unique: Map<string, Track>) {
  let epic: { name: string; length: string } | null = null;
  let tiny: { name: string; length: string } | null = null;
  let longest = 0;
  let shortest = Infinity;

  for (const track of unique.values()) {
    const ms = track.durationMs;
    if (typeof ms !== 'number') continue;
    if (ms >= 420_000 && ms > longest) {
      longest = ms;
      epic = { name: track.contributor, length: clock(ms) };
    }
    if (ms <= 105_000 && ms < shortest) {
      shortest = ms;
      tiny = { name: track.contributor, length: clock(ms) };
    }
  }

  return { epic, tiny };
}

// --- helpers -------------------------------------------------------------

/** Highest-scoring row, or null when none qualify. */
function best<T, S extends { score: number }>(rows: T[], score: (row: T) => S | null) {
  let winner: (T & S) | null = null;
  for (const row of rows) {
    const result = score(row);
    if (result && (!winner || result.score > winner.score)) winner = { ...row, ...result };
  }
  return winner;
}

/** Two playlists that came in at exactly the same size. */
function twins(players: Player[]) {
  for (let i = 1; i < players.length; i++) {
    const a = players[i - 1]!;
    const b = players[i]!;
    if (a.trackCount === b.trackCount && a.trackCount > 0) {
      return { who: [a.name, b.name], count: a.trackCount };
    }
  }
  return null;
}

function topShare(counts: Map<number, number>, total: number) {
  if (total === 0) return null;
  const [top] = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  if (!top) return null;
  return { label: `${top[0]}s`, share: Math.round((top[1] / total) * 100) };
}

function bigYear(years: Map<number, number>, total: number) {
  if (total === 0) return null;
  const [top] = [...years.entries()].sort((a, b) => b[1] - a[1]);
  if (!top) return null;
  return { year: top[0], share: Math.round((top[1] / total) * 100) };
}

function mean(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function clock(ms: number): string {
  const total = Math.round(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function possessive(name: string): string {
  return /s$/i.test(name) ? `${name}'` : `${name}'s`;
}

function shuffle<T>(items: T[]): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [items[i], items[j]] = [items[j]!, items[i]!];
  }
  return items;
}
