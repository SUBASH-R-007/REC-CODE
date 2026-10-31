import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The revealHint / viewEditorial server actions and their bodies
 * (src/lib/help/reveal.ts) with a fake db: signed-in only, strict input,
 * the chokepoint re-checked on every call, refusals record nothing and
 * return nothing, and CONTEST / ASSESSMENT get nothing whatever the state.
 */

const h = vi.hoisted(() => {
  const rows = {
    problem: null as null | { id: string; status: string; liveVersionId: string | null; editorialVisibleAt: Date | null },
    status: null as null | { status: "ATTEMPTED" | "SOLVED"; attempts: number; failedAttempts: number },
    activity: null as null | { activeSeconds: number },
    hints: [] as { id: string; problemVersionId: string; tier: number; contentMd: string }[],
    editorial: null as null | { problemVersionId: string; contentMd: string },
  };
  const db = {
    problem: { findUnique: vi.fn(async () => rows.problem) },
    userProblemStatus: { findUnique: vi.fn(async () => rows.status) },
    problemActivity: { findUnique: vi.fn(async () => rows.activity) },
    hint: {
      findUnique: vi.fn(async (args: { where: { problemVersionId_tier: { problemVersionId: string; tier: number } } }) => {
        const k = args.where.problemVersionId_tier;
        const row = rows.hints.find((r) => r.problemVersionId === k.problemVersionId && r.tier === k.tier);
        return row ? { id: row.id, contentMd: row.contentMd } : null;
      }),
    },
    hintReveal: { createMany: vi.fn(async () => ({ count: 1 })) },
    editorial: {
      findUnique: vi.fn(async (args: { where: { problemVersionId: string } }) =>
        rows.editorial && rows.editorial.problemVersionId === args.where.problemVersionId
          ? { contentMd: rows.editorial.contentMd }
          : null,
      ),
    },
    editorialView: { createMany: vi.fn(async () => ({ count: 1 })) },
  };
  return { rows, db, user: { id: "user_1" } as { id: string } | null, requireActionUser: vi.fn() };
});

vi.mock("@/lib/db", () => ({ db: h.db }));
vi.mock("@/lib/auth/guards", () => ({ requireActionUser: h.requireActionUser }));

const { UnauthorizedError } = await import("@/lib/errors");
const { revealHint, viewEditorial } = await import("@/server/actions/help");
const { revealHintFor, viewEditorialFor } = await import("@/lib/help/reveal");

const PROBLEM = "prob_1";
const LIVE = "ver_live";

beforeEach(() => {
  vi.clearAllMocks();
  h.user = { id: "user_1" };
  h.requireActionUser.mockImplementation(async () => {
    if (!h.user) throw new UnauthorizedError();
    return h.user;
  });
  h.rows.problem = { id: PROBLEM, status: "PUBLISHED", liveVersionId: LIVE, editorialVisibleAt: null };
  h.rows.status = null;
  h.rows.activity = null;
  h.rows.hints = [1, 2, 3].map((tier) => ({
    id: `hint_${tier}`,
    problemVersionId: LIVE,
    tier,
    contentMd: `Hint ${tier}: think about *complements*.`,
  }));
  h.rows.editorial = { problemVersionId: LIVE, contentMd: "Use a hash map of complements." };
});

function nothingRecorded() {
  expect(h.db.hintReveal.createMany).not.toHaveBeenCalled();
  expect(h.db.editorialView.createMany).not.toHaveBeenCalled();
}

describe("revealHint", () => {
  it("requires a signed-in user, before reading anything", async () => {
    h.user = null;
    const result = await revealHint({ problemId: PROBLEM, tier: 1 });
    expect(result).toEqual({ ok: false, error: "You need to sign in to do that." });
    expect(h.db.problem.findUnique).not.toHaveBeenCalled();
    nothingRecorded();
  });

  it("reveals an unlocked tier of the LIVE version, records it once, returns sanitised HTML", async () => {
    const result = await revealHint({ problemId: PROBLEM, tier: 1 });
    expect(result).toEqual({ ok: true, data: { tier: 1, html: "<p>Hint 1: think about <em>complements</em>.</p>\n" } });
    expect(h.db.hint.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { problemVersionId_tier: { problemVersionId: LIVE, tier: 1 } } }),
    );
    expect(h.db.hintReveal.createMany).toHaveBeenCalledWith({
      data: [{ userId: "user_1", problemId: PROBLEM, hintId: "hint_1", tier: 1, context: "PRACTICE" }],
      skipDuplicates: true,
    });
  });

  it("refuses a locked tier: no content read, nothing recorded", async () => {
    h.rows.status = { status: "ATTEMPTED", attempts: 1, failedAttempts: 1 }; // tier 2 open, tier 3 locked
    const result = await revealHint({ problemId: PROBLEM, tier: 3 });
    expect(result).toEqual({
      ok: false,
      error: "Hint 3 is still locked. Hint 3 unlocks after 2 failed submissions or 25 minutes of work.",
    });
    expect(h.db.hint.findUnique).not.toHaveBeenCalled();
    nothingRecorded();
  });

  it("refuses tier 2 at 9 min 59 s of activity and allows it at 10 min", async () => {
    h.rows.activity = { activeSeconds: 599 };
    expect((await revealHint({ problemId: PROBLEM, tier: 2 })).ok).toBe(false);
    h.rows.activity = { activeSeconds: 600 };
    expect((await revealHint({ problemId: PROBLEM, tier: 2 })).ok).toBe(true);
  });

  it.each([
    ["tier 0", { problemId: PROBLEM, tier: 0 }],
    ["tier 4", { problemId: PROBLEM, tier: 4 }],
    ["a string tier", { problemId: PROBLEM, tier: "3" }],
    ["a fractional tier", { problemId: PROBLEM, tier: 2.5 }],
    ["a client-chosen context", { problemId: PROBLEM, tier: 3, context: "PRACTICE" }],
    ["a forged user id", { problemId: PROBLEM, tier: 3, userId: "someone_else" }],
    ["a malformed problem id", { problemId: "../../etc", tier: 1 }],
    ["no problem id", { tier: 1 }],
  ])("refuses forged input (%s) before consulting anything", async (_label, input) => {
    h.rows.status = { status: "ATTEMPTED", attempts: 9, failedAttempts: 9 };
    const result = await revealHint(input as never);
    expect(result.ok).toBe(false);
    expect(h.db.problem.findUnique).not.toHaveBeenCalled();
    nothingRecorded();
  });

  it("refuses a problem that is not published", async () => {
    h.rows.problem = { id: PROBLEM, status: "DRAFT", liveVersionId: LIVE, editorialVisibleAt: null };
    expect(await revealHint({ problemId: PROBLEM, tier: 1 })).toEqual({ ok: false, error: "That problem is not available." });
    nothingRecorded();
  });

  it("says so when the live version has no such hint", async () => {
    h.rows.hints = h.rows.hints.filter((r) => r.tier !== 1);
    expect(await revealHint({ problemId: PROBLEM, tier: 1 })).toEqual({ ok: false, error: "This problem has no hint 1." });
    nothingRecorded();
  });
});

describe("viewEditorial", () => {
  it("refuses while locked, with the reason, recording nothing", async () => {
    h.rows.status = { status: "ATTEMPTED", attempts: 4, failedAttempts: 4 };
    h.rows.activity = { activeSeconds: 60 * 60 };
    const result = await viewEditorial({ problemId: PROBLEM });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toMatch(/^The editorial unlocks when you solve this problem/);
    expect(h.db.editorial.findUnique).not.toHaveBeenCalled();
    nothingRecorded();
  });

  it("opens after 5 attempts and 45 minutes, recording the first view", async () => {
    h.rows.status = { status: "ATTEMPTED", attempts: 5, failedAttempts: 5 };
    h.rows.activity = { activeSeconds: 45 * 60 };
    const result = await viewEditorial({ problemId: PROBLEM });
    expect(result).toEqual({ ok: true, data: { html: "<p>Use a hash map of complements.</p>\n" } });
    expect(h.db.editorialView.createMany).toHaveBeenCalledWith({
      data: [{ userId: "user_1", problemId: PROBLEM }],
      skipDuplicates: true,
    });
  });

  it("opens once solved, and from editorialVisibleAt", async () => {
    h.rows.status = { status: "SOLVED", attempts: 1, failedAttempts: 0 };
    expect((await viewEditorial({ problemId: PROBLEM })).ok).toBe(true);
    h.rows.status = null;
    h.rows.problem = { id: PROBLEM, status: "PUBLISHED", liveVersionId: LIVE, editorialVisibleAt: new Date(Date.now() - 1_000) };
    expect((await viewEditorial({ problemId: PROBLEM })).ok).toBe(true);
    h.rows.problem = { id: PROBLEM, status: "PUBLISHED", liveVersionId: LIVE, editorialVisibleAt: new Date(Date.now() + 60_000) };
    expect((await viewEditorial({ problemId: PROBLEM })).ok).toBe(false);
  });

  it("refuses forged input", async () => {
    h.rows.status = { status: "SOLVED", attempts: 1, failedAttempts: 0 };
    for (const input of [{ problemId: PROBLEM, context: "PRACTICE" }, { problemId: "" }, {}]) {
      expect((await viewEditorial(input as never)).ok).toBe(false);
    }
    expect(h.db.problem.findUnique).not.toHaveBeenCalled();
    nothingRecorded();
  });

  it("says so when there is no editorial", async () => {
    h.rows.status = { status: "SOLVED", attempts: 1, failedAttempts: 0 };
    h.rows.editorial = null;
    expect(await viewEditorial({ problemId: PROBLEM })).toEqual({ ok: false, error: "This problem has no editorial yet." });
    nothingRecorded();
  });
});

describe("contest and assessment contexts get nothing", () => {
  beforeEach(() => {
    // Every practice condition met: solved, many failures, hours of work, editorial date passed.
    h.rows.status = { status: "SOLVED", attempts: 20, failedAttempts: 19 };
    h.rows.activity = { activeSeconds: 10 * 3_600 };
    h.rows.problem = { id: PROBLEM, status: "PUBLISHED", liveVersionId: LIVE, editorialVisibleAt: new Date(0) };
  });

  it.each(["CONTEST", "ASSESSMENT"] as const)("%s: no hint tier, not even tier 1", async (context) => {
    for (const tier of [1, 2, 3]) {
      await expect(revealHintFor("user_1", { problemId: PROBLEM, tier }, context)).rejects.toThrow(
        "Hints are not available during contests and assessments.",
      );
    }
    expect(h.db.hint.findUnique).not.toHaveBeenCalled();
    nothingRecorded();
  });

  it.each(["CONTEST", "ASSESSMENT"] as const)("%s: no editorial", async (context) => {
    await expect(viewEditorialFor("user_1", { problemId: PROBLEM }, context)).rejects.toThrow(
      "Editorials are not available during contests and assessments.",
    );
    expect(h.db.editorial.findUnique).not.toHaveBeenCalled();
    nothingRecorded();
  });

  it("the same state in PRACTICE opens everything (the refusal is the context, nothing else)", async () => {
    await expect(revealHintFor("user_1", { problemId: PROBLEM, tier: 3 }, "PRACTICE")).resolves.toMatchObject({ tier: 3 });
    await expect(viewEditorialFor("user_1", { problemId: PROBLEM }, "PRACTICE")).resolves.toHaveProperty("html");
  });
});
