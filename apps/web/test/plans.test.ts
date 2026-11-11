import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Study-plan enrolment actions without a database: the guard runs first,
 * input is validated before any query, an unpublished plan cannot be joined,
 * and the right pages are revalidated. The counting SQL itself is exercised
 * against Postgres in plans.db.test.ts.
 */

const state = vi.hoisted(() => ({
  user: null as { id: string } | null,
  plan: null as { id: string; slug: string; kind: "SHEET" | "TRACK" } | null,
  calls: [] as string[],
  revalidated: [] as string[],
}));

vi.mock("next/cache", () => ({
  revalidatePath: (path: string) => {
    state.revalidated.push(path);
  },
}));

vi.mock("@/lib/auth/guards", async () => {
  const { UnauthorizedError } = await import("@/lib/errors");
  return {
    requireActionUser: async () => {
      if (!state.user) throw new UnauthorizedError();
      return state.user;
    },
  };
});

vi.mock("@/lib/db", () => ({
  db: {
    studyPlan: {
      findFirst: async () => {
        state.calls.push("studyPlan.findFirst");
        return state.plan;
      },
      findUnique: async () => {
        state.calls.push("studyPlan.findUnique");
        return state.plan;
      },
    },
    studyPlanEnrollment: {
      deleteMany: async () => {
        state.calls.push("studyPlanEnrollment.deleteMany");
        return { count: 1 };
      },
    },
    $queryRaw: async () => {
      state.calls.push("$queryRaw");
      return [{ itemsTotal: 12, itemsDone: 4 }];
    },
  },
}));

const { changeEnrollment, enrollInPlan, leavePlan } = await import("@/server/actions/plans");

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [k, v] of Object.entries(fields)) data.set(k, v);
  return data;
}

beforeEach(() => {
  state.user = { id: "user-1" };
  state.plan = { id: "plan-1", slug: "core-dsa", kind: "SHEET" };
  state.calls = [];
  state.revalidated = [];
});

describe("enrollInPlan / leavePlan", () => {
  it("refuses anonymous callers before any query", async () => {
    state.user = null;
    expect(await enrollInPlan({ planId: "plan-1" })).toEqual({ ok: false, error: "You need to sign in to do that." });
    expect(await leavePlan({ planId: "plan-1" })).toEqual({ ok: false, error: "You need to sign in to do that." });
    expect(state.calls).toEqual([]);
  });

  it.each([
    ["a missing plan id", {}],
    ["an empty plan id", { planId: "  " }],
    ["an over-long plan id", { planId: "p".repeat(65) }],
    ["a numeric plan id", { planId: 7 }],
  ])("rejects %s before any query", async (_label, input) => {
    expect((await enrollInPlan(input as never)).ok).toBe(false);
    expect((await leavePlan(input as never)).ok).toBe(false);
    expect(state.calls).toEqual([]);
  });

  it("enrolls in a published plan with the counted progress and revalidates its pages", async () => {
    const result = await enrollInPlan({ planId: "plan-1" });
    expect(result).toEqual({ ok: true, data: { enrolled: true, itemsTotal: 12, itemsDone: 4 } });
    expect(state.calls).toEqual(["studyPlan.findFirst", "$queryRaw"]);
    expect(state.revalidated).toEqual(["/sheets", "/sheets/core-dsa"]);
  });

  it("revalidates the track pages for a track", async () => {
    state.plan = { id: "plan-2", slug: "graphs-101", kind: "TRACK" };
    await enrollInPlan({ planId: "plan-2" });
    expect(state.revalidated).toEqual(["/learn", "/learn/graphs-101"]);
  });

  it("refuses an unpublished or unknown plan", async () => {
    state.plan = null;
    expect(await enrollInPlan({ planId: "plan-x" })).toEqual({
      ok: false,
      error: "That study plan is not available.",
    });
    expect(state.calls).toEqual(["studyPlan.findFirst"]);
  });

  it("leaves idempotently", async () => {
    expect(await leavePlan({ planId: "plan-1" })).toEqual({
      ok: true,
      data: { enrolled: false, itemsTotal: 0, itemsDone: 0 },
    });
    expect(state.calls[0]).toBe("studyPlanEnrollment.deleteMany");
  });
});

describe("changeEnrollment (form)", () => {
  it("routes the intent", async () => {
    const enrolled = await changeEnrollment(null, form({ planId: "plan-1", intent: "enroll" }));
    expect(enrolled).toEqual({ ok: true, data: { enrolled: true, itemsTotal: 12, itemsDone: 4 } });
    const left = await changeEnrollment(enrolled, form({ planId: "plan-1", intent: "leave" }));
    expect(left).toEqual({ ok: true, data: { enrolled: false, itemsTotal: 0, itemsDone: 0 } });
  });

  it("rejects a missing or unknown intent and a missing plan id", async () => {
    expect(await changeEnrollment(null, form({ planId: "plan-1", intent: "delete" }))).toEqual({
      ok: false,
      error: "Choose whether to enroll or leave.",
    });
    expect((await changeEnrollment(null, form({ planId: "plan-1" }))).ok).toBe(false);
    expect(await changeEnrollment(null, form({ intent: "enroll" }))).toEqual({
      ok: false,
      error: "Choose a study plan.",
    });
    expect(state.calls).toEqual([]);
  });
});
