import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Study-plan enrolment against a real Postgres (recx_test, migrations
 * applied): itemsTotal / itemsDone are counted from the plan's items and the
 * viewer's UserProblemStatus = SOLVED rows in one statement (ATTEMPTED and
 * other students' solves do not count), re-enrolling refreshes the counters,
 * completedAt is set only when everything is solved, unpublished plans are
 * refused, and the read side shows the viewer's own solve states.
 *
 * Opt-in: RECX_DB_TESTS=1 (RECX_TEST_DATABASE_URL overrides the URL; it must
 * name a *_test database).
 */
const ENABLED = process.env.RECX_DB_TESTS === "1";

const state = vi.hoisted(() => {
  if (process.env.RECX_DB_TESTS === "1") {
    process.env.DATABASE_URL =
      process.env.RECX_TEST_DATABASE_URL ?? "postgresql://recx:recx-dev-only@localhost:5433/recx_test";
  }
  return { user: null as { id: string } | null };
});

vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/lib/auth/guards", async () => {
  const { UnauthorizedError } = await import("@/lib/errors");
  return {
    requireActionUser: async () => {
      if (!state.user) throw new UnauthorizedError();
      return state.user;
    },
  };
});

type Modules = {
  db: (typeof import("@/lib/db"))["db"];
  actions: typeof import("@/server/actions/plans");
  data: typeof import("@/components/plans/data");
};

describe.skipIf(!ENABLED)("study-plan enrolment against recx_test", () => {
  const tag = `plan${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
  let m: Modules;
  const userIds: string[] = [];
  const problemIds: string[] = [];
  const planIds: string[] = [];
  let me = "";
  let other = "";
  const plan = { full: "", empty: "", hidden: "", solved: "" };

  async function createUser(suffix: string) {
    const id = `${tag}${suffix}`;
    const user = await m.db.user.create({
      data: { collegeId: id, email: `${id}@rec-code.example`, firstName: "Plan", lastName: "Tester", handle: id },
      select: { id: true },
    });
    userIds.push(user.id);
    return user.id;
  }

  async function createProblem(i: number) {
    const problem = await m.db.problem.create({
      data: {
        slug: `${tag}-p${i}`,
        displayCode: `${tag}-P${i}`,
        title: `${tag} plan problem ${i}`,
        difficulty: i % 2 === 0 ? "EASY" : "HARD",
        status: "PUBLISHED",
      },
      select: { id: true },
    });
    problemIds.push(problem.id);
    const version = await m.db.problemVersion.create({
      data: {
        problemId: problem.id,
        revision: 1,
        title: `${tag} plan problem ${i}`,
        difficulty: i % 2 === 0 ? "EASY" : "HARD",
        statementMd: "Test.",
        ioMode: "STDIN",
        timeLimitMs: 1000,
      },
      select: { id: true },
    });
    await m.db.problem.update({ where: { id: problem.id }, data: { liveVersionId: version.id } });
    return problem.id;
  }

  async function createPlan(
    suffix: string,
    kind: "SHEET" | "TRACK",
    published: boolean,
    sections: { title: string; problems: string[] }[],
  ) {
    const created = await m.db.studyPlan.create({
      data: {
        slug: `${tag}-${suffix}`,
        kind,
        title: `${tag} ${suffix}`,
        description: "A test plan.",
        published,
        itemsTotal: sections.reduce((n, s) => n + s.problems.length, 0),
      },
      select: { id: true },
    });
    planIds.push(created.id);
    for (const [si, section] of sections.entries()) {
      const s = await m.db.studyPlanSection.create({
        data: { planId: created.id, title: section.title, sortOrder: si },
        select: { id: true },
      });
      await m.db.studyPlanItem.createMany({
        data: section.problems.map((problemId, ii) => ({ planId: created.id, sectionId: s.id, problemId, sortOrder: ii })),
      });
    }
    return created.id;
  }

  async function setStatus(userId: string, problemId: string, status: "SOLVED" | "ATTEMPTED") {
    const now = new Date();
    await m.db.userProblemStatus.upsert({
      where: { userId_problemId: { userId, problemId } },
      create: {
        userId,
        problemId,
        status,
        attempts: 1,
        firstAttemptAt: now,
        lastAttemptAt: now,
        firstAcceptedAt: status === "SOLVED" ? now : null,
      },
      update: { status, firstAcceptedAt: status === "SOLVED" ? now : null },
    });
  }

  const enrollment = (userId: string, planId: string) =>
    m.db.studyPlanEnrollment.findUnique({ where: { userId_planId: { userId, planId } } });

  beforeAll(async () => {
    m = {
      db: (await import("@/lib/db")).db,
      actions: await import("@/server/actions/plans"),
      data: await import("@/components/plans/data"),
    };
    me = await createUser("a");
    other = await createUser("b");
    const p = [] as string[];
    for (let i = 0; i < 4; i++) p.push(await createProblem(i));
    const [p0, p1, p2, p3] = p as [string, string, string, string];

    await setStatus(me, p0, "SOLVED");
    await setStatus(me, p1, "SOLVED");
    await setStatus(me, p2, "ATTEMPTED");
    await setStatus(other, p3, "SOLVED");

    plan.full = await createPlan("full", "SHEET", true, [
      { title: "Warm-up", problems: [p0, p1] },
      { title: "Harder", problems: [p2, p3] },
    ]);
    plan.empty = await createPlan("empty", "TRACK", true, []);
    plan.hidden = await createPlan("hidden", "SHEET", false, [{ title: "Only", problems: [p0] }]);
    plan.solved = await createPlan("solved", "SHEET", true, [{ title: "Done", problems: [p0, p1] }]);
  }, 60_000);

  afterAll(async () => {
    if (!m) return;
    try {
      await m.db.$transaction([
        m.db.studyPlanEnrollment.deleteMany({ where: { planId: { in: planIds } } }),
        m.db.studyPlan.deleteMany({ where: { id: { in: planIds } } }),
        m.db.userProblemStatus.deleteMany({ where: { userId: { in: userIds } } }),
        m.db.problem.updateMany({ where: { id: { in: problemIds } }, data: { liveVersionId: null } }),
        m.db.problemVersion.deleteMany({ where: { problemId: { in: problemIds } } }),
        m.db.problem.deleteMany({ where: { id: { in: problemIds } } }),
        m.db.user.deleteMany({ where: { id: { in: userIds } } }),
      ]);
    } finally {
      await m.db.$disconnect();
    }
  }, 60_000);

  it("counts the viewer's solved items (not attempted ones, not other students') on enrolment", async () => {
    state.user = { id: me };
    const result = await m.actions.enrollInPlan({ planId: plan.full });
    expect(result).toEqual({ ok: true, data: { enrolled: true, itemsTotal: 4, itemsDone: 2 } });

    const row = await enrollment(me, plan.full);
    expect(row).toMatchObject({ itemsTotal: 4, itemsDone: 2, completedAt: null });
    expect(await enrollment(other, plan.full)).toBeNull();
  });

  it("re-enrolling is idempotent and refreshes the counters, keeping enrolledAt", async () => {
    state.user = { id: me };
    const before = await enrollment(me, plan.full);
    await setStatus(me, problemIds[2]!, "SOLVED");

    const result = await m.actions.enrollInPlan({ planId: plan.full });
    expect(result).toEqual({ ok: true, data: { enrolled: true, itemsTotal: 4, itemsDone: 3 } });
    const after = await enrollment(me, plan.full);
    expect(after?.enrolledAt.getTime()).toBe(before?.enrolledAt.getTime());
    expect(after?.completedAt).toBeNull();
  });

  it("another student's enrolment counts only their own solves", async () => {
    state.user = { id: other };
    const result = await m.actions.enrollInPlan({ planId: plan.full });
    expect(result).toEqual({ ok: true, data: { enrolled: true, itemsTotal: 4, itemsDone: 1 } });
  });

  it("marks an enrolment complete when every item is already solved", async () => {
    state.user = { id: me };
    const result = await m.actions.enrollInPlan({ planId: plan.solved });
    expect(result).toEqual({ ok: true, data: { enrolled: true, itemsTotal: 2, itemsDone: 2 } });
    expect((await enrollment(me, plan.solved))?.completedAt).toBeInstanceOf(Date);
  });

  it("enrols in an empty plan at 0 of 0, not complete", async () => {
    state.user = { id: me };
    const result = await m.actions.enrollInPlan({ planId: plan.empty });
    expect(result).toEqual({ ok: true, data: { enrolled: true, itemsTotal: 0, itemsDone: 0 } });
    expect((await enrollment(me, plan.empty))?.completedAt).toBeNull();
  });

  it("refuses an unpublished or unknown plan", async () => {
    state.user = { id: me };
    expect(await m.actions.enrollInPlan({ planId: plan.hidden })).toEqual({
      ok: false,
      error: "That study plan is not available.",
    });
    expect(await m.actions.enrollInPlan({ planId: `${tag}-missing` })).toEqual({
      ok: false,
      error: "That study plan is not available.",
    });
    expect(await enrollment(me, plan.hidden)).toBeNull();
  });

  it("shows the viewer's own solve states and enrolment on the read side", async () => {
    const detail = await m.data.getPlanDetail(`${tag}-full`, me);
    expect(detail).not.toBeNull();
    expect(detail?.sections.map((s) => [s.title, s.solved, s.items.map((i) => i.solve)])).toEqual([
      ["Warm-up", 2, ["solved", "solved"]],
      ["Harder", 1, ["solved", null]],
    ]);
    expect(detail?.itemCount).toBe(4);
    expect(detail?.solvedCount).toBe(3);
    expect(detail?.enrollment).toEqual({ itemsDone: 3, itemsTotal: 4, completed: false });
    expect(detail?.sections[0]?.items[0]?.available).toBe(true);

    expect(await m.data.getPlanDetail(`${tag}-hidden`, me)).toBeNull();

    const sheets = await m.data.listPublishedPlans("SHEET", me);
    const mine = sheets.filter((p) => p.slug.startsWith(tag));
    expect(mine.map((p) => p.slug).sort()).toEqual([`${tag}-full`, `${tag}-solved`]);
    expect(mine.find((p) => p.slug === `${tag}-full`)).toMatchObject({
      itemCount: 4,
      sectionCount: 2,
      enrollment: { itemsDone: 3, itemsTotal: 4, completed: false },
    });
    const tracks = await m.data.listPublishedPlans("TRACK", other);
    expect(tracks.find((p) => p.slug === `${tag}-empty`)?.enrollment).toBeNull();
  });

  it("leaving removes only the viewer's enrolment and is idempotent", async () => {
    state.user = { id: me };
    expect(await m.actions.leavePlan({ planId: plan.full })).toEqual({
      ok: true,
      data: { enrolled: false, itemsTotal: 0, itemsDone: 0 },
    });
    expect(await enrollment(me, plan.full)).toBeNull();
    expect(await enrollment(other, plan.full)).not.toBeNull();
    expect((await m.actions.leavePlan({ planId: plan.full })).ok).toBe(true);
  });

  it("the form entry point enrolls and leaves", async () => {
    state.user = { id: me };
    const data = new FormData();
    data.set("planId", plan.full);
    data.set("intent", "enroll");
    expect(await m.actions.changeEnrollment(null, data)).toEqual({
      ok: true,
      data: { enrolled: true, itemsTotal: 4, itemsDone: 3 },
    });
    data.set("intent", "leave");
    expect((await m.actions.changeEnrollment(null, data)).ok).toBe(true);
    expect(await enrollment(me, plan.full)).toBeNull();
  });
});
