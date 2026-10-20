import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Server CodeDraft saves against a real Postgres (recx_test): newest-wins at
 * the row (a stale beacon never overwrites newer code), clock clamping,
 * concurrent first saves, per-user isolation, and refusal for unpublished
 * problems. Opt-in: RECX_DB_TESTS=1 (RECX_TEST_DATABASE_URL overrides the
 * URL; it must name a *_test database). The rate limiter is replaced by a
 * switch, so Redis is not needed.
 */
const ENABLED = process.env.RECX_DB_TESTS === "1";

const limiter = vi.hoisted(() => {
  if (process.env.RECX_DB_TESTS === "1") {
    process.env.DATABASE_URL =
      process.env.RECX_TEST_DATABASE_URL ?? "postgresql://recx:recx-dev-only@127.0.0.1:5433/recx_test";
  }
  return { allowed: true };
});

vi.mock("@/lib/rate-limit", () => ({
  hitRateLimit: async () => ({
    allowed: limiter.allowed,
    remaining: 0,
    retryAfterMs: 0,
    key: "test",
    member: "test",
    failedOpen: false,
  }),
}));

type Modules = {
  db: (typeof import("@/lib/db"))["db"];
  server: typeof import("@/lib/drafts/server");
  errors: typeof import("@/lib/errors");
};

describe.skipIf(!ENABLED)("server drafts against recx_test", () => {
  const tag = `drafts-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
  let m: Modules;
  let userId = "";
  let otherUserId = "";
  let problemId = "";
  let hiddenProblemId = "";
  const versionIds: string[] = [];
  const T = Date.now() - 60_000;

  const save = (input: { source: string; clientUpdatedAt: number; language?: "cpp20" | "py312"; problem?: string; user?: string }) =>
    m.server.saveServerDraft(input.user ?? userId, {
      problemId: input.problem ?? problemId,
      language: input.language ?? "cpp20",
      source: input.source,
      clientUpdatedAt: input.clientUpdatedAt,
    });

  const stored = (language: "cpp20" | "py312" = "cpp20") =>
    m.db.codeDraft.findUnique({
      where: { userId_problemId_language: { userId, problemId, language } },
      select: { source: true, clientUpdatedAt: true },
    });

  beforeAll(async () => {
    m = {
      db: (await import("@/lib/db")).db,
      server: await import("@/lib/drafts/server"),
      errors: await import("@/lib/errors"),
    };
    const dbName = (await m.db.$queryRaw<{ db: string }[]>`SELECT current_database() AS db`)[0]?.db ?? "";
    if (!dbName.endsWith("_test")) throw new Error(`refusing to run against ${dbName}`);

    const makeUser = (suffix: string) =>
      m.db.user.create({
        data: {
          collegeId: `${tag}${suffix}`,
          email: `${tag}${suffix}@rec-code.example`,
          firstName: "Draft",
          lastName: "Tester",
          handle: `${tag}${suffix}`,
        },
        select: { id: true },
      });
    userId = (await makeUser("a")).id;
    otherUserId = (await makeUser("b")).id;

    const makeProblem = async (suffix: string, published: boolean) => {
      const problem = await m.db.problem.create({
        data: { slug: `${tag}-${suffix}`, displayCode: `${tag}-${suffix}`.toUpperCase(), title: "Drafts", difficulty: "EASY" },
        select: { id: true },
      });
      const version = await m.db.problemVersion.create({
        data: {
          problemId: problem.id,
          revision: 1,
          title: "Drafts",
          difficulty: "EASY",
          statementMd: "Test.",
          ioMode: "STDIN",
          timeLimitMs: 1000,
        },
        select: { id: true },
      });
      versionIds.push(version.id);
      if (published) {
        await m.db.problem.update({ where: { id: problem.id }, data: { status: "PUBLISHED", liveVersionId: version.id } });
      }
      return problem.id;
    };
    problemId = await makeProblem("pub", true);
    hiddenProblemId = await makeProblem("draft", false);
  }, 60_000);

  afterAll(async () => {
    if (!m) return;
    const users = [userId, otherUserId].filter(Boolean);
    const problems = [problemId, hiddenProblemId].filter(Boolean);
    await m.db.codeDraft.deleteMany({ where: { userId: { in: users } } });
    await m.db.problem.updateMany({ where: { id: { in: problems } }, data: { liveVersionId: null, status: "DRAFT" } });
    await m.db.problemVersion.deleteMany({ where: { id: { in: versionIds } } });
    await m.db.problem.deleteMany({ where: { id: { in: problems } } });
    await m.db.user.deleteMany({ where: { id: { in: users } } });
    await m.db.$disconnect();
  });

  it("creates the first draft", async () => {
    expect(await save({ source: "v1", clientUpdatedAt: T })).toEqual({ saved: true });
    const row = await stored();
    expect(row?.source).toBe("v1");
    expect(row?.clientUpdatedAt.getTime()).toBe(T);
  });

  it("a newer edit replaces it", async () => {
    expect(await save({ source: "v2", clientUpdatedAt: T + 1_000 })).toEqual({ saved: true });
    expect((await stored())?.source).toBe("v2");
  });

  it("an OLDER edit (a stale tab's late beacon) is a no-op", async () => {
    expect(await save({ source: "stale", clientUpdatedAt: T + 500 })).toEqual({ saved: false });
    const row = await stored();
    expect(row?.source).toBe("v2");
    expect(row?.clientUpdatedAt.getTime()).toBe(T + 1_000);
  });

  it("the same edit time again is accepted (a retried save is idempotent)", async () => {
    expect(await save({ source: "v2", clientUpdatedAt: T + 1_000 })).toEqual({ saved: true });
    expect((await stored())?.source).toBe("v2");
  });

  it("an empty draft is stored (the student cleared the editor)", async () => {
    expect(await save({ source: "", clientUpdatedAt: T + 2_000 })).toEqual({ saved: true });
    expect((await stored())?.source).toBe("");
  });

  it("clamps a clock running hours ahead to now + 2 minutes, so a correct clock can still save later", async () => {
    const before = Date.now();
    expect(await save({ source: "fast clock", clientUpdatedAt: before + 6 * 3_600_000 })).toEqual({ saved: true });
    const at = (await stored())?.clientUpdatedAt.getTime() ?? 0;
    expect(at).toBeLessThanOrEqual(Date.now() + 2 * 60_000);
    expect(at).toBeGreaterThan(before);
    // Three minutes later on a correct clock, the student's next edit wins.
    expect(await save({ source: "correct clock", clientUpdatedAt: before + 3 * 60_000 })).toEqual({ saved: true });
    expect((await stored())?.source).toBe("correct clock");
  });

  it("concurrent first saves of a new (problem, language) settle on the newest", async () => {
    const results = await Promise.all([
      save({ language: "py312", source: "older", clientUpdatedAt: T }),
      save({ language: "py312", source: "newer", clientUpdatedAt: T + 10 }),
      save({ language: "py312", source: "oldest", clientUpdatedAt: T - 10 }),
    ]);
    expect(results.some((r) => r.saved)).toBe(true);
    expect((await stored("py312"))?.source).toBe("newer");
  });

  it("drafts are per user: another student's save never touches this one, and loading is scoped", async () => {
    await save({ user: otherUserId, source: "someone else", clientUpdatedAt: Date.now() + 60_000 });
    expect((await stored())?.source).toBe("correct clock");
    const mine = await m.server.loadServerDrafts(userId, problemId);
    expect(mine.map((d) => d.language).sort()).toEqual(["cpp20", "py312"]);
    expect(mine.every((d) => d.source !== "someone else")).toBe(true);
    expect(mine.every((d) => typeof d.updatedAt === "number")).toBe(true);
  });

  it("refuses drafts for a problem that is not published", async () => {
    await expect(save({ problem: hiddenProblemId, source: "x", clientUpdatedAt: T })).rejects.toBeInstanceOf(
      m.errors.NotFoundError,
    );
    await expect(save({ problem: "does-not-exist", source: "x", clientUpdatedAt: T })).rejects.toBeInstanceOf(
      m.errors.NotFoundError,
    );
  });

  it("refuses past the rate limit, writing nothing", async () => {
    limiter.allowed = false;
    try {
      await expect(save({ source: "flood", clientUpdatedAt: Date.now() + 90_000 })).rejects.toBeInstanceOf(
        m.errors.RateLimitError,
      );
      expect((await stored())?.source).toBe("correct clock");
    } finally {
      limiter.allowed = true;
    }
  });
});
