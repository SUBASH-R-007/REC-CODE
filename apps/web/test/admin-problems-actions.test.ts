import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * RBAC of the authoring actions (admin-problems.ts, admin-problem-content.ts):
 * every export refuses STUDENT, TA_MENTOR, PLACEMENT_OFFICER and a signed-out
 * caller with the exact Forbidden / Unauthorized result before touching the
 * database, the audit log or the queue. Allowed paths are checked for their
 * audit names and sensitivities and for the publish contract.
 */

const h = vi.hoisted(() => {
  const user = { current: null as null | { id: string; role: string } };
  const touched: string[] = [];
  const db = new Proxy(
    {},
    {
      get(_t, prop) {
        touched.push(String(prop));
        throw new Error(`DbTouched: ${String(prop)}`);
      },
    },
  );
  return { user, touched, db, audit: vi.fn(), enqueue: vi.fn() };
});

vi.mock("@/lib/auth/session", () => ({ getCurrentUser: async () => h.user.current }));
vi.mock("@/lib/db", () => ({ db: h.db }));
vi.mock("@/lib/audit", () => ({ audit: h.audit }));
vi.mock("@/lib/ip", () => ({ requestIpHash: async () => "iphash" }));
vi.mock("@/lib/judge/queue", () => ({ enqueueJudge: h.enqueue }));
vi.mock("@/lib/testdata/store", () => ({ getTestDataStore: () => ({}) }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined, revalidateTag: () => undefined }));
vi.mock("@/lib/authoring/edits", () => ({
  updateDraftDetails: vi.fn(async () => ({ versionId: "v1", problemId: "p1", revision: 2, editSeq: 5, judgeSeq: 3 })),
  updateDraftJudging: vi.fn(),
  setDraftChecker: vi.fn(),
  upsertReferenceSolution: vi.fn(),
  removeReferenceSolution: vi.fn(),
  upsertStarterCode: vi.fn(),
  removeStarterCode: vi.fn(),
  setDraftHelp: vi.fn(),
}));
vi.mock("@/lib/judge/validation", async (orig) => {
  const real = await orig<typeof import("@/lib/judge/validation")>();
  return { ...real, publishVersion: vi.fn(), startValidation: vi.fn(), advanceValidation: vi.fn(), redispatchQueuedRuns: vi.fn() };
});

const problems = await import("@/server/actions/admin-problems");
const content = await import("@/server/actions/admin-problem-content");
const validation = await import("@/lib/judge/validation");

const FORBIDDEN = { ok: false, error: "You don't have permission to do that." };
const UNAUTHORIZED = { ok: false, error: "You need to sign in to do that." };

type AnyAction = (input: unknown) => Promise<unknown>;
const EXPORTS: [string, AnyAction][] = [
  ...Object.entries(problems).map(([name, fn]) => [`admin-problems#${name}`, fn as AnyAction] as [string, AnyAction]),
  ...Object.entries(content).map(([name, fn]) => [`admin-problem-content#${name}`, fn as AnyAction] as [string, AnyAction]),
];

beforeEach(() => {
  vi.clearAllMocks();
  h.touched.length = 0;
  h.user.current = null;
});

describe("authoring actions RBAC", () => {
  it("covers every export of both modules", () => {
    expect(EXPORTS.map(([n]) => n)).toEqual(
      expect.arrayContaining([
        "admin-problems#createProblem",
        "admin-problems#publishProblemVersion",
        "admin-problems#approveVersion",
        "admin-problem-content#addDraftTests",
        "admin-problem-content#upsertReferenceSolution",
      ]),
    );
    expect(EXPORTS.length).toBeGreaterThanOrEqual(25);
    for (const [, fn] of EXPORTS) expect(typeof fn).toBe("function");
  });

  it.each(["STUDENT", "TA_MENTOR", "PLACEMENT_OFFICER"])("refuses %s on every export before any database access", async (role) => {
    h.user.current = { id: `u-${role}`, role };
    for (const [name, fn] of EXPORTS) {
      const result = await fn({ versionId: "v1", problemId: "p1", expectedEditSeq: 0, expectedProblemVersion: 0, importId: "i1" });
      expect(result, name).toEqual(FORBIDDEN);
    }
    expect(h.touched).toEqual([]);
    expect(h.audit).not.toHaveBeenCalled();
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it("refuses a signed-out caller on every export", async () => {
    for (const [name, fn] of EXPORTS) expect(await fn({}), name).toEqual(UNAUTHORIZED);
    expect(h.touched).toEqual([]);
    expect(h.audit).not.toHaveBeenCalled();
  });

  it("refuses a super-admin who is viewing as another user (read-only impersonation)", async () => {
    h.user.current = { id: "super", role: "SUPER_ADMIN", impersonation: { impersonator: { id: "super" } } } as never;
    const result = (await problems.createProblem({} as never)) as { ok: boolean; error: string };
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/read-only/);
    expect(h.touched).toEqual([]);
  });
});

describe("allowed paths", () => {
  it("a content edit is audited as problem.draft.edited (NORMAL) with the new editSeq", async () => {
    h.user.current = { id: "admin-1", role: "ADMIN" };
    const result = await content.updateDraftDetails({
      versionId: "v1",
      expectedEditSeq: 4,
      title: "Loud Echo",
      difficulty: "EASY",
      statementMd: "Statement",
      constraints: [],
      origin: "FACULTY",
    });
    expect(result).toEqual({ ok: true, data: { editSeq: 5, judgeSeq: 3 } });
    expect(h.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: "admin-1",
        action: "problem.draft.edited",
        entityType: "ProblemVersion",
        entityId: "v1",
        sensitivity: "NORMAL",
        ipHash: "iphash",
        metadata: expect.objectContaining({ section: "details", editSeq: 5, versionId: "v1" }),
      }),
    );
  });

  it("a judging edit forwards the answers the form asked for: the SQL ordering and the edit budget", async () => {
    h.user.current = { id: "admin-1", role: "ADMIN" };
    const edits = await import("@/lib/authoring/edits");
    vi.mocked(edits.updateDraftJudging).mockResolvedValue({
      versionId: "v1",
      problemId: "p1",
      revision: 2,
      editSeq: 6,
      judgeSeq: 4,
    });

    /**
     * Phase 12k asked the author whether the row order is part of a SQL
     * answer "rather than guessing it" — and this action dropped the
     * answer on the floor, defaulting it to true. Phase 12m found that
     * while adding the edit budget beside it, so both are asserted here.
     */
    const sql = await content.updateDraftJudging({
      versionId: "v1",
      expectedEditSeq: 5,
      ioMode: "SQL",
      functionSignature: "",
      compareMode: "TOKEN",
      floatEpsilon: null,
      scoringMode: "ICPC",
      stopOnFirstFailure: true,
      timeLimitMs: 2000,
      memoryLimitMb: 256,
      sqlOrdered: false,
    } as never);
    expect(sql).toEqual({ ok: true, data: { editSeq: 6, judgeSeq: 4 } });
    expect(edits.updateDraftJudging).toHaveBeenLastCalledWith(
      expect.objectContaining({ ioMode: "SQL", sqlOrdered: false, maxEditedLines: null }),
    );

    // The budget arrives as a string from the form, and blank means "not a
    // debugging problem" rather than a budget of zero.
    await content.updateDraftJudging({
      versionId: "v1",
      expectedEditSeq: 6,
      ioMode: "STDIN",
      functionSignature: "",
      compareMode: "TOKEN",
      floatEpsilon: "",
      scoringMode: "ICPC",
      stopOnFirstFailure: true,
      timeLimitMs: 2000,
      memoryLimitMb: 256,
      maxEditedLines: "3",
    });
    expect(edits.updateDraftJudging).toHaveBeenLastCalledWith(expect.objectContaining({ maxEditedLines: 3 }));

    await content.updateDraftJudging({
      versionId: "v1",
      expectedEditSeq: 7,
      ioMode: "STDIN",
      functionSignature: "",
      compareMode: "TOKEN",
      floatEpsilon: "",
      scoringMode: "ICPC",
      stopOnFirstFailure: true,
      timeLimitMs: 2000,
      memoryLimitMb: 256,
      maxEditedLines: "",
    });
    expect(edits.updateDraftJudging).toHaveBeenLastCalledWith(expect.objectContaining({ maxEditedLines: null }));

    const refused = (await content.updateDraftJudging({
      versionId: "v1",
      expectedEditSeq: 8,
      ioMode: "STDIN",
      functionSignature: "",
      compareMode: "TOKEN",
      floatEpsilon: "",
      scoringMode: "ICPC",
      stopOnFirstFailure: true,
      timeLimitMs: 2000,
      memoryLimitMb: 256,
      maxEditedLines: "0",
    })) as { ok: boolean };
    expect(refused.ok).toBe(false);
  });

  it("publish requires expectedProblemVersion and passes the approval gate and actor to the library", async () => {
    h.user.current = { id: "admin-2", role: "SUPER_ADMIN" };
    const missing = (await problems.publishProblemVersion({ versionId: "v1" } as never)) as { ok: boolean };
    expect(missing.ok).toBe(false);
    expect(validation.publishVersion).not.toHaveBeenCalled();

    vi.mocked(validation.publishVersion).mockResolvedValueOnce({ ok: true, problemId: "p1", versionId: "v1", revision: 3 });
    expect(await problems.publishProblemVersion({ versionId: "v1", expectedProblemVersion: 7 })).toEqual({
      ok: true,
      data: { problemId: "p1", revision: 3 },
    });
    expect(validation.publishVersion).toHaveBeenCalledWith("v1", {
      actorId: "admin-2",
      via: "admin",
      expectedProblemVersion: 7,
      requireApproval: true,
      ipHash: "iphash",
    });

    vi.mocked(validation.publishVersion).mockResolvedValueOnce({ ok: false, reason: "CONFLICT", message: validation.PUBLISH_CONFLICT_MESSAGE });
    expect(await problems.publishProblemVersion({ versionId: "v1", expectedProblemVersion: 7 })).toEqual({
      ok: false,
      error: validation.PUBLISH_CONFLICT_MESSAGE,
    });

    vi.mocked(validation.publishVersion).mockResolvedValueOnce({ ok: false, reason: "BLOCKED", blockers: ["first reason", "second reason"] });
    const blocked = (await problems.publishProblemVersion({ versionId: "v1", expectedProblemVersion: 7 })) as { ok: false; error: string };
    expect(blocked.error).toBe("Publishing is blocked: first reason (+1 more — see the validation report)");
  });

  it("submitting for review requires the originality attestation", async () => {
    h.user.current = { id: "admin-1", role: "ADMIN" };
    const result = (await problems.submitForReview({ versionId: "v1", expectedEditSeq: 0, attestOriginal: false })) as {
      ok: false;
      error: string;
    };
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/originally authored/);
    expect(h.touched).toEqual([]);
  });

  it("previewStatement renders sanitised Markdown", async () => {
    h.user.current = { id: "admin-1", role: "ADMIN" };
    const result = (await problems.previewStatement({ markdown: "# Title\n\n<script>alert(1)</script>" })) as {
      ok: true;
      data: { html: string };
    };
    expect(result.data.html).toContain("<h3>Title</h3>");
    expect(result.data.html).not.toContain("<script>");
  });
});
