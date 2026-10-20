import { beforeEach, describe, expect, it, vi } from "vitest";
import { helpAccess } from "@recx/shared";

/**
 * Active-time crediting (src/lib/help/activity.ts): the pure decision, and
 * the recorder against an in-memory fake db that implements the
 * compare-and-set the real one relies on. The headline property: whatever
 * a client claims, credited time never runs ahead of the wall clock, so a
 * forged client cannot unlock a hint tier early.
 */

const h = vi.hoisted(() => {
  type Row = { activeSeconds: number; lastPingAt: Date };
  const state = {
    published: new Set<string>(),
    activity: new Map<string, Row>(),
    days: new Map<string, number>(),
    /** Runs just before the compare-and-set (simulates a concurrent writer). */
    beforeUpdate: null as null | (() => void),
    sql: [] as string[],
  };
  const key = (userId: string, problemId: string) => `${userId}|${problemId}`;
  const db = {
    problem: {
      findFirst: vi.fn(async (args: { where: { id: string; status: string } }) =>
        state.published.has(args.where.id) && args.where.status === "PUBLISHED" ? { id: args.where.id } : null,
      ),
    },
    problemActivity: {
      findUnique: vi.fn(async (args: { where: { userId_problemId: { userId: string; problemId: string } } }) => {
        const { userId, problemId } = args.where.userId_problemId;
        const row = state.activity.get(key(userId, problemId));
        return row ? { ...row } : null;
      }),
      createMany: vi.fn(
        async (args: { data: { userId: string; problemId: string; activeSeconds: number; lastPingAt: Date }[]; skipDuplicates: boolean }) => {
          let count = 0;
          for (const d of args.data) {
            const k = key(d.userId, d.problemId);
            if (state.activity.has(k)) continue;
            state.activity.set(k, { activeSeconds: d.activeSeconds, lastPingAt: d.lastPingAt });
            count++;
          }
          return { count };
        },
      ),
      updateMany: vi.fn(
        async (args: {
          where: { userId: string; problemId: string; lastPingAt: Date };
          data: { activeSeconds: { increment: number }; lastPingAt: Date };
        }) => {
          state.beforeUpdate?.();
          const row = state.activity.get(key(args.where.userId, args.where.problemId));
          if (!row || row.lastPingAt.getTime() !== args.where.lastPingAt.getTime()) return { count: 0 };
          row.activeSeconds += args.data.activeSeconds.increment;
          row.lastPingAt = args.data.lastPingAt;
          return { count: 1 };
        },
      ),
    },
    $executeRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      state.sql.push(strings.join("?"));
      const [userId, day, credit, cap] = values as [string, string, number, number];
      const k = `${userId}|${day}`;
      state.days.set(k, Math.min((state.days.get(k) ?? 0) + credit, cap));
      return 1;
    }),
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(db)),
  };
  return { state, db };
});

vi.mock("@/lib/db", () => ({ db: h.db }));

const { decidePing, recordActivityPing } = await import("@/lib/help/activity");
const { ACTIVITY_POLICY, crossesUnlock } = await import("@/lib/help/activity-policy");

const USER = "user_1";
const PROBLEM = "prob_1";
const T0 = new Date("2026-10-10T10:00:00.000Z"); // 15:30 IST
const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000);
const ping = (seconds: number, now: Date, problemId = PROBLEM) =>
  recordActivityPing({ userId: USER, problemId, seconds, now });
const row = () => h.state.activity.get(`${USER}|${PROBLEM}`);

beforeEach(() => {
  vi.clearAllMocks();
  h.state.published = new Set([PROBLEM]);
  h.state.activity.clear();
  h.state.days.clear();
  h.state.beforeUpdate = null;
  h.state.sql = [];
});

describe("the policy", () => {
  it("is 30 s pings, one accepted per 20 s, at most 60 s each, idle after 60 s", () => {
    expect(ACTIVITY_POLICY).toMatchObject({
      pingIntervalMs: 30_000,
      minPingGapMs: 20_000,
      maxCreditSeconds: 60,
      idleAfterMs: 60_000,
      maxDaySeconds: 86_400,
    });
  });

  it("refreshes the panels when the total crosses 10, 25 or 45 minutes", () => {
    expect(crossesUnlock(599, 600)).toBe(true);
    expect(crossesUnlock(1_490, 1_520)).toBe(true);
    expect(crossesUnlock(2_699, 2_759)).toBe(true);
    expect(crossesUnlock(600, 630)).toBe(false);
    expect(crossesUnlock(0, 30)).toBe(false);
  });
});

describe("decidePing", () => {
  const last = T0;
  it.each([
    // [claimed, seconds since last accepted ping, credited]
    [30, 30, 30],
    [30, 25, 25], // never more than the wall clock
    [3_600, 45, 45],
    [3_600, 600, 60], // never more than 60 per ping
    [0, 30, 0],
    [12, 3_600, 12], // after a long idle the claim is the bound
  ])("claim %i s after %i s → credits %i", (claimed, elapsed, credit) => {
    expect(decidePing({ claimedSeconds: claimed, lastPingAt: last, now: at(elapsed) })).toEqual({ accepted: true, credit });
  });

  it("refuses a ping within 20 s of the last accepted one", () => {
    expect(decidePing({ claimedSeconds: 30, lastPingAt: last, now: at(19.999) })).toEqual({ accepted: false, retryAfterMs: 1 });
    expect(decidePing({ claimedSeconds: 30, lastPingAt: last, now: at(5) })).toEqual({ accepted: false, retryAfterMs: 15_000 });
    expect(decidePing({ claimedSeconds: 30, lastPingAt: last, now: at(20) }).accepted).toBe(true);
  });

  it("refuses when the clock runs backwards (another instance's skew) and floors fractions", () => {
    expect(decidePing({ claimedSeconds: 30, lastPingAt: last, now: at(-3) })).toEqual({ accepted: false, retryAfterMs: 20_000 });
    expect(decidePing({ claimedSeconds: 29.9, lastPingAt: last, now: at(40.7) })).toEqual({ accepted: true, credit: 29 });
    expect(decidePing({ claimedSeconds: Number.NaN, lastPingAt: last, now: at(40) })).toEqual({ accepted: true, credit: 0 });
  });
});

describe("recordActivityPing", () => {
  it("first ping starts the clock and credits nothing — even a large claim", async () => {
    expect(await ping(3_600, T0)).toEqual({ status: "accepted", credited: 0, activeSeconds: 0 });
    expect(row()).toEqual({ activeSeconds: 0, lastPingAt: T0 });
    expect(h.db.$executeRaw).not.toHaveBeenCalled();
  });

  it("refuses an unknown or unpublished problem and creates nothing", async () => {
    expect(await ping(0, T0, "prob_draft")).toEqual({ status: "not-found" });
    expect(h.state.activity.size).toBe(0);
  });

  it("credits min(claim, wall clock, 60) and adds it to today's ActivityDay", async () => {
    await ping(0, T0);
    expect(await ping(30, at(30))).toEqual({ status: "accepted", credited: 30, activeSeconds: 30 });
    expect(await ping(3_600, at(75))).toEqual({ status: "accepted", credited: 45, activeSeconds: 75 });
    expect(await ping(3_600, at(1_000))).toEqual({ status: "accepted", credited: 60, activeSeconds: 135 });
    expect(h.state.days.get(`${USER}|2026-10-10`)).toBe(135);
    expect(h.state.sql[0]).toMatch(/INSERT INTO "ActivityDay"[\s\S]*ON CONFLICT[\s\S]*LEAST/);
  });

  it("rate-limits within 20 s of the last accepted ping, without crediting or moving the clock", async () => {
    await ping(0, T0);
    expect(await ping(30, at(10))).toEqual({ status: "rate-limited", retryAfterMs: 10_000 });
    expect(row()).toEqual({ activeSeconds: 0, lastPingAt: T0 });
    // The refused ping did not reset the clock: 30 s after T0 is accepted.
    expect(await ping(30, at(30))).toMatchObject({ status: "accepted", credited: 30 });
  });

  it("a zero-second ping moves the clock but writes no ActivityDay", async () => {
    await ping(0, T0);
    expect(await ping(0, at(40))).toEqual({ status: "accepted", credited: 0, activeSeconds: 0 });
    expect(row()?.lastPingAt).toEqual(at(40));
    expect(h.db.$executeRaw).not.toHaveBeenCalled();
  });

  it("loses the compare-and-set to a concurrent ping: nothing is credited twice", async () => {
    await ping(0, T0);
    h.state.beforeUpdate = () => {
      const r = row();
      if (r) Object.assign(r, { activeSeconds: r.activeSeconds + 30, lastPingAt: at(30) });
      h.state.beforeUpdate = null;
    };
    expect(await ping(30, at(30))).toEqual({ status: "rate-limited", retryAfterMs: 20_000 });
    expect(row()?.activeSeconds).toBe(30); // only the other ping's credit
    expect(h.db.$executeRaw).not.toHaveBeenCalled();
  });

  it("books the credit to the Asia/Kolkata day of the ping", async () => {
    const nearMidnight = new Date("2026-10-10T18:29:00.000Z"); // 23:59 IST
    await ping(0, nearMidnight);
    await ping(60, new Date("2026-10-10T18:30:30.000Z")); // 00:00:30 IST on the 11th
    expect(h.state.days.get(`${USER}|2026-10-11`)).toBe(60);
    expect(h.state.days.has(`${USER}|2026-10-10`)).toBe(false);
  });

  it("caps a day at 24 hours however many problems are pinged", async () => {
    const problems = Array.from({ length: 30 }, (_, i) => `prob_${i}`);
    for (const p of problems) h.state.published.add(p);
    for (const p of problems) await recordActivityPing({ userId: USER, problemId: p, seconds: 0, now: T0 });
    for (let t = 60; t <= 3_600; t += 60) {
      for (const p of problems) await recordActivityPing({ userId: USER, problemId: p, seconds: 60, now: at(t) });
    }
    expect(h.state.days.get(`${USER}|2026-10-10`)).toBe(ACTIVITY_POLICY.maxDaySeconds);
  });
});

describe("a forged client cannot get ahead of the wall clock", () => {
  it.each([
    ["claims an hour every 20 s", 20, 3_600],
    ["claims an hour every second", 1, 3_600],
    ["claims 60 s every 21 s", 21, 60],
  ])("%s: hint 2 never unlocks before 10 real minutes", async (_label, every, claim) => {
    await ping(0, T0);
    for (let t = every; t <= 15 * 60; t += every) {
      await ping(claim, at(t));
      const credited = row()?.activeSeconds ?? 0;
      expect(credited).toBeLessThanOrEqual(t);
      const access = helpAccess({
        context: "PRACTICE",
        attempts: 0,
        failedAttempts: 0,
        activeSeconds: credited,
        solved: false,
        editorialVisibleAt: null,
        now: at(t),
      });
      if (t < 10 * 60) expect(access.maxHintTier).toBe(1);
      if (t < 25 * 60) expect(access.maxHintTier).toBeLessThan(3);
    }
  });

  it("an honest client pinging every 30 s is credited all of its active time", async () => {
    await ping(0, T0);
    for (let t = 30; t <= 10 * 60; t += 30) await ping(30, at(t));
    expect(row()?.activeSeconds).toBe(600);
  });
});
