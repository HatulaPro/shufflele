import { Redis } from '@upstash/redis';

let client: Redis | null = null;

/**
 * Lazily constructed so that importing a route module during `next build`
 * doesn't require the env vars to be present.
 */
export function redis(): Redis {
  if (!client) {
    const url = process.env.UPSTASH_REDIS_REST_URL;
    const token = process.env.UPSTASH_REDIS_REST_TOKEN;
    if (!url || !token) {
      throw new Error(
        'Missing UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN. Copy .env.example to .env.local.',
      );
    }
    client = new Redis({ url, token });
  }
  return client;
}

/** Everything expires, so there is no cleanup job. SPEC §2.2. */
export const LOBBY_TTL_SECONDS = 6 * 60 * 60;
export const RATELIMIT_TTL_SECONDS = 48 * 60 * 60;

/**
 * Short, deliberately: people edit their playlists, and a stale tracklist means
 * a guest sees songs they just removed. The cache exists to absorb the common
 * burst — several lobbies (or re-joins) reading the same playlist within
 * minutes — and to spare a 500-song playlist its five API calls each time.
 */
export const PLAYLIST_TTL_SECONDS = 10 * 60;

/**
 * Retired early by this much, so a token can't expire between two pages of one
 * ingest. Applied both to the cache TTL and to the expiry we record inside it.
 */
export const TOKEN_SLACK_SECONDS = 120;

/**
 * A track's YouTube art-track id (lib/ytmusic.ts). Long, because the answer is
 * a fact about the catalogue rather than about a lobby: the master recording
 * for a Spotify id does not change, and every cached row is one undocumented
 * request Rush doesn't have to make mid-run.
 */
export const YT_VIDEO_TTL_SECONDS = 30 * 24 * 60 * 60;

/**
 * Misses expire far sooner. A track with no art track is usually a permanent
 * fact too, but this also absorbs the transient case — a bot-checked lookup, a
 * timeout — and those must not be remembered for a month.
 */
export const YT_VIDEO_MISS_TTL_SECONDS = 12 * 60 * 60;

/**
 * How long one lobby must wait between Rush starts. Long enough that a script
 * POSTing `/rush/start` in a loop can't hold the outbound lookups open, short
 * enough that a host restarting a run after a bad first song never feels it.
 */
export const RUSH_START_COOLDOWN_SECONDS = 5;

export const keys = {
  lobby: (code: string) => `lobby:${code}`,
  tracks: (code: string) => `lobby:${code}:tracks`,
  round: (code: string, n: number) => `lobby:${code}:round:${n}`,
  /** NX guard so one round slot never buys two separations. See lib/prefetch.ts. */
  prefetchLock: (code: string, n: number) => `lobby:${code}:round:${n}:prefetch`,
  ratelimit: (day: string) => `ratelimit:games:${day}`,
  /** Rush's own daily counter — no GPU behind it, so a separate, larger budget. */
  rushRatelimit: (day: string) => `ratelimit:rush:${day}`,
  /** NX guard so a restart loop can't deal boards faster than a person plays. */
  rushStartLock: (code: string) => `lobby:${code}:rush:start`,
  playlist: (playlistId: string) => `cache:playlist:${playlistId}`,
  /** Spotify id to YouTube art-track id, for Rush's from-the-top playback. */
  ytVideo: (spotifyId: string) => `cache:yt:${spotifyId}`,
  /** Shared across instances so one token serves the whole deployment. */
  spotifyToken: () => 'cache:spotify:token',
};

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}
