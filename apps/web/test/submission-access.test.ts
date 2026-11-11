import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Who may read a submission or run through the student-facing views
 * (server/queries/submissions.ts): the owner, a SUPER_ADMIN, or an ADMIN whose
 * AdminScope covers the owner. Anyone else, including an ADMIN without a
 * grant, gets null, exactly like a missing id. An in-scope ADMIN sees the
 * metadata and verdicts but never the code (sourceWithheld). The scope itself (grants to
 * students) is tested against Postgres in admin-scope.db.test.ts; here the
 * scope module is replaced so the wiring can be checked without a database.
 */

const OWNER = "student-in-other-dept";
const IN_SCOPE_FOR = new Set(["admin-cse"]);

const SUB = {
  id: "sub1",
  userId: OWNER,
  problemVersionId: "pv1",
  status: "DONE",
  verdict: "WA",
  language: "py312",
  passedCases: 1,
  totalCases: 2,
  maxTimeMs: 10,
  maxMemoryKb: 1000,
  compileOutput: null,
  testResults: [],
  score: null,
  maxScore: null,
  subtaskResults: null,
  createdAt: new Date(),
  judgedAt: new Date(),
  languageConfig: { label: "Python 3.12" },
  origin: "ASSESSMENT",
  problem: { slug: "two-sum", displayCode: "REC-0001", liveVersion: { revision: 1 } },
  problemVersion: {
    scoringMode: "ICPC",
    compareMode: "TOKEN",
    functionSignature: null,
    testCases: [],
    title: "Two Sum",
    revision: 1,
    statementMd: "x",
  },
  details: [],
  source: { source: "print('student source')", archivedAt: null },
  user: { firstName: "Priya", lastName: "Sharma" },
};

const RUN = {
  id: "run1",
  userId: OWNER,
  problemVersionId: "pv1",
  status: "DONE",
  verdict: "OK",
  language: "py312",
  customInput: "1 2",
  result: null,
  compileOutput: null,
  createdAt: new Date(),
  judgedAt: new Date(),
  expiresAt: new Date(Date.now() + 60 * 60_000),
  languageConfig: { label: "Python 3.12" },
  problemVersion: { compareMode: "TOKEN", functionSignature: null },
};

const scopeCalls: string[] = [];

vi.mock("@/lib/db", () => ({
  db: {
    submission: { findUnique: async () => SUB },
    runRequest: { findUnique: async () => RUN },
    testCase: { findMany: async () => [] },
  },
}));

vi.mock("@/lib/auth/scope", () => ({
  loadStudentScope: async (viewer: { id: string; role: string }) => {
    scopeCalls.push(viewer.id);
    return { viewerId: viewer.id };
  },
  findScopedStudent: async (scope: { viewerId: string }, where: { id: string }) =>
    where.id === OWNER && IN_SCOPE_FOR.has(scope.viewerId) ? { scopedId: OWNER } : null,
}));

type Viewer = { id: string; role: "STUDENT" | "ADMIN" | "SUPER_ADMIN" | "TA_MENTOR" };

describe("submission and run views: owner, SUPER_ADMIN or in-scope ADMIN only", () => {
  beforeEach(() => {
    scopeCalls.length = 0;
  });

  const cases: [string, boolean, Viewer][] = [
    ["the owner", true, { id: OWNER, role: "STUDENT" }],
    ["a SUPER_ADMIN", true, { id: "super", role: "SUPER_ADMIN" }],
    ["an ADMIN whose scope covers the owner", true, { id: "admin-cse", role: "ADMIN" }],
    ["an ADMIN whose scope does not cover the owner", false, { id: "admin-ece", role: "ADMIN" }],
    ["an ADMIN without a grant", false, { id: "admin-none", role: "ADMIN" }],
    ["another student", false, { id: "someone-else", role: "STUDENT" }],
    ["a TA_MENTOR", false, { id: "ta", role: "TA_MENTOR" }],
  ];

  it.each(cases)("getSubmissionDetail: %s → allowed %s", async (_label, allowed, viewer) => {
    const { getSubmissionDetail } = await import("@/server/queries/submissions");
    const detail = await getSubmissionDetail("sub1", "two-sum", viewer as never);
    if (!allowed) return expect(detail).toBeNull();
    // The owner's ASSESSMENT submission is not shown on the practice page; staff see it.
    if (viewer.role === "STUDENT") return expect(detail).toBeNull();
    // An ADMIN sees metadata and verdicts, never another student's code.
    if (viewer.role === "ADMIN") {
      expect(detail).toMatchObject({ source: null, sourceWithheld: true });
      return;
    }
    expect(detail).toMatchObject({ source: "print('student source')", sourceWithheld: false });
  });

  it.each(cases)("getStudentView(submission): %s → allowed %s", async (_label, allowed, viewer) => {
    const { getStudentView } = await import("@/server/queries/submissions");
    const view = await getStudentView("submission", "sub1", viewer as never);
    expect(view !== null).toBe(allowed);
  });

  it.each(cases)("getStudentView(run): %s → allowed %s", async (_label, allowed, viewer) => {
    const { getStudentView } = await import("@/server/queries/submissions");
    const view = await getStudentView("run", "run1", viewer as never);
    expect(view !== null).toBe(allowed);
  });

  it("consults the scope only for an ADMIN who is not the owner", async () => {
    const { getStudentView } = await import("@/server/queries/submissions");
    await getStudentView("submission", "sub1", { id: OWNER, role: "STUDENT" } as never);
    await getStudentView("submission", "sub1", { id: "super", role: "SUPER_ADMIN" } as never);
    await getStudentView("submission", "sub1", { id: "someone-else", role: "STUDENT" } as never);
    expect(scopeCalls).toEqual([]);
    await getStudentView("submission", "sub1", { id: "admin-ece", role: "ADMIN" } as never);
    expect(scopeCalls).toEqual(["admin-ece"]);
  });
});
