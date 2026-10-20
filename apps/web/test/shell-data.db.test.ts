import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { User } from "@recx/db";
import { isoWeekKey } from "@recx/shared";

/**
 * The shell's data paths against a real Postgres (recx_test):
 *   - /api/search: signed-in only, PUBLISHED only, the pg_trgm index path,
 *     LIKE wildcards matched literally, the viewer's own solve state only;
 *   - notification actions: only the caller's own rows change;
 *   - getDashboard: a brand-new student gets empty states, an active one
 *     gets the right Continue card, weekly goal and streak.
 *
 * Opt-in: RECX_DB_TESTS=1 (RECX_TEST_DATABASE_URL overrides the URL; it must
 * name a *_test database). Session, cache and rate limiter are faked.
 */
const ENABLED = process.env.RECX_DB_TESTS === "1";
const TEST_URL = process.env.RECX_TEST_DATABASE_URL ?? "postgresql://recx:recx-dev-only@127.0.0.1:5433/recx_test";

const state = vi.hoisted(() => {
  if (process.env.RECX_DB_TESTS === "1") {
    process.env.DATABASE_URL =
      process.env.RECX_TEST_DATABASE_URL ?? "postgresql://recx:recx-dev-only@127.0.0.1:5433/recx_test";
  }
  return { user: null as unknown };
});

vi.mock("@/lib/auth/session", () => ({ getCurrentUser: async () => state.user }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined, revalidateTag: () => undefined }));
vi.mock("@/lib/rate-limit", () => ({
  hitRateLimit: async () => ({ allowed: true, remaining: 1, retryAfterMs: 0, key: "k", member: "m", failedOpen: true }),
}));

type Modules = {
  db: (typeof import("@/lib/db"))["db"];
  search: typeof import("@/app/api/search/route");
  notifications: typeof import("@/server/actions/notifications");
  dashboard: typeof import("@/server/queries/dashboard");
};

describe.skipIf(!ENABLED)("shell data paths against recx_test", () => {
  const tag = `shell-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
  // A distinctive, searchable word that no other fixture uses.
  const word = `Quokka${randomBytes(3).toString("hex")}`;
  let m: Modules;
  let alice: User;
  let bob: User;
  const problemIds: string[] = [];
  let attemptedId = "";

  const as = (user: User | null) => {
    state.user = user;
  };

  async function search(q: string): Promise<{ status: number; body: { results?: Array<Record<string, unknown>> } }> {
    const response = await m.search.GET(new Request(`http://localhost/api/search?q=${encodeURIComponent(q)}`));
    return { status: response.status, body: (await response.json()) as { results?: Array<Record<string, unknown>> } };
  }

  async function problem(suffix: string, title: string, published: boolean, difficulty: "EASY" | "MEDIUM" | "HARD" = "EASY") {
    const row = await m.db.problem.create({
      data: {
        slug: `${tag}-${suffix}`.toLowerCase(),
        displayCode: `${tag}-${suffix}`,
        title,
        difficulty,
        status: published ? "PUBLISHED" : "DRAFT",
      },
      select: { id: true },
    });
    problemIds.push(row.id);
    if (published) {
      const version = await m.db.problemVersion.create({
        data: { problemId: row.id, revision: 1, title, difficulty, statementMd: "Test.", ioMode: "STDIN", timeLimitMs: 1000 },
        select: { id: true },
      });
      await m.db.problem.update({ where: { id: row.id }, data: { liveVersionId: version.id } });
    }
    return row.id;
  }

  beforeAll(async () => {
    if (!new URL(TEST_URL).pathname.endsWith("_test")) {
      throw new Error(`Refusing to run against a non-test database: ${new URL(TEST_URL).pathname}`);
    }
    const [dbModule, search, notifications, dashboard] = await Promise.all([
      import("@/lib/db"),
      import("@/app/api/search/route"),
      import("@/server/actions/notifications"),
      import("@/server/queries/dashboard"),
    ]);
    m = { db: dbModule.db, search, notifications, dashboard };

    const mkUser = (suffix: string, firstName: string) =>
      m.db.user.create({
        data: {
          collegeId: `${tag}-${suffix}`,
          email: `${tag}-${suffix}@rec-code.example`,
          handle: `${tag}-${suffix}`,
          firstName,
          lastName: "Tester",
        },
      });
    alice = await mkUser("a", "Alice");
    bob = await mkUser("b", "Bob");

    attemptedId = await problem("p1", `${word} Pairs`, true, "MEDIUM");
    await problem("p2", `Counting ${word}s`, true, "EASY");
    await problem("p3", `${word} Draft`, false);
    await problem("p4", "100% Literal_Title", true, "HARD");
  }, 60_000);

  afterAll(async () => {
    if (!m) return;
    try {
      const users = [alice.id, bob.id];
      await m.db.notification.deleteMany({ where: { userId: { in: users } } });
      await m.db.userProblemStatus.deleteMany({ where: { userId: { in: users } } });
      await m.db.activityDay.deleteMany({ where: { userId: { in: users } } });
      await m.db.xpBucket.deleteMany({ where: { userId: { in: users } } });
      await m.db.userStats.deleteMany({ where: { userId: { in: users } } });
      await m.db.problem.updateMany({ where: { id: { in: problemIds } }, data: { liveVersionId: null } });
      await m.db.problemVersion.deleteMany({ where: { problemId: { in: problemIds } } });
      await m.db.problem.deleteMany({ where: { id: { in: problemIds } } });
      await m.db.user.deleteMany({ where: { id: { in: users } } });
    } finally {
      await m.db.$disconnect();
    }
  }, 60_000);

  describe("/api/search", () => {
    it("is for signed-in users only", async () => {
      as(null);
      expect((await search(word)).status).toBe(401);
    });

    it("returns published titles only, ranked by prefix, with no-store caching", async () => {
      as(alice);
      const response = await m.search.GET(new Request(`http://localhost/api/search?q=${word}`));
      expect(response.headers.get("cache-control")).toContain("no-store");
      const body = (await response.json()) as { results: Array<{ title: string; slug: string }> };
      expect(body.results.map((r) => r.title)).toEqual([`${word} Pairs`, `Counting ${word}s`]);
      expect(body.results.length).toBeLessThanOrEqual(8);
    });

    it("tolerates a typo through trigram similarity", async () => {
      as(alice);
      const typo = `${word.slice(0, -1)} Pairz`;
      const { body } = await search(typo);
      expect(body.results?.some((r) => r.title === `${word} Pairs`)).toBe(true);
    });

    it("matches LIKE wildcards literally", async () => {
      as(alice);
      expect((await search("100%")).body.results?.map((r) => r.title)).toContain("100% Literal_Title");
      // "%_" must not act as "anything": only titles containing those characters match.
      const { body } = await search("%_");
      for (const r of body.results ?? []) expect(String(r.title)).toMatch(/%_/);
    });

    it("returns an empty list for too-short queries", async () => {
      as(alice);
      expect(await search("a")).toEqual({ status: 200, body: { results: [] } });
    });

    it("shows the viewer's own solve state, nobody else's", async () => {
      const now = new Date();
      await m.db.userProblemStatus.create({
        data: { userId: alice.id, problemId: attemptedId, status: "ATTEMPTED", attempts: 2, failedAttempts: 2, firstAttemptAt: now, lastAttemptAt: now },
      });
      as(alice);
      expect((await search(`${word} Pairs`)).body.results?.[0]).toMatchObject({ title: `${word} Pairs`, status: "attempted" });
      as(bob);
      expect((await search(`${word} Pairs`)).body.results?.[0]).toMatchObject({ title: `${word} Pairs`, status: null });
    });
  });

  describe("notification actions", () => {
    it("change only the caller's own rows", async () => {
      const mine = await m.db.notification.create({ data: { userId: alice.id, kind: "badge", title: "Badge", body: "You earned it" } });
      await m.db.notification.create({ data: { userId: alice.id, kind: "streak", title: "Streak", body: "7 days" } });
      const theirs = await m.db.notification.create({ data: { userId: bob.id, kind: "badge", title: "Badge", body: "Bob's" } });

      as(alice);
      expect(await m.notifications.markNotificationRead({ id: theirs.id })).toEqual({ ok: true, data: { updated: 0 } });
      expect(await m.notifications.markNotificationRead({ id: mine.id })).toEqual({ ok: true, data: { updated: 1 } });
      expect(await m.notifications.markAllNotificationsRead()).toEqual({ ok: true, data: { updated: 1 } });

      expect(await m.db.notification.count({ where: { userId: alice.id, readAt: null } })).toBe(0);
      expect((await m.db.notification.findUniqueOrThrow({ where: { id: theirs.id } })).readAt).toBeNull();

      as(null);
      expect((await m.notifications.markAllNotificationsRead()).ok).toBe(false);
      expect((await m.notifications.markNotificationRead({ id: "bad id!" })).ok).toBe(false);
    });
  });

  describe("getDashboard", () => {
    it("gives a brand-new student empty, zeroed read models", async () => {
      const data = await m.dashboard.getDashboard(bob.id);
      expect(data.weekly).toMatchObject({ solved: 0, goal: 3, met: false });
      expect(data.streak).toMatchObject({ current: 0, longest: 0 });
      expect(data.level).toMatchObject({ level: 1, xpTotal: 0 });
      expect(data.recent).toEqual([]);
      expect(data.plans).toEqual([]);
      expect(data.week).toHaveLength(7);
      expect(["suggested", "daily", "none"]).toContain(data.continueAction.kind);
      if (data.continueAction.kind === "suggested") expect(data.continueAction.firstEver).toBe(true);
    });

    it("puts the most recently attempted unsolved problem first and reads the week bucket", async () => {
      const now = new Date();
      const today = new Date(`${new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(now)}T00:00:00Z`);
      await m.db.userStats.create({
        data: { userId: alice.id, xpTotal: 300, currentStreak: 4, longestStreak: 6, lastActiveDate: today, solvedTotal: 2, submissions: 5 },
      });
      await m.db.xpBucket.create({
        data: { userId: alice.id, period: "WEEK", periodKey: isoWeekKey(now), xp: 170, solvedEasy: 1, solvedMedium: 1, lastXpAt: now },
      });
      await m.db.activityDay.create({ data: { userId: alice.id, date: today, submissions: 3, solved: 1 } });

      const data = await m.dashboard.getDashboard(alice.id, now);
      expect(data.continueAction).toMatchObject({ kind: "attempted", problem: { id: attemptedId }, attempts: 2 });
      expect(data.weekly).toMatchObject({ solved: 2, met: false, percent: 67 });
      expect(data.streak).toMatchObject({ current: 4, longest: 6, activeToday: true, atRisk: false });
      expect(data.level).toMatchObject({ level: 3, xpTotal: 300 });
      expect(data.week.find((d) => d.isToday)).toMatchObject({ submissions: 3, solved: 1 });
      expect(data.solvedTotal).toBe(2);
    });
  });
});
