import type { Player, Track } from './types';

/**
 * Loading-screen filler. The wait is 20–120s of nothing, so instead of narrating
 * the pipeline at people (nobody cares which stem is being separated) the screen
 * rotates through short jokes about the playlists in the room. SPEC §1.2.
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
 * That third rule is what shapes the popularity lines: the guess screen shows a
 * difficulty label derived straight from the secret's popularity (lib/par.ts),
 * so "everything Maya brought is obscure" plus a `Very hard` header is the year
 * leak again in another costume. Pool-wide shares name nobody and are safe. The
 * one per-player popularity line is a *spread*, for the same reason the era line
 * is: a range from 4 to 88 constrains nothing.
 *
 * Popularity lines still get to name someone, via `blame`: a player drawn at
 * random and pinned with a pool-wide fact that has nothing to do with them. It
 * reads as an accusation and carries no information, which is the point — the
 * name is noise, so it can't leak what the share doesn't already say. Every one
 * of them is phrased as an obvious scapegoating rather than an attribution.
 *
 * What still isn't here: energy, tempo and loudness. `GET /v1/audio-features`
 * would answer "how shouty is Maya's taste" directly, and chosic's token plausibly
 * still reaches it, but that is unverified, it is a second request per ingest,
 * and the endpoint is deprecated. Everything below runs on the playlist payload.
 */

const TARGET = 20;

/** Hebrew block, used to spot a playlist that never left the country. */
const HEBREW = /[֐-׿]/;

/** House jokes. Also the safety net when the pool is too thin to mock. */
const FILLER = [
  "It's not Despacito by Maroon 5",
  'No penguins in this prod',
  "It's okay to give up if it's from Ron's playlist",
  "Tip: always blame whoever's playlist it came from.",
  'Shmip the Shmop',
  'Efrat HaMeshugaat' // Thanks Shani
];

/**
 * Aimed at a random player, no data required. Guarantees the screen has teeth.
 *
 * These run *before* the round is playable — nobody has heard a stem or made a
 * guess yet — so every line is either a prediction or a timeless insult. Nothing
 * may react to play that hasn't happened ("nobody is asking you", "unearned
 * confidence"); on a loading screen that reads as a bug, not a joke.
 */
const TAUNTS = [
  (name: string) => `Tip: Don\'t let ${name} guess. Ever.`,
  (name: string) => `Whatever ${name} is about to say, it isn't that.`,
  (name: string) => `${name} has never once recognised the song.`,
  (name: string) => `${name} is already Googling.`,
  (name: string) => `${name} will say Imagine Dragons.`,
  (name: string) => `Please take ${possessive(name)} phone away.`,
  (name: string) => `${name} is warming up a wrong answer.`,
  (name: string) => `${possessive(name)} music taste peaked at fourteen.`,
  (name: string) => `${possessive(name)} songs will fit well in my funeral.`,
  (name: string) => `No way ${name} actually listens to their playlist.`,
  (name: string) => `${Math.floor(Math.random() * 1000)} racial slurs in ${name}'s playlist.`,
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
    return small ? `${small.trackCount} songs, ${small.name}? Pathetic.` : null;
  },

  ({ players }) => {
    if (players.length < 2) return null;
    const big = players[players.length - 1];
    return big ? `${big.name} brought ${big.trackCount} songs. Nobody asked, nobody wanted.` : null;
  },

  ({ hog }) =>
    hog && hog.share >= 45
      ? `${hog.share}% of this pool is ${possessive(hog.name)}. Fatty.`
      : null,

  ({ players }) =>
    players.length === 1 && players[0]
      ? `One playlist. Every bad decision here is ${possessive(players[0].name)}.`
      : null,

  ({ players }) => {
    if (players.length < 3) return null;
    const last = [...players].sort((a, b) => b.joinedAt - a.joinedAt)[0];
    const big = players[players.length - 1];
    return last && big && last.id === big.id
      ? `${last.name} joined last and brought most. Desperate.`
      : null;
  },

  ({ twins }) =>
    twins
      ? `${twins.who[0]} and ${twins.who[1]} brought ${twins.count} each. One of you is redundant.`
      : null,

  ({ dupes }) => (dupes > 0 ? `${dupes} songs got brought twice. Staggering originality.` : null),

  // --- taste ---

  ({ topArtist }) =>
    topArtist && topArtist.share >= 3
      ? `${topArtist.share}% of this pool is ${topArtist.name}. Grim.`
      : null,

  ({ obsessed }) =>
    obsessed
      ? `${obsessed.share}% of ${possessive(obsessed.player)} list is ${obsessed.artist}. Get a therapist.`
      : null,

  ({ sharedArtist }) =>
    sharedArtist
      ? `${sharedArtist.who[0]} and ${sharedArtist.who[1]} both brought ${sharedArtist.name}. Twins.`
      : null,

  ({ narrow }) =>
    narrow
      ? `Only ${narrow.artists} artists, ${narrow.name}? Try leaving the house.`
      : null,

  ({ albumDump }) =>
    albumDump
      ? `${albumDump.name} brought ${albumDump.count} songs off one album. Lazy.`
      : null,

  ({ singles }) =>
    singles
      ? `${singles.share}% of ${possessive(singles.name)} list is singles. Commitment issues.`
      : null,

  // --- language ---

  ({ explicitPlayer }) =>
    explicitPlayer
      ? `${explicitPlayer.share}% of ${possessive(explicitPlayer.name)} list is explicit. Charming.`
      : null,

  ({ hebrewOnly }) =>
    hebrewOnly ? `All Hebrew from ${hebrewOnly}. Akh Sheli.` : null,

  ({ cleanPlayer }) =>
    cleanPlayer ? `Not one swear word from ${cleanPlayer}.` : null,

  ({ explicitShare }) =>
    explicitShare !== null && explicitShare >= 30
      ? `${explicitShare}% of this pool has a parental advisory.`
      : null,

  // --- length ---

  ({ epic }) => (epic ? `${epic.name} pooled a ${epic.length} song. Who hurt you.` : null),

  ({ tiny }) => (tiny ? `${tiny.name} pooled a ${tiny.length} song. Like bro.` : null),

  ({ impatient }) =>
    impatient
      ? `${possessive(impatient.name)} songs average ${impatient.length}. Attention span.`
      : null,

  // --- eras ---

  ({ eraSpread }) =>
    eraSpread
      ? `${possessive(eraSpread.name)} taste spans ${eraSpread.range}. Damn.`
      : null,

  ({ decade, blame2 }) =>
    decade && decade.share >= 30
      ? blame2
        ? `${decade.share}% of this is ${decade.label}. Grow up, ${blame2}.`
        : `${decade.share}% of this pool is ${decade.label}. Predictable.`
      : null,

  ({ bigYear }) =>
    bigYear && bigYear.share >= 12
      ? `${bigYear.share}% of this pool is ${bigYear.year} alone.`
      : null,

  ({ oldest }) => (oldest !== null ? `Something in here is from ${oldest}. Museum piece.` : null),


  // --- popularity (pool-wide shares only, plus a scapegoat; see the header) ---

  ({ obscureShare, blame }) =>
    obscureShare !== null && obscureShare >= 25
      ? blame
        ? `A lot of this pool is unheard of. Classic ${blame}.`
        : `A lot of this pool is genuinely unheard of.`
      : null,

  ({ hitShare, blame2 }) =>
    hitShare !== null && hitShare >= 30
      ? blame2
        ? `Heavy chart energy in here. Thanks, ${blame2}.`
        : `This pool is basically a Top 50 playlist.`
      : null,

  ({ meanPopularity }) =>
    meanPopularity !== null && meanPopularity >= 65
      ? `Top hits only. Basic.`
      : null,

  ({ meanPopularity, blame }) =>
    meanPopularity !== null && meanPopularity <= 30
      ? blame
        ? `Most of this pool is deep cuts. ${blame} is proud of that.`
        : `Most of this pool is deep cuts. Bold strategy.`
      : null,

  ({ ceiling }) =>
    ceiling !== null ? `Nothing here is even slightly mainstream. Fascinating.` : null,

  ({ popSpread }) =>
    popSpread
      ? `${possessive(popSpread.name)} list goes from underground to mainstream. Pick a lane.`
      : null,

  // --- titles ---

  ({ titles }) => (titles.love >= 5 ? `${titles.love} songs about love. Cringe.` : null),

  ({ titles }) => (titles.remix >= 20 ? `${titles.remix} remixes in here. Why.` : null),

  ({ titles }) => (titles.xmas > 2 ? 'Somebody keeps putting Christmas songs.' : null),

  ({ titles }) => (titles.money >= 3 ? `${titles.money} songs about money.` : null),

  ({ titles }) => (titles.death >= 3 ? `${titles.death} songs about death.` : null),

  ({ titles }) => (titles.booze >= 3 ? `${titles.booze} songs about drinking.` : null),

  ({ titles }) => (titles.cali > 1 ? 'Somebody keeps writing songs about California.' : null),
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
  hebrew: number;
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
  const titles = { love: 0, remix: 0, xmas: 0, money: 0, death: 0, booze: 0, cali: 0 };

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
    // `\$\d` catches Ca$h-style spellings without matching artist names like A$AP.
    if (/money|dollar|\bcash\b|\brich\b|\$\d/.test(lower)) titles.money++;
    if (/\bdie\b|\bdying\b|\bdead\b|death|funeral|\bgrave\b|\bkill(s|ed|ing)?\b/.test(lower))
      titles.death++;
    if (/whiske?y|\bwine\b|drunk|\bbeer\b|tequila|vodka|\bbottle\b|hangover/.test(lower))
      titles.booze++;
    if (/california|hollywood|malibu/.test(lower)) titles.cali++;
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
        hebrew: 0,
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
    // Script, not language: an Israeli artist with a Latin-spelled name still
    // counts if the song title is written in Hebrew, which is the common case.
    if (HEBREW.test(track.title) || track.artists.some((a) => HEBREW.test(a.name))) bucket.hebrew++;
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

  // Two distinct names, drawn fresh every build, for the pool-wide lines to
  // pin things on. Deliberately unrelated to the fact they accompany — see the
  // header. Null in a one-player lobby, where a second name doesn't exist and
  // the first would read as a real accusation.
  const scapegoats = shuffle(players.map((p) => p.name));

  return {
    players: byTrackCount,
    blame: players.length >= 2 ? scapegoats[0] ?? null : null,
    blame2: players.length >= 2 ? scapegoats[1] ?? null : null,
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

  // Only the all-in case is funny; a mixed list is just a list.
  const hebrewOnly = best(rows, ({ b }) =>
    b.songs >= 6 && b.hebrew / b.songs >= 0.9 ? { score: b.songs } : null,
  );

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
    hebrewOnly: hebrewOnly?.name ?? null,
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
