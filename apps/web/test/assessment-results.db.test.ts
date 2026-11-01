import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * What a paper came to, against the real tables (Phase 12y).
 *
 * The bug this exists to refuse is the one the whole slice is about: a
 * results screen that renders perfectly and shows nothing, because the
 * query asked for a shape the rows do not have. Four of those have been
 * found in this codebase in two days — the hall roster that read a column
 * nothing wrote, the invigilator messages delivered to nobody, the CIDR
 * allowlist that never ran, the rank job looking for a status nothing
 * sets. Every one of them passed its unit tests.
 *
 * So this drives the real `getAssessmentResults` against a real sitting:
 * a paper with one multiple-choice question and one coding question, a
 * candidate who got one right and one wrong, and a judged submission. It
 * asserts the marks, the question breakdown and — the part a unit test
 * cannot reach — that the scope is honoured in both directions.
 *
 * Opt-in: RECX_DB_TESTS=1.
 */

const ENABLED = process.env.RECX_DB_TESTS === "1";

vi.hoisted(() => {
  if (process.env.RECX_DB_TESTS === "1") {
    process.env.DATABASE_URL =
      process.env.RECX_TEST_DATABASE_URL ?? "postgresql://recx:recx-dev-only@127.0.0.1:5433/recx_test";
    process.env.IP_HASH_PEPPER ??= "results-test-pepper";
  }
});

vi.mock("next/headers", () => ({
  headers: async () => new Headers(),
  cookies: async () => ({ get: () => undefined, set: () => undefined, delete: () => undefined }),
}));

const tag = `res-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
const DEPT = "CSE";
const OTHER_DEPT = "ECE";
const BATCH = 2031;

describe.skipIf(!ENABLED)("an assessment's results, against recx_test", () => {
  let db: import("@recx/db").Db;
  let results: typeof import("@/server/queries/admin-assessment-results");
  let mine: typeof import("@/server/queries/my-assessment-result");
  let listing: typeof import("@/server/queries/assessments");
  let scopeWhere: typeof import("@/lib/auth/scope-where");

  let staffId = "";
  let assessmentId = "";
  let mcqId = "";
  let problemVersionId = "";
  let assessmentProblemId = "";
  let problemId = "";
  let languageConfigId = "";
  const userIds: string[] = [];
  const attemptIds: string[] = [];

  /** A whole-college scope, as a SUPER_ADMIN has. */
  const wholeCollege = () => scopeWhere.buildStudentScope({ id: staffId, role: "SUPER_ADMIN" }, []);
  /** One department, as a scoped ADMIN has. */
  const oneDepartment = (code: string) =>
    scopeWhere.buildStudentScope({ id: staffId, role: "ADMIN" }, [{ departmentCode: code, batchYear: null }]);

  beforeAll(async () => {
    const { createPrismaClient } = await import("@recx/db");
    db = createPrismaClient({
      url: process.env.RECX_TEST_DATABASE_URL ?? "postgresql://recx:recx-dev-only@127.0.0.1:5433/recx_test",
      log: [],
    });
    results = await import("@/server/queries/admin-assessment-results");
    mine = await import("@/server/queries/my-assessment-result");
    listing = await import("@/server/queries/assessments");
    scopeWhere = await import("@/lib/auth/scope-where");

    const staff = await db.user.create({
      data: {
        collegeId: `${tag}-staff`.toUpperCase().slice(0, 32),
        email: `${tag}-staff@rec-code.example`,
        firstName: "Paper",
        lastName: "Setter",
        handle: `${tag}-staff`,
        role: "SUPER_ADMIN",
      },
      select: { id: true },
    });
    staffId = staff.id;

    // The coding question's problem, created here rather than found: a
    // suite that depends on seed data passes on a seeded database and
    // fails on a fresh one (Phase 10's CI lesson).
    const problem = await db.problem.create({
      data: {
        slug: `${tag}-sum`,
        displayCode: `REC-${(Date.now() % 9000) + 1000}`,
        title: "Add them up",
        status: "PUBLISHED",
        difficulty: "EASY",
        createdById: staffId,
      },
      select: { id: true },
    });
    problemId = problem.id;
    const version = await db.problemVersion.create({
      data: {
        problemId: problem.id,
        revision: 1,
        title: "Add them up",
        statementMd: "Add the numbers.",
        difficulty: "EASY",
        ioMode: "STDIN",
        timeLimitMs: 1000,
      },
      select: { id: true },
    });
    /**
     * Frozen by an UPDATE, never created frozen: the database refuses the
     * second ("a revision is frozen by publishing it"), and refuses an
     * assessment that pins an unfrozen one. Both guards are right, and
     * between them they describe how publishing really works.
     */
    await db.problemVersion.update({ where: { id: version.id }, data: { frozenAt: new Date() } });
    problemVersionId = version.id;
    const language = await db.languageConfig.findFirst({ select: { id: true } });
    languageConfigId = language?.id ?? "";

    const assessment = await db.assessment.create({
      data: {
        slug: tag,
        title: "A paper with a result",
        instructions: "Answer both.",
        status: "CLOSED",
        proctorMode: "ADVISORY",
        opensAt: new Date(Date.now() - 7_200_000),
        closesAt: new Date(Date.now() - 3_600_000),
        durationSec: 3_600,
        createdById: staffId,
        problems: { create: [{ problemVersionId: version.id, position: 1, points: 10 }] },
        mcqs: {
          create: [
            {
              position: 2,
              stem: "Which sort is stable?",
              options: ["Quicksort", "Merge sort", "Heapsort"],
              correctIndex: 1,
              points: 4,
            },
          ],
        },
      } as never,
      select: { id: true, mcqs: { select: { id: true } }, problems: { select: { id: true } } },
    });
    assessmentId = assessment.id;
    mcqId = assessment.mcqs[0]!.id;
    assessmentProblemId = assessment.problems[0]!.id;
  }, 120_000);

  afterAll(async () => {
    if (!db) return;
    try {
      await db.assessmentMcqAnswer.deleteMany({ where: { attemptId: { in: attemptIds } } });
      await db.submission.deleteMany({ where: { assessmentAttemptId: { in: attemptIds } } });
      // A sitting is never deleted by the application; the guard comes off
      // only for this teardown.
      await db.$executeRawUnsafe(`ALTER TABLE "public"."AssessmentAttempt" DISABLE TRIGGER "AssessmentAttempt_machine"`);
      try {
        await db.assessmentAttempt.deleteMany({ where: { assessmentId } });
      } finally {
        await db.$executeRawUnsafe(`ALTER TABLE "public"."AssessmentAttempt" ENABLE TRIGGER "AssessmentAttempt_machine"`);
      }
      await db.$executeRawUnsafe(`ALTER TABLE "public"."Assessment" DISABLE TRIGGER "Assessment_published_immutable"`);
      try {
        await db.assessment.delete({ where: { id: assessmentId } });
      } finally {
        await db.$executeRawUnsafe(`ALTER TABLE "public"."Assessment" ENABLE TRIGGER "Assessment_published_immutable"`);
      }
      /**
       * Raw, because the client extension in `packages/db/src/frozen.ts`
       * refuses to delete a frozen revision — correctly: a published
       * revision is what somebody's result cites. Only this teardown goes
       * around it, and only for a fixture it created itself.
       */
      await db.$executeRawUnsafe(`ALTER TABLE "public"."ProblemVersion" DISABLE TRIGGER "ProblemVersion_frozen_guard"`);
      try {
        await db.$executeRawUnsafe(`DELETE FROM "ProblemVersion" WHERE "problemId" = $1`, problemId);
      } finally {
        await db.$executeRawUnsafe(`ALTER TABLE "public"."ProblemVersion" ENABLE TRIGGER "ProblemVersion_frozen_guard"`);
      }
      await db.$executeRawUnsafe(`DELETE FROM "Problem" WHERE id = $1`, problemId);
      await db.user.deleteMany({ where: { id: { in: [staffId, ...userIds] } } });
    } finally {
      await db.$disconnect();
    }
  }, 120_000);

  /** A candidate who sat the paper, with the answers this test needs. */
  async function sitting(args: {
    readonly suffix: string;
    readonly departmentCode: string;
    /** The position in the order THEY were shown, which is what is stored. */
    readonly chosenShownIndex: number | null;
    readonly verdict: "AC" | "WA" | null;
  }): Promise<string> {
    const user = await db.user.create({
      data: {
        collegeId: `${tag}-${args.suffix}`.toUpperCase().slice(0, 32),
        email: `${tag}-${args.suffix}@rec-code.example`,
        firstName: "Candidate",
        lastName: args.suffix.toUpperCase(),
        handle: `${tag}-${args.suffix}`,
        role: "STUDENT",
        batchYear: BATCH,
        departmentCode: args.departmentCode,
      },
      select: { id: true },
    });
    userIds.push(user.id);

    /**
     * The options were shown REVERSED to this candidate, so the stored
     * answer is an index into [2,1,0]. Shown position 1 is stored option 1
     * — the correct one. A marking that forgot to map back would read it
     * as option 1 of the stored order by luck here, so the wrong answer
     * below is the case that actually proves the mapping.
     */
    const attempt = await db.assessmentAttempt.create({
      data: {
        assessmentId,
        userId: user.id,
        attemptNumber: 1,
        status: "SUBMITTED",
        seed: 7,
        startedAt: new Date(Date.now() - 1_800_000),
        expiresAt: new Date(Date.now() - 600_000),
        submittedAt: new Date(Date.now() - 900_000),
        proctorMode: "ADVISORY",
        tokenHash: randomBytes(16).toString("hex"),
        layout: {
          v: 2,
          questions: [
            { questionId: assessmentProblemId, problemVersionId, sourcePosition: 1, points: 10, seed: 1 },
          ],
          mcqs: [{ mcqId, sourcePosition: 2, points: 4, optionOrder: [2, 1, 0] }],
        } as never,
      } as never,
      select: { id: true },
    });
    attemptIds.push(attempt.id);

    if (args.chosenShownIndex !== null) {
      await db.assessmentMcqAnswer.create({
        data: { attemptId: attempt.id, mcqId, chosenIndex: args.chosenShownIndex },
      });
    }
    if (args.verdict !== null && languageConfigId !== "") {
      await db.submission.create({
        data: {
          userId: user.id,
          problemId,
          problemVersionId,
          languageConfigId,
          language: "cpp20",
          lane: "ASSESSMENT",
          origin: "ASSESSMENT",
          assessmentAttemptId: attempt.id,
          status: "DONE",
          judgeState: "DONE",
          verdict: args.verdict,
          /**
           * Per-test results, as the judge stores them (Phase 12y.6). The
           * student's result reads these through `hiddenTestsOf`, which
           * is the projection that decides a candidate sees an index and
           * a verdict and never the case itself.
           */
          testResults: [
            { i: 0, v: "AC", ms: 12, kb: 2048 },
            { i: 1, v: args.verdict === "AC" ? "AC" : "WA", ms: 15, kb: 2048 },
          ] as never,
          passedCases: args.verdict === "AC" ? 2 : 1,
          totalCases: 2,
          sourceSha256: randomBytes(32).toString("hex"),
          sourceBytes: 42,
        } as never,
      });
    }
    return attempt.id;
  }

  it("shows a candidate's marks, both halves added up", async () => {
    await sitting({ suffix: "a", departmentCode: DEPT, chosenShownIndex: 1, verdict: "AC" });

    const page = await results.getAssessmentResults(wholeCollege(), assessmentId);
    const row = page.rows.find((r) => r.collegeId === `${tag}-a`.toUpperCase().slice(0, 32));
    expect(row, "the candidate is missing from the results").toBeDefined();
    // 10 for the accepted coding question, 4 for the right choice.
    expect(row?.result?.points).toBe(14);
    expect(row?.result?.maxPoints).toBe(14);
    expect(row?.result?.percent).toBe(100);
    expect(row?.result?.provisional).toBe(false);
    expect(page.maxPoints).toBe(14);
  });

  it("maps the shuffled option order back before marking it", async () => {
    /**
     * This candidate picked the option shown SECOND, which is stored
     * option 1 — no. Their order is [2,1,0]: shown 0 is stored 2, shown 1
     * is stored 1 (the correct one), shown 2 is stored 0. So picking shown
     * 2 is picking stored option 0, which is wrong. A marker that compared
     * the shown index with `correctIndex` directly would score this right.
     */
    await sitting({ suffix: "b", departmentCode: DEPT, chosenShownIndex: 2, verdict: "WA" });

    const page = await results.getAssessmentResults(wholeCollege(), assessmentId);
    const row = page.rows.find((r) => r.collegeId === `${tag}-b`.toUpperCase().slice(0, 32));
    expect(row?.result?.mcq.correct).toBe(0);
    expect(row?.result?.mcq.wrong).toBe(1);
    expect(row?.result?.points).toBe(0);
  });

  it("counts a question nobody answered as blank, not wrong", async () => {
    await sitting({ suffix: "c", departmentCode: DEPT, chosenShownIndex: null, verdict: null });

    const page = await results.getAssessmentResults(wholeCollege(), assessmentId);
    const row = page.rows.find((r) => r.collegeId === `${tag}-c`.toUpperCase().slice(0, 32));
    expect(row?.result?.mcq.blank).toBe(1);
    expect(row?.result?.coding.blank).toBe(1);
    expect(row?.result?.points).toBe(0);
  });

  it("breaks the paper down question by question, over the finished sittings", async () => {
    const page = await results.getAssessmentResults(wholeCollege(), assessmentId);
    expect(page.finished).toBe(3);

    const coding = page.questions.find((q) => q.kind === "coding");
    expect(coding).toMatchObject({ maxPoints: 10, fullMarks: 1, zero: 1, blank: 1 });

    const mcq = page.questions.find((q) => q.kind === "mcq");
    expect(mcq).toMatchObject({ maxPoints: 4, fullMarks: 1, zero: 1, blank: 1 });

    // One of three scored everything, two scored nothing.
    expect(page.averagePercent).toBeCloseTo(100 / 3, 5);
    expect(page.medianPercent).toBe(0);
  });

  it("shows a scoped admin their own department's candidates and nobody else's", async () => {
    await sitting({ suffix: "d", departmentCode: OTHER_DEPT, chosenShownIndex: 1, verdict: "AC" });

    const mine = await results.getAssessmentResults(oneDepartment(DEPT), assessmentId);
    const theirs = await results.getAssessmentResults(oneDepartment(OTHER_DEPT), assessmentId);

    expect(mine.rows.map((r) => r.departmentCode)).toEqual([DEPT, DEPT, DEPT]);
    expect(theirs.rows.map((r) => r.departmentCode)).toEqual([OTHER_DEPT]);
    // And the whole-college view still sees all four, so the filter above
    // is the scope and not an empty query.
    const all = await results.getAssessmentResults(wholeCollege(), assessmentId);
    expect(all.rows).toHaveLength(4);
  });

  describe("what the candidate themselves can see", () => {
    /**
     * The rule the feature was asked for in: "only when result published
     * by admin". It is enforced in the WHERE clause rather than checked
     * afterwards, and these two tests are the pair that proves it — the
     * same candidate, the same sitting, the only difference being whether
     * staff have released the marks.
     */
    let candidateId = "";

    beforeAll(async () => {
      const user = await db.user.findFirstOrThrow({
        where: { collegeId: `${tag}-a`.toUpperCase().slice(0, 32) },
        select: { id: true },
      });
      candidateId = user.id;
    });

    it("shows a candidate nothing at all before their department releases it", async () => {
      await db.assessment.update({
        where: { id: assessmentId },
        data: { resultsPublishedAt: null, resultsPublishedById: null },
      });
      expect(await mine.myAssessmentResult({ userId: candidateId, slug: tag })).toBeNull();
    });

    it("shows them their own marks once it is released", async () => {
      await db.assessment.update({
        where: { id: assessmentId },
        data: { resultsPublishedAt: new Date(), resultsPublishedById: staffId },
      });
      const result = await mine.myAssessmentResult({ userId: candidateId, slug: tag });
      expect(result, "a released result is not reaching the candidate").not.toBeNull();
      expect(result?.points).toBe(14);
      expect(result?.maxPoints).toBe(14);
      expect(result?.percent).toBe(100);
      expect(result?.questions).toHaveLength(2);
    });

    it("shows them their own and nobody else's", async () => {
      const other = await db.user.findFirstOrThrow({
        where: { collegeId: `${tag}-b`.toUpperCase().slice(0, 32) },
        select: { id: true },
      });
      const theirs = await mine.myAssessmentResult({ userId: other.id, slug: tag });
      // Candidate B got the choice wrong and the code wrong.
      expect(theirs?.points).toBe(0);
      expect(theirs?.attemptId).not.toBe((await mine.myAssessmentResult({ userId: candidateId, slug: tag }))?.attemptId);
    });

    it("shows which hidden tests passed, and nothing about what was in them", async () => {
      await db.assessment.update({
        where: { id: assessmentId },
        data: { resultsPublishedAt: new Date(), resultsPublishedById: staffId },
      });
      const result = await mine.myAssessmentResult({ userId: candidateId, slug: tag });
      const coding = result?.questions.find((q) => q.kind === "coding");
      expect(coding?.totalCases).toBe(2);
      expect(coding?.passedCases).toBe(2);
      expect(coding?.tests.map((t) => [t.i, t.v])).toEqual([
        [0, "AC"],
        [1, "AC"],
      ]);
      // Four keys and no more: the hidden-test rule in lib/judge/view.ts.
      for (const test of coding?.tests ?? []) {
        expect(Object.keys(test).sort()).toEqual(["i", "kb", "ms", "v"]);
      }
    });

    it("shows the failing case by number, which is the part a candidate can learn from", async () => {
      const other = await db.user.findFirstOrThrow({
        where: { collegeId: `${tag}-b`.toUpperCase().slice(0, 32) },
        select: { id: true },
      });
      const result = await mine.myAssessmentResult({ userId: other.id, slug: tag });
      const coding = result?.questions.find((q) => q.kind === "coding");
      expect(coding?.passedCases).toBe(1);
      expect(coding?.tests.map((t) => t.v)).toEqual(["AC", "WA"]);
    });

    it("never names the right answer, only what the candidate's own came to", async () => {
      // A student holding the key is a student who can pass it on, and the
      // next cohort sits the same paper.
      const result = await mine.myAssessmentResult({ userId: candidateId, slug: tag });
      const serialised = JSON.stringify(result);
      expect(serialised).not.toMatch(/correctIndex/);
      expect(serialised).not.toMatch(/Merge sort|Quicksort|Heapsort/);
      // And nothing about a rank, a cohort or anybody else's mark.
      expect(serialised).not.toMatch(/rank|percentile|average|median/i);
    });

    it("still lists the paper after it is ARCHIVED, so a released result does not vanish when it is filed away", async () => {
      /**
       * The bug this is here to refuse, reported from use: "when the
       * results are published, it is not visible to the students". The
       * list asked for `status IN (PUBLISHED, OPEN, CLOSED)` — "ARCHIVED
       * is history" — which was right while the list was only a way IN to
       * a paper. It is also the way to a RESULT now, and a department
       * archives a paper as soon as it is done with it, which is exactly
       * when a student goes looking. Both released papers on the
       * development database were ARCHIVED and neither was reachable.
       *
       * A fresh object per call on purpose: `listMyAssessments` is wrapped
       * in React's `cache()`, which keys on argument identity, so reusing
       * one would hand back the previous state's answer.
       */
      await db.assessment.update({
        where: { id: assessmentId },
        data: { status: "ARCHIVED", resultsPublishedAt: new Date(), resultsPublishedById: staffId },
      });
      const candidate = await db.user.findFirstOrThrow({
        where: { collegeId: `${tag}-a`.toUpperCase().slice(0, 32) },
        select: { id: true, batchYear: true, departmentCode: true, section: true },
      });

      const listed = await listing.listMyAssessments({ ...candidate });
      const row = listed.find((entry) => entry.slug === tag);
      expect(row, "an archived paper the student sat is not listed").toBeDefined();
      expect(row?.resultReleased).toBe(true);

      // And it is their OWN history, not a filing cabinet: a student who
      // never sat it does not see it.
      const stranger = await db.user.findFirstOrThrow({
        where: { collegeId: `${tag}-staff`.toUpperCase().slice(0, 32) },
        select: { id: true, batchYear: true, departmentCode: true, section: true },
      });
      const theirs = await listing.listMyAssessments({ ...stranger });
      expect(theirs.some((entry) => entry.slug === tag)).toBe(false);
    });

    it("goes back to showing nothing if the result is withdrawn", async () => {
      await db.assessment.update({
        where: { id: assessmentId },
        data: { resultsPublishedAt: null, resultsPublishedById: null },
      });
      expect(await mine.myAssessmentResult({ userId: candidateId, slug: tag })).toBeNull();
    });
  });

  it("gives a sitting still in progress no result at all, rather than a zero", async () => {
    const user = await db.user.create({
      data: {
        collegeId: `${tag}-live`.toUpperCase().slice(0, 32),
        email: `${tag}-live@rec-code.example`,
        firstName: "Still",
        lastName: "Sitting",
        handle: `${tag}-live`,
        role: "STUDENT",
        batchYear: BATCH,
        departmentCode: DEPT,
      },
      select: { id: true },
    });
    userIds.push(user.id);
    const attempt = await db.assessmentAttempt.create({
      data: {
        assessmentId,
        userId: user.id,
        attemptNumber: 1,
        status: "IN_PROGRESS",
        seed: 9,
        startedAt: new Date(),
        expiresAt: new Date(Date.now() + 3_600_000),
        proctorMode: "ADVISORY",
        tokenHash: randomBytes(16).toString("hex"),
        layout: { v: 1, questions: [] } as never,
      } as never,
      select: { id: true },
    });
    attemptIds.push(attempt.id);

    const page = await results.getAssessmentResults(wholeCollege(), assessmentId);
    const row = page.rows.find((r) => r.attemptId === attempt.id);
    expect(row?.result, "an unfinished paper has no result").toBeNull();
    expect(page.inProgress).toBe(1);
    // And it is not counted in the average.
    expect(page.finished).toBe(4);
  });
});
