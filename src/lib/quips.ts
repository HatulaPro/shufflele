import type { Player, Track } from './types';

/**
 * Loading-screen filler. The wait is 20–120s of nothing, so instead of narrating
 * the pipeline at people (nobody cares which stem is being separated) the screen
 * rotates through short jokes about the playlists in the room. SPEC §1.2.
 *
 * Four rules hold everything here together:
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
 * - **Not the same twice.** A group plays a dozen rounds a night and comes back
 *   next week. Every observation below carries four or more phrasings and one is
 *   drawn at random per build, and only `TARGET` lines survive to the screen, so
 *   two rounds off an identical pool look nothing alike.
 * - **Legible from the room.** Nobody out there can see the test that fired the
 *   line, so a line has to carry its own trigger. "Ron treated this like a job
 *   interview" is a joke only the code gets; "Ron brought 200 songs to a party
 *   game" is the same joke and lands. The number doesn't have to be printed, but
 *   the *subject* — songs brought, one album, an artist, a swear, a duplicate —
 *   does, or the line reads as a non-sequitur.
 * - **Vary the shape.** Four phrasings that are all `Fact. Adjective.` are one
 *   phrasing. Rotate through questions, imperatives, direct address, comparisons
 *   and flat statements with no tag at all; the `Fact. Adjective.` shape is the
 *   sharpest of them and stops working the moment it's the only one on screen.
 *
 * The taunts are the one place both of those relax, since they run on no data at
 * all — but they may not *predict the round*, and they may not all be the same
 * prediction. The guess screen shows the release year, so "they'll name the wrong
 * decade" is a line the room can immediately disprove.
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
 * **Thresholds are proportional, not absolute.** 47 songs is not a small
 * playlist and 5 love songs is not an obsession in a pool of 400. Every gate
 * below is either a share of the pool or a ratio against the rest of the room,
 * so the line only fires when the number actually earns the tone — and the
 * nastier phrasings are held back for the tiers that deserve them.
 *
 * What still isn't here: energy, tempo and loudness. `GET /v1/audio-features`
 * would answer "how shouty is Maya's taste" directly, and chosic's token plausibly
 * still reaches it, but that is unverified, it is a second request per ingest,
 * and the endpoint is deprecated. Everything below runs on the playlist payload.
 */

/**
 * Lines per round. Deliberately far below the number the pool can produce: at
 * `QUIP_SECONDS` apart a long cold wait shows maybe a dozen slots, and a small
 * hand drawn from a large deck is what stops the fifth game of the night from
 * reading like the first. SPEC §1.2.
 */
const TARGET = 8;

/** Of those, how many are pure taunts. The rest come from the pool. */
const TAUNT_SLOTS = 2;

/**
 * Below this many unique tracks, a percentage of the pool is not a fact about
 * anyone's taste — in a seven-song lobby one track is 14% and "modal decade:
 * 2010s, 57%" is arithmetic, not an observation. Every pool-wide share that
 * describes *the music* is gated on it. Shares that describe who brought what
 * (`hog`) are exempt: those are true at any size.
 */
const MIN_POOL_FOR_SHARES = 25;

/** Hebrew block, used to spot a playlist that never left the country. */
const HEBREW = /[֐-׿]/;

/** House jokes. Also the safety net when the pool is too thin to mock. */
const FILLER = [
  "It's not Despacito by Maroon 5",
  'No penguins in this prod',
  "It's okay to give up if it's from Ron's playlist",
  "Tip: always blame whoever's playlist it came from.",
  'Shmip the Shmop',
  'Efrat HaMeshugaat', // Thanks Shani
  'Somebody in this room is about to embarrass themselves',
  'Loading. Unlike your music taste, this improves with time.',
  'Nobody has ever won this on the drums',
  'The algorithm has seen your playlist and said nothing',
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
  (name: string) => `Tip: Don't let ${name} guess. Ever.`,
  (name: string) => `Whatever ${name} is about to say, it isn't that.`,
  (name: string) => `${name} has never once recognised the song.`,
  (name: string) => `${name} is already Googling.`,
  (name: string) => `${name} will say Imagine Dragons.`,
  (name: string) => `Please take ${possessive(name)} phone away.`,
  (name: string) => `${name} is warming up a wrong answer.`,
  (name: string) => `${possessive(name)} music taste peaked at fourteen.`,
  (name: string) => `No way ${name} actually listens to their playlist.`,
  (name: string) => `Do not let ${name} near the volume.`,
  (name: string) => `${possessive(name)} playlist is a cry for help.`,
  (name: string) => `Even ${name} doesn't know the songs they chose.`,
];

type Facts = ReturnType<typeof gather>;
/** Every observation returns *all* its phrasings; the builder draws one. */
type Quip = (f: Facts) => string[] | null;

export function buildQuips(players: Player[], tracks: Track[]): string[] {
  const facts = gather(players, tracks);
  const lines: string[] = [];

  for (const quip of QUIPS) {
    const variants = quip(facts);
    if (variants && variants.length > 0) lines.push(pick(variants));
  }

  for (const key of THEME_KEYS) {
    const variants = themeLine(key, facts);
    if (variants) lines.push(pick(variants));
  }

  // Drawn, not truncated: the pool routinely produces forty candidates and only
  // a handful reach the screen, which is where replay variety comes from.
  const out = shuffle(lines).slice(0, TARGET - TAUNT_SLOTS);

  // One taunt per player, each on a different template.
  const names = shuffle(players.map((p) => p.name)).slice(0, TAUNT_SLOTS);
  const templates = shuffle([...TAUNTS]);
  names.forEach((name, i) => out.push(templates[i % templates.length]!(name)));

  shuffle(out);
  // Fillers go last, so a well-stocked lobby rarely reaches them.
  for (const line of shuffle([...FILLER])) {
    if (out.length >= TARGET) break;
    out.push(line);
  }

  return out.slice(0, TARGET);
}

// --- the lines -----------------------------------------------------------

const QUIPS: Quip[] = [
  // --- who brought what ---

  // Tiered, because "47 songs? Pathetic." is a lie. `slacker` only exists when
  // the smallest playlist is both small on its own terms and small next to the
  // room, and the tone tracks which of those is true.
  ({ slacker }) => {
    if (!slacker) return null;
    const { name, count, ratio } = slacker;
    if (count <= 20) {
      return [
        `${count} songs, ${name}? Pathetic.`,
        `${name} with only ${count} songs.`,
        `Who told ${name} that ${count} songs was enough?`,
        `${count} songs from ${name}. We've seen ringtone libraries with more.`,
        `${name} showed up with ${count} songs and no shame.`,
      ];
    }
    if (ratio <= 0.5) {
      return [
        `${name} brought half of what everyone else did.`,
        `${count} songs, ${name}. Everyone else managed more.`,
        `Everyone else brought double what ${name} did.`,
        `${name} is coasting on other people's playlists.`,
      ];
    }
    return [
      `${name} brought the fewest. Somebody had to.`,
      `Smallest playlist: ${possessive(name)}.`,
      `Only ${count} songs from ${name}.`,
      `${name} came last in a competition nobody announced.`,
    ];
  },

  ({ hoarder }) => {
    if (!hoarder) return null;
    const { name, count, ratio } = hoarder;
    if (ratio >= 2) {
      return [
        `${name} brought ${count} songs. Nobody asked, nobody wanted.`,
        `Nobody asked ${name} for ${count} songs.`,
        `${count} songs from ${name}. A personality, not a playlist.`,
        `${name} brought ${count} songs.`,
      ];
    }
    return [
      `${name} brought the most songs.`,
      `Largest playlist: ${possessive(name)}, at ${count}.`,
    ];
  },

  ({ hog }) => {
    if (!hog) return null;
    if (hog.share >= 60) {
      return [
        `${hog.share}% of this pool is ${possessive(hog.name)}. Tyrant.`,
        `${hog.name} isn't a player, ${hog.name} is the venue.`,
        `${hog.share}% of everything here came from one person.`,
        `This is ${possessive(hog.name)} playlist with witnesses.`,
      ];
    }
    if (hog.share >= 45) {
      return [
        `${hog.share}% of this pool is ${possessive(hog.name)}. Fatty.`,
        `Nearly half of this is ${hog.name}. Nobody voted for that.`,
        `Almost every other song tonight is ${possessive(hog.name)}.`,
        `${hog.name} took up more room than anyone invited them to.`,
      ];
    }
    return null;
  },

  ({ players }) => {
    const solo = players.length === 1 ? players[0] : null;
    return solo
      ? [
          `One playlist. Every bad decision here is ${possessive(solo.name)}.`,
          `${solo.name} is playing against themselves. And losing.`,
          `${solo.name} is the only one who brought anything.`,
          `Nobody else showed up. That tracks, ${solo.name}.`,
        ]
      : null;
  },

  ({ players }) => {
    if (players.length < 3) return null;
    const last = [...players].sort((a, b) => b.joinedAt - a.joinedAt)[0];
    const big = players[players.length - 1];
    return last && big && last.id === big.id
      ? [
          `${last.name} joined last and brought most. Desperate.`,
          `${last.name} was late and overcompensated.`,
          `Last in, biggest playlist. We see you, ${last.name}.`,
          `${last.name} joined last, then dumped the biggest playlist in.`,
        ]
      : null;
  },

  ({ twins }) =>
    twins
      ? [
          `${twins.who[0]} and ${twins.who[1]} brought ${twins.count} each. One of you is redundant.`,
          `${twins.who[0]} and ${twins.who[1]} landed on the same number.`,
          `Two playlists, ${twins.count} songs each. Collusion.`,
          `Get separate hobbies, ${twins.who[0]} and ${twins.who[1]}.`,
        ]
      : null,

  ({ dupes, dupeShare }) => {
    if (dupes < 1) return null;
    if (dupeShare >= 10) {
      return [
        `${dupeShare}% of this pool got brought twice.`,
        `${dupes} songs are in here more than once.`,
        `Playlist overlap: ${dupeShare}%. Nobody here has a personality.`,
        `${dupes} duplicates. You all listen to the same eleven songs.`,
      ];
    }
    return [
      `${dupes} songs got brought twice.`,
      `Somebody copied somebody. ${dupes} songs are in here twice.`,
      `${dupes} songs showed up twice. Two people, one taste.`,
      `${dupes} overlaps. Unremarkable, and still embarrassing.`,
    ];
  },

  // --- taste ---

  ({ topArtist }) => {
    if (!topArtist) return null;
    if (topArtist.share >= 8) {
      return [
        `${topArtist.share}% of this pool is ${topArtist.name}. Grim.`,
        `One artist owns ${topArtist.share}% of this room. It's ${topArtist.name}.`,
        `Roughly every tenth song tonight is ${topArtist.name}.`,
        `This isn't a pool, it's a ${topArtist.name} tribute night.`,
      ];
    }
    if (topArtist.share >= 3) {
      return [
        `Most-brought artist: ${topArtist.name}, at ${topArtist.share}%.`,
        `${topArtist.name} leads the pool.`,
        `${topArtist.share}% ${topArtist.name}. I can appreciate that.`,
        `More ${topArtist.name} in here than anybody else.`,
      ];
    }
    return null;
  },

  ({ obsessed }) => {
    if (!obsessed) return null;
    if (obsessed.share >= 15) {
      return [
        `${obsessed.share}% of ${possessive(obsessed.player)} list is ${obsessed.artist}. Get a therapist ♥`,
        `${obsessed.player} has one artist and it's ${obsessed.artist}.`,
        `Does ${obsessed.player} listen to anyone except ${obsessed.artist}?`,
        `Somebody tell ${obsessed.player} that other artists exist.`,
      ];
    }
    return [
      `${obsessed.share}% of ${possessive(obsessed.player)} list is ${obsessed.artist}. A lot.`,
      `Branch out, ${obsessed.player}. ${obsessed.artist} has peers.`,
      `More ${obsessed.artist} from ${obsessed.player} than anything else.`,
      `${obsessed.player} found ${obsessed.artist} and stopped looking.`,
    ];
  },

  ({ sharedArtist }) =>
    sharedArtist
      ? [
          `${sharedArtist.who[0]} and ${sharedArtist.who[1]} both brought ${sharedArtist.name}. Twins.`,
          `${sharedArtist.name} turned up in two different playlists.`,
          `Two of you brought ${sharedArtist.name}. You know who you are.`,
          `${sharedArtist.who[0]} and ${sharedArtist.who[1]} never compared notes on ${sharedArtist.name}.`,
        ]
      : null,

  ({ narrow }) =>
    narrow
      ? [
          `Only ${narrow.artists} artists, ${narrow.name}? Try leaving the house.`,
          `${narrow.songs} songs from ${narrow.artists} artists. ${narrow.name} has a very small world.`,
          `${possessive(narrow.name)} playlist is ${narrow.artists} artists on a loop.`,
          `${narrow.name} rotates ${narrow.artists} artists and calls it taste.`,
        ]
      : null,

  ({ albumDump }) =>
    albumDump
      ? [
          `${albumDump.name} brought ${albumDump.count} songs off one album. Lazy.`,
          `${albumDump.name} copy-pasted an entire album. Respect.`,
          `${albumDump.count} tracks, one album, one contributor: ${albumDump.name}.`,
          `${albumDump.name} found one album they liked and stopped there.`,
        ]
      : null,

  ({ singles }) =>
    singles
      ? [
          `${singles.share}% of ${possessive(singles.name)} list is singles. Commitment issues.`,
          `${singles.name} has never finished an album in their life.`,
          `Album completion rate for ${singles.name}: functionally zero.`,
          `${singles.name} only likes the song that got advertised.`,
        ]
      : null,

  // Reads the album, never prints it. See ALBUM_VIBES for why this is safe.
  ({ albumVibe }) => (albumVibe ? VIBE_LINES[albumVibe.vibe].map((line) => line(albumVibe.name)) : null),

  // --- absences ---

  // Only fires on a pool big enough that an absence means something. See
  // `MISSING_ARTISTS`.
  ({ missingArtists }) =>
    missingArtists.length > 0 ? MISSING_LINES[pick(missingArtists)] ?? null : null,

  // --- language ---

  ({ explicitPlayer }) => {
    if (!explicitPlayer) return null;
    if (explicitPlayer.share >= 60) {
      return [
        `${explicitPlayer.share}% of ${possessive(explicitPlayer.name)} list is explicit.`,
        `${explicitPlayer.name} cannot go one song without swearing.`,
        `Advisory coverage for ${explicitPlayer.name}: ${explicitPlayer.share}%. Medically impressive.`,
        `${possessive(explicitPlayer.name)} playlist should not be played near a school.`,
      ];
    }
    return [
      `${explicitPlayer.share}% of ${possessive(explicitPlayer.name)} list is explicit. Noted.`,
      `${explicitPlayer.name} swears more than everyone else here.`,
      `Nobody in this room swears more than ${explicitPlayer.name}.`,
      `${possessive(explicitPlayer.name)} playlist has opinions and vocabulary.`,
    ];
  },

  ({ hebrewOnly }) =>
    hebrewOnly
      ? [
          `All Hebrew from ${hebrewOnly}. Akh Sheli.`,
          `${hebrewOnly} has never once left the country.`,
          `Eliezer Ben Yehuda would be proud of ${possessive(hebrewOnly)} playlist.`,
          `${hebrewOnly} listens to Minecraft enchantment table?`,
        ]
      : null,

  ({ cleanPlayer }) =>
    cleanPlayer
      ? [
          `Not one swear word from ${cleanPlayer}.`,
          `${cleanPlayer} brought a playlist you could play at a funeral.`,
          `Explicit tracks from ${cleanPlayer}: zero. Suspicious.`,
          `${cleanPlayer} is being supervised by somebody.`,
        ]
      : null,

  ({ explicitShare }) => {
    if (explicitShare === null) return null;
    if (explicitShare >= 55) {
      return [
        `${explicitShare}% of this pool has a parental advisory.`,
        `Over half of this room is unbroadcastable.`,
        `This pool is ${explicitShare}% profanity by volume.`,
        `Nobody here can be trusted with a speaker.`,
      ];
    }
    if (explicitShare >= 30) {
      return [
        `${explicitShare}% of this pool has a parental advisory.`,
        `A third of this room swears at you.`,
        `Explicit share: ${explicitShare}%. About what you'd expect here.`,
        `So many explicit songs here. I hope your dad comes back ♥`,
      ];
    }
    return null;
  },

  // --- length ---

  ({ epic }) =>
    epic
      ? [
          `${epic.name} pooled a ${epic.length} song. Who hurt you.`,
          `Longest track in here is ${epic.length}. Thanks, ${epic.name}.`,
          `Nobody has ${epic.length} to spare, ${epic.name}.`,
          `This one ${epic.length} song by ${epic.name} will kill me.`,
        ]
      : null,

  ({ tiny }) =>
    tiny
      ? [
          `${tiny.name} pooled a ${tiny.length} song. Like bro.`,
          `Shortest track: ${tiny.length}. ${tiny.name} did that on purpose.`,
          `${tiny.name} brought something that ends before it starts.`,
          `${tiny.length} is not a song, ${tiny.name}. It's a notification.`,
        ]
      : null,

  ({ impatient }) =>
    impatient
      ? [
          `${possessive(impatient.name)} songs average ${impatient.length}. Attention span.`,
          `Nothing ${impatient.name} brought goes much past ${impatient.length}.`,
          `${impatient.name} cannot sit through a bridge.`,
          `Everything ${impatient.name} brought is over in ${impatient.length}.`,
        ]
      : null,

  // --- eras ---

  ({ eraSpread }) =>
    eraSpread
      ? [
          `${possessive(eraSpread.name)} taste spans ${eraSpread.range}. Damn.`,
          `${eraSpread.name} brought ${eraSpread.range}. No decade is safe.`,
          `${eraSpread.name} brought ${eraSpread.range} and everything between.`,
          `${eraSpread.name} has no era, only impulses.`,
        ]
      : null,

  ({ decade, blame2 }) => {
    if (!decade) return null;
    if (decade.share >= 50) {
      return [
        `${decade.share}% of this is ${decade.label}. Grow up${blame2 ? `, ${blame2}` : ''}.`,
        `Half this pool is ${decade.label}. Nobody has moved on.`,
        `Modal decade: ${decade.label}, at ${decade.share}%. Stuck.`,
        `This room never left the ${decade.label}.`,
      ];
    }
    if (decade.share >= 30) {
      return [
        `${decade.share}% of this pool is ${decade.label}. Predictable.`,
        `The ${decade.label} are doing a lot of work in here.`,
        `${decade.share}% of what you lot brought is ${decade.label}.`,
        blame2
          ? `Too much ${decade.label} in here. Classic ${blame2}.`
          : `Somebody in here is very attached to the ${decade.label}.`,
      ];
    }
    return null;
  },

  ({ bigYear }) =>
    bigYear && bigYear.share >= 12
      ? [
          `${bigYear.share}% of this pool is ${bigYear.year} alone.`,
          `A lot happened to this room in ${bigYear.year}.`,
          `Single most represented year: ${bigYear.year}, ${bigYear.share}%.`,
          `${bigYear.year} was clearly a formative year for somebody here.`,
        ]
      : null,

  ({ oldest }) =>
    oldest !== null && oldest < 1975
      ? [
          `Something in here is from ${oldest}. Museum piece.`,
          `Oldest track in the pool: ${oldest}. Somebody's dad is playing.`,
          `Somebody put a song from ${oldest}.`,
          `This pool reaches back to ${oldest}.`,
        ]
      : null,

  // --- popularity (pool-wide shares only, plus a scapegoat; see the header) ---

  ({ obscureShare, blame }) => {
    if (obscureShare === null || obscureShare < 25) return null;
    if (obscureShare >= 50) {
      return [
        blame ? `Half this pool is unheard of. Classic ${blame}.` : `Half this pool is genuinely unheard of.`,
        `${obscureShare}% of these tracks have never been streamed by anyone.`,
        `This room is allergic to a popular songs.`,
        `Obscurity share: ${obscureShare}%. Somebody is trying very hard.`,
      ];
    }
    return [
      blame ? `A lot of this pool is unheard of. Classic ${blame}.` : `A lot of this pool is genuinely unheard of.`,
      `${obscureShare}% of this pool is deeply unpopular.`,
      `A quarter of these tracks are strangers to the charts.`,
      blame
        ? `Somebody brought the obscure stuff. Probably ${blame}.`
        : `Somebody brought the deep cuts to a party game.`,
    ];
  },

  ({ hitShare, blame2 }) => {
    if (hitShare === null || hitShare < 30) return null;
    if (hitShare >= 65) {
      return [
        `This pool is basically a Top 50 playlist.`,
        blame2 ? `Chart music, wall to wall. Thanks, ${blame2}.` : `Chart music, wall to wall. Cowards.`,
        `${hitShare}% of this pool is a certified hit.`,
        `Nothing in here has ever surprised anyone.`,
      ];
    }
    return [
      blame2 ? `Heavy chart energy in here. Thanks, ${blame2}.` : `Heavy chart energy in here.`,
      `${hitShare}% of this pool charted. Comfortable.`,
      `A third of this room came straight off the radio.`,
      `Popular, but not yet embarrassing.`,
    ];
  },

  ({ meanPopularity }) => {
    if (meanPopularity === null) return null;
    if (meanPopularity >= 75) {
      return [
        `Top hits only. Basic.`,
        `Mean popularity: ${meanPopularity}. Nobody took a single risk.`,
        `This pool has the taste of an airport lounge.`,
        `Every song in here has been in an advert.`,
      ];
    }
    if (meanPopularity >= 65) {
      return [
        `Mostly hits. Safe.`,
        `Average popularity across the pool: ${meanPopularity}.`,
        `This room likes what it was told to like.`,
        `Nothing in this pool is even slightly obscure.`,
      ];
    }
    return null;
  },

  ({ meanPopularity, blame }) => {
    if (meanPopularity === null || meanPopularity > 30) return null;
    return [
      blame ? `Most of this pool is deep cuts. ${blame} is proud of that.` : `Most of this pool is deep cuts. Bold strategy.`,
      `Mean popularity: ${meanPopularity}. This is going to be painful.`,
      `Almost nothing in this pool is famous.`,
      blame ? `Somebody made this unwinnable. Probably ${blame}.` : `Somebody made this unwinnable on purpose.`,
    ];
  },

  ({ ceiling }) =>
    ceiling !== null
      ? [
          `Nothing here is even slightly mainstream. Fascinating.`,
          `Nothing in this pool scores above ${ceiling}.`,
          `Not one song in here has ever been a hit.`,
          `This pool tops out well below famous.`,
        ]
      : null,

  ({ popSpread }) =>
    popSpread
      ? [
          `${possessive(popSpread.name)} list goes from underground to mainstream. Pick a lane.`,
          `${popSpread.name} brought the famous and the unheard-of, equally.`,
          `${possessive(popSpread.name)} taste covers the whole popularity scale.`,
          `${popSpread.name} likes both the smash and the nobody. Suspicious.`,
        ]
      : null,

  // The concept counters (love, death, Christmas and the rest) are not listed
  // here — `buildQuips` walks `THEME_LINES` directly. See `themeLine`.
];

// --- what the titles are about -------------------------------------------

/**
 * A predicate per concept, run once per unique track against the lowercased
 * title. Counting rather than quoting is what keeps this side of the file safe:
 * "9 songs about death" names no track, so it can't be the secret's title. `t`
 * is the original casing, needed only by the shape counters.
 */
const themes = <T extends Record<string, (lower: string, title: string) => boolean>>(t: T) =>
  // Widened back to the full signature so every entry is callable with both
  // arguments, whether or not it declared the second one.
  t as { [K in keyof T]: (lower: string, title: string) => boolean };

const THEME_TESTS = themes({
  love: (l) => /\blove/.test(l),
  remix: (l) => /remix|edit\b|rework/.test(l),
  xmas: (l) => /christmas|xmas|santa|jingle|sleigh/.test(l),
  // `\$\d` catches Ca$h-style spellings without matching artist names like A$AP.
  money: (l) => /money|dollar|\bcash\b|\brich\b|\$\d/.test(l),
  death: (l) => /\bdie\b|\bdying\b|\bdead\b|death|funeral|\bgrave\b|\bkill(s|ed|ing)?\b/.test(l),
  booze: (l) => /whiske?y|\bwine\b|drunk|\bbeer\b|tequila|vodka|\bbottle\b|hangover/.test(l),
  cali: (l) => /california|hollywood|malibu/.test(l),

  night: (l) => /\bnight|midnight|\b3 ?a\.?m\.?\b|\bmoon\b/.test(l),
  summer: (l) => /\bsummer\b|sunshine|\bsun\b|\bbeach\b|\bocean\b|\bwaves?\b/.test(l),
  rain: (l) => /\brain|\bstorm\b|thunder|umbrella|\bclouds?\b/.test(l),
  fire: (l) => /\bfire\b|\bburn(s|ing|ed)?\b|\bflames?\b|\bhell\b|\bashes\b/.test(l),
  dance: (l) => /\bdanc|\bboogie\b|\bgroove\b|\bshake\b|\bmove your\b/.test(l),
  tears: (l) => /\bcry(ing)?\b|\btears?\b|\bsad\b|\bweep/.test(l),
  heartbreak: (l) => /heart\s?break|broken heart|\bbroken\b|\bhurts?\b|\bache\b/.test(l),
  baby: (l) => /\bbaby\b|\bbabe\b|\bhoney\b/.test(l),
  god: (l) => /\bgod\b|\bjesus\b|\bheaven\b|\bangel|\bpray|\bchurch\b|\bhallelujah\b/.test(l),
  drugs: (l) => /\bhigh\b|\bsmoke\b|\bweed\b|\bdrugs?\b|\bpills?\b|cocaine|\bxanax\b|\bstoned\b/.test(l),
  cars: (l) => /\bdriv|\bcar\b|highway|\broad\b|\bride\b|\bwheel|\bgasoline\b/.test(l),
  war: (l) => /\bwar\b|\bfight(ing)?\b|\bsoldier|\bguns?\b|\bbattle\b|\bblood\b|\barmy\b/.test(l),
  dreams: (l) => /\bdream|\bsleep|\basleep\b|\bawake\b|\bnightmare/.test(l),
  alone: (l) => /\balone\b|\blonely\b|\bmyself\b|\bnobody\b|\bno one\b/.test(l),
  body: (l) => /\bbody\b|\blips\b|\bskin\b|\bhands?\b|\beyes\b|\bhips\b/.test(l),
  colours: (l) => /\bblue\b|\bred\b|\bblack\b|\bwhite\b|\bgold(en)?\b|\bgreen\b|\bpink\b/.test(l),
  places: (l) => /\bnew york\b|\blondon\b|\bparis\b|\btexas\b|\btokyo\b|\bmiami\b|\bberlin\b|\bvegas\b|\btel aviv\b|\bnashville\b/.test(l),
  cussing: (l) => /\bfuck|\bshit\b|\bbitch\b|\bdamn\b|\bass\b/.test(l),
  sorry: (l) => /\bsorry\b|\bforgive|\bmistakes?\b|\bregrets?\b|\bapolog/.test(l),
  runaway: (l) => /\brun(ning)?\b|\baway\b|\bescape\b|\bleave\b|\bgoodbye\b|\bgone\b/.test(l),
  girls: (l) => /\bgirls?\b|\bshe\b|\bher\b/.test(l),
  questions: (l) => l.includes('?'),
  numbers: (l) => /\d/.test(l),
  collabs: (l) => /\(feat|\bfeat\.|\bft\.|\bwith .+\)/.test(l),
  live: (l) => /\blive\b|acoustic|\bversion\b|\bdemo\b|deluxe|radio edit|\bsession\b/.test(l),
  // Shape, not subject — the two below are the only ones that need the casing.
  shouting: (_l, t) => /[A-Z]{3}/.test(t) && !/[a-z]/.test(t),
  oneWord: (_l, t) => !/\s/.test(t.trim()) && t.trim().length > 0,
});

type Theme = keyof typeof THEME_TESTS;

/**
 * When each concept is allowed to speak, and what it says.
 *
 * `min` is an absolute floor (three love songs is a coincidence) and `share` a
 * percentage of the unique pool (five love songs in four hundred is also a
 * coincidence). Both must clear before the line fires, which is the whole point
 * of the exercise: the joke is the number being genuinely absurd, not the
 * template being loud about an ordinary one.
 */
const THEME_LINES: Record<Theme, { min: number; share: number; lines: (n: number, s: number) => string[] }> = {
  love: {
    min: 6,
    share: 4,
    lines: (n, s) => [
      `${n} songs about love. Cringe.`,
      `${s}% of this pool is about love. Get a hobby.`,
      `${n} love songs. Somebody in here is not over it.`,
      `${n} songs say the word love. Not one of you means it.`,
    ],
  },
  remix: {
    min: 8,
    share: 5,
    lines: (n, s) => [
      `${n} remixes in here. Why.`,
      `${s}% of this pool is somebody else's song with drums on it.`,
      `${n} remixes. At least one of you had a DJ phase.`,
      `Original versions were available, ${n} times.`,
    ],
  },
  xmas: {
    min: 3,
    share: 1,
    lines: (n) => [
      'Somebody keeps putting Christmas songs.',
      `${n} Christmas songs. In this economy.`,
      `Check the date. There are ${n} Christmas songs in here.`,
      `${n} songs about Christmas. Somebody peaked in December.`,
    ],
  },
  money: {
    min: 4,
    share: 2,
    lines: (n, s) => [
      `${n} songs about money.`,
      `${s}% of this pool is about being rich. None of you are.`,
      `${n} songs about money in a room with no money.`,
      `${n} songs about getting paid. It hasn't worked.`,
    ],
  },
  death: {
    min: 4,
    share: 2,
    lines: (n, s) => [
      `${n} songs about death.`,
      `${s}% of this pool is about dying. Everything fine at home?`,
      `${n} tracks reference death. Somebody check on somebody.`,
      `Mortality comes up ${n} times in here. Casually.`,
    ],
  },
  booze: {
    min: 4,
    share: 2,
    lines: (n, s) => [
      `${n} songs about drinking.`,
      `${s}% of this pool is about being drunk. Consistent, at least.`,
      `${n} tracks about alcohol. That's a pattern, not a taste.`,
      `Somebody here has a bar tab and a theme song.`,
    ],
  },
  cali: {
    min: 3,
    share: 1,
    lines: (n) => [
      'Somebody keeps writing songs about California.',
      `${n} songs about California. None of you have been.`,
      `${n} California songs. Book a flight or stop.`,
      `${n} tracks about a state nobody in this room lives in.`,
    ],
  },
  night: {
    min: 8,
    share: 5,
    lines: (n, s) => [
      `${n} songs about the night. Nobody here sleeps.`,
      `${s}% of this pool happens after midnight.`,
      `${n} songs set after midnight. Go to bed.`,
      `${n} songs about 3am. Somebody has a routine.`,
    ],
  },
  summer: {
    min: 6,
    share: 4,
    lines: (n, s) => [
      `${n} songs about summer. It's a personality now.`,
      `${s}% of this pool is sunshine. Insufferable.`,
      `${n} tracks about the beach. Nobody here owns a boat.`,
      `${n} summer songs. Look outside.`,
    ],
  },
  rain: {
    min: 4,
    share: 2,
    lines: (n) => [
      `${n} songs about rain. Dramatic.`,
      `${n} tracks about weather. Somebody stares out of windows.`,
      `${n} rain songs. Somebody scores their own bus rides.`,
      `${n} songs about weather. Pick a different subject.`,
    ],
  },
  fire: {
    min: 5,
    share: 3,
    lines: (n, s) => [
      `${n} songs about burning things. Calm down.`,
      `${s}% of this pool involves fire. Seek help.`,
      `${n} tracks about flames. Somebody has unresolved anger.`,
      `A lot of arson imagery for a party game.`,
    ],
  },
  dance: {
    min: 5,
    share: 3,
    lines: (n) => [
      `${n} songs telling you to dance. Nobody will.`,
      `${n} tracks about dancing, zero dancers in this room.`,
      `${n} songs about dancing. Everyone is sitting down.`,
      `Music for a party nobody here got invited to.`,
    ],
  },
  tears: {
    min: 5,
    share: 3,
    lines: (n, s) => [
      `${n} songs about crying. Somebody is not okay.`,
      `${s}% of this pool is tears. This is a support group.`,
      `${n} songs about crying. Who brought those, and why.`,
      `Emotional stability of this room: ${n} crying songs.`,
    ],
  },
  heartbreak: {
    min: 6,
    share: 4,
    lines: (n, s) => [
      `${n} songs about heartbreak. Somebody hasn't moved on.`,
      `${s}% of this pool is a breakup. Same breakup, probably.`,
      `${n} tracks about being hurt. Group therapy, but with drums.`,
      `${n} breakup songs. Somebody still checks an old profile.`,
    ],
  },
  baby: {
    min: 8,
    share: 5,
    lines: (n, s) => [
      `${n} titles say "baby". Vocabulary of a toddler.`,
      `${s}% of this pool calls somebody "baby". Grim.`,
      `${n} songs, and the best word any of them found was "baby".`,
      `${n} tracks, one word, zero imagination.`,
    ],
  },
  god: {
    min: 4,
    share: 2,
    lines: (n) => [
      `${n} songs about God. Bold choice for this crowd.`,
      `${n} songs mention God. Somebody is hedging.`,
      `${n} tracks mention heaven. None of you are going.`,
      `${n} religious songs, and then this crowd. Interesting.`,
    ],
  },
  drugs: {
    min: 5,
    share: 3,
    lines: (n, s) => [
      `${n} songs about being high. Consistent lifestyle.`,
      `${s}% of this pool is chemically assisted.`,
      `${n} tracks about drugs. This playlist is a confession.`,
      `This pool would not pass a workplace screening.`,
    ],
  },
  cars: {
    min: 6,
    share: 4,
    lines: (n, s) => [
      `${n} songs about driving. Somebody has a long commute.`,
      `${s}% of this pool is road music. You live in a city.`,
      `${n} tracks about cars. Nobody here has a licence.`,
      `Somebody made a playlist for a highway that isn't here.`,
    ],
  },
  war: {
    min: 4,
    share: 2,
    lines: (n) => [
      `${n} songs about fighting. Aggressive for a Tuesday.`,
      `${n} songs about fighting. Who is everyone so angry at?`,
      `${n} tracks about war. This is a music game.`,
      `${n} violent songs. Everyone here seems nice, though.`,
    ],
  },
  dreams: {
    min: 5,
    share: 3,
    lines: (n, s) => [
      `${n} songs about dreaming. Nobody here is awake.`,
      `${s}% of this pool is about sleep.`,
      `${n} tracks about dreams. Say less. Genuinely.`,
      `${n} songs about dreams. Nobody wants to hear about it.`,
    ],
  },
  alone: {
    min: 5,
    share: 3,
    lines: (n, s) => [
      `${n} songs about being alone. In a room full of people.`,
      `${s}% of this pool is loneliness. Awkward.`,
      `${n} songs about being alone. Everyone look at each other.`,
      `Isolation index for this room: ${n} tracks. High.`,
    ],
  },
  body: {
    min: 6,
    share: 4,
    lines: (n, s) => [
      `${n} songs about somebody's body. Charming.`,
      `${s}% of this pool is anatomy.`,
      `${n} tracks about lips, skin and eyes. Get a room.`,
      `${n} songs about bodies. Whose, exactly?`,
    ],
  },
  colours: {
    min: 8,
    share: 5,
    lines: (n, s) => [
      `${n} titles are just a colour. Effort: minimal.`,
      `${s}% of this pool names a colour. Poetic, allegedly.`,
      `${n} tracks named after paint.`,
      `Try a noun: ${n} of these titles are just a colour.`,
    ],
  },
  places: {
    min: 4,
    share: 2,
    lines: (n) => [
      `${n} songs about cities nobody here lives in.`,
      `Geographic name-dropping: ${n} tracks.`,
      `${n} tracks set somewhere more interesting than here.`,
      `Somebody is homesick for a place they've never been.`,
    ],
  },
  cussing: {
    min: 5,
    share: 3,
    lines: (n, s) => [
      `${n} titles swear at you before the song starts.`,
      `${s}% of these titles are unprintable.`,
      `${n} tracks that can't be read aloud at work.`,
      `${n} titles with a swear in them. Classy.`,
    ],
  },
  sorry: {
    min: 4,
    share: 2,
    lines: (n) => [
      `${n} songs apologising. Somebody did something.`,
      `${n} tracks about regret. Whatever it was, it was bad.`,
      `Apology count: ${n}. Forgiveness: pending.`,
      `Somebody built a playlist instead of sending a text.`,
    ],
  },
  runaway: {
    min: 8,
    share: 5,
    lines: (n, s) => [
      `${n} songs about leaving. Somebody has a plan.`,
      `${s}% of this pool is about getting out.`,
      `${n} tracks about running away. Nobody has moved.`,
      `${n} songs about leaving. The door is right there.`,
    ],
  },
  girls: {
    min: 10,
    share: 6,
    lines: (n, s) => [
      `${n} songs about a girl. Every single time.`,
      `${s}% of this pool is one man's problem with one woman.`,
      `${n} tracks, one subject. Songwriting is a narrow field.`,
      `Somebody should tell these artists women have other qualities.`,
    ],
  },
  questions: {
    min: 5,
    share: 3,
    lines: (n) => [
      `${n} titles are questions. Nobody is answering.`,
      `${n} tracks ask you something and none of them wait.`,
      `${n} titles end in a question mark. Commit to something.`,
      `${n} songs asking questions nobody wanted asked.`,
    ],
  },
  numbers: {
    min: 8,
    share: 5,
    lines: (n) => [
      `${n} titles contain a number. Fascinating.`,
      `${n} titles have a number in them.`,
      `${n} tracks that couldn't think of a word.`,
      `${n} titles couldn't manage without a digit.`,
    ],
  },
  collabs: {
    min: 10,
    share: 8,
    lines: (n, s) => [
      `${n} songs needed a second artist to work.`,
      `${s}% of this pool is a feature. Nobody can carry a track alone.`,
      `${n} collaborations. Confidence: low.`,
      `A lot of "feat." for a pool this small.`,
    ],
  },
  live: {
    min: 6,
    share: 4,
    lines: (n, s) => [
      `${n} tracks are a live or acoustic version. Why.`,
      `${s}% of this pool is somebody's worse take.`,
      `${n} alternate versions. The originals exist.`,
      `Somebody brought the acoustic one on purpose.`,
    ],
  },
  shouting: {
    min: 5,
    share: 3,
    lines: (n) => [
      `${n} titles are in all caps. Calm down.`,
      `${n} tracks are shouting before they start.`,
      `Caps lock incidents: ${n}.`,
      `${n} titles in all caps. We can read, thanks.`,
    ],
  },
  oneWord: {
    min: 15,
    share: 12,
    lines: (n, s) => [
      `${n} titles are a single word. Effort: none.`,
      `${s}% of this pool couldn't manage a second word.`,
      `Is ${n} one-word titles minimalism or laziness?`,
      `${n} one-word titles. Somebody ran out of ideas early.`,
    ],
  },
};

const THEME_KEYS = Object.keys(THEME_TESTS) as Theme[];

/** One concept's phrasings, or null when its numbers don't earn the line. */
function themeLine(key: Theme, { titles, poolSize }: Facts): string[] | null {
  if (poolSize === 0) return null;
  const n = titles[key];
  const s = Math.round((n / poolSize) * 100);
  const rule = THEME_LINES[key];
  return n >= rule.min && s >= rule.share ? rule.lines(n, s) : null;
}

// --- albums, read but never named ---------------------------------------

/**
 * Albums are a personality test, so the line describes the *listener* and never
 * the record. That is a joke requirement and a safety one at once: printing
 * "somebody brought Rumours" would narrow the secret to a tracklist, while
 * "owns a record player they never use" narrows nothing at all.
 *
 * Matching is on the normalised album name, so a Deluxe Edition or a
 * Remastered 2011 still lands on the same vibe. Missing from the list simply
 * means no line — the pool is enormous and this is decoration.
 */
type Vibe = keyof typeof VIBE_LINES;

const VIBE_LINES = {
  journal: [
    (n: string) => `${n} brought the album of a girl who cries in the car.`,
    (n: string) => `${n} brought an album for writing paragraphs nobody reads.`,
    (n: string) => `${n} brought the album they cried to. Recently.`,
    (n: string) => `${possessive(n)} taste is a diary with a chorus.`,
  ],
  deep: [
    (n: string) => `${n} thinks they're deep. ${n} is not deep.`,
    (n: string) => `${n} has explained an album to somebody against their will.`,
    (n: string) => `${n} calls it "a body of work" out loud, in public.`,
    (n: string) => `${n} brought an album with a concept. They'll tell you.`,
  ],
  vinyl: [
    (n: string) => `${n} owns a record player they have never once used.`,
    (n: string) => `${n} believes music died before they were born.`,
    (n: string) => `${n} has said "they don't make them like this anymore".`,
    (n: string) => `${possessive(n)} taste was inherited, not chosen.`,
  ],
  dorm: [
    (n: string) => `${possessive(n)} taste peaked in a dorm room and stayed there.`,
    (n: string) => `${n} still owns the band hoodie.`,
    (n: string) => `${n} found this album at fifteen and stopped looking.`,
    (n: string) => `${n} brought the album that got them through tenth grade.`,
  ],
  threeam: [
    (n: string) => `We all know what ${n} was going through that year.`,
    (n: string) => `${n} listens to this alone at 3am. On purpose.`,
    (n: string) => `${n} brought an album for staring at a ceiling.`,
    (n: string) => `${possessive(n)} songs are a quiet cry for help.`,
  ],
  villain: [
    (n: string) => `${n} thinks they're the villain. ${n} is not the villain.`,
    (n: string) => `${n} brought music for texting people who moved on.`,
    (n: string) => `${n} drives twelve minutes and calls it a night drive.`,
    (n: string) => `${n} brought villain music. ${n} is not a villain.`,
  ],
  basic: [
    (n: string) => `${n} brought the safest album ever pressed.`,
    (n: string) => `${possessive(n)} taste has never surprised a single person.`,
    (n: string) => `${n} likes exactly what they were told to like.`,
    (n: string) => `Nothing ${n} brought has ever offended anyone. Tragic.`,
  ],
  angst: [
    (n: string) => `${n} brought music from when they were angry. They still are.`,
    (n: string) => `${n} brought an album for slamming doors to.`,
    (n: string) => `${n} peaked emotionally at fifteen and filed it under taste.`,
    (n: string) => `${n} would like everyone to know they're not okay.`,
  ],
  decks: [
    (n: string) => `${n} thinks they could DJ.`,
    (n: string) => `${n} owns a controller. ${n} does not own a gig.`,
    (n: string) => `${n} says "the production on this" far too often.`,
    (n: string) => `${n} brought an album for people who discuss builds.`,
  ],
  artschool: [
    (n: string) => `${n} has ruined a dinner party with this album.`,
    (n: string) => `${n} will explain why this one matters. Uninvited.`,
    (n: string) => `${n} rates albums out of ten. Publicly.`,
    (n: string) => `${n} brought the album you're supposed to have heard.`,
  ],
};

const ALBUM_VIBES: Record<Vibe, string[]> = {
  journal: [
    '1989', 'folklore', 'evermore', 'lover', 'reputation', 'midnights', 'red', 'fearless',
    'speak now', 'the tortured poets department', 'sour', 'guts', 'punisher', 'the record',
    'stranger in the alps',
  ],
  deep: [
    'my beautiful dark twisted fantasy', 'the college dropout', 'late registration', 'graduation',
    'yeezus', 'donda', 'to pimp a butterfly', 'good kid, m.a.a.d city', 'damn.',
    'mr. morale & the big steppers', 'the miseducation of lauryn hill', 'illmatic',
  ],
  vinyl: [
    'the dark side of the moon', 'the wall', 'wish you were here', 'abbey road', 'revolver',
    "sgt. pepper's lonely hearts club band", 'a night at the opera', 'greatest hits', 'rumours',
    'back in black', 'thriller', 'led zeppelin iv', 'hotel california', 'born to run',
    'the joshua tree', 'bridge over troubled water',
  ],
  dorm: [
    'am', "whatever people say i am, that's what i'm not", 'favourite worst nightmare',
    'hybrid theory', 'meteora', 'blurryface', 'trench', 'californication', 'blood sugar sex magik',
    'enema of the state', 'american idiot', 'dookie', 'is this it',
  ],
  threeam: [
    'for emma, forever ago', 'carrie & lowell', 'blonde', 'channel orange', 'swimming', 'circles',
    'born to die', 'norman fucking rockwell!', 'ultraviolence', 'in the aeroplane over the sea',
    'sea change', 'a moon shaped pool',
  ],
  villain: [
    'after hours', 'starboy', 'dawn fm', 'beauty behind the madness', 'take care', 'views',
    'scorpion', "if you're reading this it's too late", 'astroworld', 'rodeo', 'nothing was the same',
  ],
  basic: [
    '21', '25', '30', 'thank u, next', 'positions', 'future nostalgia', 'fine line', "harry's house",
    'lemonade', 'renaissance', 'a rush of blood to the head', 'parachutes',
    'viva la vida or death and all his friends', 'x&y', 'divide', 'multiply', 'no. 6 collaborations project',
  ],
  angst: [
    'nevermind', 'in utero', 'toxicity', 'the marshall mathers lp', 'the eminem show',
    'the slim shady lp', 'iowa', 'rage against the machine', 'ten', 'master of puppets',
    'the black album', 'appetite for destruction',
  ],
  decks: [
    'random access memories', 'discovery', 'homework', 'currents', 'lonerism', 'innerspeaker',
    'cross', 'woman', 'settle', 'in colour', 'music for the jilted generation',
  ],
  artschool: [
    'ok computer', 'kid a', 'in rainbows', 'the bends', 'homogenic', 'vespertine',
    'selected ambient works 85-92', 'the velvet underground & nico', 'loveless',
    'yankee hotel foxtrot', 'the queen is dead', 'unknown pleasures',
  ],
};

const VIBE_BY_ALBUM = new Map<string, Vibe>();
for (const [vibe, albums] of Object.entries(ALBUM_VIBES) as [Vibe, string[]][]) {
  for (const album of albums) VIBE_BY_ALBUM.set(album, vibe);
}

/** Strips the edition/remaster tail and the punctuation that varies between releases. */
function normaliseAlbum(name: string): string {
  return name
    .toLowerCase()
    .replace(/\s*[([].*$/, '')
    .replace(/\s*-\s*(deluxe|remaster|remastered|expanded|anniversary|special|platinum|bonus).*$/, '')
    .trim();
}

// --- artists conspicuously absent ---------------------------------------

/**
 * A short list of artists whose *absence* is the joke. Gated on `MIN_POOL_FOR_ABSENCE`
 * because "no Justin Timberlake" is not an observation about a nine-song pool.
 * Aliases cover the Hebrew spellings and the ampersand, which Spotify writes
 * inconsistently across releases.
 */
const MIN_POOL_FOR_ABSENCE = 40;

const MISSING_ARTISTS: Record<string, string[]> = {
  omerAdam: ['omer adam', 'עומר אדם'],
  uziHitman: ['uzi hitman', 'uzi chitman', 'עוזי חיטמן'],
  simonGarfunkel: ['simon & garfunkel', 'simon and garfunkel'],
  timberlake: ['justin timberlake'],
};

const MISSING_LINES: Record<string, string[]> = {
  omerAdam: [
    'Not one Omer Adam song. Homie.',
    '0 songs by Omer Adam.',
    'Zero Omer Adam songs.',
  ],
  uziHitman: [
    'Not one Uzi Hitman song.',
    '0 songs by Uzi Hitman.',
    'Zero Uzi Hitman songs.',
  ],
  simonGarfunkel: [
    'Not one Simon & Garfunkel song.',
    '0 songs by Simon & Garfunkel.',
    'Zero Simon & Garfunkel songs.',
  ],
  timberlake: [
    'Not one Justin Timberlake song. Gotta try Post Malone.',
    '0 songs by Justin Timberlake.',
    'Zero Justin Timberlake songs. Someone bring the Sexy Back.',
  ],
};

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
  // Every credited name, not just the primary — an absence line has to be true.
  const everyArtist = new Set<string>();
  const years = new Map<number, number>();
  const decades = new Map<number, number>();
  const titles = Object.fromEntries(THEME_KEYS.map((key) => [key, 0])) as Record<Theme, number>;

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
    for (const artist of track.artists) everyArtist.add(artist.name.toLowerCase().trim());

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
    for (const key of THEME_KEYS) {
      if (THEME_TESTS[key](lower, track.title)) titles[key]++;
    }
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

  const dupes = [...idPlaylists.values()].filter((set) => set.size >= 2).length;

  return {
    players: byTrackCount,
    poolSize: unique.size,
    blame: players.length >= 2 ? scapegoats[0] ?? null : null,
    blame2: players.length >= 2 ? scapegoats[1] ?? null : null,
    dupes,
    dupeShare: unique.size >= MIN_POOL_FOR_SHARES ? Math.round((dupes / unique.size) * 100) : 0,
    // Raw counts lie in a lobby of 400 songs, so every "how much" is a share.
    topArtist:
      top && unique.size >= MIN_POOL_FOR_SHARES
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
    missingArtists:
      unique.size >= MIN_POOL_FOR_ABSENCE
        ? Object.keys(MISSING_ARTISTS).filter((key) =>
            MISSING_ARTISTS[key]!.every((alias) => !everyArtist.has(alias)),
          )
        : [],
    ...popularityFacts(popularity),
    decade: topShare(decades, unique.size),
    bigYear: bigYear(years, unique.size),
    titles,
    ...sizeFacts(byTrackCount),
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
 * Who brought too much and who brought too little, measured against the room
 * rather than against a number somebody typed once. `ratio` is the playlist
 * over the median playlist, which is what decides how hard the line is allowed
 * to go: 47 songs is only pathetic if everybody else brought 200.
 */
function sizeFacts(byTrackCount: Player[]) {
  if (byTrackCount.length < 2) return { slacker: null, hoarder: null };

  const counts = byTrackCount.map((p) => p.trackCount);
  const mid = median(counts);
  const small = byTrackCount[0]!;
  const big = byTrackCount[byTrackCount.length - 1]!;
  if (mid <= 0 || small.id === big.id) return { slacker: null, hoarder: null };

  const smallRatio = small.trackCount / mid;
  const bigRatio = big.trackCount / mid;

  return {
    // Genuinely tiny, or genuinely below the room. Otherwise nothing to say.
    slacker:
      small.trackCount <= 12 || smallRatio <= 0.7
        ? { name: small.name, count: small.trackCount, ratio: smallRatio }
        : null,
    hoarder: bigRatio >= 1.4 ? { name: big.name, count: big.trackCount, ratio: bigRatio } : null,
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

  // Every recognised album in the room, one entry per player who brought two or
  // more of its tracks — one track is a shuffle artefact, not a personality.
  // Drawn at random rather than by size, so a lobby that plays all evening gets
  // a different accusation each round.
  const vibed: { name: string; vibe: Vibe }[] = [];
  for (const { name, b } of rows) {
    for (const [album, count] of b.albums) {
      if (count < 2) continue;
      const vibe = VIBE_BY_ALBUM.get(normaliseAlbum(album));
      if (vibe) vibed.push({ name, vibe });
    }
  }

  return {
    obsessed: obsessed ? { player: obsessed.name, artist: obsessed.artist, share: obsessed.share } : null,
    narrow,
    albumDump,
    singles,
    impatient,
    eraSpread,
    popSpread,
    explicitPlayer,
    albumVibe: vibed.length > 0 ? pick(vibed) : null,
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
  if (total < MIN_POOL_FOR_SHARES) return null;
  const [top] = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  if (!top) return null;
  return { label: `${top[0]}s`, share: Math.round((top[1] / total) * 100) };
}

function bigYear(years: Map<number, number>, total: number) {
  if (total < MIN_POOL_FOR_SHARES) return null;
  const [top] = [...years.entries()].sort((a, b) => b[1] - a[1]);
  if (!top) return null;
  return { year: top[0], share: Math.round((top[1] / total) * 100) };
}

function mean(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/** Assumes `values` is already sorted ascending, which every caller here is. */
function median(values: number[]): number {
  if (values.length === 0) return 0;
  const mid = Math.floor(values.length / 2);
  return values.length % 2 === 0 ? (values[mid - 1]! + values[mid]!) / 2 : values[mid]!;
}

function clock(ms: number): string {
  const total = Math.round(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function possessive(name: string): string {
  return /s$/i.test(name) ? `${name}'` : `${name}'s`;
}

function pick<T>(items: T[]): T {
  return items[Math.floor(Math.random() * items.length)]!;
}

function shuffle<T>(items: T[]): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [items[i], items[j]] = [items[j]!, items[i]!];
  }
  return items;
}
