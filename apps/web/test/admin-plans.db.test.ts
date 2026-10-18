import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * /admin sheets and tracks against a real Postgres (recx_test), through the
 * server actions: adding and removing problems recounts the plan and every
 * enrolment (itemsDone from UserProblemStatus SOLVED); unpublished problems
 * are refused; publishing needs at least one problem; a seed-managed plan is
 * read-only until detached; the seed sync creates seed-managed plans and
 * leaves a detached plan exactly as the admin made it.
 *
 * Opt-in: RECX_DB_TESTS=1 (RECX_TEST_DATABASE_URL overrides the URL).
 */
const ENABLED = process.env.RECX_DB_TESTS === "1";

const state = vi.hoisted(() => {
  if (process.env.RECX_DB_TESTS === "1") {
    process.env.DATABASE_URL =
      process.env.RECX_TEST_DATABASE_URL ?? "postgresql://recx:recx-dev-only@localhost:5433/recx_test";
  }
  return { user: null as unknown, redirect: "", audits: [] as Array<Record<string, unknown>> };
});

vi.mock("@/lib/auth/session", () => ({ getCurrentUser: async () => state.user, destroyAllSessions: async () => undefined }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined, revalidateTag: () => undefined }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    state.redirect = url;
    throw new Error("NEXT_REDIRECT");
  },
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));
vi.mock("@/lib/ip", () => ({ requestIpHash: async () => null }));
vi.mock("@/lib/audit", () => ({
  audit: async (entry: Record<string, unknown>) => {
    state.audits.push(entry);
  },
}));

type M = {
  db: (typeof import("@/lib/db"))["db"];
  actions: typeof import("@/server/actions/admin-plans");
  seed: typeof import("../scripts/content/study-plans");
  support: typeof import("./support/admin-db");
};

describe.skipIf(!ENABLED)("admin study plans against recx_test", () => {
  const tag = `ap${Date.now().toString(36)}${randomBytes(2).toString("hex")}`;
  let m: M;
  let u: Record<"admin" | "stu", import("./support/admin-db").TestUser>;
  const problemIds: string[] = [];
  const codes: string[] = [];
  const planIds: string[] = [];

  async function createProblem(i: number, published: boolean) {
    const code = `${tag}-P${i}`.toUpperCase();
    const problem = await m.db.problem.create({
      data: { slug: `${tag}-p${i}`, displayCode: code, title: `${tag} problem ${i}`, difficulty: "EASY", status: published ? "PUBLISHED" : "DRAFT" },
      select: { id: true },
    });
    problemIds.push(problem.id);
    codes.push(code);
    if (published) {
      const version = await m.db.problemVersion.create({
        data: { problemId: problem.id, revision: 1, title: `${tag} problem ${i}`, difficulty: "EASY", statementMd: "Test.", ioMode: "STDIN", timeLimitMs: 1000 },
        select: { id: true },
      });
      await m.db.problem.update({ where: { id: problem.id }, data: { liveVersionId: version.id } });
    }
    return { id: problem.id, code };
  }

  const plan = (id: string) => m.db.studyPlan.findUniqueOrThrow({ where: { id } });
  const enrollment = (planId: string) =>
    m.db.studyPlanEnrollment.findUniqueOrThrow({ where: { userId_planId: { userId: u.stu.id, planId } } });

  beforeAll(async () => {
    m = {
      db: (await import("@/lib/db")).db,
      actions: await import("@/server/actions/admin-plans"),
      seed: await import("../scripts/content/study-plans"),
      support: await import("./support/admin-db"),
    };
    u = await m.support.createUsers(m.db, tag, { admin: { role: "ADMIN" }, stu: { batchYear: 2027, departmentCode: "CSE", section: "A" } });
    state.user = await m.db.user.findUniqueOrThrow({ where: { id: u.admin.id } });
  }, 60_000);

  afterAll(async () => {
    if (!m) return;
    try {
      const plans = await m.db.studyPlan.findMany({ where: { slug: { startsWith: tag } }, select: { id: true } });
      await m.db.studyPlanEnrollment.deleteMany({ where: { planId: { in: plans.map((p) => p.id) } } });
      await m.db.studyPlan.deleteMany({ where: { id: { in: plans.map((p) => p.id) } } });
      await m.db.userProblemStatus.deleteMany({ where: { problemId: { in: problemIds } } });
      await m.db.problem.updateMany({ where: { id: { in: problemIds } }, data: { liveVersionId: null } });
      await m.db.problemVersion.deleteMany({ where: { problemId: { in: problemIds } } });
      await m.db.problem.deleteMany({ where: { id: { in: problemIds } } });
      await m.support.cleanupAdminRows(m.db, Object.values(u ?? {}).map((x) => x.id));
      expect(await m.support.disabledTriggers(m.db)).toEqual([]);
    } finally {
      await m.db.$disconnect();
    }
  }, 60_000);

  let planId = "";
  let sectionId = "";
  let p: { id: string; code: string }[] = [];

  it("creates an unpublished, admin-managed plan", async () => {
    p = [await createProblem(1, true), await createProblem(2, true), await createProblem(3, true), await createProblem(4, false)];
    const now = new Date();
    await m.db.userProblemStatus.create({
      data: { userId: u.stu.id, problemId: p[0]!.id, status: "SOLVED", attempts: 1, firstAttemptAt: now, lastAttemptAt: now, firstAcceptedAt: now },
    });

    await expect(
      m.actions.createStudyPlan({ kind: "SHEET", slug: `${tag}-sheet`, title: "Admin sheet", description: "A sheet made in /admin.", sortOrder: 5 }),
    ).rejects.toThrow("NEXT_REDIRECT");
    planId = state.redirect.split("/").pop()!;
    planIds.push(planId);
    expect(await plan(planId)).toMatchObject({ kind: "SHEET", published: false, seedManaged: false, createdById: u.admin.id });

    const publish = await m.actions.setStudyPlanPublished({ planId, published: true });
    expect(publish.ok || publish.error).toMatch(/at least one problem/);
  });

  it("adding problems recounts the plan and its enrolments; unpublished problems are refused", async () => {
    const section = await m.actions.addPlanSection({ planId, title: "Warm-up" });
    sectionId = section.ok ? section.data.id : "";
    await m.db.studyPlanEnrollment.create({ data: { userId: u.stu.id, planId } });

    const added = await m.actions.addPlanItems({ planId, sectionId, problemCodes: [p[0]!.code, p[1]!.code, p[3]!.code, "NO-SUCH"] });
    expect(added).toEqual({
      ok: true,
      data: { added: [p[0]!.code, p[1]!.code], alreadyInPlan: [], unavailable: [p[3]!.code, "NO-SUCH"], itemsTotal: 2 },
    });
    expect((await plan(planId)).itemsTotal).toBe(2);
    expect(await enrollment(planId)).toMatchObject({ itemsTotal: 2, itemsDone: 1, completedAt: null });

    const dup = await m.actions.addPlanItems({ planId, sectionId, problemCodes: [p[0]!.code.toLowerCase()] });
    expect(dup).toMatchObject({ ok: true, data: { added: [], alreadyInPlan: [p[0]!.code] } });
  });

  it("removing a problem recounts, and a plan that becomes complete gets completedAt", async () => {
    const item = await m.db.studyPlanItem.findFirstOrThrow({ where: { planId, problemId: p[1]!.id } });
    expect(await m.actions.removePlanItem({ itemId: item.id })).toEqual({ ok: true, data: { itemsTotal: 1 } });
    const e = await enrollment(planId);
    expect(e).toMatchObject({ itemsTotal: 1, itemsDone: 1 });
    expect(e.completedAt).not.toBeNull();

    // Growing the plan past the student clears completedAt (the seed sync's rule).
    await m.actions.addPlanItems({ planId, sectionId, problemCodes: [p[2]!.code] });
    expect(await enrollment(planId)).toMatchObject({ itemsTotal: 2, itemsDone: 1, completedAt: null });

    expect((await m.actions.setStudyPlanPublished({ planId, published: true })).ok).toBe(true);
    expect((await plan(planId)).published).toBe(true);
    expect(state.audits.map((a) => a.action)).toEqual(
      expect.arrayContaining(["plan.created", "plan.section.added", "plan.items.added", "plan.item.removed", "plan.published"]),
    );
  });

  it("a recount racing a solve being counted keeps the solve (the recount waits for it)", async () => {
    const { recountStudyPlan } = await import("@/lib/plans/recount");
    expect(await enrollment(planId)).toMatchObject({ itemsTotal: 2, itemsDone: 1 });
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    // What finalise does when a submission solves p2: the status row, then the enrolment, in one transaction.
    const finalise = m.db.$transaction(
      async (tx) => {
        const now = new Date();
        await tx.userProblemStatus.create({
          data: { userId: u.stu.id, problemId: p[2]!.id, status: "SOLVED", attempts: 1, firstAttemptAt: now, lastAttemptAt: now, firstAcceptedAt: now },
        });
        await tx.studyPlanEnrollment.update({
          where: { userId_planId: { userId: u.stu.id, planId } },
          data: { itemsDone: { increment: 1 } },
        });
        await sleep(400);
      },
      { timeout: 10_000 },
    );
    await sleep(100);
    // An admin edit's recount starts while that transaction is still open.
    const recount = m.db.$transaction((tx) => recountStudyPlan(tx, planId), { timeout: 10_000 });
    await Promise.all([finalise, recount]);
    const e = await enrollment(planId);
    expect(e).toMatchObject({ itemsTotal: 2, itemsDone: 2 });
    expect(e.completedAt).not.toBeNull();
  });

  it("a seed-managed plan is read-only until detached, and the seed sync then leaves it alone", async () => {
    const slug = `${tag}-seeded`;
    const seeded: Parameters<M["seed"]["syncStudyPlans"]>[1][number] = {
      slug,
      kind: "TRACK",
      title: "Seeded track",
      description: "Created by the seed sync.",
      sortOrder: 9,
      sections: [{ title: "Only", slugs: [`${tag}-p1`] }],
    };
    const [created] = await m.seed.syncStudyPlans(m.db, [seeded]);
    expect(created).toMatchObject({ created: true, detached: false, itemsTotal: 1 });
    const row = await m.db.studyPlan.findUniqueOrThrow({ where: { slug } });
    expect(row.seedManaged).toBe(true);

    const refused = await m.actions.addPlanSection({ planId: row.id, title: "Mine" });
    expect(refused.ok || refused.error).toMatch(/managed by the seed/);
    const rename = await m.actions.updateStudyPlan({ planId: row.id, title: "Renamed", description: "Changed in /admin.", sortOrder: 1 });
    expect(rename.ok).toBe(false);

    expect(await m.actions.detachPlanFromSeed({ planId: row.id, reason: "Curating it by hand now." })).toEqual({ ok: true, data: { id: row.id } });
    expect((await m.actions.updateStudyPlan({ planId: row.id, title: "Renamed", description: "Changed in /admin.", sortOrder: 1 })).ok).toBe(true);

    const [again] = await m.seed.syncStudyPlans(m.db, [{ ...seeded, sections: [{ title: "Only", slugs: [`${tag}-p1`, `${tag}-p2`] }] }]);
    expect(again).toMatchObject({ detached: true, added: 0 });
    const after = await m.db.studyPlan.findUniqueOrThrow({ where: { slug }, include: { items: true } });
    expect(after).toMatchObject({ title: "Renamed", seedManaged: false });
    expect(after.items).toHaveLength(1);
  });
});
