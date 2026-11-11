import { beforeEach, describe, expect, it, vi } from "vitest";
import { HELP_CONTEXTS, type HelpContext } from "@recx/shared";

/**
 * The help chokepoint (src/lib/help/access.ts) through its server helper
 * with a fake db: the full matrix context × attempts × active minutes ×
 * solved × editorialVisibleAt against an independent restatement of the
 * policy, plus the rows it reads and the problems it refuses.
 */

const h = vi.hoisted(() => {
  const rows = {
    problem: null as null | {
      id: string;
      status: string;
      liveVersionId: string | null;
      editorialVisibleAt: Date | null;
    },
    status: null as null | { status: "ATTEMPTED" | "SOLVED"; attempts: number; failedAttempts: number },
    activity: null as null | { activeSeconds: number },
  };
  const db = {
    problem: { findUnique: vi.fn(async () => rows.problem) },
    userProblemStatus: { findUnique: vi.fn(async () => rows.status) },
    problemActivity: { findUnique: vi.fn(async () => rows.activity) },
  };
  return { rows, db };
});

vi.mock("@/lib/db", () => ({ db: h.db }));

const { getHelpState, helpClosed, hintAllowed, editorialAllowed, WORKSPACE_HELP_CONTEXT } = await import(
  "@/lib/help/access"
);

const NOW = new Date("2026-10-10T10:00:00.000Z");
const USER = "user_1";
const PROBLEM = "prob_1";

function publishedProblem(editorialVisibleAt: Date | null = null) {
  return { id: PROBLEM, status: "PUBLISHED", liveVersionId: "ver_live", editorialVisibleAt };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.rows.problem = publishedProblem();
  h.rows.status = null;
  h.rows.activity = null;
});

/**
 * The policy, restated from the specification rather than imported:
 *   tier 1 always; tier 2 after 1 failed submission or 10 active minutes;
 *   tier 3 after 2 failed submissions or 25 active minutes; editorial once
 *   solved, or past editorialVisibleAt, or after ≥ 5 attempts AND ≥ 45
 *   minutes. CONTEST and ASSESSMENT: nothing.
 */
function oracle(c: {
  context: HelpContext;
  attempts: number;
  failed: number;
  seconds: number;
  solved: boolean;
  visibleAt: Date | null;
}): { maxHintTier: number; editorial: boolean } {
  if (c.context !== "PRACTICE") return { maxHintTier: 0, editorial: false };
  const minutes = c.seconds / 60;
  const maxHintTier = c.failed >= 2 || minutes >= 25 ? 3 : c.failed >= 1 || minutes >= 10 ? 2 : 1;
  const editorial =
    c.solved || (c.visibleAt !== null && c.visibleAt.getTime() <= NOW.getTime()) || (c.attempts >= 5 && minutes >= 45);
  return { maxHintTier, editorial };
}

const WORK: { attempts: number; failed: number }[] = [
  { attempts: 0, failed: 0 },
  { attempts: 1, failed: 1 },
  { attempts: 1, failed: 0 },
  { attempts: 2, failed: 2 },
  { attempts: 3, failed: 1 },
  { attempts: 4, failed: 4 },
  { attempts: 5, failed: 5 },
  { attempts: 6, failed: 5 },
];
const SECONDS = [0, 599, 600, 1_499, 1_500, 2_699, 2_700, 7_200];
const VISIBLE_AT: (Date | null)[] = [
  null,
  new Date(NOW.getTime() - 86_400_000),
  new Date(NOW.getTime()),
  new Date(NOW.getTime() + 1),
];

describe("getHelpState — the chokepoint matrix", () => {
  it.each(HELP_CONTEXTS.map((context) => [context]))("%s: every combination matches the policy", async (context) => {
    const mismatches: string[] = [];
    let cases = 0;
    for (const work of WORK) {
      for (const seconds of SECONDS) {
        for (const solved of [false, true]) {
          for (const visibleAt of VISIBLE_AT) {
            h.rows.problem = publishedProblem(visibleAt);
            h.rows.status =
              work.attempts === 0 && !solved
                ? null
                : { status: solved ? "SOLVED" : "ATTEMPTED", attempts: work.attempts, failedAttempts: work.failed };
            h.rows.activity = seconds === 0 ? null : { activeSeconds: seconds };

            const state = await getHelpState(USER, PROBLEM, context, { now: NOW });
            const want = oracle({ context, attempts: work.attempts, failed: work.failed, seconds, solved, visibleAt });
            cases++;
            if (
              !state ||
              state.access.maxHintTier !== want.maxHintTier ||
              state.access.editorial !== want.editorial
            ) {
              mismatches.push(
                `${JSON.stringify({ ...work, seconds, solved, visibleAt })} → ${JSON.stringify(state?.access)} (want ${JSON.stringify(want)})`,
              );
            }
          }
        }
      }
    }
    expect(cases).toBe(WORK.length * SECONDS.length * 2 * VISIBLE_AT.length);
    expect(mismatches).toEqual([]);
  });

  it("gives CONTEST and ASSESSMENT nothing even with every condition met", async () => {
    h.rows.problem = publishedProblem(new Date(NOW.getTime() - 1));
    h.rows.status = { status: "SOLVED", attempts: 50, failedAttempts: 49 };
    h.rows.activity = { activeSeconds: 100_000 };
    for (const context of ["CONTEST", "ASSESSMENT"] as const) {
      const state = await getHelpState(USER, PROBLEM, context, { now: NOW });
      expect(state?.access).toEqual({ maxHintTier: 0, editorial: false, nextUnlock: null });
      expect(state && helpClosed(state)).toBe(true);
      expect(state && hintAllowed(state, 1)).toBe(false);
      expect(state && editorialAllowed(state)).toBe(false);
    }
  });

  it("fails closed for a context it does not know", async () => {
    h.rows.status = { status: "SOLVED", attempts: 9, failedAttempts: 8 };
    const state = await getHelpState(USER, PROBLEM, "MOCK_INTERVIEW" as HelpContext, { now: NOW });
    expect(state?.access.maxHintTier).toBe(0);
    expect(state?.access.editorial).toBe(false);
  });
});

describe("getHelpState — what it reads and returns", () => {
  it("reads the viewer's own status and activity rows for that problem", async () => {
    h.rows.status = { status: "ATTEMPTED", attempts: 3, failedAttempts: 2 };
    h.rows.activity = { activeSeconds: 754 };
    const state = await getHelpState(USER, PROBLEM, WORKSPACE_HELP_CONTEXT, { now: NOW });

    const key = { userId_problemId: { userId: USER, problemId: PROBLEM } };
    expect(h.db.userProblemStatus.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: key }));
    expect(h.db.problemActivity.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: key }));
    expect(h.db.problem.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: PROBLEM } }));
    expect(state).toMatchObject({
      problemId: PROBLEM,
      liveVersionId: "ver_live",
      context: "PRACTICE",
      attempts: 3,
      failedAttempts: 2,
      solved: false,
      activeSeconds: 754,
      editorialVisibleAt: null,
      now: NOW,
      access: { maxHintTier: 3, editorial: false },
    });
    expect(state?.access.nextUnlock).toMatch(/^The editorial unlocks/);
  });

  it("treats a student with no rows yet as a fresh start (tier 1 only)", async () => {
    const state = await getHelpState(USER, PROBLEM, "PRACTICE", { now: NOW });
    expect(state).toMatchObject({ attempts: 0, failedAttempts: 0, solved: false, activeSeconds: 0 });
    expect(state?.access).toEqual({
      maxHintTier: 1,
      editorial: false,
      nextUnlock: "Hint 2 unlocks after 1 failed submission or 10 minutes of work.",
    });
  });

  it.each([
    ["an unknown problem", null],
    ["a draft", { id: PROBLEM, status: "DRAFT", liveVersionId: "ver_live", editorialVisibleAt: null }],
    ["a retired problem", { id: PROBLEM, status: "RETIRED", liveVersionId: "ver_live", editorialVisibleAt: null }],
    ["a published problem without a live version", { id: PROBLEM, status: "PUBLISHED", liveVersionId: null, editorialVisibleAt: null }],
  ])("returns null for %s", async (_label, problem) => {
    h.rows.problem = problem;
    h.rows.status = { status: "SOLVED", attempts: 9, failedAttempts: 8 };
    expect(await getHelpState(USER, PROBLEM, "PRACTICE", { now: NOW })).toBeNull();
  });
});
