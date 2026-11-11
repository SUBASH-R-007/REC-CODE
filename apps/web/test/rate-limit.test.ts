import { randomUUID } from "node:crypto";
import { Redis } from "ioredis";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  hitRateLimit,
  LOGIN_RATE_LIMITS,
  parseDecision,
  releaseRateLimit,
  resetRateLimit,
  SLIDING_WINDOW_SCRIPT,
} from "@/lib/rate-limit";

/** A live Redis when one is reachable (dev box, CI service); otherwise those tests skip. */
async function connectRedis(): Promise<Redis | null> {
  const client = new Redis(process.env.REDIS_URL ?? "redis://127.0.0.1:6379", {
    lazyConnect: true,
    connectTimeout: 500,
    maxRetriesPerRequest: 0,
    retryStrategy: () => null,
  });
  client.on("error", () => undefined);
  try {
    await client.connect();
    await client.ping();
    return client;
  } catch {
    client.disconnect();
    return null;
  }
}

const liveRedis = await connectRedis();
afterAll(() => liveRedis?.disconnect());

const MIN = 60_000;
const rule = { limit: 5, windowMs: 15 * MIN };

describe("login budgets", () => {
  it("are 5 per account and 20 per IP hash, per 15 minutes", () => {
    expect(LOGIN_RATE_LIMITS.account).toEqual({ limit: 5, windowMs: 15 * MIN });
    expect(LOGIN_RATE_LIMITS.ip).toEqual({ limit: 20, windowMs: 15 * MIN });
  });
});

describe("sliding-window script", () => {
  it("decides on Redis's own clock and never adds a refused attempt", () => {
    // Local clocks cannot order concurrent attempts; only TIME inside the script can.
    expect(SLIDING_WINDOW_SCRIPT).toContain("redis.call('TIME')");
    const addAt = SLIDING_WINDOW_SCRIPT.indexOf("ZADD");
    const limitCheckAt = SLIDING_WINDOW_SCRIPT.indexOf("if count < limit then");
    expect(limitCheckAt).toBeGreaterThan(0);
    expect(addAt).toBeGreaterThan(limitCheckAt);
  });

  it("parses the script reply", () => {
    expect(parseDecision([1, 4, 0])).toEqual({ allowed: true, remaining: 4, retryAfterMs: 0 });
    expect(parseDecision([0, 0, 61_000])).toEqual({ allowed: false, remaining: 0, retryAfterMs: 61_000 });
  });

  it("rejects a malformed reply (the caller then fails open)", () => {
    for (const bad of [null, "OK", [1, 2], [1, "4", 0], [1, 2, 3, 4]]) {
      expect(() => parseDecision(bad)).toThrow();
    }
  });
});

describe("hitRateLimit", () => {
  it("fails open (and warns) when Redis is unavailable", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const down = { status: "reconnecting" } as unknown as Redis;
    const hit = await hitRateLimit("login:acct:user-1", rule, down);
    expect(hit).toMatchObject({ allowed: true, failedOpen: true });
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it("fails open when the script errors", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const broken = {
      status: "ready",
      eval: async () => {
        throw new Error("Connection is closed.");
      },
    } as unknown as Redis;
    expect(await hitRateLimit("login:ip:abc", rule, broken)).toMatchObject({ allowed: true, failedOpen: true });
    warn.mockRestore();
  });
});

describe.runIf(liveRedis)("hitRateLimit against Redis", () => {
  const redis = liveRedis!;
  const small = { limit: 3, windowMs: 60_000 };

  it("allows `limit` attempts, refuses the next, and does not count refusals", async () => {
    const name = `test:${randomUUID()}`;
    const results = [];
    for (let i = 0; i < 5; i++) results.push(await hitRateLimit(name, small, redis));
    expect(results.map((r) => r.allowed)).toEqual([true, true, true, false, false]);
    expect(results.every((r) => !r.failedOpen)).toBe(true);
    expect(results[3]!.retryAfterMs).toBeGreaterThan(0);
    expect(await redis.zcard(`recx:rl:${name}`)).toBe(3);
    expect(await redis.pttl(`recx:rl:${name}`)).toBeGreaterThan(0);
    await resetRateLimit(name, redis);
    expect(await redis.exists(`recx:rl:${name}`)).toBe(0);
  });

  it("admits exactly `limit` of a concurrent burst, every time", async () => {
    // Repeated: the old client-clock implementation passed most single runs.
    for (let round = 0; round < 25; round++) {
      const name = `test:${randomUUID()}`;
      const burst = await Promise.all(Array.from({ length: 10 }, () => hitRateLimit(name, small, redis)));
      expect(burst.filter((r) => r.allowed)).toHaveLength(3);
      expect(await redis.zcard(`recx:rl:${name}`)).toBe(3);
      await resetRateLimit(name, redis);
    }
  });

  it("releasing an attempt gives its slot back", async () => {
    const name = `test:${randomUUID()}`;
    const hits = [];
    for (let i = 0; i < 3; i++) hits.push(await hitRateLimit(name, small, redis));
    expect((await hitRateLimit(name, small, redis)).allowed).toBe(false);
    await releaseRateLimit(hits[0]!, redis);
    expect((await hitRateLimit(name, small, redis)).allowed).toBe(true);
    await resetRateLimit(name, redis);
  });
});
