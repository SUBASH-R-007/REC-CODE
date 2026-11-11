import { randomBytes } from "node:crypto";
import { freeDisplayCode } from "./support/display-code";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * A SQL problem IS sat in an assessment (Phase 16o), against a real
 * PostgreSQL.
 *
 * Phase 12p refused the pin with a trigger, as the three kinds before it
 * were refused — interactive (12l), debugging (12m), output-only (12n) —
 * because a sitting chose ONE language for the whole paper and
 * `/api/exam/[attemptId]/submit` accepted only a toolchain language. Phase
 * 16h then found a clause 12p had not written down: `SENSITIVE_LANES`
 * barred a `postgres` node from ASSESSMENT **by engine**, so a pinned query
 * would have queued a submission no node could claim.
 *
 * Both are gone — 13a gave a sitting a language per question, 16n gave the
 * query engine a calibration benchmark, 16o froze the kind — so this file
 * asserts the ACCEPTANCE, and that the guard is gone from the LIVE
 * database rather than merely dropped in a migration.
 *
 * What it still asserts unchanged: a pinned question cannot be REPOINTED.
 * That was the write-once rule all along, and since the kind trigger went
 * it is the only rule left on this table.
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
        displayCode: await freeDisplayCode(db),
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

  /**
   * Phase 16o. This test asserted the opposite until the lane and the
   * surface both existed, and the refusal it checked is the thing that is
   * gone: `AssessmentProblem_no_sql` and its function are dropped, recorded
   * in `DROPPED_GUARDS` rather than deleted.
   *
   * It asserts the ACCEPTANCE against the real tables because a dropped
   * trigger is not the same claim as a working pin: the row has to exist,
   * carry the SQL version it names, and still be subject to every other
   * rule on the table — which the two tests below are about.
   */
  it("accepts the pin of a SQL version, now that a sitting can hold one", async () => {
    const v = await frozen({
      ioMode: "SQL",
      compareMode: "ROWS",
      sqlDialect: "postgres17",
      sqlOrdered: false,
    });
    expect(v.ioMode).toBe("SQL");
    const row = await db.assessmentProblem.create({
      data: { assessmentId, problemVersionId: v.id, position: 1, points: 100 },
      select: { id: true, problemVersionId: true },
    });
    expect(row.problemVersionId).toBe(v.id);
    // And it is really there, read back rather than inferred from the
    // create's return value.
    const stored = await db.assessmentProblem.findUniqueOrThrow({
      where: { id: row.id },
      select: { problemVersionId: true, position: true },
    });
    expect(stored).toEqual({ problemVersionId: v.id, position: 1 });
  });

  it("has no trigger left to refuse it, and the catalogue says so", async () => {
    // The guard is gone from the LIVE database, which is a different
    // statement from the migration having a DROP in it.
    const triggers = await db.$queryRawUnsafe<{ tgname: string }[]>(
      `SELECT tgname FROM pg_trigger WHERE NOT tgisinternal AND tgname = $1`,
      "AssessmentProblem_no_sql",
    );
    expect(triggers).toEqual([]);
    const fns = await db.$queryRawUnsafe<{ proname: string }[]>(
      `SELECT proname FROM pg_proc WHERE proname = $1`,
      "recx_refuse_sql_assessment_problem",
    );
    expect(fns).toEqual([]);
  });

  it("cannot acquire one by repointing a row either, and says which rule stopped it", async () => {
    /**
     * A pinned question must not change underneath a candidate, whatever
     * kind the new one is. `AssessmentProblem` freezes assessmentId,
     * problemVersionId and position, so a repoint is refused by THAT rule.
     *
     * It mattered less while the kind trigger also stood; since Phase 16o
     * dropped that trigger this is the only rule left here, which makes
     * this test the one that holds the line. The refusal must keep naming
     * the write-once rule rather than any kind rule.
     */
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
