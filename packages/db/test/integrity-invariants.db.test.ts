import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  applyMigrations,
  disabledTriggers,
  openTestDb,
  RUN_DB_TESTS,
  testDatabaseName,
  type TestDb,
} from "./support/test-db";

/**
 * The review invariants (migration 20261019240000).
 *
 * These are the promises Phase 6 makes to a student, and they are in the
 * DATABASE because a promise enforced only in a route is a promise one future
 * route forgets:
 *
 *   - a verdict carries a WRITTEN rationale. Not "ok", not "cleared" — the
 *     floor is 40 characters, which is about the shortest a real sentence
 *     runs, and the student reads it in their own report;
 *   - an appeal takes TWO people, and the same person twice is not two
 *     people;
 *   - terminating a sitting takes a second staff member;
 *   - a flag's band is written once, so retuning the thresholds later cannot
 *     change what a verdict was a verdict ABOUT;
 *   - nothing here is ever deleted or rewritten, because a student may appeal
 *     it and an appeal needs something to read.
 *
 * Phase 6d taught the reason this file exists: three CHECK constraints there
 * were created happily by Postgres and failed on every insert, and both
 * catalog fences reported them present and correct. A catalog fence proves a
 * guard EXISTS; only this kind of test proves it WORKS.
 */

const tag = `ig-${randomBytes(4).toString("hex")}`;
const TITLE = RUN_DB_TESTS
  ? "integrity review invariants (live database)"
  : "integrity review invariants (set RECX_DB_TESTS=1 to run)";

/** Long enough to satisfy the rationale floor. */
const RATIONALE =
  "Reviewed the snapshot timeline and the paste events; the code grew steadily and nothing was pasted.";
const SHORT = "ok";

describe.skipIf(!RUN_DB_TESTS)(TITLE, () => {
  let db: TestDb;
  let restoreEnv: () => void;

  let studentId = "";
  let reviewerA = "";
  let reviewerB = "";
  let assessmentId = "";
  const attemptIds: string[] = [];
  let nextAttempt = 1;

  async function refused(fn: () => Promise<unknown>): Promise<string> {
    try {
      await fn();
    } catch (error) {
      return String((error as Error).message);
    }
    throw new Error("the write was expected to be refused, but it went through");
  }

  /** A finished sitting, so a flag has something to hang off. */
  async function attempt(): Promise<string> {
    const startedAt = new Date(Date.now() - 3_600_000);
    const row = await db.assessmentAttempt.create({
      data: {
        assessmentId,
        userId: studentId,
        attemptNumber: nextAttempt++,
        seed: 1,
        startedAt,
        expiresAt: new Date(startedAt.getTime() + 3_600_000),
        layout: { v: 1, questions: [] },
        tokenHash: "c".repeat(64),
        proctorMode: "ADVISORY",
        status: "SUBMITTED",
        submittedAt: new Date(),
      },
      select: { id: true },
    });
    attemptIds.push(row.id);
    return row.id;
  }

  async function flag(over: Record<string, unknown> = {}) {
    const attemptId = (over.attemptId as string | undefined) ?? (await attempt());
    const flaggedAt = new Date();
    return db.integrityFlag.create({
      data: {
        attemptId,
        band: "MEDIUM",
        substantivePoints: 37,
        reviewersRequired: 1,
        flaggedAt,
        reviewDeadline: new Date(flaggedAt.getTime() + 72 * 3_600_000),
        ...over,
      },
      select: { id: true, status: true, band: true },
    });
  }

  beforeAll(async () => {
    const dbName = testDatabaseName();
    applyMigrations();
    ({ db, restore: restoreEnv } = await openTestDb());
    const [current] = await db.$queryRawUnsafe<Array<{ name: string }>>("SELECT current_database() AS name");
    expect(current?.name).toBe(dbName);
    expect(await disabledTriggers(db)).toEqual([]);

    const make = async (suffix: string, role: "STUDENT" | "ADMIN") => {
      const handle = `${tag}-${suffix}`;
      const row = await db.user.create({
        data: {
          collegeId: handle.toUpperCase(),
          email: `${handle}@example.test`,
          firstName: "A",
          lastName: "Person",
          handle,
          role,
        },
        select: { id: true },
      });
      return row.id;
    };
    studentId = await make("s", "STUDENT");
    reviewerA = await make("ra", "ADMIN");
    reviewerB = await make("rb", "ADMIN");

    const assessment = await db.assessment.create({
      data: {
        slug: `${tag}-a`,
        title: "Review fixture",
        instructions: "Go.",
        opensAt: new Date(Date.now() - 7_200_000),
        closesAt: new Date(Date.now() + 7_200_000),
        durationSec: 3_600,
        maxAttempts: 5,
        createdById: reviewerA,
      },
      select: { id: true },
    });
    assessmentId = assessment.id;
  });

  afterAll(async () => {
    if (!db) return;
    try {
      const raw = (sql: string, ...params: unknown[]) => db.$executeRawUnsafe(sql, ...params);
      const users = [studentId, reviewerA, reviewerB];
      const off = [
        ["IntegrityReview", "IntegrityReview_append_only"],
        ["IntegrityAppeal", "IntegrityAppeal_write_once"],
        ["IntegrityFlag", "IntegrityFlag_write_once"],
        ["InvigilatorMessage", "InvigilatorMessage_write_once"],
        ["AttemptTermination", "AttemptTermination_write_once"],
        ["AssessmentAttempt", "AssessmentAttempt_machine"],
        ["Assessment", "Assessment_published_immutable"],
      ] as const;
      await db.$transaction([
        ...off.map(([t, g]) => raw(`ALTER TABLE "public"."${t}" DISABLE TRIGGER "${g}"`)),
        raw(`DELETE FROM "public"."IntegrityAppeal" WHERE "studentId" = ANY($1::text[])`, users),
        raw(
          `DELETE FROM "public"."IntegrityReview" WHERE "flagId" IN (SELECT "id" FROM "public"."IntegrityFlag" WHERE "attemptId" = ANY($1::text[]))`,
          attemptIds,
        ),
        raw(`DELETE FROM "public"."IntegrityFlag" WHERE "attemptId" = ANY($1::text[])`, attemptIds),
        raw(`DELETE FROM "public"."InvigilatorMessage" WHERE "attemptId" = ANY($1::text[])`, attemptIds),
        raw(`DELETE FROM "public"."AttemptTermination" WHERE "attemptId" = ANY($1::text[])`, attemptIds),
        raw(`DELETE FROM "public"."AssessmentAttempt" WHERE "userId" = ANY($1::text[])`, users),
        raw(`DELETE FROM "public"."Assessment" WHERE "id" = $1`, assessmentId),
        ...off.map(([t, g]) => raw(`ALTER TABLE "public"."${t}" ENABLE TRIGGER "${g}"`)),
        raw(`DELETE FROM "public"."User" WHERE "id" = ANY($1::text[])`, users),
      ]);
      expect(await disabledTriggers(db)).toEqual([]);
    } finally {
      await db.$disconnect();
      restoreEnv?.();
    }
  });

  // ── The flag ───────────────────────────────────────────────────────────

  describe("a flag withholds and orders; it carries no score", () => {
    it("records a band and its points", async () => {
      const row = await flag();
      expect(row.band).toBe("MEDIUM");
      expect(row.status).toBe("OPEN");
    });

    it("refuses a NONE band — that is not a flag at all", async () => {
      expect(await refused(() => flag({ band: "NONE", substantivePoints: 2, reviewersRequired: 0 }))).toMatch(
        /band_check/,
      );
    });

    it("refuses a reviewer count its band does not call for", async () => {
      // 1 at MEDIUM, 2 at HIGH. A flag cannot claim to need a different
      // number from the one its band means.
      expect(await refused(() => flag({ band: "MEDIUM", reviewersRequired: 2 }))).toMatch(/reviewers_check/);
      expect(await refused(() => flag({ band: "HIGH", substantivePoints: 80, reviewersRequired: 1 }))).toMatch(
        /reviewers_check/,
      );
      await expect(flag({ band: "HIGH", substantivePoints: 80, reviewersRequired: 2 })).resolves.toBeDefined();
      await expect(flag({ band: "LOW", substantivePoints: 20, reviewersRequired: 0 })).resolves.toBeDefined();
    });

    it("refuses negative points", async () => {
      expect(await refused(() => flag({ substantivePoints: -1 }))).toMatch(/points_check/);
    });

    it("refuses a deadline before the flag", async () => {
      const flaggedAt = new Date();
      expect(
        await refused(() => flag({ flaggedAt, reviewDeadline: new Date(flaggedAt.getTime() - 1_000) })),
      ).toMatch(/deadline_check/);
    });

    it("keeps a result withheld exactly while the flag is OPEN", async () => {
      // "Withhold from the public leaderboard" is the WHOLE automatic
      // consequence, so it has to end when the review does.
      expect(await refused(() => flag({ withheld: false }))).toMatch(/withheld_check/);
      const row = await flag();
      expect(
        await refused(() =>
          db.integrityFlag.update({ where: { id: row.id }, data: { status: "CLEARED", resolvedAt: new Date() } }),
        ),
      ).toMatch(/withheld_check/);
      await expect(
        db.integrityFlag.update({
          where: { id: row.id },
          data: { status: "CLEARED", resolvedAt: new Date(), withheld: false },
        }),
      ).resolves.toBeDefined();
    });

    it("writes the band once, so a retune cannot change what a verdict judged", async () => {
      const row = await flag();
      expect(
        await refused(() => db.integrityFlag.update({ where: { id: row.id }, data: { band: "HIGH" } })),
      ).toMatch(/written once/);
      expect(
        await refused(() => db.integrityFlag.update({ where: { id: row.id }, data: { substantivePoints: 99 } })),
      ).toMatch(/written once/);
    });

    it("never reopens once resolved", async () => {
      const row = await flag();
      await db.integrityFlag.update({
        where: { id: row.id },
        data: { status: "CLEARED", resolvedAt: new Date(), withheld: false },
      });
      expect(
        await refused(() =>
          db.integrityFlag.update({ where: { id: row.id }, data: { status: "OPEN", resolvedAt: null, withheld: true } }),
        ),
      ).toMatch(/cannot be reopened/);
    });

    it("reaches OVERTURNED only from UPHELD", async () => {
      const cleared = await flag();
      await db.integrityFlag.update({
        where: { id: cleared.id },
        data: { status: "CLEARED", resolvedAt: new Date(), withheld: false },
      });
      expect(
        await refused(() => db.integrityFlag.update({ where: { id: cleared.id }, data: { status: "OVERTURNED" } })),
      ).toMatch(/already resolved|only an upheld flag/);

      const upheld = await flag();
      await db.integrityFlag.update({
        where: { id: upheld.id },
        data: { status: "UPHELD", resolvedAt: new Date(), withheld: false },
      });
      await expect(
        db.integrityFlag.update({ where: { id: upheld.id }, data: { status: "OVERTURNED" } }),
      ).resolves.toBeDefined();
    });

    it("is never deleted, because a student may appeal it", async () => {
      const row = await flag();
      expect(await refused(() => db.integrityFlag.delete({ where: { id: row.id } }))).toMatch(/never deleted/);
      expect(await refused(() => db.$executeRawUnsafe(`TRUNCATE TABLE "public"."IntegrityFlag"`))).toMatch(
        /truncate/i,
      );
    });

    it("allows one flag per sitting", async () => {
      const attemptId = await attempt();
      await flag({ attemptId });
      expect(await refused(() => flag({ attemptId }))).toMatch(/attemptId/);
    });
  });

  // ── The written rationale ──────────────────────────────────────────────

  describe("a verdict carries a written rationale", () => {
    it("accepts a real sentence", async () => {
      const row = await flag();
      await expect(
        db.integrityReview.create({
          data: { flagId: row.id, reviewerId: reviewerA, verdict: "CLEAR", rationale: RATIONALE },
        }),
      ).resolves.toBeDefined();
    });

    it('refuses "ok" — which is the whole point of the floor', async () => {
      const row = await flag();
      expect(
        await refused(() =>
          db.integrityReview.create({
            data: { flagId: row.id, reviewerId: reviewerA, verdict: "CLEAR", rationale: SHORT },
          }),
        ),
      ).toMatch(/rationale_check/);
    });

    it("refuses whitespace padded out to the floor", async () => {
      const row = await flag();
      expect(
        await refused(() =>
          db.integrityReview.create({
            data: { flagId: row.id, reviewerId: reviewerA, verdict: "UPHOLD", rationale: `${SHORT}${" ".repeat(60)}` },
          }),
        ),
      ).toMatch(/rationale_check/);
    });

    it("refuses one past the ceiling", async () => {
      const row = await flag();
      expect(
        await refused(() =>
          db.integrityReview.create({
            data: { flagId: row.id, reviewerId: reviewerA, verdict: "CLEAR", rationale: "x".repeat(4_001) },
          }),
        ),
      ).toMatch(/rationale_check/);
    });

    it("is never rewritten or deleted: it is the record of a human decision", async () => {
      const row = await flag();
      const review = await db.integrityReview.create({
        data: { flagId: row.id, reviewerId: reviewerA, verdict: "UPHOLD", rationale: RATIONALE },
        select: { id: true },
      });
      expect(
        await refused(() => db.integrityReview.update({ where: { id: review.id }, data: { verdict: "CLEAR" } })),
      ).toMatch(/never changed/);
      expect(await refused(() => db.integrityReview.delete({ where: { id: review.id } }))).toMatch(/never deleted/);
    });

    it("counts two reviewers as two PEOPLE, not one person twice", async () => {
      const row = await flag({ band: "HIGH", substantivePoints: 80, reviewersRequired: 2 });
      await db.integrityReview.create({
        data: { flagId: row.id, reviewerId: reviewerA, verdict: "UPHOLD", rationale: RATIONALE },
      });
      expect(
        await refused(() =>
          db.integrityReview.create({
            data: { flagId: row.id, reviewerId: reviewerA, verdict: "UPHOLD", rationale: `${RATIONALE} Again.` },
          }),
        ),
      ).toMatch(/flagId|reviewerId/);
      await expect(
        db.integrityReview.create({
          data: { flagId: row.id, reviewerId: reviewerB, verdict: "CLEAR", rationale: RATIONALE },
        }),
      ).resolves.toBeDefined();
    });
  });

  // ── The two-person appeal ──────────────────────────────────────────────

  describe("an appeal takes two people", () => {
    async function appeal(over: Record<string, unknown> = {}) {
      const row = await flag();
      const submittedAt = new Date();
      return db.integrityAppeal.create({
        data: {
          flagId: row.id,
          studentId,
          reason: "I wrote this myself; the timeline shows me working through it.",
          submittedAt,
          decideBy: new Date(submittedAt.getTime() + 7 * 24 * 3_600_000),
          ...over,
        },
        select: { id: true },
      });
    }

    it("records the student's own words", async () => {
      await expect(appeal()).resolves.toBeDefined();
    });

    it("refuses an appeal too short to be one", async () => {
      expect(await refused(() => appeal({ reason: "unfair" }))).toMatch(/reason_check/);
    });

    it("refuses a window that closes before it opens", async () => {
      const submittedAt = new Date();
      expect(
        await refused(() => appeal({ submittedAt, decideBy: new Date(submittedAt.getTime() - 1_000) })),
      ).toMatch(/window_check/);
    });

    it("refuses a verdict without its rationale", async () => {
      const row = await appeal();
      expect(
        await refused(() =>
          db.integrityAppeal.update({
            where: { id: row.id },
            data: { firstReviewerId: reviewerA, firstVerdict: "CLEAR", firstDecidedAt: new Date() },
          }),
        ),
      ).toMatch(/first_check/);
    });

    it("refuses the same person as both reviewers", async () => {
      const row = await appeal();
      await db.integrityAppeal.update({
        where: { id: row.id },
        data: {
          firstReviewerId: reviewerA,
          firstVerdict: "CLEAR",
          firstRationale: RATIONALE,
          firstDecidedAt: new Date(),
        },
      });
      expect(
        await refused(() =>
          db.integrityAppeal.update({
            where: { id: row.id },
            data: {
              secondReviewerId: reviewerA,
              secondVerdict: "CLEAR",
              secondRationale: RATIONALE,
              secondDecidedAt: new Date(),
            },
          }),
        ),
      ).toMatch(/two_person_check/);
    });

    it("refuses a second reviewer before a first", async () => {
      const row = await appeal();
      expect(
        await refused(() =>
          db.integrityAppeal.update({
            where: { id: row.id },
            data: {
              secondReviewerId: reviewerB,
              secondVerdict: "CLEAR",
              secondRationale: RATIONALE,
              secondDecidedAt: new Date(),
            },
          }),
        ),
      ).toMatch(/order_check/);
    });

    it("refuses a decision before both have spoken", async () => {
      const row = await appeal();
      await db.integrityAppeal.update({
        where: { id: row.id },
        data: {
          firstReviewerId: reviewerA,
          firstVerdict: "CLEAR",
          firstRationale: RATIONALE,
          firstDecidedAt: new Date(),
        },
      });
      expect(
        await refused(() =>
          db.integrityAppeal.update({
            where: { id: row.id },
            data: { outcome: "OVERTURNED", resolvedAt: new Date() },
          }),
        ),
      ).toMatch(/complete_check/);
    });

    it("accepts a complete two-person decision", async () => {
      const row = await appeal();
      await db.integrityAppeal.update({
        where: { id: row.id },
        data: {
          firstReviewerId: reviewerA,
          firstVerdict: "CLEAR",
          firstRationale: RATIONALE,
          firstDecidedAt: new Date(),
          secondReviewerId: reviewerB,
          secondVerdict: "CLEAR",
          secondRationale: RATIONALE,
          secondDecidedAt: new Date(),
        },
      });
      await expect(
        db.integrityAppeal.update({
          where: { id: row.id },
          data: { outcome: "OVERTURNED", resolvedAt: new Date() },
        }),
      ).resolves.toBeDefined();
    });

    it("never rewrites a recorded verdict or the student's words", async () => {
      const row = await appeal();
      await db.integrityAppeal.update({
        where: { id: row.id },
        data: {
          firstReviewerId: reviewerA,
          firstVerdict: "CLEAR",
          firstRationale: RATIONALE,
          firstDecidedAt: new Date(),
        },
      });
      expect(
        await refused(() => db.integrityAppeal.update({ where: { id: row.id }, data: { firstVerdict: "UPHOLD" } })),
      ).toMatch(/never rewritten/);
      expect(
        await refused(() =>
          db.integrityAppeal.update({ where: { id: row.id }, data: { reason: "something else entirely" } }),
        ),
      ).toMatch(/written once/);
    });
  });

  // ── Terminate takes two staff ──────────────────────────────────────────

  describe("terminating a sitting takes a second staff member", () => {
    async function termination(over: Record<string, unknown> = {}) {
      const attemptId = await attempt();
      return db.attemptTermination.create({
        data: {
          attemptId,
          requestedById: reviewerA,
          reason: "Candidate was observed with a phone under the desk.",
          ...over,
        },
        select: { id: true },
      });
    }

    it("records who asked and why", async () => {
      await expect(termination()).resolves.toBeDefined();
    });

    it("refuses a reason too short to be one", async () => {
      expect(await refused(() => termination({ reason: "cheating" }))).toMatch(/reason_check/);
    });

    it("refuses the requester as their own second staff member", async () => {
      // This CHECK IS the two-person rule. A rule enforced only in a route is
      // a rule one future route forgets.
      const row = await termination();
      expect(
        await refused(() =>
          db.attemptTermination.update({
            where: { id: row.id },
            data: { confirmedById: reviewerA, confirmedAt: new Date() },
          }),
        ),
      ).toMatch(/two_person_check/);
    });

    it("accepts a different staff member", async () => {
      const row = await termination();
      await expect(
        db.attemptTermination.update({
          where: { id: row.id },
          data: { confirmedById: reviewerB, confirmedAt: new Date() },
        }),
      ).resolves.toBeDefined();
    });

    it("refuses a confirmation without a name, or a name without a moment", async () => {
      const row = await termination();
      expect(
        await refused(() => db.attemptTermination.update({ where: { id: row.id }, data: { confirmedAt: new Date() } })),
      ).toMatch(/confirmed_check/);
      expect(
        await refused(() =>
          db.attemptTermination.update({ where: { id: row.id }, data: { confirmedById: reviewerB } }),
        ),
      ).toMatch(/confirmed_check/);
    });

    it("confirms once", async () => {
      const row = await termination();
      await db.attemptTermination.update({
        where: { id: row.id },
        data: { confirmedById: reviewerB, confirmedAt: new Date() },
      });
      expect(
        await refused(() =>
          db.attemptTermination.update({
            where: { id: row.id },
            data: { confirmedById: reviewerA, confirmedAt: new Date() },
          }),
        ),
      ).toMatch(/already confirmed|two_person/);
    });

    it("writes who asked and why once", async () => {
      const row = await termination();
      expect(
        await refused(() =>
          db.attemptTermination.update({ where: { id: row.id }, data: { reason: "a different reason entirely" } }),
        ),
      ).toMatch(/written once/);
    });
  });

  // ── The invigilator's message ──────────────────────────────────────────

  describe("an invigilator message, and its acknowledgement", () => {
    async function message(over: Record<string, unknown> = {}) {
      const attemptId = await attempt();
      return db.invigilatorMessage.create({
        data: { attemptId, body: "Please raise your hand.", sentById: reviewerA, ...over },
        select: { id: true },
      });
    }

    it("records what was sent", async () => {
      await expect(message()).resolves.toBeDefined();
    });

    it("refuses an empty body", async () => {
      expect(await refused(() => message({ body: "   " }))).toMatch(/body_check/);
    });

    it("records an acknowledgement once", async () => {
      const row = await message();
      await db.invigilatorMessage.update({ where: { id: row.id }, data: { acknowledgedAt: new Date() } });
      expect(
        await refused(() =>
          db.invigilatorMessage.update({ where: { id: row.id }, data: { acknowledgedAt: new Date() } }),
        ),
      ).toMatch(/already acknowledged/);
    });

    it("never rewrites what was sent, by whom or when", async () => {
      const row = await message();
      expect(
        await refused(() => db.invigilatorMessage.update({ where: { id: row.id }, data: { body: "something else" } })),
      ).toMatch(/written once/);
    });
  });
});
