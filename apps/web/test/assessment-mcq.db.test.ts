import { randomBytes } from "node:crypto";
import { freeDisplayCode } from "./support/display-code";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * The rules a multiple-choice question is held to (Phase 12r), against a
 * real PostgreSQL.
 *
 * Each one is in the database rather than in a form validator because each
 * one, got wrong, is found by a cohort rather than by the author: a
 * question nobody can get right, a radio button with no text beside it, or
 * two questions both calling themselves number four.
 *
 * The last of those is the novel one. A candidate sees "Question 4 of 9"
 * whether 4 is a program or a question, so `position` has to be unique
 * across BOTH tables, which no single unique index can say — hence one
 * guard function and two triggers, and hence a test that comes at it from
 * both sides.
 *
 * Opt-in: RECX_DB_TESTS=1.
 */
const ENABLED = process.env.RECX_DB_TESTS === "1";
const URL = () => process.env.RECX_TEST_DATABASE_URL ?? "postgresql://recx:recx-dev-only@127.0.0.1:5433/recx_test";

vi.hoisted(() => {
  if (process.env.RECX_DB_TESTS === "1") {
    process.env.DATABASE_URL =
      process.env.RECX_TEST_DATABASE_URL ?? "postgresql://recx:recx-dev-only@127.0.0.1:5433/recx_test";
  }
});

describe.skipIf(!ENABLED)("an assessment's multiple-choice questions, against recx_test", () => {
  const tag = `mcq-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
  let db: import("@recx/db").Db;
  let actorId = "";
  let assessmentId = "";
  let problemId = "";
  let frozenVersionId = "";

  /**
   * A paper may hold a given problem version only once
   * (`@@unique([assessmentId, problemVersionId])`), so a test that pins two
   * coding questions needs two versions.
   */
  async function anotherFrozenVersion(): Promise<string> {
    const v = await db.problemVersion.create({
      data: {
        problemId,
        revision: Math.floor(Math.random() * 1_000_000),
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
    await db.$executeRawUnsafe(`UPDATE "ProblemVersion" SET "frozenAt" = now() WHERE id = $1`, v.id);
    return v.id;
  }

  const mcq = (over: Record<string, unknown> = {}) =>
    db.assessmentMcq.create({
      data: {
        assessmentId,
        position: 10,
        stem: "Which of these is a stable sort?",
        options: ["Quicksort", "Merge sort", "Heapsort"],
        correctIndex: 1,
        points: 2,
        ...over,
      } as never,
      select: { id: true, position: true, options: true, correctIndex: true },
    });

  beforeAll(async () => {
    const { createPrismaClient } = await import("@recx/db");
    db = createPrismaClient({ url: URL(), log: [] });
    const user = await db.user.create({
      data: {
        collegeId: `${tag}-a`,
        email: `${tag}@rec-code.example`,
        firstName: "Paper",
        lastName: "Setter",
        handle: `${tag}-a`,
        role: "ADMIN",
      },
      select: { id: true },
    });
    actorId = user.id;
    const assessment = await db.assessment.create({
      data: {
        slug: `${tag}-paper`,
        title: "A mixed paper",
        instructions: "Answer everything.",
        status: "DRAFT",
        proctorMode: "ADVISORY",
        opensAt: new Date(Date.now() + 86_400_000),
        closesAt: new Date(Date.now() + 90_000_000),
        durationSec: 3_600,
        createdById: actorId,
      } as never,
      select: { id: true },
    });
    assessmentId = assessment.id;
    const problem = await db.problem.create({
      data: {
        slug: `${tag}-add`,
        displayCode: await freeDisplayCode(db),
        title: "Add them up",
        difficulty: "EASY",
        status: "PUBLISHED",
      },
      select: { id: true },
    });
    problemId = problem.id;
    const version = await db.problemVersion.create({
      data: {
        problemId,
        revision: Math.floor(Math.random() * 1_000_000),
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
    frozenVersionId = version.id;
    await db.$executeRawUnsafe(`UPDATE "ProblemVersion" SET "frozenAt" = now() WHERE id = $1`, frozenVersionId);
  }, 90_000);

  afterAll(async () => {
    if (!db) return;
    try {
      await db.$executeRawUnsafe(`DELETE FROM "AssessmentMcq" WHERE "assessmentId" = $1`, assessmentId);
      await db.$executeRawUnsafe(`DELETE FROM "AssessmentProblem" WHERE "assessmentId" = $1`, assessmentId);
      await db.$executeRawUnsafe(`DELETE FROM "Assessment" WHERE id = $1`, assessmentId);
      await db.$executeRawUnsafe(`DELETE FROM "ProblemVersion" WHERE "problemId" = $1 AND "frozenAt" IS NULL`, problemId);
      if ((await db.problemVersion.count({ where: { problemId } })) === 0) {
        await db.$executeRawUnsafe(`DELETE FROM "Problem" WHERE id = $1`, problemId);
      }
      await db.user.deleteMany({ where: { id: actorId } });
    } finally {
      await db.$disconnect();
    }
  }, 90_000);

  it("takes an ordinary question", async () => {
    const row = await mcq({ position: 1 });
    expect(row).toMatchObject({ position: 1, correctIndex: 1 });
    expect(row.options).toEqual(["Quicksort", "Merge sort", "Heapsort"]);
  });

  it("refuses fewer than two options: one option is not a choice", async () => {
    await expect(mcq({ position: 2, options: ["Only this"], correctIndex: 0 })).rejects.toThrow(
      /AssessmentMcq_options_check/,
    );
  });

  it("refuses more than eight, which is more than a phone can show", async () => {
    await expect(
      mcq({ position: 3, options: Array.from({ length: 9 }, (_, i) => `Option ${i}`), correctIndex: 0 }),
    ).rejects.toThrow(/AssessmentMcq_options_check/);
  });

  it("refuses a blank option, which is a radio button with nothing beside it", async () => {
    await expect(mcq({ position: 4, options: ["Yes", ""], correctIndex: 0 })).rejects.toThrow(
      /AssessmentMcq_options_check/,
    );
  });

  it("refuses an answer that is not one of the options", async () => {
    // A question nobody can get right, found by a cohort rather than by
    // whoever set it.
    await expect(mcq({ position: 5, correctIndex: 3 })).rejects.toThrow(/AssessmentMcq_correct_index_check/);
    await expect(mcq({ position: 5, correctIndex: -1 })).rejects.toThrow(/AssessmentMcq_correct_index_check/);
  });

  it("refuses an empty stem, and zero or negative marks", async () => {
    await expect(mcq({ position: 6, stem: "   " })).rejects.toThrow(/AssessmentMcq_stem_check/);
    await expect(mcq({ position: 6, points: 0 })).rejects.toThrow(/AssessmentMcq_points_check/);
  });

  it("refuses a position outside the palette", async () => {
    await expect(mcq({ position: 0 })).rejects.toThrow(/AssessmentMcq_position_check/);
    await expect(mcq({ position: 201 })).rejects.toThrow(/AssessmentMcq_position_check/);
  });

  it("refuses two MCQs at the same position", async () => {
    await mcq({ position: 20 });
    await expect(mcq({ position: 20 })).rejects.toThrow();
  });

  describe("the palette is one numbered list", () => {
    it("refuses an MCQ at a position a coding question already holds", async () => {
      await db.assessmentProblem.create({
        data: { assessmentId, problemVersionId: frozenVersionId, position: 30, points: 10 },
      });
      await expect(mcq({ position: 30 })).rejects.toThrow(/already a coding question on this assessment/);
    });

    it("refuses a coding question at a position an MCQ already holds, by the mirror trigger", async () => {
      // The half that is easy to leave out, and the reason one function
      // serves both triggers.
      await mcq({ position: 31 });
      await expect(
        db.assessmentProblem.create({
          data: { assessmentId, problemVersionId: await anotherFrozenVersion(), position: 31, points: 10 },
        }),
      ).rejects.toThrow(/already a multiple-choice question on this assessment/);
    });

    it("lets the two kinds interleave, which is the point of sharing the list", async () => {
      await mcq({ position: 40 });
      const coding = await db.assessmentProblem.create({
        data: { assessmentId, problemVersionId: await anotherFrozenVersion(), position: 41, points: 10 },
        select: { position: true },
      });
      await mcq({ position: 42 });
      expect(coding.position).toBe(41);
      const positions = [
        ...(await db.assessmentMcq.findMany({ where: { assessmentId }, select: { position: true } })),
        ...(await db.assessmentProblem.findMany({ where: { assessmentId }, select: { position: true } })),
      ].map((r) => r.position);
      // No duplicates anywhere in the palette.
      expect(new Set(positions).size).toBe(positions.length);
    });
  });
});
