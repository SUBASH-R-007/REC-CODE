import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * A SQL problem is not sat in an assessment (Phase 12p), against a real
 * PostgreSQL.
 *
 * The fourth rule of a shape this codebase already had three times —
 * interactive (12l), debugging (12m), output-only (12n) — and the one kind
 * that was missing it. A sitting chooses ONE language for the whole paper
 * and `/api/exam/[attemptId]/submit` only accepts a toolchain language, so
 * a SQL question would be a C++ editor over a problem that wants a query,
 * and the candidate would discover that mid-sitting.
 *
 * The pin is refused on INSERT *and* on UPDATE: a paper that cannot hold a
 * SQL question must not be able to acquire one by having a row repointed.
 *
 * Opt-in: RECX_DB_TESTS=1.
 */
const ENABLED = process.env.RECX_DB_TESTS === "1";

vi.hoisted(() => {
  if (process.env.RECX_DB_TESTS === "1") {
    process.env.DATABASE_URL =
      process.env.RECX_TEST_DATABASE_URL ?? "postgresql://recx:recx-dev-only@127.0.0.1:5433/recx_test";
  }
});

describe.skipIf(!ENABLED)("a SQL problem's assessment pin, against recx_test", () => {
  const tag = `sqlpin-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
  let db: import("@recx/db").Db;
  let problemId = "";
  let actorId = "";
  let assessmentId = "";

  /** A frozen, published version of the given kind, which is what a pin points at. */
  async function frozen(over: Record<string, unknown>) {
    const v = await db.problemVersion.create({
      data: {
        problemId,
        revision: Math.floor(Math.random() * 1_000_000),
        status: "PUBLISHED",
        title: "Who ordered the most",
        difficulty: "MEDIUM",
        statementMd: "Answer it.",
        ioMode: "STDIN",
        compareMode: "TOKEN",
        scoringMode: "ICPC",
        stopOnFirstFailure: true,
        timeLimitMs: 2000,
        ...over,
      } as never,
      select: { id: true, ioMode: true },
    });
    await db.$executeRawUnsafe(`UPDATE "ProblemVersion" SET "frozenAt" = now() WHERE id = $1`, v.id);
    return v;
  }

  beforeAll(async () => {
    const { createPrismaClient } = await import("@recx/db");
    db = createPrismaClient({
      url: process.env.RECX_TEST_DATABASE_URL ?? "postgresql://recx:recx-dev-only@127.0.0.1:5433/recx_test",
      log: [],
    });
    const user = await db.user.create({
      data: {
        collegeId: `${tag}-a`,
        email: `${tag}@rec-code.example`,
        firstName: "Paper",
        lastName: "Maker",
        handle: `${tag}-a`,
        role: "ADMIN",
      },
      select: { id: true },
    });
    actorId = user.id;
    const problem = await db.problem.create({
      data: {
        slug: `${tag}-orders`,
        displayCode: `REC-${Math.floor(1000 + Math.random() * 8999)}`,
        title: "Who ordered the most",
        difficulty: "MEDIUM",
        status: "PUBLISHED",
      },
      select: { id: true },
    });
    problemId = problem.id;
    const assessment = await db.assessment.create({
      data: {
        slug: `${tag}-paper`,
        title: "A paper",
        instructions: "Be honest.",
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
  }, 60_000);

  afterAll(async () => {
    if (!db) return;
    try {
      await db.$executeRawUnsafe(`DELETE FROM "AssessmentProblem" WHERE "assessmentId" = $1`, assessmentId);
      await db.$executeRawUnsafe(`DELETE FROM "Assessment" WHERE id = $1`, assessmentId);
      // A frozen version is immutable, including to a DELETE — that is the
      // rule this test's fixtures depend on, so the rows it froze stay.
      await db.$executeRawUnsafe(
        `DELETE FROM "ProblemVersion" WHERE "problemId" = $1 AND "frozenAt" IS NULL`,
        problemId,
      );
      const left = await db.problemVersion.count({ where: { problemId } });
      if (left === 0) await db.$executeRawUnsafe(`DELETE FROM "Problem" WHERE id = $1`, problemId);
      await db.user.deleteMany({ where: { id: actorId } });
    } finally {
      await db.$disconnect();
    }
  }, 60_000);

  it("refuses the pin of a SQL version, by trigger", async () => {
    const v = await frozen({
      ioMode: "SQL",
      compareMode: "ROWS",
      sqlDialect: "postgres17",
      sqlOrdered: false,
    });
    expect(v.ioMode).toBe("SQL");
    await expect(
      db.assessmentProblem.create({
        data: { assessmentId, problemVersionId: v.id, position: 1, points: 100 },
      }),
    ).rejects.toThrow(/is a SQL problem, which is not sat in an assessment yet/);
  });

  it("cannot acquire one by repointing a row either, and says which rule stopped it", async () => {
    // A paper may hold an ordinary problem; it must not be able to become a
    // paper with a SQL question in it by moving the pointer. It cannot, and
    // not because of this phase's trigger: `AssessmentProblem` already
    // freezes assessmentId, problemVersionId and position, so the UPDATE
    // never reaches the kind check. The new trigger covers UPDATE anyway,
    // the way its three siblings do — if that older rule is ever relaxed,
    // the kind rule must not be relaxed with it.
    const ordinary = await frozen({});
    const sql = await frozen({
      ioMode: "SQL",
      compareMode: "ROWS",
      sqlDialect: "postgres17",
      sqlOrdered: true,
    });
    const row = await db.assessmentProblem.create({
      data: { assessmentId, problemVersionId: ordinary.id, position: 2, points: 100 },
      select: { id: true },
    });
    expect(sql.ioMode).toBe("SQL");
    await expect(
      db.assessmentProblem.update({ where: { id: row.id }, data: { problemVersionId: sql.id } }),
    ).rejects.toThrow(/assessmentId, problemVersionId and position never change/);
    // And the row is still the one it was.
    const after = await db.assessmentProblem.findUniqueOrThrow({
      where: { id: row.id },
      select: { problemVersionId: true },
    });
    expect(after.problemVersionId).toBe(ordinary.id);
  });

  it("leaves an ordinary problem's pin alone", async () => {
    const ordinary = await frozen({});
    const row = await db.assessmentProblem.create({
      data: { assessmentId, problemVersionId: ordinary.id, position: 3, points: 100 },
      select: { id: true, problemVersionId: true },
    });
    expect(row.problemVersionId).toBe(ordinary.id);
  });
});
