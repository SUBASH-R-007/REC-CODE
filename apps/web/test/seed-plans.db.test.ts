import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { SeededPlan } from "../scripts/content/study-plans";

/**
 * The study-plan sync (scripts/content/study-plans.ts) against a real
 * Postgres (recx_test): only published problems become items, a problem that
 * publishes later joins on the next sync, itemsTotal and every enrollment's
 * itemsTotal / itemsDone / completedAt follow UserProblemStatus (SOLVED), and
 * a second sync changes nothing. The test syncs its own fixture plan, so no
 * other data in the database is touched.
 *
 * Opt-in: RECX_DB_TESTS=1 (RECX_TEST_DATABASE_URL overrides the URL; it must
 * name a *_test database).
 */
const ENABLED = process.env.RECX_DB_TESTS === "1";
const TEST_URL = process.env.RECX_TEST_DATABASE_URL ?? "postgresql://recx:recx-dev-only@localhost:5433/recx_test";

vi.hoisted(() => {
  if (process.env.RECX_DB_TESTS === "1") {
    process.env.DATABASE_URL =
      process.env.RECX_TEST_DATABASE_URL ?? "postgresql://recx:recx-dev-only@localhost:5433/recx_test";
  }
});

type Modules = {
  db: (typeof import("@/lib/db"))["db"];
  plans: typeof import("../scripts/content/study-plans");
};

describe.skipIf(!ENABLED)("study-plan sync against recx_test", () => {
  const tag = `plan-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
  let m: Modules;
  let userId = "";
  const ids: Record<"a" | "b" | "c", string> = { a: "", b: "", c: "" };
  const versionIds: Record<"a" | "b" | "c", string> = { a: "", b: "", c: "" };
  const slug = (k: string) => `${tag}-${k}`;

  const plan = (sections: SeededPlan["sections"]): SeededPlan => ({
    slug: tag,
    kind: "TRACK",
    title: "Fixture Track",
    description: "A plan that exists only for this test.",
    sortOrder: 99,
    sections,
  });
  const FULL = plan([
    { title: "One", slugs: [slug("a"), slug("c")] },
    { title: "Two", slugs: [slug("b")] },
  ]);

  const sync = async (p: SeededPlan) => {
    const [result] = await m.plans.syncStudyPlans(m.db, [p]);
    return result!;
  };
  const enrollment = () => m.db.studyPlanEnrollment.findFirstOrThrow({ where: { userId, plan: { slug: tag } } });
  const items = async () =>
    (
      await m.db.studyPlanItem.findMany({
        where: { plan: { slug: tag } },
        orderBy: [{ section: { sortOrder: "asc" } }, { sortOrder: "asc" }],
        select: { problemId: true, section: { select: { title: true } } },
      })
    ).map((i) => [i.section.title, i.problemId]);
  const solve = (problemId: string) =>
    m.db.userProblemStatus.create({
      data: { userId, problemId, status: "SOLVED", attempts: 1, firstAttemptAt: new Date(), lastAttemptAt: new Date(), firstAcceptedAt: new Date() },
    });
  const publish = (k: "a" | "b" | "c") =>
    m.db.problem.update({ where: { id: ids[k] }, data: { status: "PUBLISHED", liveVersionId: versionIds[k] } });

  beforeAll(async () => {
    if (!new URL(TEST_URL).pathname.endsWith("_test")) {
      throw new Error(`Refusing to run against a non-test database: ${new URL(TEST_URL).pathname}`);
    }
    const [dbModule, plans] = await Promise.all([import("@/lib/db"), import("../scripts/content/study-plans")]);
    m = { db: dbModule.db, plans };
    const user = await m.db.user.create({
      data: { collegeId: tag, email: `${tag}@rec-code.example`, firstName: "Plan", lastName: "Tester", handle: tag },
      select: { id: true },
    });
    userId = user.id;
    for (const [k, difficulty] of [["a", "EASY"], ["b", "MEDIUM"], ["c", "EASY"]] as const) {
      const problem = await m.db.problem.create({
        data: { slug: slug(k), displayCode: slug(k).toUpperCase(), title: `Fixture ${k}`, difficulty },
        select: { id: true },
      });
      ids[k] = problem.id;
      const version = await m.db.problemVersion.create({
        data: { problemId: problem.id, revision: 1, title: `Fixture ${k}`, difficulty, statementMd: "Fixture.", ioMode: "STDIN", timeLimitMs: 1000 },
        select: { id: true },
      });
      versionIds[k] = version.id;
    }
    await publish("a");
    await publish("b");
  }, 60_000);

  afterAll(async () => {
    if (!m) return;
    try {
      const problemIds = Object.values(ids).filter(Boolean);
      await m.db.studyPlan.deleteMany({ where: { slug: tag } });
      await m.db.userProblemStatus.deleteMany({ where: { userId } });
      await m.db.problem.updateMany({ where: { id: { in: problemIds } }, data: { liveVersionId: null } });
      await m.db.problemVersion.deleteMany({ where: { problemId: { in: problemIds } } });
      await m.db.problem.deleteMany({ where: { id: { in: problemIds } } });
      if (userId) await m.db.user.deleteMany({ where: { id: userId } });
    } finally {
      await m.db.$disconnect();
    }
  }, 60_000);

  it("lists only published problems, in curated order", async () => {
    const first = await sync(FULL);
    expect(first).toMatchObject({ created: true, itemsTotal: 2, added: 2, removed: 0 });
    expect(await items()).toEqual([
      ["One", ids.a],
      ["Two", ids.b],
    ]);
    expect(await m.db.studyPlan.findUniqueOrThrow({ where: { slug: tag } })).toMatchObject({ published: true, itemsTotal: 2 });
  });

  it("adds a problem once it publishes and keeps enrollments counted", async () => {
    const planId = (await m.db.studyPlan.findUniqueOrThrow({ where: { slug: tag } })).id;
    await m.db.studyPlanEnrollment.create({ data: { userId, planId, itemsTotal: 2, itemsDone: 0 } });
    await solve(ids.a);
    await publish("c");

    const second = await sync(FULL);
    expect(second).toMatchObject({ created: false, itemsTotal: 3, added: 1, removed: 0, enrollmentsUpdated: 1 });
    expect(await items()).toEqual([
      ["One", ids.a],
      ["One", ids.c],
      ["Two", ids.b],
    ]);
    expect(await enrollment()).toMatchObject({ itemsTotal: 3, itemsDone: 1, completedAt: null });

    await solve(ids.b);
    await solve(ids.c);
    await sync(FULL);
    const done = await enrollment();
    expect(done).toMatchObject({ itemsTotal: 3, itemsDone: 3 });
    expect(done.completedAt).toBeInstanceOf(Date);
  });

  it("removes dropped items and empty sections, and a repeat sync is a no-op", async () => {
    const before = (await enrollment()).completedAt;
    const smaller = plan([{ title: "One", slugs: [slug("a"), slug("c")] }]);
    expect(await sync(smaller)).toMatchObject({ itemsTotal: 2, added: 0, removed: 1, enrollmentsUpdated: 1 });
    expect(await m.db.studyPlanSection.findMany({ where: { plan: { slug: tag } }, select: { title: true } })).toEqual([{ title: "One" }]);
    const after = await enrollment();
    expect(after).toMatchObject({ itemsTotal: 2, itemsDone: 2 });
    expect(after.completedAt?.getTime()).toBe(before?.getTime());

    expect(await sync(smaller)).toMatchObject({ added: 0, removed: 0, moved: 0, enrollmentsUpdated: 0 });
  });
});
