import { mockEnabled } from './mock';
import {
  RATELIMIT_TTL_SECONDS,
  RUSH_START_COOLDOWN_SECONDS,
  keys,
  redis,
  today,
} from './redis';

export function gamesPerDay(): number {
  const configured = Number.parseInt(process.env.GAMES_PER_DAY ?? '', 10);
  if (Number.isFinite(configured) && configured > 0) return configured;
  // The default exists to bound a GPU bill, and mock mode has no GPU behind
  // it — ten rounds is about twenty minutes of testing before the app starts
  // refusing to play. An explicit GAMES_PER_DAY still wins, which is how the
  // limit screen itself gets tested (set it to 1).
  return mockEnabled() ? 1000 : 10;
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

/**
 * Rush's own daily budget, deliberately separate from `gamesPerDay`. A Rush
 * game spends no GPU time — the classic cap exists to bound a Replicate bill
 * and would be far too tight here — but it is not free either: every song
 * dealt is an iTunes lookup plus an undocumented YouTube Music search, and the
 * thing worth protecting is the deployment's standing with those endpoints
 * rather than a spend. So the number is set where no honest evening of play
 * reaches it and a runaway script does.
 */
export function rushGamesPerDay(): number {
  const configured = Number.parseInt(process.env.RUSH_GAMES_PER_DAY ?? '', 10);
  if (Number.isFinite(configured) && configured > 0) return configured;
  // Same reasoning as `gamesPerDay`: offline there are no endpoints whose
  // goodwill this is protecting.
  return mockEnabled() ? 1000 : 50;
}

/** Counted per started run, the same shape as `consumeGameCredit`. */
export async function consumeRushCredit(): Promise<RateLimitResult> {
  const limit = rushGamesPerDay();
  const key = keys.rushRatelimit(today());

  const used = await redis().incr(key);
  if (used === 1) await redis().expire(key, RATELIMIT_TTL_SECONDS);

  if (used > limit) return { allowed: false, used: used - 1, limit };
  return { allowed: true, used, limit };
}

/** Rolls back a credit when the run never got a first song on air. */
export async function refundRushCredit(): Promise<void> {
  await redis().decr(keys.rushRatelimit(today()));
}

/**
 * The per-lobby start throttle: true when this lobby may start a run now,
 * false when it started one moments ago.
 *
 * A daily counter alone doesn't stop the shape of abuse that matters here — a
 * loop of start-and-abandon never finishes a game but does hold a stream of
 * outbound lookups open, and it would burn the day's budget for every other
 * lobby on the way. This is the NX-set idiom used for the prefetch lock: the
 * first caller creates the key and wins, everyone else inside the window sees
 * it already there. It expires on its own, so nothing releases it and an
 * abandoned run can still be restarted a few seconds later.
 */
export async function claimRushStart(code: string): Promise<boolean> {
  const set = await redis().set(keys.rushStartLock(code), 1, {
    nx: true,
    ex: RUSH_START_COOLDOWN_SECONDS,
  });
  return set === 'OK';
}
