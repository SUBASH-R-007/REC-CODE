import { randomBytes } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { READINESS_RULES_VERSION, TOPICS } from "@recx/shared";
import {
  applyMigrations,
  disabledTriggers,
  openTestDb,
  RUN_DB_TESTS,
  testDatabaseName,
  type TestDb,
} from "./support/test-db";

/**
 * The readiness invariants (migration 20261020270000).
 *
 * SPEC §5 asks for readiness to be "a preparation-coverage measure,
 * explicitly not a prediction of being placed", with the component breakdown
 * retained and missing components shown as missing. Three constraints here
 * are that promise expressed in the data rather than in a code review, and
 * they are the reason this suite exists:
 *
 *   - `score <= availableWeight` — a renormalised or zero-filled score is
 *     NOT STORABLE. With `mockInterviewScore` unsourced, no TOP score may
 *     exceed 85, and a row claiming 95 is refused.
 *   - `(availableWeight = 0) = (score IS NULL)` — a tier with nothing
 *     measurable has NO score, not a zero.
 *   - a breadth value always names the topic that limited it, so the MINIMUM
 *     is checkable rather than asserted.
 *
 * And the mentor rule, which is a privacy boundary rather than a tidy-up: a
 * PLACEMENT_OFFICER may never be the mentor of record, because the at-risk
 * list exists to route a student AWAY from the analytics surface.
 */

const run = (randomBytes(3).readUIntBE(0, 3) % 90_000) + 10_000;
const TITLE = RUN_DB_TESTS
  ? "readiness invariants (live database)"
  : "readiness invariants (set RECX_DB_TESTS=1 to run)";

/** Far in the future, so no other suite's run row collides with ours. */
const DAY = "2095-03-14";
const computedOn = new Date(`${DAY}T00:00:00.000Z`);

const EVEN_TOPICS = Object.fromEntries(TOPICS.map((topic) => [topic, 3]));

describe.skipIf(!RUN_DB_TESTS)(TITLE, () => {
  let db: TestDb;
  let restoreEnv: () => void;
  let studentId = "";
  let mentorId = "";
  let officerId = "";
  let staffId = "";
  const userIds: string[] = [];
  const assignmentIds: string[] = [];

  async function refused(fn: () => Promise<unknown>): Promise<string> {
    try {
      await fn();
    } catch (error) {
      return String((error as Error).message);
    }
    throw new Error("the write was expected to be refused, but it went through");
  }

  const snapshot = (over: Record<string, unknown> = {}) =>
    db.readinessSnapshot.create({
      data: {
        userId: studentId,
        computedOn,
        rulesVersion: READINESS_RULES_VERSION,
        cohortKey: "2095",
        cohortSize: 120,
        serviceScore: 60,
        productScore: 50,
        topScore: 40,
        serviceAvailableWeight: 90,
        productAvailableWeight: 90,
        topAvailableWeight: 85,
        topicBreadthProduct: 25,
        topicBreadthTop: 12,
        limitingTopicProduct: "GRAPHS",
        limitingTopicTop: "GRAPHS",
        components: { SERVICE: {}, PRODUCT: {}, TOP: {} } as never,
        topicUnassisted: EVEN_TOPICS as never,
        ...over,
      } as never,
      select: { userId: true, serviceScore: true, topScore: true, rulesVersion: true },
    });

  const assignment = (over: Record<string, unknown> = {}) =>
    db.mentorAssignment
      .create({
        data: {
          menteeId: studentId,
          mentorId,
          assignedById: staffId,
          reason: "Flagged by the at-risk list; needs a conversation.",
          ...over,
        } as never,
        select: { id: true, endedAt: true },
      })
      .then((row) => {
        assignmentIds.push(row.id);
        return row;
      });

  beforeAll(async () => {
    const dbName = testDatabaseName();
    applyMigrations();
    ({ db, restore: restoreEnv } = await openTestDb());
    const [current] = await db.$queryRawUnsafe<Array<{ name: string }>>("SELECT current_database() AS name");
    expect(current?.name).toBe(dbName);
    expect(await disabledTriggers(db)).toEqual([]);

    const mk = async (suffix: string, role: "STUDENT" | "TA_MENTOR" | "PLACEMENT_OFFICER" | "SUPER_ADMIN") => {
      const row = await db.user.create({
        data: {
          collegeId: `RDY${run}${suffix}`,
          email: `rdy-${run}-${suffix}@example.test`,
          firstName: "A",
          lastName: suffix,
          handle: `rdy-${run}-${suffix}`,
          role,
        },
        select: { id: true },
      });
      userIds.push(row.id);
      return row.id;
    };
    studentId = await mk("s", "STUDENT");
    mentorId = await mk("m", "TA_MENTOR");
    officerId = await mk("o", "PLACEMENT_OFFICER");
    staffId = await mk("t", "SUPER_ADMIN");

    // A snapshot has a foreign key to its run, so the run comes first.
    //
    // `startedAt` is written explicitly rather than left to the column's
    // CURRENT_TIMESTAMP default: the WSL mirror's clock runs a fraction of a
    // second behind the host's, so a `finishedAt` taken from the app clock
    // lands BEFORE a `startedAt` taken from the database's and
    // `ReadinessRun_window_check` refuses the row (docs/CONVENTIONS.md).
    // Both ends of a window always come from the same clock.
    const started = new Date("2095-03-14T02:30:00.000Z");
    await db.readinessRun.create({
      data: {
        computedOn,
        rulesVersion: READINESS_RULES_VERSION,
        startedAt: started,
        finishedAt: new Date(started.getTime() + 60_000),
        ok: true,
      },
    });
  });

  afterEach(async () => {
    // Each test writes at most one snapshot for the one student, so the
    // unique key would refuse the next one.
    await db.readinessSnapshot.deleteMany({ where: { userId: studentId } });
  });

  afterAll(async () => {
    if (!db) return;
    try {
      await db.readinessSnapshot.deleteMany({ where: { userId: { in: userIds } } });
      await db.readinessRun.deleteMany({ where: { computedOn } });
      // An assignment refuses DELETE by trigger — it is ended, never removed.
      await db.$executeRawUnsafe(`ALTER TABLE "MentorAssignment" DISABLE TRIGGER "MentorAssignment_immutable"`);
      await db.mentorAssignment.deleteMany({ where: { id: { in: assignmentIds } } });
      await db.$executeRawUnsafe(`ALTER TABLE "MentorAssignment" ENABLE TRIGGER "MentorAssignment_immutable"`);
      await db.user.deleteMany({ where: { id: { in: userIds } } });
      expect(await disabledTriggers(db)).toEqual([]);
    } finally {
      await db.$disconnect();
      restoreEnv?.();
    }
  });

  describe("a score never exceeds what was measurable", () => {
    it("accepts a score equal to the available weight", async () => {
      const row = await snapshot({ topScore: 85, topAvailableWeight: 85 });
      expect(row.topScore).toBe(85);
    });

    it("REFUSES a TOP score of 95 when only 85 was measurable", async () => {
      /**
       * The honesty constraint. `mockInterviewScore` has no source in this
       * plan, so it is 15% of TOP that nobody can measure — and a row
       * claiming 95 would be a row that had quietly renormalised the weights,
       * making a student who has never done a mock interview look as ready
       * as one who has done five.
       */
      const message = await refused(() => snapshot({ topScore: 95, topAvailableWeight: 85 }));
      expect(message).toMatch(/ReadinessSnapshot_score_le_available/);
    });

    it("refuses it on SERVICE and PRODUCT too", async () => {
      expect(await refused(() => snapshot({ serviceScore: 95, serviceAvailableWeight: 90 }))).toMatch(
        /ReadinessSnapshot_score_le_available/,
      );
      expect(await refused(() => snapshot({ productScore: 95, productAvailableWeight: 90 }))).toMatch(
        /ReadinessSnapshot_score_le_available/,
      );
    });

    it("refuses a score or a weight outside 0..100", async () => {
      // A NEGATIVE score is the one case only the range check catches.
      expect(await refused(() => snapshot({ serviceScore: -1 }))).toMatch(/ReadinessSnapshot_score_range/);
      expect(await refused(() => snapshot({ serviceAvailableWeight: 101 }))).toMatch(
        /ReadinessSnapshot_weight_range/,
      );
      /**
       * Above 100 the two constraints overlap, and deliberately so: the
       * weight is itself capped at 100, so a score of 101 cannot help
       * exceeding its own denominator. Postgres reports whichever it
       * evaluates first, so the assertion names both rather than pretending
       * the order is fixed.
       */
      expect(await refused(() => snapshot({ serviceScore: 101, serviceAvailableWeight: 100 }))).toMatch(
        /ReadinessSnapshot_score_range|ReadinessSnapshot_score_le_available/,
      );
    });
  });

  describe("a tier with nothing measurable has NO score, not a zero", () => {
    it("accepts a null score with zero available weight", async () => {
      // "Show missing components as missing, never silently as zero", in the
      // column definition.
      const row = await snapshot({
        topScore: null,
        topAvailableWeight: 0,
        topicBreadthTop: null,
        limitingTopicTop: null,
      });
      expect(row.topScore).toBeNull();
    });

    it("refuses a ZERO score where nothing was measurable", async () => {
      // This is the row the whole constraint exists to refuse: a zero that
      // reads as "this student is not ready" when it means "we could not
      // measure them".
      const message = await refused(() => snapshot({ topScore: 0, topAvailableWeight: 0 }));
      expect(message).toMatch(/ReadinessSnapshot_null_when_unmeasurable/);
    });

    it("refuses a null score where something WAS measurable", async () => {
      // The other direction: a tier with 85 measurable has a score, even if
      // that score is 0.
      const message = await refused(() => snapshot({ topScore: null, topAvailableWeight: 85 }));
      expect(message).toMatch(/ReadinessSnapshot_null_when_unmeasurable/);
    });

    it("accepts a genuine zero when something was measurable", async () => {
      const row = await snapshot({ topScore: 0, topAvailableWeight: 85 });
      expect(row.topScore).toBe(0);
    });
  });

  describe("a breadth value always names the topic that limited it", () => {
    it("accepts a value with its topic, and a null with no topic", async () => {
      const withBoth = await snapshot({ topicBreadthProduct: 25, limitingTopicProduct: "GRAPHS" });
      expect(withBoth.userId).toBe(studentId);
      await db.readinessSnapshot.deleteMany({ where: { userId: studentId } });
      const withNeither = await snapshot({
        topicBreadthProduct: null,
        limitingTopicProduct: null,
        productScore: null,
        productAvailableWeight: 0,
      });
      expect(withNeither.userId).toBe(studentId);
    });

    it("refuses a value with no topic — a number nobody can act on", async () => {
      expect(await refused(() => snapshot({ topicBreadthProduct: 25, limitingTopicProduct: null }))).toMatch(
        /ReadinessSnapshot_breadth_pairs/,
      );
    });

    it("refuses a topic with no value", async () => {
      expect(await refused(() => snapshot({ topicBreadthTop: null, limitingTopicTop: "GRAPHS" }))).toMatch(
        /ReadinessSnapshot_breadth_pairs/,
      );
    });

    it("bounds a breadth value to 0..100", async () => {
      expect(await refused(() => snapshot({ topicBreadthTop: 101 }))).toMatch(
        /ReadinessSnapshot_breadth_range/,
      );
    });
  });

  describe("the cohort and the breakdown", () => {
    it("refuses an empty cohort key — a row must say which group it was not ranked in", async () => {
      expect(await refused(() => snapshot({ cohortKey: "   " }))).toMatch(/ReadinessSnapshot_cohort_check/);
    });

    it("refuses a negative cohort size or a zero rules version", async () => {
      expect(await refused(() => snapshot({ cohortSize: -1 }))).toMatch(/ReadinessSnapshot_cohort_check/);
      expect(await refused(() => snapshot({ rulesVersion: 0 }))).toMatch(/ReadinessSnapshot_cohort_check/);
    });

    it("refuses a breakdown that is not an object", async () => {
      expect(await refused(() => snapshot({ components: [] }))).toMatch(
        /ReadinessSnapshot_components_object/,
      );
      expect(await refused(() => snapshot({ topicUnassisted: 7 }))).toMatch(
        /ReadinessSnapshot_components_object|invalid input syntax/i,
      );
    });

    it("refuses a snapshot for a run that was never recorded", async () => {
      // The explanation of HOW a cohort's numbers were produced cannot be
      // absent.
      const message = await refused(() =>
        snapshot({ computedOn: new Date("2095-03-15T00:00:00.000Z") }),
      );
      expect(message).toMatch(/ReadinessSnapshot_computedOn_fkey|foreign key/i);
    });
  });

  describe("a snapshot is recomputed, never edited", () => {
    it("lets the same day be recomputed under the same rules version", async () => {
      await snapshot();
      const updated = await db.readinessSnapshot.update({
        where: { userId_computedOn: { userId: studentId, computedOn } },
        data: { serviceScore: 70 },
        select: { serviceScore: true },
      });
      expect(updated.serviceScore).toBe(70);
    });

    it("lets the rules version go FORWARD, which is a recalibration", async () => {
      await snapshot();
      const updated = await db.readinessSnapshot.update({
        where: { userId_computedOn: { userId: studentId, computedOn } },
        data: { rulesVersion: READINESS_RULES_VERSION + 1 },
        select: { rulesVersion: true },
      });
      expect(updated.rulesVersion).toBe(READINESS_RULES_VERSION + 1);
    });

    it("refuses the rules version going BACKWARDS", async () => {
      /**
       * A row whose rules version regressed would be a row whose stored
       * components no longer explain its score — which is the one thing the
       * breakdown exists to prevent.
       */
      await snapshot({ rulesVersion: 5 });
      const message = await refused(() =>
        db.readinessSnapshot.update({
          where: { userId_computedOn: { userId: studentId, computedOn } },
          data: { rulesVersion: 4 },
        }),
      );
      expect(message).toMatch(/ReadinessSnapshot_recompute_only/);
      expect(message).toMatch(/cannot go backwards/);
    });

    it("refuses moving a snapshot to another student, through raw SQL", async () => {
      await snapshot();
      const message = await refused(() =>
        db.$executeRawUnsafe(
          `UPDATE "ReadinessSnapshot" SET "userId" = $1 WHERE "userId" = $2`,
          mentorId,
          studentId,
        ),
      );
      expect(message).toMatch(/ReadinessSnapshot_recompute_only/);
    });

    it("refuses rewriting createdAt", async () => {
      await snapshot();
      const message = await refused(() =>
        db.$executeRawUnsafe(`UPDATE "ReadinessSnapshot" SET "createdAt" = now() - interval '1 year'`),
      );
      expect(message).toMatch(/ReadinessSnapshot_recompute_only/);
    });

    it("refuses TRUNCATE", async () => {
      expect(await refused(() => db.$executeRawUnsafe(`TRUNCATE "ReadinessSnapshot"`))).toMatch(/TRUNCATE/i);
    });
  });

  describe("the run row", () => {
    it("refuses ok with no finish time", async () => {
      const message = await refused(() =>
        db.readinessRun.create({
          data: { computedOn: new Date("2095-04-01T00:00:00.000Z"), rulesVersion: 1, ok: true },
        }),
      );
      expect(message).toMatch(/ReadinessRun_ok_check/);
    });

    it("refuses a finish before the start", async () => {
      const message = await refused(() =>
        db.readinessRun.create({
          data: {
            computedOn: new Date("2095-04-02T00:00:00.000Z"),
            rulesVersion: 1,
            startedAt: new Date("2095-04-02T03:00:00.000Z"),
            finishedAt: new Date("2095-04-02T02:00:00.000Z"),
          },
        }),
      );
      expect(message).toMatch(/ReadinessRun_window_check/);
    });

    it("holds ONE run per campus day", async () => {
      const message = await refused(() =>
        db.readinessRun.create({ data: { computedOn, rulesVersion: 1 } }),
      );
      expect(message).toMatch(/Unique|ReadinessRun_pkey/i);
    });

    it("refuses deleting a run that still has snapshots", async () => {
      await snapshot();
      expect(await refused(() => db.readinessRun.delete({ where: { computedOn } }))).toMatch(
        /foreign key|ReadinessSnapshot_computedOn_fkey/i,
      );
    });
  });

  describe("the mentor of record", () => {
    afterEach(async () => {
      await db.$executeRawUnsafe(`ALTER TABLE "MentorAssignment" DISABLE TRIGGER "MentorAssignment_immutable"`);
      await db.mentorAssignment.deleteMany({ where: { menteeId: studentId } });
      await db.$executeRawUnsafe(`ALTER TABLE "MentorAssignment" ENABLE TRIGGER "MentorAssignment_immutable"`);
    });

    it("accepts a TA_MENTOR", async () => {
      const row = await assignment();
      expect(row.endedAt).toBeNull();
    });

    it("REFUSES a PLACEMENT_OFFICER", async () => {
      /**
       * SPEC §5: the at-risk list "routes to a named mentor for a
       * conversation". The whole purpose of that routing is to move a student
       * AWAY from the analytics surface and towards somebody who teaches
       * them — so the person it routes to must not be the one reading the
       * dashboard.
       */
      const message = await refused(() => assignment({ mentorId: officerId }));
      expect(message).toMatch(/MentorAssignment_mentor_is_not_student_or_officer/);
      expect(message).toMatch(/PLACEMENT_OFFICER/);
    });

    it("refuses a STUDENT as mentor", async () => {
      const message = await refused(() => assignment({ mentorId: studentId, menteeId: mentorId }));
      expect(message).toMatch(/MentorAssignment_mentor_is_not_student_or_officer/);
    });

    it("refuses a self-assignment", async () => {
      expect(await refused(() => assignment({ menteeId: mentorId, mentorId }))).toMatch(
        /MentorAssignment_not_self/,
      );
    });

    it("refuses a second LIVE mentor for one mentee", async () => {
      // Two live mentors would have each of them assume the other had spoken
      // to the student.
      await assignment();
      const message = await refused(() => assignment({ mentorId: staffId }));
      expect(message).toMatch(/one_active_per_mentee|Unique/i);
    });

    it("allows a new mentor once the previous assignment has ended", async () => {
      const first = await assignment();
      await db.mentorAssignment.update({
        where: { id: first.id },
        data: { endedAt: new Date(), endedById: staffId },
      });
      const second = await assignment({ mentorId: staffId });
      expect(second.endedAt).toBeNull();
    });

    it("pairs endedAt with endedById", async () => {
      const row = await assignment();
      expect(
        await refused(() =>
          db.mentorAssignment.update({ where: { id: row.id }, data: { endedAt: new Date() } }),
        ),
      ).toMatch(/MentorAssignment_end_pair/);
    });

    it("refuses a reason too short for anybody to act on", async () => {
      expect(await refused(() => assignment({ reason: "at risk" }))).toMatch(
        /MentorAssignment_reason_check/,
      );
    });

    it("never changes its terms, and ends once", async () => {
      const row = await assignment();
      expect(
        await refused(() => db.mentorAssignment.update({ where: { id: row.id }, data: { mentorId: staffId } })),
      ).toMatch(/MentorAssignment_mentor_is_not_student_or_officer|MentorAssignment_immutable/);
      expect(
        await refused(() =>
          db.mentorAssignment.update({ where: { id: row.id }, data: { reason: "A different reason entirely." } }),
        ),
      ).toMatch(/MentorAssignment_immutable/);

      await db.mentorAssignment.update({ where: { id: row.id }, data: { endedAt: new Date(), endedById: staffId } });
      expect(
        await refused(() =>
          db.mentorAssignment.update({ where: { id: row.id }, data: { endedAt: new Date(0) } }),
        ),
      ).toMatch(/MentorAssignment_immutable/);
    });

    it("is ended, never deleted — so the history of who was asked survives", async () => {
      const row = await assignment();
      expect(await refused(() => db.mentorAssignment.delete({ where: { id: row.id } }))).toMatch(
        /MentorAssignment_immutable/,
      );
    });

    it("refuses TRUNCATE", async () => {
      expect(await refused(() => db.$executeRawUnsafe(`TRUNCATE "MentorAssignment"`))).toMatch(/TRUNCATE/i);
    });
  });
});
