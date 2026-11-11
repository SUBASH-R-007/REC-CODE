import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The Hints / Editorial tab view models (src/lib/help/panels.ts) with a fake
 * db: states come only from the chokepoint, locked content is never even
 * queried, and every closed / empty / stale case says so.
 */

type HintRow = { id: string; problemVersionId: string; tier: number; contentMd: string };

const h = vi.hoisted(() => {
  const rows = {
    problem: null as null | { id: string; status: string; liveVersionId: string | null; editorialVisibleAt: Date | null },
    status: null as null | { status: "ATTEMPTED" | "SOLVED"; attempts: number; failedAttempts: number },
    activity: null as null | { activeSeconds: number },
    hints: [] as HintRow[],
    reveals: [] as { tier: number }[],
    editorial: null as null | { id: string; problemVersionId: string; contentMd: string },
    viewed: false,
  };
  type Where = { problemVersionId?: string; tier?: { in: number[] } };
  const db = {
    problem: { findUnique: vi.fn(async () => rows.problem) },
    userProblemStatus: { findUnique: vi.fn(async () => rows.status) },
    problemActivity: { findUnique: vi.fn(async () => rows.activity) },
    hint: {
      findMany: vi.fn(async (args: { where: Where; select: Record<string, boolean> }) =>
        rows.hints
          .filter((r) => r.problemVersionId === args.where.problemVersionId)
          .filter((r) => !args.where.tier || args.where.tier.in.includes(r.tier))
          .map((r) => Object.fromEntries(Object.keys(args.select).map((k) => [k, r[k as keyof HintRow]]))),
      ),
    },
    hintReveal: { findMany: vi.fn(async () => rows.reveals) },
    editorial: {
      findUnique: vi.fn(async (args: { where: { problemVersionId?: string; id?: string }; select: Record<string, boolean> }) => {
        const e = rows.editorial;
        if (!e) return null;
        if (args.where.problemVersionId && args.where.problemVersionId !== e.problemVersionId) return null;
        if (args.where.id && args.where.id !== e.id) return null;
        return Object.fromEntries(Object.keys(args.select).map((k) => [k, e[k as keyof typeof e]]));
      }),
    },
    editorialView: {
      findUnique: vi.fn(async () => (rows.viewed ? { firstViewedAt: new Date() } : null)),
    },
  };
  return { rows, db };
});

vi.mock("@/lib/db", () => ({ db: h.db }));

const { loadHintsPanel, loadEditorialPanel } = await import("@/lib/help/panels");

const NOW = new Date("2026-10-10T10:00:00.000Z");
const USER = "user_1";
const PROBLEM = "prob_1";
const LIVE = "ver_live";

function hint(tier: number, versionId = LIVE): HintRow {
  return { id: `hint_${versionId}_${tier}`, problemVersionId: versionId, tier, contentMd: `Tier **${tier}** text` };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.rows.problem = { id: PROBLEM, status: "PUBLISHED", liveVersionId: LIVE, editorialVisibleAt: null };
  h.rows.status = null;
  h.rows.activity = null;
  h.rows.hints = [hint(1), hint(2), hint(3), hint(1, "ver_old")];
  h.rows.reveals = [];
  h.rows.editorial = { id: "ed_1", problemVersionId: LIVE, contentMd: "## Approach\n\nUse a hash map." };
  h.rows.viewed = false;
});

const hints = (versionId = LIVE) => loadHintsPanel(USER, PROBLEM, versionId, "PRACTICE", { now: NOW });
const editorial = (versionId = LIVE) => loadEditorialPanel(USER, PROBLEM, versionId, "PRACTICE", { now: NOW });

/** Every tier whose contentMd was selected by any hint query. */
function contentTiersQueried(): number[] {
  return h.db.hint.findMany.mock.calls
    .filter(([args]) => args.select.contentMd)
    .flatMap(([args]) => args.where.tier?.in ?? [1, 2, 3]);
}

describe("loadHintsPanel", () => {
  it("fresh start: hint 1 open, 2 and 3 locked with their conditions, no content loaded", async () => {
    const view = await hints();
    expect(view).toEqual({
      kind: "ready",
      progress: "So far: 0 failed submissions and 0 minutes of active work.",
      rows: [
        { tier: 1, state: "available", warning: null },
        { tier: 2, state: "locked", condition: "Hint 2 unlocks after 1 failed submission or 10 minutes of work." },
        { tier: 3, state: "locked", condition: "Hint 3 unlocks after 2 failed submissions or 25 minutes of work." },
      ],
    });
    expect(contentTiersQueried()).toEqual([]);
  });

  it("only revealed AND allowed tiers carry content — a reveal never outranks the chokepoint", async () => {
    h.rows.status = { status: "ATTEMPTED", attempts: 1, failedAttempts: 1 };
    // Reveals for every tier exist (e.g. forged rows); access stops at tier 2.
    h.rows.reveals = [{ tier: 1 }, { tier: 2 }, { tier: 3 }];
    const view = await hints();
    expect(view.kind).toBe("ready");
    if (view.kind !== "ready") return;
    expect(view.rows.map((r) => r.state)).toEqual(["revealed", "revealed", "locked"]);
    expect(contentTiersQueried().sort()).toEqual([1, 2]);
    const first = view.rows[0];
    expect(first?.state === "revealed" && first.html).toBe("<p>Tier <strong>1</strong> text</p>\n");
  });

  it("warns before hint 3 while unsolved, and not once solved", async () => {
    h.rows.status = { status: "ATTEMPTED", attempts: 2, failedAttempts: 2 };
    let view = await hints();
    expect(view.kind === "ready" && view.rows[2]).toEqual({
      tier: 3,
      state: "available",
      warning: "Using hint 3 marks a later solve as assisted (40% XP).",
    });
    expect(view.kind === "ready" && view.rows[1]).toEqual({ tier: 2, state: "available", warning: null });

    h.rows.status = { status: "SOLVED", attempts: 3, failedAttempts: 2 };
    view = await hints();
    expect(view.kind === "ready" && view.rows[2]).toEqual({ tier: 3, state: "available", warning: null });
  });

  it("unlocks by active time alone", async () => {
    h.rows.activity = { activeSeconds: 25 * 60 };
    const view = await hints();
    expect(view.kind === "ready" && view.rows.map((r) => r.state)).toEqual(["available", "available", "available"]);
    expect(view.kind === "ready" && view.progress).toBe("So far: 0 failed submissions and 25 minutes of active work.");
  });

  it("sanitises revealed content", async () => {
    h.rows.hints = [{ ...hint(1), contentMd: "<script>alert(1)</script>\n\nSee [this](javascript:alert(1)) and <img src=x onerror=alert(1)>" }];
    h.rows.reveals = [{ tier: 1 }];
    const view = await hints();
    const row = view.kind === "ready" ? view.rows[0] : undefined;
    const html = row?.state === "revealed" ? row.html : "";
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toMatch(/<script|<img|href="javascript/i);
  });

  it("says so when the version has no hints", async () => {
    h.rows.hints = [hint(1, "ver_old")];
    expect(await hints()).toEqual({ kind: "empty" });
  });

  it("refuses a contest without reading a single hint", async () => {
    h.rows.status = { status: "ATTEMPTED", attempts: 9, failedAttempts: 9 };
    for (const context of ["CONTEST", "ASSESSMENT"] as const) {
      const view = await loadHintsPanel(USER, PROBLEM, LIVE, context, { now: NOW });
      expect(view).toEqual({ kind: "closed", message: "Hints are not available during contests and assessments." });
    }
    expect(h.db.hint.findMany).not.toHaveBeenCalled();
    expect(h.db.hintReveal.findMany).not.toHaveBeenCalled();
  });

  it("reports a version that is no longer live instead of mixing versions", async () => {
    const view = await hints("ver_old");
    expect(view.kind).toBe("stale");
    expect(h.db.hint.findMany).not.toHaveBeenCalled();
  });

  it("is unavailable for an unpublished problem", async () => {
    h.rows.problem = { id: PROBLEM, status: "DRAFT", liveVersionId: LIVE, editorialVisibleAt: null };
    expect((await hints()).kind).toBe("unavailable");
    expect(h.db.hint.findMany).not.toHaveBeenCalled();
  });
});

describe("loadEditorialPanel", () => {
  it("locked: the reason and the student's progress, content never loaded", async () => {
    h.rows.status = { status: "ATTEMPTED", attempts: 2, failedAttempts: 2 };
    h.rows.activity = { activeSeconds: 12 * 60 + 30 };
    const view = await editorial();
    expect(view).toEqual({
      kind: "locked",
      reason:
        "The editorial unlocks when you solve this problem, or after 5 attempts and 45 minutes of work. So far: 2 attempts and 12 minutes of active work.",
    });
    const selects = h.db.editorial.findUnique.mock.calls.map(([args]) => args.select);
    expect(selects.every((s) => !("contentMd" in s))).toBe(true);
  });

  it("names the date when the editorial opens to everyone later", async () => {
    h.rows.problem = {
      id: PROBLEM,
      status: "PUBLISHED",
      liveVersionId: LIVE,
      editorialVisibleAt: new Date("2026-10-12T12:30:00.000Z"),
    };
    const view = await editorial();
    expect(view.kind === "locked" && view.reason).toContain("It also opens to everyone on 12 Oct 2026, 6:00 pm IST.");
  });

  it("available before solving: explicit step with the assisted warning", async () => {
    h.rows.status = { status: "ATTEMPTED", attempts: 5, failedAttempts: 5 };
    h.rows.activity = { activeSeconds: 45 * 60 };
    expect(await editorial()).toEqual({
      kind: "available",
      warning: "Viewing the editorial before you solve this problem marks your solve as assisted (40% XP).",
    });
  });

  it("available once solved: no warning", async () => {
    h.rows.status = { status: "SOLVED", attempts: 1, failedAttempts: 0 };
    expect(await editorial()).toEqual({ kind: "available", warning: null });
  });

  it("available from editorialVisibleAt for everyone", async () => {
    h.rows.problem = { id: PROBLEM, status: "PUBLISHED", liveVersionId: LIVE, editorialVisibleAt: new Date(NOW.getTime() - 1) };
    expect((await editorial()).kind).toBe("available");
  });

  it("viewed: the sanitised content, headings demoted below the page's h2", async () => {
    h.rows.status = { status: "SOLVED", attempts: 1, failedAttempts: 0 };
    h.rows.viewed = true;
    const view = await editorial();
    expect(view).toEqual({ kind: "viewed", html: "<h3>Approach</h3>\n<p>Use a hash map.</p>\n" });
  });

  it("a past view does not outrank the chokepoint", async () => {
    h.rows.viewed = true; // e.g. viewed while editorialVisibleAt was in the past, since moved
    expect((await editorial()).kind).toBe("locked");
  });

  it("says so when there is no editorial", async () => {
    h.rows.editorial = null;
    h.rows.status = { status: "SOLVED", attempts: 1, failedAttempts: 0 };
    expect(await editorial()).toEqual({ kind: "empty" });
  });

  it("refuses contests and assessments without reading the editorial", async () => {
    h.rows.status = { status: "SOLVED", attempts: 1, failedAttempts: 0 };
    for (const context of ["CONTEST", "ASSESSMENT"] as const) {
      const view = await loadEditorialPanel(USER, PROBLEM, LIVE, context, { now: NOW });
      expect(view).toEqual({ kind: "closed", message: "Editorials are not available during contests and assessments." });
    }
    expect(h.db.editorial.findUnique).not.toHaveBeenCalled();
    expect(h.db.editorialView.findUnique).not.toHaveBeenCalled();
  });
});
