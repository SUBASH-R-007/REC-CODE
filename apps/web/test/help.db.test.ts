import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { campusDayDate } from "@recx/shared";

/**
 * Hints, the editorial gate and active-time crediting against a real
 * Postgres (recx_test, migrations applied): the activity compare-and-set
 * under truly concurrent pings, the ActivityDay upsert and its 24 h cap, and
 * the chokepoint → reveal → record path with real HintReveal / EditorialView
 * rows (idempotent under double clicks).
 *
 * Opt-in: RECX_DB_TESTS=1 (RECX_TEST_DATABASE_URL overrides the URL; it must
 * name a *_test database).
 */
const ENABLED = process.env.RECX_DB_TESTS === "1";
const TEST_URL = process.env.RECX_TEST_DATABASE_URL ?? "postgresql://recx:recx-dev-only@127.0.0.1:5433/recx_test";

vi.hoisted(() => {
  if (process.env.RECX_DB_TESTS === "1") {
    process.env.DATABASE_URL =
      process.env.RECX_TEST_DATABASE_URL ?? "postgresql://recx:recx-dev-only@127.0.0.1:5433/recx_test";
  }
});

type Modules = {
  db: (typeof import("@/lib/db"))["db"];
  activity: typeof import("@/lib/help/activity");
  access: typeof import("@/lib/help/access");
  reveal: typeof import("@/lib/help/reveal");
  panels: typeof import("@/lib/help/panels");
};

describe.skipIf(!ENABLED)("help and activity against recx_test", () => {
  const tag = `help-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
  let m: Modules;
  let userId = "";
  let problemId = "";
  let draftId = "";
  let versionId = "";
  const T0 = new Date(Date.UTC(2026, 9, 10, 6, 0, 0)); // 11:30 IST

  beforeAll(async () => {
    if (!new URL(TEST_URL).pathname.endsWith("_test")) {
      throw new Error(`Refusing to run against a non-test database: ${new URL(TEST_URL).pathname}`);
    }
    const [dbModule, activity, access, reveal, panels] = await Promise.all([
      import("@/lib/db"),
      import("@/lib/help/activity"),
      import("@/lib/help/access"),
      import("@/lib/help/reveal"),
      import("@/lib/help/panels"),
    ]);
    m = { db: dbModule.db, activity, access, reveal, panels };

    const user = await m.db.user.create({
      data: { collegeId: tag, email: `${tag}@rec-code.example`, firstName: "Help", lastName: "Tester", handle: tag },
      select: { id: true },
    });
    userId = user.id;

    const problem = await m.db.problem.create({
      data: { slug: tag, displayCode: tag.toUpperCase(), title: "Help test problem", difficulty: "EASY" },
      select: { id: true },
    });
    problemId = problem.id;
    const version = await m.db.problemVersion.create({
      data: {
        problemId,
        revision: 1,
        title: "Help test problem",
        difficulty: "EASY",
        statementMd: "Test.",
        ioMode: "STDIN",
        timeLimitMs: 1000,
        hints: {
          create: [1, 2, 3].map((tier) => ({ tier, contentMd: `Hint ${tier} for ${tag}.` })),
        },
        editorial: { create: { contentMd: `Editorial for ${tag}.` } },
      },
      select: { id: true },
    });
    versionId = version.id;
    await m.db.problem.update({ where: { id: problemId }, data: { status: "PUBLISHED", liveVersionId: versionId } });

    const draft = await m.db.problem.create({
      data: { slug: `${tag}-draft`, displayCode: `${tag.toUpperCase()}-D`, title: "Draft", difficulty: "EASY" },
      select: { id: true },
    });
    draftId = draft.id;
  }, 60_000);

  afterAll(async () => {
    if (!m) return;
    try {
      await m.db.$transaction([
        m.db.hintReveal.deleteMany({ where: { userId } }),
        m.db.editorialView.deleteMany({ where: { userId } }),
        m.db.problemActivity.deleteMany({ where: { userId } }),
        m.db.activityDay.deleteMany({ where: { userId } }),
        m.db.userProblemStatus.deleteMany({ where: { userId } }),
        m.db.hint.deleteMany({ where: { problemVersionId: versionId } }),
        m.db.editorial.deleteMany({ where: { problemVersionId: versionId } }),
        m.db.problem.updateMany({ where: { id: problemId }, data: { liveVersionId: null } }),
        m.db.problemVersion.deleteMany({ where: { problemId } }),
        m.db.problem.deleteMany({ where: { id: { in: [problemId, draftId] } } }),
        m.db.user.deleteMany({ where: { id: userId } }),
      ]);
    } finally {
      await m.db.$disconnect();
    }
  });

  const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000);
  const ping = (seconds: number, now: Date, pid = problemId) =>
    m.activity.recordActivityPing({ userId, problemId: pid, seconds, now });

  it("refuses activity for an unpublished problem", async () => {
    expect(await ping(0, T0, draftId)).toEqual({ status: "not-found" });
    expect(await m.db.problemActivity.count({ where: { userId, problemId: draftId } })).toBe(0);
  });

  it("starts the clock, then credits exactly one of many concurrent pings", async () => {
    expect(await ping(3_600, T0)).toEqual({ status: "accepted", credited: 0, activeSeconds: 0 });

    const outcomes = await Promise.all(Array.from({ length: 8 }, () => ping(30, at(30))));
    const accepted = outcomes.filter((o) => o.status === "accepted");
    expect(accepted).toEqual([{ status: "accepted", credited: 30, activeSeconds: 30 }]);
    expect(outcomes.filter((o) => o.status === "rate-limited")).toHaveLength(7);

    const row = await m.db.problemActivity.findUniqueOrThrow({ where: { userId_problemId: { userId, problemId } } });
    expect(row).toMatchObject({ activeSeconds: 30, lastPingAt: at(30) });
    const day = await m.db.activityDay.findUniqueOrThrow({ where: { userId_date: { userId, date: campusDayDate(T0) } } });
    expect(day.activeSeconds).toBe(30);
  });

  it("never credits more than the wall clock or 60 s per ping", async () => {
    expect(await ping(3_600, at(55))).toEqual({ status: "accepted", credited: 25, activeSeconds: 55 });
    expect(await ping(3_600, at(10_000))).toEqual({ status: "accepted", credited: 60, activeSeconds: 115 });
    expect(await ping(30, at(10_010))).toEqual({ status: "rate-limited", retryAfterMs: 10_000 });
  });

  it("caps ActivityDay at 24 hours", async () => {
    await m.db.activityDay.update({
      where: { userId_date: { userId, date: campusDayDate(T0) } },
      data: { activeSeconds: 86_390 },
    });
    expect(await ping(60, at(20_000))).toMatchObject({ status: "accepted", credited: 60 });
    const day = await m.db.activityDay.findUniqueOrThrow({ where: { userId_date: { userId, date: campusDayDate(T0) } } });
    expect(day.activeSeconds).toBe(86_400);
  });

  it("reads real rows through the chokepoint and records a hint reveal once", async () => {
    // 175 credited seconds so far: tier 1 only.
    let state = await m.access.getHelpState(userId, problemId, "PRACTICE");
    expect(state?.access.maxHintTier).toBe(1);
    await expect(m.reveal.revealHintFor(userId, { problemId, tier: 2 }, "PRACTICE")).rejects.toThrow(/still locked/);

    await m.db.userProblemStatus.create({
      data: { userId, problemId, status: "ATTEMPTED", attempts: 2, failedAttempts: 2, firstAttemptAt: T0, lastAttemptAt: T0 },
    });
    state = await m.access.getHelpState(userId, problemId, "PRACTICE");
    expect(state?.access.maxHintTier).toBe(3);

    const [a, b] = await Promise.all([
      m.reveal.revealHintFor(userId, { problemId, tier: 3 }, "PRACTICE"),
      m.reveal.revealHintFor(userId, { problemId, tier: 3 }, "PRACTICE"),
    ]);
    expect(a.html).toBe(`<p>Hint 3 for ${tag}.</p>\n`);
    expect(b).toEqual(a);
    const reveals = await m.db.hintReveal.findMany({ where: { userId, problemId } });
    expect(reveals).toHaveLength(1);
    expect(reveals[0]).toMatchObject({ tier: 3, context: "PRACTICE" });

    await expect(m.reveal.revealHintFor(userId, { problemId, tier: 1 }, "CONTEST")).rejects.toThrow(/not available/);
    expect(await m.db.hintReveal.count({ where: { userId, problemId } })).toBe(1);

    const panel = await m.panels.loadHintsPanel(userId, problemId, versionId, "PRACTICE");
    expect(panel.kind === "ready" && panel.rows.map((r) => r.state)).toEqual(["available", "available", "revealed"]);
  });

  it("gates the editorial, then records the first view once", async () => {
    await expect(m.reveal.viewEditorialFor(userId, { problemId }, "PRACTICE")).rejects.toThrow(/editorial unlocks/);
    expect(await m.db.editorialView.count({ where: { userId } })).toBe(0);

    await m.db.userProblemStatus.update({
      where: { userId_problemId: { userId, problemId } },
      data: { status: "SOLVED", firstAcceptedAt: T0 },
    });
    const first = await m.reveal.viewEditorialFor(userId, { problemId }, "PRACTICE");
    expect(first.html).toBe(`<p>Editorial for ${tag}.</p>\n`);
    const firstView = await m.db.editorialView.findUniqueOrThrow({ where: { userId_problemId: { userId, problemId } } });
    await m.reveal.viewEditorialFor(userId, { problemId }, "PRACTICE");
    const again = await m.db.editorialView.findUniqueOrThrow({ where: { userId_problemId: { userId, problemId } } });
    expect(again.firstViewedAt).toEqual(firstView.firstViewedAt);

    await expect(m.reveal.viewEditorialFor(userId, { problemId }, "ASSESSMENT")).rejects.toThrow(/not available/);
    const panel = await m.panels.loadEditorialPanel(userId, problemId, versionId, "PRACTICE");
    expect(panel.kind).toBe("viewed");
  });
});
