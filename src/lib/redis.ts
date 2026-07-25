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

export const keys = {
  lobby: (code: string) => `lobby:${code}`,
  tracks: (code: string) => `lobby:${code}:tracks`,
  round: (code: string, n: number) => `lobby:${code}:round:${n}`,
  spotifyToken: () => 'spotify:token',
  ratelimit: (day: string) => `ratelimit:games:${day}`,
};

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}
