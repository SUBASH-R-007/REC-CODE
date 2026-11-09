import { randomBytes } from "node:crypto";
import { freeDisplayCode } from "./support/display-code";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Defect reports against the real tables (Phase 16a).
 *
 * What this file is for is the three rules that are NOT in TypeScript:
 *
 *   * one OPEN report per student per revision, which is a partial unique
 *     index and therefore a race nobody can lose twice;
 *   * a decision is all three columns or none, which is a CHECK;
 *   * a held problem is refused a pin into a new paper, which is a trigger
 *     on `AssessmentProblem` — and, just as importantly, an EXISTING pin is
 *     not touched by the hold being set, because a paper somebody is
 *     part-way through setting must not break under them.
 *
 * It makes every row it needs (docs/ROADMAP.md §3.2's own lesson, learned in
 * Phase 15q): a migrated database with nothing seeded in it runs this file.
 *
 * Opt-in: RECX_DB_TESTS=1.
 */
const ENABLED = process.env.RECX_DB_TESTS === "1";

vi.hoisted(() => {
  if (process.env.RECX_DB_TESTS === "1") {
    process.env.DATABASE_URL =
      process.env.RECX_TEST_DATABASE_URL ?? "postgresql://recx:recx-dev-only@127.0.0.1:5433/recx_test";
    process.env.IP_HASH_PEPPER ??= "problem-reports-test-pepper";
  }
});

vi.mock("next/headers", () => ({
  headers: async () => new Headers(),
  cookies: async () => ({ get: () => undefined, set: () => undefined, delete: () => undefined }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined, revalidateTag: () => undefined }));

describe.skipIf(!ENABLED)("defect reports against recx_test", () => {
  const tag = `rep-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
  let db: (typeof import("@/lib/db"))["db"];
  let reports: typeof import("@/lib/problems/reports");

  let staffId = "";
  let studentId = "";
  let otherStudentId = "";
  let problemId = "";
  let versionId = "";
  let draftProblemId = "";
  /** Reporters made inside a test, so afterAll can take them away again. */
  const extraUserIds: string[] = [];

  async function user(suffix: string, role: "STUDENT" | "SUPER_ADMIN"): Promise<string> {
    const row = await db.user.create({
      data: {
        collegeId: `${tag}-${suffix}`.toUpperCase().slice(0, 32),
        email: `${tag}-${suffix}@rajalakshmi.edu.invalid`,
        firstName: "Report",
        lastName: suffix,
        handle: `${tag}-${suffix}`.slice(0, 30),
        role,
        status: "ACTIVE",
      },
      select: { id: true },
    });
    return row.id;
  }

  /** A published problem of its own: created, then a frozen revision, then made live. */
  async function publishedProblem(suffix: string): Promise<{ problemId: string; versionId: string }> {
    const problem = await db.problem.create({
      data: {
        slug: `${tag}-${suffix}`,
        displayCode: await freeDisplayCode(db),
        title: "Add them up",
        difficulty: "EASY",
        status: "PUBLISHED",
      },
      select: { id: true },
    });
    const version = await db.problemVersion.create({
      data: {
        problemId: problem.id,
        revision: 1,
        status: "PUBLISHED",
        title: "Add them up",
        difficulty: "EASY",
        statementMd: "Add them up.",
        ioMode: "STDIN",
        compareMode: "TOKEN",
        scoringMode: "ICPC",
        stopOnFirstFailure: true,
        timeLimitMs: 2000,
      } as never,
      select: { id: true },
    });
    // Frozen by UPDATE: the guard refuses a row that arrives frozen.
    await db.$executeRawUnsafe(`UPDATE "ProblemVersion" SET "frozenAt" = now() WHERE id = $1`, version.id);
    await db.problem.update({ where: { id: problem.id }, data: { liveVersionId: version.id } });
    return { problemId: problem.id, versionId: version.id };
  }

  async function draftAssessment(suffix: string): Promise<string> {
    const row = await db.assessment.create({
      data: {
        slug: `${tag}-${suffix}`,
        title: "A paper",
        instructions: "Answer everything.",
        status: "DRAFT",
        proctorMode: "ADVISORY",
        opensAt: new Date(Date.now() + 86_400_000),
        closesAt: new Date(Date.now() + 90_000_000),
        durationSec: 3_600,
        createdById: staffId,
      } as never,
      select: { id: true },
    });
    return row.id;
  }

  beforeAll(async () => {
    ({ db } = await import("@/lib/db"));
    reports = await import("@/lib/problems/reports");

    staffId = await user("staff", "SUPER_ADMIN");
    studentId = await user("stud", "STUDENT");
    otherStudentId = await user("other", "STUDENT");

    ({ problemId, versionId } = await publishedProblem("live"));

    const draft = await db.problem.create({
      data: {
        slug: `${tag}-draft`,
        displayCode: await freeDisplayCode(db),
        title: "Not published",
        difficulty: "EASY",
        status: "DRAFT",
      },
      select: { id: true },
    });
    draftProblemId = draft.id;
  }, 120_000);

  afterAll(async () => {
    if (!ENABLED) return;
    const problemIds = [problemId, draftProblemId].filter(Boolean);
    await db.$executeRawUnsafe(
      `DELETE FROM "ProblemReport" WHERE "reporterId" = ANY($1::text[])`,
      [studentId, otherStudentId, staffId, ...extraUserIds].filter(Boolean),
    );
    const assessments = await db.assessment.findMany({ where: { slug: { startsWith: tag } }, select: { id: true } });
    const ids = assessments.map((a) => a.id);
    await db.assessmentProblem.deleteMany({ where: { assessmentId: { in: ids } } });
    await db.assessment.deleteMany({ where: { id: { in: ids } } });
    await db.auditLog.deleteMany({ where: { actorId: staffId } });
    const { cleanup } = await import("./support/authoring-fixtures");
    await cleanup(db, {
      problemIds,
      userIds: [studentId, otherStudentId, staffId, ...extraUserIds].filter(Boolean),
      blobShas: [],
    });
  }, 120_000);

  it("takes a report on a published problem", async () => {
    const result = await reports.reportProblemFor(studentId, {
      problemId,
      reason: "WRONG_EXPECTED_OUTPUT",
      detail: "Case 3 expects 7 but 1 + 2 + 3 is 6.",
    });
    expect(result.problemVersionId).toBe(versionId);
    const row = await db.problemReport.findUniqueOrThrow({
      where: { id: result.reportId },
      select: { status: true, resolvedAt: true, resolvedById: true, resolution: true },
    });
    // An OPEN report is three nulls: the CHECK says so, and it is what
    // "a report changes nothing on its own" means in the data.
    expect(row).toEqual({ status: "OPEN", resolvedAt: null, resolvedById: null, resolution: null });
  }, 60_000);

  it("refuses a second open report from the same student on the same revision", async () => {
    await expect(
      reports.reportProblemFor(studentId, { problemId, reason: "STATEMENT_UNCLEAR", detail: "Still looks wrong." }),
    ).rejects.toThrow(/already reported/i);
  }, 60_000);

  it("takes another student's report on the same revision", async () => {
    const result = await reports.reportProblemFor(otherStudentId, {
      problemId,
      reason: "LIMITS_TOO_TIGHT",
      detail: "My O(n log n) solution is TLE.",
    });
    expect(result.reportId).toBeTruthy();
  }, 60_000);

  it("refuses a report on a problem that is not published", async () => {
    await expect(
      reports.reportProblemFor(studentId, { problemId: draftProblemId, reason: "OTHER", detail: "Draft." }),
    ).rejects.toThrow(/not found/i);
  }, 60_000);

  it("refuses an empty detail at the database as well as at the schema", async () => {
    await expect(
      db.problemReport.create({
        data: { problemVersionId: versionId, reporterId: staffId, reason: "OTHER", detail: "   " },
      }),
    ).rejects.toThrow();
  }, 60_000);

  it("refuses a decided row with no answer on it", async () => {
    // The other door: the CHECK, with no action in the way.
    await expect(
      db.problemReport.create({
        data: {
          problemVersionId: versionId,
          reporterId: staffId,
          reason: "OTHER",
          detail: "Raw.",
          status: "UPHELD",
        } as never,
      }),
    ).rejects.toThrow();
  }, 60_000);

  describe("deciding one", () => {
    it("records the answer, and refuses a second decision", async () => {
      const filed = await reports.reportProblemFor(staffId, {
        problemId,
        reason: "STATEMENT_UNCLEAR",
        detail: "The second paragraph contradicts the first.",
      });
      const decided = await reports.decideProblemReportAs(staffId, {
        reportId: filed.reportId,
        status: "DISMISSED",
        resolution: "Checked: the sentence is right, the sample was misread.",
        hold: false,
        holdReason: null,
      });
      expect(decided).toMatchObject({ status: "DISMISSED", held: false, problemId });

      const row = await db.problemReport.findUniqueOrThrow({
        where: { id: filed.reportId },
        select: { status: true, resolvedById: true, resolution: true, resolvedAt: true },
      });
      expect(row.status).toBe("DISMISSED");
      expect(row.resolvedById).toBe(staffId);
      expect(row.resolution).toMatch(/misread/);
      expect(row.resolvedAt).not.toBeNull();

      await expect(
        reports.decideProblemReportAs(staffId, {
          reportId: filed.reportId,
          status: "UPHELD",
          resolution: "Changed my mind.",
          hold: false,
          holdReason: null,
        }),
      ).rejects.toThrow(/already been decided/i);
    }, 90_000);

    it("refuses a decision with no sentence in it", async () => {
      // A reporter of its own: `otherStudentId` already holds an open
      // report on this revision, and the rule the test above proves would
      // refuse a second one — which would be this test failing for the
      // previous test's reason.
      const freshId = await user(`fresh-${extraUserIds.length}`, "STUDENT");
      extraUserIds.push(freshId);
      const filed = await reports.reportProblemFor(freshId, {
        problemId,
        reason: "OTHER",
        detail: "Something.",
      });
      await expect(
        reports.decideProblemReportAs(staffId, {
          reportId: filed.reportId,
          status: "UPHELD",
          resolution: "   ",
          hold: false,
          holdReason: null,
        }),
      ).rejects.toThrow(/Write what you decided/i);
      // And it is still open, so the queue has not silently lost it.
      const row = await db.problemReport.findUniqueOrThrow({ where: { id: filed.reportId }, select: { status: true } });
      expect(row.status).toBe("OPEN");
    }, 90_000);
  });

  describe("the hold, and what it does and does not touch", () => {
    it("refuses a flag with no reason and no stamp", async () => {
      await expect(
        db.problem.update({ where: { id: problemId }, data: { qualityHold: true } }),
      ).rejects.toThrow();
    }, 60_000);

    it("withholds the problem from a NEW pin and leaves an existing one alone", async () => {
      const { problemId: ownId, versionId: ownVersionId } = await publishedProblem("held");
      const paper = await draftAssessment("paper-a");

      // Pinned BEFORE the hold: this is the row that must survive.
      const existing = await db.assessmentProblem.create({
        data: { assessmentId: paper, problemVersionId: ownVersionId, position: 1, points: 10 },
        select: { id: true },
      });

      const filed = await reports.reportProblemFor(studentId, {
        problemId: ownId,
        reason: "WRONG_EXPECTED_OUTPUT",
        detail: "Case 2 is wrong.",
      });
      const decided = await reports.decideProblemReportAs(staffId, {
        reportId: filed.reportId,
        status: "UPHELD",
        resolution: "You are right. Revision 2 will fix it.",
        hold: true,
        holdReason: "case 2 expects the wrong sum",
      });
      expect(decided.held).toBe(true);

      // The existing pin is still there, and still readable.
      expect(await db.assessmentProblem.count({ where: { id: existing.id } })).toBe(1);

      // A NEW pin, on another paper, is refused by the trigger.
      const second = await draftAssessment("paper-b");
      await expect(
        db.assessmentProblem.create({
          data: { assessmentId: second, problemVersionId: ownVersionId, position: 1, points: 10 },
        }),
      ).rejects.toThrow(/withheld from new papers/i);

      // Clearing it lets the pin through again.
      await reports.clearQualityHoldAs(staffId, { problemId: ownId, reason: "revision 2 published" });
      const after = await db.assessmentProblem.create({
        data: { assessmentId: second, problemVersionId: ownVersionId, position: 1, points: 10 },
        select: { id: true },
      });
      expect(after.id).toBeTruthy();

      // And the hold's three columns went back to null together.
      const row = await db.problem.findUniqueOrThrow({
        where: { id: ownId },
        select: { qualityHold: true, qualityHoldReason: true, qualityHeldById: true, qualityHeldAt: true },
      });
      expect(row).toEqual({ qualityHold: false, qualityHoldReason: null, qualityHeldById: null, qualityHeldAt: null });

      await db.assessmentProblem.deleteMany({ where: { assessmentId: { in: [paper, second] } } });
      await db.assessment.deleteMany({ where: { id: { in: [paper, second] } } });
      await db.$executeRawUnsafe(`DELETE FROM "ProblemReport" WHERE "problemVersionId" = $1`, ownVersionId);
      const { cleanup } = await import("./support/authoring-fixtures");
      await cleanup(db, { problemIds: [ownId], userIds: [], blobShas: [] });
    }, 180_000);

    it("refuses clearing a hold that is not there", async () => {
      await expect(
        reports.clearQualityHoldAs(staffId, { problemId, reason: "nothing to clear" }),
      ).rejects.toThrow(/not withheld/i);
    }, 60_000);
  });

  it("counts open reports per problem for the admin list", async () => {
    const counts = await reports.openReportCounts([problemId, draftProblemId]);
    // Two were filed on this problem and left open (the student's and the
    // other student's); the staff one was decided, and a decided report is
    // not work waiting for anybody.
    expect(counts.get(problemId)).toBeGreaterThanOrEqual(1);
    expect(counts.get(draftProblemId)).toBeUndefined();
  }, 60_000);

  it("shows a student only their own reports, on the live revision", async () => {
    const mine = await reports.myReportsFor(studentId, problemId);
    expect(mine.length).toBeGreaterThanOrEqual(1);
    const theirs = await reports.myReportsFor(otherStudentId, problemId);
    // Different students, different rows: no id appears in both lists.
    const overlap = mine.filter((row) => theirs.some((other) => other.id === row.id));
    expect(overlap).toEqual([]);
  }, 60_000);
});
