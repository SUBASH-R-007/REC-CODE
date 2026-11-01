import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * A paper answered in more than one language (Phase 13a), against the real
 * tables.
 *
 * A sitting used to have ONE language that nobody chose, so everything
 * downstream of it had only ever been exercised with one: the submit path
 * read the toolchain row for `answers[0].language` and stamped every
 * submission with it. That is invisible with one language and a quiet
 * disaster with two — a paper answered in Python and C would have had the
 * Python file compiled by gcc, and the candidate would have read "compile
 * error" against a correct program.
 *
 * Unit tests cannot catch that: it is a join between an answer, a
 * `LanguageConfig` row and a `Submission`, and the whole mistake is which
 * row ends up on which submission. So this drives the real `submitAttempt`
 * against a real paper with two accepted languages and reads the rows back.
 *
 * Opt-in: RECX_DB_TESTS=1.
 */

const ENABLED = process.env.RECX_DB_TESTS === "1";

vi.hoisted(() => {
  if (process.env.RECX_DB_TESTS === "1") {
    process.env.DATABASE_URL =
      process.env.RECX_TEST_DATABASE_URL ?? "postgresql://recx:recx-dev-only@127.0.0.1:5433/recx_test";
    process.env.IP_HASH_PEPPER ??= "exam-languages-test-pepper";
  }
});

vi.mock("next/headers", () => ({
  headers: async () => new Headers(),
  cookies: async () => ({ get: () => undefined, set: () => undefined, delete: () => undefined }),
}));
// Nothing here should reach Redis: the rows are what this is about.
vi.mock("@/lib/judge/queue", () => ({ enqueueJudge: async () => false }));

const tag = `lang-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;

describe.skipIf(!ENABLED)("a paper answered in two languages, against recx_test", () => {
  let db: import("@recx/db").Db;
  let submitModule: typeof import("@/lib/exam/submit");
  let paperModule: typeof import("@/server/queries/exam");

  let staffId = "";
  let userId = "";
  let problemId = "";
  let assessmentId = "";
  const versionIds: string[] = [];
  const questionIds: string[] = [];
  const attemptIds: string[] = [];
  /** The LanguageConfig rows this fixture created, if it had to. */
  const configIds: string[] = [];
  let cppConfigId = "";
  let pyConfigId = "";

  /**
   * A toolchain row for a key, created only if the test database has none.
   * A suite that depends on seed data passes on a seeded database and fails
   * on a fresh one, which is Phase 10's CI lesson.
   */
  async function toolchain(key: string, label: string): Promise<string> {
    const existing = await db.languageConfig.findFirst({
      where: { key, enabled: true, isCurrent: true },
      select: { id: true },
    });
    if (existing) return existing.id;
    const row = await db.languageConfig.create({
      data: {
        key,
        toolchainId: `${tag}-${key}`,
        version: "0.0.0-test",
        label,
        runtime: {} as never,
        enabled: true,
        isCurrent: true,
      },
      select: { id: true },
    });
    configIds.push(row.id);
    return row.id;
  }

  beforeAll(async () => {
    const { createPrismaClient } = await import("@recx/db");
    db = createPrismaClient({
      url: process.env.RECX_TEST_DATABASE_URL ?? "postgresql://recx:recx-dev-only@127.0.0.1:5433/recx_test",
      log: [],
    });
    submitModule = await import("@/lib/exam/submit");
    paperModule = await import("@/server/queries/exam");

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

    const candidate = await db.user.create({
      data: {
        collegeId: `${tag}-cand`.toUpperCase().slice(0, 32),
        email: `${tag}-cand@rec-code.example`,
        firstName: "Two",
        lastName: "Languages",
        handle: `${tag}-cand`,
        role: "STUDENT",
        batchYear: 2027,
        departmentCode: "CSE",
      },
      select: { id: true },
    });
    userId = candidate.id;

    cppConfigId = await toolchain("cpp20", "C++20 (test)");
    pyConfigId = await toolchain("py312", "Python 3.12 (test)");

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

    // Two questions, so one can be answered in each language.
    for (const revision of [1, 2]) {
      const version = await db.problemVersion.create({
        data: {
          problemId: problem.id,
          revision,
          title: `Add them up (r${revision})`,
          statementMd: "Add the numbers.",
          difficulty: "EASY",
          ioMode: "STDIN",
          timeLimitMs: 1000,
          // A starter in each language, which is what the editor swaps
          // between when a candidate changes the picker.
          starterCodes: {
            create: [
              { language: "cpp20", code: "int main(){}\n" },
              { language: "py312", code: "def main():\n    pass\n" },
            ],
          },
          // A question with no tests cannot be judged and is counted blank,
          // so each needs one for a submission to exist at all.
          testCases: {
            create: [
              {
                index: 0,
                isSample: true,
                input: { create: { inline: "1 2\n", sha256: `${tag}-in-${revision}`, sizeBytes: 4 } },
                output: { create: { inline: "3\n", sha256: `${tag}-out-${revision}`, sizeBytes: 2 } },
              },
            ],
          },
        },
        select: { id: true },
      });
      await db.problemVersion.update({ where: { id: version.id }, data: { frozenAt: new Date() } });
      versionIds.push(version.id);
    }

    const assessment = await db.assessment.create({
      data: {
        slug: tag,
        title: "A paper in two languages",
        instructions: "Answer both, in whichever of the two you like.",
        status: "OPEN",
        proctorMode: "ADVISORY",
        opensAt: new Date(Date.now() - 3_600_000),
        closesAt: new Date(Date.now() + 3_600_000),
        durationSec: 3_600,
        createdById: staffId,
        // What this whole phase is about.
        allowedLanguages: ["cpp20", "py312"],
        problems: {
          create: [
            { problemVersionId: versionIds[0]!, position: 1, points: 10 },
            { problemVersionId: versionIds[1]!, position: 2, points: 10 },
          ],
        },
      } as never,
      select: { id: true, problems: { orderBy: { position: "asc" }, select: { id: true } } },
    });
    assessmentId = assessment.id;
    questionIds.push(...assessment.problems.map((p) => p.id));
  }, 120_000);

  afterAll(async () => {
    if (!db) return;
    try {
      await db.attemptSnapshot.deleteMany({ where: { attemptId: { in: attemptIds } } });
      await db.submission.deleteMany({ where: { assessmentAttemptId: { in: attemptIds } } });
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
      // The test cases and their blobs first: `TestCase` has no cascade
      // from a version, so a fixture that created tests has to remove them
      // before the revision they hang off.
      await db.$executeRawUnsafe(`ALTER TABLE "public"."TestCase" DISABLE TRIGGER "TestCase_frozen_guard"`);
      try {
        await db.$executeRawUnsafe(
          `DELETE FROM "TestCase" WHERE "problemVersionId" IN (SELECT id FROM "ProblemVersion" WHERE "problemId" = $1)`,
          problemId,
        );
      } finally {
        await db.$executeRawUnsafe(`ALTER TABLE "public"."TestCase" ENABLE TRIGGER "TestCase_frozen_guard"`);
      }
      await db.$executeRawUnsafe(`DELETE FROM "TestBlob" WHERE sha256 LIKE $1`, `${tag}-%`);
      await db.$executeRawUnsafe(`ALTER TABLE "public"."StarterCode" DISABLE TRIGGER "StarterCode_frozen_guard"`);
      try {
        await db.$executeRawUnsafe(
          `DELETE FROM "StarterCode" WHERE "problemVersionId" IN (SELECT id FROM "ProblemVersion" WHERE "problemId" = $1)`,
          problemId,
        );
      } finally {
        await db.$executeRawUnsafe(`ALTER TABLE "public"."StarterCode" ENABLE TRIGGER "StarterCode_frozen_guard"`);
      }
      await db.$executeRawUnsafe(`ALTER TABLE "public"."ProblemVersion" DISABLE TRIGGER "ProblemVersion_frozen_guard"`);
      try {
        await db.$executeRawUnsafe(`DELETE FROM "ProblemVersion" WHERE "problemId" = $1`, problemId);
      } finally {
        await db.$executeRawUnsafe(`ALTER TABLE "public"."ProblemVersion" ENABLE TRIGGER "ProblemVersion_frozen_guard"`);
      }
      await db.$executeRawUnsafe(`DELETE FROM "Problem" WHERE id = $1`, problemId);
      if (configIds.length > 0) await db.languageConfig.deleteMany({ where: { id: { in: configIds } } });
      await db.user.deleteMany({ where: { id: { in: [staffId, userId] } } });
    } finally {
      await db.$disconnect();
    }
  }, 120_000);

  /** The frozen paper, with both languages accepted. */
  function layout() {
    return {
      v: 1 as const,
      questions: [
        { questionId: questionIds[0]!, problemVersionId: versionIds[0]!, sourcePosition: 1, points: 10, seed: 1 },
        { questionId: questionIds[1]!, problemVersionId: versionIds[1]!, sourcePosition: 2, points: 10, seed: 2 },
      ],
      language: "cpp20",
      languages: ["cpp20", "py312"],
    };
  }

  /** A live sitting of that paper, as the guard hands it to the submit path. */
  async function sitting() {
    const attempt = await db.assessmentAttempt.create({
      data: {
        assessmentId,
        userId,
        attemptNumber: attemptIds.length + 1,
        status: "IN_PROGRESS",
        seed: 11,
        startedAt: new Date(Date.now() - 600_000),
        expiresAt: new Date(Date.now() + 600_000),
        proctorMode: "ADVISORY",
        tokenHash: randomBytes(16).toString("hex"),
        layout: layout() as never,
      } as never,
    });
    attemptIds.push(attempt.id);
    return {
      ok: true as const,
      attempt,
      status: attempt.status,
      msRemaining: 600_000,
      now: new Date(),
      sessionNotice: null as never,
      sessionId: null,
    };
  }

  it("judges each answer with the toolchain of ITS OWN language", async () => {
    const guard = await sitting();
    const result = await submitModule.submitAttempt(guard, layout() as never, [
      { questionId: questionIds[0]!, language: "cpp20", source: "int main(){return 0;}\n" },
      { questionId: questionIds[1]!, language: "py312", source: "print(3)\n" },
    ]);

    expect(result.submitted).toBe(true);
    expect(result.submissionIds).toHaveLength(2);

    const rows = await db.submission.findMany({
      where: { id: { in: result.submissionIds } },
      select: { language: true, languageConfigId: true, problemVersionId: true },
    });
    const byLanguage = new Map(rows.map((row) => [row.language, row]));
    expect([...byLanguage.keys()].sort()).toEqual(["cpp20", "py312"]);
    /**
     * The assertion this file exists for. Before Phase 13a both rows
     * would have carried the FIRST answer's toolchain, so the Python
     * submission would have been queued to gcc.
     */
    expect(byLanguage.get("cpp20")!.languageConfigId).toBe(cppConfigId);
    expect(byLanguage.get("py312")!.languageConfigId).toBe(pyConfigId);
    // And each is still pinned to the frozen version its question names.
    expect(byLanguage.get("cpp20")!.problemVersionId).toBe(versionIds[0]);
    expect(byLanguage.get("py312")!.problemVersionId).toBe(versionIds[1]);

    // The snapshots record the same languages, because the timeline is the
    // record of the answer and must reconstruct as the right program.
    const snapshots = await db.attemptSnapshot.findMany({
      where: { attemptId: guard.attempt.id },
      select: { questionId: true, language: true },
    });
    expect(new Set(snapshots.map((s) => s.language))).toEqual(new Set(["cpp20", "py312"]));
  });

  it("reports what each answer was written in, to staff and to the candidate", async () => {
    /**
     * Phase 13a.3. A mark with no language beside it cannot be read once a
     * paper accepts several: an examiner looking at a wrong answer in a
     * language the paper was not taught in is looking at something else
     * entirely, and a candidate reading their own result chose the
     * language themselves.
     */
    const guard = await sitting();
    await submitModule.submitAttempt(guard, layout() as never, [
      { questionId: questionIds[0]!, language: "cpp20", source: "int main(){return 0;}\n" },
      { questionId: questionIds[1]!, language: "py312", source: "print(3)\n" },
    ]);

    const results = await import("@/server/queries/admin-assessment-results");
    const scopeWhere = await import("@/lib/auth/scope-where");
    const wholeCollege = scopeWhere.buildStudentScope({ id: staffId, role: "SUPER_ADMIN" }, []);
    const read = await results.getAssessmentResults(wholeCollege, assessmentId);
    const row = read.rows.find((r) => r.attemptId === guard.attempt.id);
    expect(row).toBeDefined();
    // Both, with their labels resolved on the server and in catalog order.
    expect(row!.languages.map((language) => language.key)).toEqual(["cpp20", "py312"]);
    expect(row!.languages[0]!.shortLabel).toBe("C++20");

    // And the candidate's own result, once staff release it.
    await db.assessment.update({
      where: { id: assessmentId },
      data: { resultsPublishedAt: new Date(), resultsPublishedById: staffId },
    });
    const mine = await import("@/server/queries/my-assessment-result");
    const own = await mine.myAssessmentResult({ userId, slug: tag });
    expect(own).not.toBeNull();
    const languages = own!.questions.filter((q) => q.kind === "coding").map((q) => q.language);
    expect(languages).toContain("C++20 (GCC 13.2.0)");
    expect(languages.some((label) => label?.startsWith("Python 3.12"))).toBe(true);

    // Put it back, so the other tests see an unreleased paper.
    await db.assessment.update({
      where: { id: assessmentId },
      data: { resultsPublishedAt: null, resultsPublishedById: null },
    });
  });

  it("refuses a language the paper does not accept, and leaves the sitting open", async () => {
    const guard = await sitting();
    const result = await submitModule.submitAttempt(guard, layout() as never, [
      { questionId: questionIds[0]!, language: "java21", source: "class Main {}\n" },
    ]);

    expect(result).toMatchObject({ submitted: false, reason: "language_not_accepted", refusedLanguage: "java21" });
    expect(result.submissionIds).toHaveLength(0);

    /**
     * Nothing finalised, which is the point of checking before anything
     * else happens: the candidate can pick an accepted language and hand
     * in again. A refusal that closed the sitting would have taken the
     * paper away over a language.
     */
    const after = await db.assessmentAttempt.findUniqueOrThrow({
      where: { id: guard.attempt.id },
      select: { status: true, submittedAt: true },
    });
    expect(after.status).toBe("IN_PROGRESS");
    expect(after.submittedAt).toBeNull();
    expect(await db.submission.count({ where: { assessmentAttemptId: guard.attempt.id } })).toBe(0);
  });

  it("hands the candidate both languages, with a starter for each", async () => {
    const paper = await paperModule.getExamPaper(layout() as never);
    expect(paper.languages.map((language) => language.key)).toEqual(["cpp20", "py312"]);
    // Labels resolved on the server; the catalog never reaches a browser.
    expect(paper.languages[0]!.shortLabel).toBe("C++20");
    expect(paper.languages[1]!.editorLanguage).toBe("python");

    const first = paper.questions[0];
    expect(Object.keys(first!.starters).sort()).toEqual(["cpp20", "py312"]);
    expect(first!.starters.cpp20).toContain("int main");
    expect(first!.starters.py312).toContain("def main");
    // The editor opens in the first accepted language.
    expect(first!.languageKey).toBe("cpp20");
  });

  it("offers only what the judge can run, whatever the paper asked for", async () => {
    /**
     * The intersection, against real rows. An administrator picks a
     * language, somebody disables that toolchain a week later, and the
     * candidate must not be handed an editor whose every Run comes back
     * "that language is not available right now".
     */
    const { acceptedLanguagesFor } = await import("@/lib/exam/language");
    expect(await acceptedLanguagesFor(["cpp20", "py312"])).toEqual(["cpp20", "py312"]);
    // A key with no enabled, current row at all.
    expect(await acceptedLanguagesFor(["cpp20", "fortran77"])).toEqual(["cpp20"]);
    // And an empty list means every installed language, which includes
    // both of the fixture's.
    const all = await acceptedLanguagesFor([]);
    expect(all).toContain("cpp20");
    expect(all).toContain("py312");
  });
});
