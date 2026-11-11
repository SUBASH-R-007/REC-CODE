import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations, disabledTriggers, openTestDb, RUN_DB_TESTS, testDatabaseName, type TestDb } from "./support/test-db";

/**
 * The interview archive's invariants (migration 20261030200000).
 *
 * Every row here is a public claim about a named company, so each CHECK
 * holds up something a reader is told: a decided row names the person,
 * the moment and the sentence the student is shown; a row with no author
 * is the pre-launch collection and nothing else; a month is a month; and
 * a company tag's frequency is a count.
 */

const run = (randomBytes(3).readUIntBE(0, 3) % 90_000) + 10_000;
const TITLE = RUN_DB_TESTS ? "interview archive invariants (live database)" : "interview archive invariants (set RECX_DB_TESTS=1 to run)";

describe.skipIf(!RUN_DB_TESTS)(TITLE, () => {
  let db: TestDb;
  let restoreEnv: () => void;
  let userId = "";
  let moderatorId = "";
  let companyId = "";
  let problemId = "";

  async function refused(fn: () => Promise<unknown>): Promise<string> {
    try {
      await fn();
    } catch (error) {
      return String((error as Error).message);
    }
    throw new Error("the write was expected to be refused, but it went through");
  }

  const experience = (over: Record<string, unknown> = {}) =>
    db.interviewExperience.create({
      data: {
        authorId: userId,
        companyName: "A Company",
        role: "Software Engineer",
        mode: "ON_CAMPUS",
        heldYear: 2026,
        heldMonth: 3,
        rounds: 3,
        outcome: "WAITING",
        roundKinds: ["TECHNICAL"],
        topics: ["GRAPHS"],
        preparation: ["REC_CODE_PRACTICE"],
        ...over,
      } as never,
      select: { id: true, status: true, source: true },
    });

  beforeAll(async () => {
    const dbName = testDatabaseName();
    applyMigrations();
    ({ db, restore: restoreEnv } = await openTestDb());
    const [current] = await db.$queryRawUnsafe<Array<{ name: string }>>("SELECT current_database() AS name");
    expect(current?.name).toBe(dbName);
    expect(await disabledTriggers(db)).toEqual([]);

    for (const [role, suffix] of [
      ["STUDENT", "s"],
      ["TA_MENTOR", "m"],
    ] as const) {
      const user = await db.user.create({
        data: {
          collegeId: `IVW${run}${suffix}`,
          email: `ivw-${run}-${suffix}@example.test`,
          firstName: "A",
          lastName: role === "STUDENT" ? "Student" : "Mentor",
          handle: `ivw-${run}-${suffix}`,
          role,
          batchYear: 2027,
          departmentCode: "CSE",
        },
        select: { id: true },
      });
      if (role === "STUDENT") userId = user.id;
      else moderatorId = user.id;
    }

    companyId = (
      await db.company.create({ data: { slug: `ivw-${run}`, name: `Company ${run}` }, select: { id: true } })
    ).id;
    problemId = (
      await db.problem.create({
        data: { slug: `ivw-${run}`, displayCode: `IVW-${run}`, title: "A problem they asked", difficulty: "EASY" },
        select: { id: true },
      })
    ).id;
  });

  afterAll(async () => {
    if (!db) return;
    try {
      await db.interviewExperienceProblem.deleteMany({ where: { problemId } });
      await db.interviewExperience.deleteMany({ where: { authorId: { in: [userId, moderatorId] } } });
      await db.interviewExperience.deleteMany({ where: { companyId } });
      await db.problemCompanyTag.deleteMany({ where: { companyId } });
      await db.problem.deleteMany({ where: { id: problemId } });
      await db.company.deleteMany({ where: { id: companyId } });
      await db.user.deleteMany({ where: { id: { in: [userId, moderatorId] } } });
      expect(await disabledTriggers(db)).toEqual([]);
    } finally {
      await db.$disconnect();
      restoreEnv?.();
    }
  });

  describe("a decided row names who decided it and why", () => {
    it("accepts a pending row with none of the three set", async () => {
      expect((await experience()).status).toBe("PENDING");
    });

    it("accepts a properly decided row", async () => {
      const row = await experience({
        status: "APPROVED",
        decidedById: moderatorId,
        decidedAt: new Date(),
        decisionReason: "Clear, specific and nothing a company could object to.",
      });
      expect(row.status).toBe("APPROVED");
    });

    it("refuses a decision with nobody attached, and a pending row carrying one", async () => {
      expect(await refused(() => experience({ status: "REJECTED", decidedAt: new Date() }))).toMatch(
        /InterviewExperience_decided_pair_check/,
      );
      expect(await refused(() => experience({ decidedById: moderatorId, decidedAt: new Date() }))).toMatch(
        /InterviewExperience_decided_pair_check/,
      );
    });

    it("refuses a reason too short to be one", async () => {
      expect(
        await refused(() =>
          experience({ status: "APPROVED", decidedById: moderatorId, decidedAt: new Date(), decisionReason: "no" }),
        ),
      ).toMatch(/InterviewExperience_(decided_pair|reason_size)_check/);
    });
  });

  describe("a row with no author is the pre-launch collection", () => {
    it("accepts a BOOTSTRAP row with no author", async () => {
      const row = await experience({ source: "BOOTSTRAP", authorId: null });
      expect(row.source).toBe("BOOTSTRAP");
    });

    it("refuses a STUDENT row with no author", async () => {
      // An anonymous claim about a named company, with nobody to ask.
      expect(await refused(() => experience({ authorId: null }))).toMatch(/InterviewExperience_author_check/);
    });
  });

  describe("the shape of the facts", () => {
    it("refuses a month that is not one, and a year out of range", async () => {
      expect(await refused(() => experience({ heldMonth: 0 }))).toMatch(/InterviewExperience_held_check/);
      expect(await refused(() => experience({ heldMonth: 13 }))).toMatch(/InterviewExperience_held_check/);
      expect(await refused(() => experience({ heldYear: 1999 }))).toMatch(/InterviewExperience_held_check/);
    });

    it("refuses zero rounds, and a round count nobody sat", async () => {
      expect(await refused(() => experience({ rounds: 0 }))).toMatch(/InterviewExperience_rounds_check/);
      expect(await refused(() => experience({ rounds: 99 }))).toMatch(/InterviewExperience_rounds_check/);
    });

    it("refuses an experience that names no kind of round", async () => {
      expect(await refused(() => experience({ roundKinds: [] }))).toMatch(/InterviewExperience_round_kinds_check/);
    });

    it("refuses an unreasonable round length, and a one-character company", async () => {
      expect(await refused(() => experience({ longestRoundMinutes: 1 }))).toMatch(/InterviewExperience_duration_check/);
      expect(await refused(() => experience({ companyName: "X" }))).toMatch(/InterviewExperience_company_name_check/);
    });
  });

  describe("a company tag's frequency is a count", () => {
    it("accepts zero and above", async () => {
      const tag = await db.problemCompanyTag.create({
        data: { problemId, companyId, frequency: 0, source: "CURATED" },
        select: { frequency: true },
      });
      expect(tag.frequency).toBe(0);
      await db.problemCompanyTag.delete({ where: { problemId_companyId: { problemId, companyId } } });
    });

    it("refuses a negative one, which is what a bad decrement would write", async () => {
      expect(
        await refused(() => db.problemCompanyTag.create({ data: { problemId, companyId, frequency: -1 } })),
      ).toMatch(/ProblemCompanyTag_frequency_check/);
    });
  });
});
