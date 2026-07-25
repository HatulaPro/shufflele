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
 * A track's popularity moves on the scale of months, and the Deezer pass is the
 * slowest part of starting a first round — so cache hits generously. A track
 * Deezer couldn't match is remembered too, but briefly, in case the miss was a
 * quota refusal rather than a real absence.
 */
export const POPULARITY_TTL_SECONDS = 30 * 24 * 60 * 60;
export const POPULARITY_MISS_TTL_SECONDS = 24 * 60 * 60;

/**
 * Short, deliberately: people edit their playlists, and a stale tracklist means
 * a guest sees songs they just removed. The cache exists to absorb the common
 * burst — several lobbies (or re-joins) reading the same playlist within
 * minutes — and to keep our hits on the undocumented embed page down.
 */
export const PLAYLIST_TTL_SECONDS = 10 * 60;

export const keys = {
  lobby: (code: string) => `lobby:${code}`,
  tracks: (code: string) => `lobby:${code}:tracks`,
  round: (code: string, n: number) => `lobby:${code}:round:${n}`,
  ratelimit: (day: string) => `ratelimit:games:${day}`,
  popularity: (spotifyId: string) => `cache:pop:${spotifyId}`,
  playlist: (playlistId: string) => `cache:playlist:${playlistId}`,
};

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}
