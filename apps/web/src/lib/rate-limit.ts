import "server-only";
import { randomUUID } from "node:crypto";
import type { Redis } from "ioredis";
import { redis } from "@/lib/redis";

/**
 * Redis sliding-window rate limiter (one ZSET per key: member = attempt id,
 * score = attempt time in ms). Shared by every web instance, unlike the
 * LMS's per-process limiter.
 *
 * Redis is transport, not truth: if it is unreachable the limiter FAILS OPEN
 * with a logged warning. Refusing every sign-in during a Redis outage would
 * turn a cache failure into a full outage; the per-account Argon2id cost
 * still bounds guessing speed while it lasts.
 */

export interface RateLimitRule {
  limit: number;
  windowMs: number;
}

const FIFTEEN_MINUTES = 15 * 60_000;

/** Sign-in budgets: attempts per account and per hashed client IP. */
export const LOGIN_RATE_LIMITS = {
  account: { limit: 5, windowMs: FIFTEEN_MINUTES },
  ip: { limit: 20, windowMs: FIFTEEN_MINUTES },
} as const satisfies Record<string, RateLimitRule>;

/**
 * Asking for a password-reset link: per account (the hashed identifier,
 * whether or not it matched) and per hashed client address.
 *
 * Tighter than sign-in on purpose. A sign-in attempt costs the asker an
 * Argon2id verification and tells them nothing; a reset request sends mail
 * to somebody else's inbox, so the thing to bound is not guessing but the
 * ability to fill a mailbox — or to use ours to send it. Three an hour is
 * generous for forgetting a password and useless as a flood.
 */
export const PASSWORD_RESET_RATE_LIMITS = {
  identifier: { limit: 3, windowMs: 60 * 60_000 },
  ip: { limit: 10, windowMs: 60 * 60_000 },
} as const satisfies Record<string, RateLimitRule>;

/**
 * Spending a link: per hashed client address only, because the link itself
 * is the secret and a wrong one is cheap to answer. This bounds walking
 * tokens, which 256 bits already makes hopeless; it is here so that trying
 * is also slow.
 */
export const PASSWORD_RESET_ATTEMPT_LIMIT = { limit: 20, windowMs: 60 * 60_000 } as const satisfies RateLimitRule;

/**
 * Field vitals (Phase 10d): per hashed client address.
 *
 * 120 a minute is a generous page-load rate for one browser — a student
 * clicking through the problem list fast samples one in four of those — and
 * a useless write rate for anybody who found the endpoint and wanted to fill
 * Redis with it.
 */
export const VITALS_RATE_LIMIT = { limit: 120, windowMs: 60_000 } as const satisfies RateLimitRule;

export interface RateLimitDecision {
  allowed: boolean;
  /** Budget left after this attempt (0 when refused). */
  remaining: number;
  /** When refused: how long until a slot frees up. */
  retryAfterMs: number;
}

/**
 * The whole decision runs atomically inside Redis, on Redis's own clock:
 * drop expired entries, count the live ones, and add this attempt only if
 * it fits. Timestamps taken in the web process cannot be used — two
 * concurrent attempts can reach Redis in the opposite order to their local
 * clock readings, and both would then see themselves "first" and be
 * admitted (observed: a 10-request burst against a limit of 3 admitted 4).
 * A refused attempt is never added, so refusals never extend a lockout.
 *
 * Returns [allowed (0|1), remaining, retryAfterMs].
 */
export const SLIDING_WINDOW_SCRIPT = `
local key = KEYS[1]
local window = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
local member = ARGV[3]
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
redis.call('ZREMRANGEBYSCORE', key, '-inf', now - window)
local count = redis.call('ZCARD', key)
if count < limit then
  redis.call('ZADD', key, now, member)
  redis.call('PEXPIRE', key, window)
  return {1, limit - count - 1, 0}
end
local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
local retry = window
if oldest[2] then retry = math.max(0, tonumber(oldest[2]) + window - now) end
return {0, 0, retry}
`;

/** Validate the script's reply. Throws on anything unexpected (the caller fails open). */
export function parseDecision(reply: unknown): RateLimitDecision {
  if (!Array.isArray(reply) || reply.length !== 3 || !reply.every((n) => typeof n === "number")) {
    throw new Error("unexpected rate-limit script reply");
  }
  const [allowed, remaining, retryAfterMs] = reply as [number, number, number];
  return { allowed: allowed === 1, remaining, retryAfterMs };
}

export interface RateLimitHit extends RateLimitDecision {
  key: string;
  /** This attempt's ZSET member, for releaseRateLimit(). */
  member: string;
  /** True when Redis was unavailable and the attempt was let through unchecked. */
  failedOpen: boolean;
}

const KEY_PREFIX = "recx:rl:";

/** Wait briefly for the very first connection; never wait on a reconnect. */
async function whenReady(client: Redis, timeoutMs: number): Promise<void> {
  if (client.status === "ready") return;
  if (client.status !== "connecting" && client.status !== "connect" && client.status !== "wait") {
    throw new Error(`redis is ${client.status}`);
  }
  await new Promise<void>((resolve, reject) => {
    const onReady = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      client.off("ready", onReady);
      reject(new Error("redis not ready"));
    }, timeoutMs);
    client.once("ready", onReady);
  });
}

/**
 * Record one attempt against `name` and decide whether it may proceed.
 * Refused attempts are not counted. Never throws.
 */
export async function hitRateLimit(name: string, rule: RateLimitRule, client?: Redis): Promise<RateLimitHit> {
  const key = KEY_PREFIX + name;
  const member = randomUUID();
  try {
    const conn = client ?? redis();
    await whenReady(conn, 500);
    const decision = parseDecision(
      await conn.eval(SLIDING_WINDOW_SCRIPT, 1, key, String(rule.windowMs), String(rule.limit), member),
    );
    return { ...decision, key, member, failedOpen: false };
  } catch (error) {
    console.warn(
      `[rate-limit] Redis unavailable — failing open for ${name.split(":").slice(0, 2).join(":")}:`,
      error instanceof Error ? error.message : error,
    );
    return { allowed: true, remaining: rule.limit, retryAfterMs: 0, key, member, failedOpen: true };
  }
}

/** Un-count one attempt (e.g. a successful sign-in should not spend budget). */
export async function releaseRateLimit(hit: RateLimitHit, client?: Redis): Promise<void> {
  if (hit.failedOpen) return;
  try {
    await (client ?? redis()).zrem(hit.key, hit.member);
  } catch {
    // Best effort: the entry expires with the window anyway.
  }
}

/** Clear a key entirely (e.g. reset an account's failures after a success). */
export async function resetRateLimit(name: string, client?: Redis): Promise<void> {
  try {
    await (client ?? redis()).del(KEY_PREFIX + name);
  } catch {
    // Best effort, as above.
  }
}
