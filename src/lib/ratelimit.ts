import { RATELIMIT_TTL_SECONDS, keys, redis, today } from './redis';

export function gamesPerDay(): number {
  const configured = Number.parseInt(process.env.GAMES_PER_DAY ?? '', 10);
  return Number.isFinite(configured) && configured > 0 ? configured : 5;
}

export type RateLimitResult = { allowed: boolean; used: number; limit: number };

/**
 * Each round costs a few cents of Replicate GPU time, so a runaway loop is
 * the one way this project can get expensive. Counted per started round.
 * SPEC §2.3.
 */
export async function consumeGameCredit(): Promise<RateLimitResult> {
  const limit = gamesPerDay();
  const key = keys.ratelimit(today());

  const used = await redis().incr(key);
  if (used === 1) await redis().expire(key, RATELIMIT_TTL_SECONDS);

  if (used > limit) return { allowed: false, used: used - 1, limit };
  return { allowed: true, used, limit };
}

/** Rolls back a credit when the round failed before any GPU time was spent. */
export async function refundGameCredit(): Promise<void> {
  await redis().decr(keys.ratelimit(today()));
}

export async function creditsUsed(): Promise<number> {
  const value = await redis().get<number>(keys.ratelimit(today()));
  return typeof value === 'number' ? value : 0;
}
