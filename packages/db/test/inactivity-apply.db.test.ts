import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_INACTIVITY_POLICY, campusDay } from "@recx/shared";
import { applyDecision, evaluate, loadSweepContext, sweepCandidates } from "../src/inactivity";
import {
  applyMigrations,
  disabledTriggers,
  openTestDb,
  RUN_DB_TESTS,
  testDatabaseName,
  type TestDb,
} from "./support/test-db";

/**
 * The live sweep's transaction (Phase 8d).
 *
 * `applyDecision()` is the only thing in this system that can restrict an
 * account without a human, so this suite is about what it writes and —
 * harder, and more important — what it does NOT.
 *
 * The cases that justify the design:
 *   - XP is withheld from the boards, never destroyed;
 *   - only the CONTEST lane is cancelled, because a practice solve is the
 *     documented way out of the restriction;
 *   - the engine writes `User.status` only while it owns it, so an account a
 *     human suspended for something else is never quietly reopened;
 *   - a second instance finds the work done and reports a race rather than
 *     writing a second rung.
 */

const run = (randomBytes(3).readUIntBE(0, 3) % 90_000) + 10_000;
const TITLE = RUN_DB_TESTS
  ? "the live inactivity transaction (live database)"
  : "the live inactivity transaction (set RECX_DB_TESTS=1 to run)";

const NOW = new Date();

describe.skipIf(!RUN_DB_TESTS)(TITLE, () => {
  let db: TestDb;
  let restoreEnv: () => void;
  let staffId = "";
  let mentorId = "";
  let policyVersion = 0;
  const userIds: string[] = [];
  const calendarDays: Date[] = [];
  const BATCH_YEAR = 2089;
  const DEPT = `AP${run % 100}`;

  const student = async (suffix: string, over: Record<string, unknown> = {}) => {
    const row = await db.user.create({
      data: {
        collegeId: `APL${run}${suffix}`,
        email: `apl-${run}-${suffix}@example.test`,
        firstName: "A",
        lastName: suffix,
        handle: `apl-${run}-${suffix}`,
        role: "STUDENT",
        batchYear: BATCH_YEAR,
        departmentCode: DEPT,
        // Long enough ago to pass softRestrict (10) on the shipped ladder.
        lastActiveAt: new Date(NOW.getTime() - 20 * 86_400_000),
        ...over,
      } as never,
      select: { id: true },
    });
    userIds.push(row.id);
    return row.id;
  };

  /**
   * Plan and perform one student's sweep, start to finish.
   *
   * `dayOffset` walks REAL days rather than rewriting `evaluationDate`
   * afterwards: `AccountStatusEvent_append_only` refuses that UPDATE, which
   * is exactly right — `notifiedAt` is the only column that may ever move.
   * So the ladder is climbed the way it really is, one run per campus day.
   */
  const sweepOne = async (userId: string, dayOffset = 0) => {
    const now = new Date(NOW.getTime() + dayOffset * 86_400_000);
    const all = await sweepCandidates(db as never, { now, limit: 500 });
    const candidate = all.find((c) => c.userId === userId);
    expect(candidate, "the student is not a sweep candidate").toBeDefined();
    const context = await loadSweepContext(db as never, [candidate!], now);
    const decision = evaluate(candidate!, context);
    const applied = await applyDecision(db as never, decision, {
      now,
      evaluationDay: context.evaluationDay,
    });
    return { decision, applied };
  };

  beforeAll(async () => {
    const dbName = testDatabaseName();
    applyMigrations();
    ({ db, restore: restoreEnv } = await openTestDb());
    const [current] = await db.$queryRawUnsafe<Array<{ name: string }>>("SELECT current_database() AS name");
    expect(current?.name).toBe(dbName);
    expect(await disabledTriggers(db)).toEqual([]);

    const staff = async (suffix: string, role: "SUPER_ADMIN" | "TA_MENTOR") => {
      const row = await db.user.create({
        data: {
          collegeId: `APLS${run}${suffix}`,
          email: `apls-${run}-${suffix}@example.test`,
          firstName: "A",
          lastName: suffix,
          handle: `apls-${run}-${suffix}`,
          role,
        },
        select: { id: true },
      });
      userIds.push(row.id);
      return row.id;
    };
    staffId = await staff("s", "SUPER_ADMIN");
    mentorId = await staff("m", "TA_MENTOR");

    // The named human for this cohort.
    await db.adminScope.create({
      data: {
        adminId: mentorId,
        departmentCode: DEPT,
        batchYear: BATCH_YEAR,
        reason: "Mentor for this cohort, for the inactivity notification.",
        grantedById: staffId,
      },
    });

    const policy = await db.inactivityPolicy.create({
      data: {
        ...DEFAULT_INACTIVITY_POLICY,
        isActive: true,
        batchYear: BATCH_YEAR,
        departmentCode: DEPT,
        countsAsActivity: DEFAULT_INACTIVITY_POLICY.countsAsActivity as never,
        createdById: staffId,
      },
      select: { version: true },
    });
    policyVersion = policy.version;

    // A complete calendar, so nothing is held back for an incomplete one.
    const today = campusDay(NOW);
    const start = new Date(`${today}T00:00:00.000Z`);
    start.setUTCDate(start.getUTCDate() - 70);
    // Forward as well as back: the later runs in this suite evaluate days
    // after today, and an unentered day holds EVERYBODY back — which is the
    // engine working, not a bug to route around.
    for (let i = 0; i <= 85; i += 1) {
      const date = new Date(start);
      date.setUTCDate(date.getUTCDate() + i);
      calendarDays.push(date);
    }
    await db.calendarDay.createMany({
      data: calendarDays.map((date) => ({
        date,
        kind: "REGULAR" as const,
        isWorkingDay: true,
        label: "Working day",
        createdById: staffId,
      })),
      skipDuplicates: true,
    });
  });

  afterAll(async () => {
    if (!db) return;
    try {
      const lift = (table: string, trigger: string) =>
        db.$executeRawUnsafe(`ALTER TABLE "${table}" DISABLE TRIGGER "${trigger}"`);
      const drop = (table: string, trigger: string) =>
        db.$executeRawUnsafe(`ALTER TABLE "${table}" ENABLE TRIGGER "${trigger}"`);

      // The submission fixture's rows, before the users they belong to.
      await db.submission.deleteMany({ where: { userId: { in: userIds } } });
      await db.emailOutbox.deleteMany({ where: { toUserId: { in: userIds } } });
      await db.notification.deleteMany({ where: { userId: { in: userIds } } });
      await db.accountRestriction.deleteMany({ where: { userId: { in: userIds } } });
      await lift("AccountStatusEvent", "AccountStatusEvent_append_only");
      await db.$executeRawUnsafe(`DELETE FROM "AccountStatusEvent" WHERE "userId" = ANY($1::text[])`, userIds);
      await drop("AccountStatusEvent", "AccountStatusEvent_append_only");
      await lift("InactivityPolicy", "InactivityPolicy_version_immutable");
      await db.inactivityPolicy.deleteMany({ where: { version: policyVersion } });
      await drop("InactivityPolicy", "InactivityPolicy_version_immutable");
      await lift("CalendarDay", "CalendarDay_past_immutable");
      await db.calendarDay.deleteMany({ where: { date: { in: calendarDays }, createdById: staffId } });
      await drop("CalendarDay", "CalendarDay_past_immutable");
      // An AdminScope is REVOKED, never deleted (a Phase 4 guard): a grant
      // that could vanish is a grant nobody can prove was ever held. Only
      // teardown lifts it.
      await lift("AdminScope", "AdminScope_grant_immutable");
      await db.adminScope.deleteMany({ where: { adminId: mentorId } });
      await drop("AdminScope", "AdminScope_grant_immutable");
      await db.user.deleteMany({ where: { id: { in: userIds } } });
      expect(await disabledTriggers(db)).toEqual([]);
    } finally {
      await db.$disconnect();
      restoreEnv?.();
    }
  });

  describe("one rung, with everything it needs", () => {
    it("writes the event, the restriction, the notification and the audit row together", async () => {
      const id = await student("a");
      const { applied } = await sweepOne(id);

      expect(applied.toStage).toBe("NUDGED");
      expect(applied.eventId).not.toBeNull();

      const event = await db.accountStatusEvent.findFirstOrThrow({
        where: { userId: id },
        orderBy: { createdAt: "desc" },
      });
      expect(event).toMatchObject({
        fromStage: "NONE",
        toStage: "NUDGED",
        source: "INACTIVITY_SWEEP",
        triggeredBySystem: true,
        actorId: null,
        policyVersion,
      });
      expect(event.evaluationDate).not.toBeNull();
      expect(event.notifiedAt).not.toBeNull();

      const restriction = await db.accountRestriction.findUniqueOrThrow({ where: { userId: id } });
      expect(restriction).toMatchObject({ stage: "NUDGED", policyVersion });
      expect(restriction.countedInactiveDays).toBeGreaterThanOrEqual(19);

      const notification = await db.notification.findFirstOrThrow({ where: { userId: id } });
      expect(notification.kind).toBe("inactivity.stage");
      // Never the word, at any rung.
      expect(notification.body.toLowerCase()).not.toContain("disabl");

      const audited = await db.auditLog.count({
        where: { targetUserId: id, action: "inactivity.stage_escalated" },
      });
      expect(audited).toBe(1);
    });

    it("leaves User.status ACTIVE at a nudge — a nudge is a message, not a consequence", async () => {
      const id = await student("b");
      await sweepOne(id);
      const user = await db.user.findUniqueOrThrow({ where: { id }, select: { status: true } });
      expect(user.status).toBe("ACTIVE");
      const restriction = await db.accountRestriction.findUniqueOrThrow({ where: { userId: id } });
      expect(restriction.ownsAccountStatus).toBe(false);
    });

    it("writes User.status and claims it at SOFT_RESTRICTED", async () => {
      const id = await student("c");
      // Walk the ladder: NONE -> NUDGED -> WARNED -> SOFT_RESTRICTED, one
      // rung per run, which is the rule the trigger also enforces.
      // One run per campus day, which is also the rule the per-day unique
      // index enforces: a second run on one day writes nothing.
      // Three days apart, not one: the shipped policy gives two grace days
      // after a student is TOLD before the next rung, so a rung takes
      // graceDays + 1 days. A ladder that climbed every night would be a
      // ladder that reached a restriction in three days flat.
      for (const [day, expected] of [
        [0, "NUDGED"],
        [3, "WARNED"],
        [6, "SOFT_RESTRICTED"],
      ] as const) {
        const { applied } = await sweepOne(id, day);
        expect(applied.toStage, expected).toBe(expected);
      }
      const user = await db.user.findUniqueOrThrow({ where: { id }, select: { status: true } });
      expect(user.status).toBe("SOFT_RESTRICTED");
      const restriction = await db.accountRestriction.findUniqueOrThrow({ where: { userId: id } });
      expect(restriction).toMatchObject({ stage: "SOFT_RESTRICTED", ownsAccountStatus: true });
    });

    it("tells the named human at WARNED, and not before", async () => {
      const id = await student("d");
      await sweepOne(id);
      // Counted for THIS student: other tests in this file walk other
      // students to WARNED and mail the same mentor.
      const mailFor = async () =>
        db.emailOutbox.count({
          where: {
            toUserId: mentorId,
            kind: "inactivity.mentor",
            subject: { contains: `APL${run}d` },
          },
        });
      expect(await mailFor()).toBe(0);

      const { applied } = await sweepOne(id, 3);
      expect(applied.toStage).toBe("WARNED");
      expect(applied.notifiedMentor).toBe(true);

      expect(await mailFor()).toBe(1);
      const mail = await db.emailOutbox.findFirstOrThrow({
        where: { toUserId: mentorId, kind: "inactivity.mentor", subject: { contains: `APL${run}d` } },
      });
      // An ask, not a report — and it carries the college id, not a diagnosis.
      expect(mail.bodyText).toMatch(/conversation/);
      expect(mail.subject).toContain(`APL${run}d`);
    });
  });

  describe("the contest lane only", () => {
    it("cancels a QUEUED contest submission and leaves practice alone", async () => {
      const id = await student("e");
      const fixture = await submissionFixture(id);

      // Walk them to SOFT_RESTRICTED, which is where a lane is locked.
      for (const day of [0, 3, 6]) await sweepOne(id, day);

      const contest = await db.submission.findUniqueOrThrow({
        where: { id: fixture.contestId },
        select: { status: true },
      });
      const practice = await db.submission.findUniqueOrThrow({
        where: { id: fixture.practiceId },
        select: { status: true },
      });
      const assessment = await db.submission.findUniqueOrThrow({
        where: { id: fixture.assessmentId },
        select: { status: true },
      });

      expect(contest.status).toBe("CANCELLED");
      // The documented way OUT of the restriction. Killing it would be
      // killing the exit.
      expect(practice.status).toBe("QUEUED");
      // "Sitting a scheduled assessment" is explicitly not blocked.
      expect(assessment.status).toBe("QUEUED");
    });
  });

  describe("the engine writes User.status only while it owns it", () => {
    it("does not reopen an account a human suspended", async () => {
      /**
       * The case `ownsAccountStatus` exists for. A student a super-admin
       * suspended for something else entirely must not be quietly restored
       * by an inactivity clear, and must not have their status rewritten by
       * an inactivity escalation either.
       */
      const id = await student("f", { status: "SOFT_RESTRICTED" });
      const { applied } = await sweepOne(id);
      expect(applied.toStage).toBe("NUDGED");

      const user = await db.user.findUniqueOrThrow({ where: { id }, select: { status: true } });
      expect(user.status).toBe("SOFT_RESTRICTED");
      const restriction = await db.accountRestriction.findUniqueOrThrow({ where: { userId: id } });
      expect(restriction.ownsAccountStatus).toBe(false);

      const event = await db.accountStatusEvent.findFirstOrThrow({
        where: { userId: id },
        orderBy: { createdAt: "desc" },
      });
      // The event records the truth: the status did not move.
      expect(event.fromStatus).toBe("SOFT_RESTRICTED");
      expect(event.toStatus).toBe("SOFT_RESTRICTED");
    });
  });

  describe("two instances", () => {
    it("reports a race rather than writing a second rung", async () => {
      const id = await student("g");
      const all = await sweepCandidates(db as never, { now: NOW, limit: 500 });
      const candidate = all.find((c) => c.userId === id)!;
      const context = await loadSweepContext(db as never, [candidate], NOW);
      const decision = evaluate(candidate, context);

      const first = await applyDecision(db as never, decision, {
        now: NOW,
        evaluationDay: context.evaluationDay,
      });
      expect(first.eventId).not.toBeNull();

      // The SAME stale decision again, as the other instance would hold.
      const second = await applyDecision(db as never, decision, {
        now: NOW,
        evaluationDay: context.evaluationDay,
      });
      expect(second.skipped).toBe("already-moved");
      expect(second.eventId).toBeNull();

      expect(await db.accountStatusEvent.count({ where: { userId: id } })).toBe(1);
    });
  });

  describe("a hold", () => {
    it("records the count and opens a review item without writing an event", async () => {
      // A student at eight counted days has to have that count recorded, or
      // the dormancy chip cannot warn them before the rung they are heading
      // for — and the review queue would only ever show students already
      // acted on, which is the opposite of a review queue.
      const id = await student("h", { lastActiveAt: new Date(NOW.getTime() - 5 * 86_400_000) });
      // Two rungs are deserved (nudge 3, warn 5), so the first run escalates
      // to NUDGED; the second holds, because one rung per run.
      await sweepOne(id);
      const before = await db.accountStatusEvent.count({ where: { userId: id } });
      // A grace window stops the next rung; the hold still refreshes the count.
      await db.accountRestriction.update({
        where: { userId: id },
        // Strictly after the day-1 run's clock: the planner holds while
        // graceEndsAt > now, so a window ending exactly at  has run out.
        data: { graceEndsAt: new Date(NOW.getTime() + 2 * 86_400_000) },
      });
      const { decision, applied } = await sweepOne(id, 1);
      expect(decision.plan.kind).toBe("hold");
      expect(applied.skipped).toBe("nothing-to-do");
      expect(await db.accountStatusEvent.count({ where: { userId: id } })).toBe(before);

      const restriction = await db.accountRestriction.findUniqueOrThrow({ where: { userId: id } });
      expect(restriction.lastEvaluatedAt).not.toBeNull();
    });
  });

  /** A contest, a practice and an assessment submission, all QUEUED. */
  async function submissionFixture(userId: string) {
    const problem = await db.problem.findFirstOrThrow({ select: { id: true } });
    const version = await db.problemVersion.findFirstOrThrow({
      where: { problemId: problem.id },
      select: { id: true },
    });
    const language = await db.languageConfig.findFirstOrThrow({ select: { id: true, key: true } });

    const make = async (lane: "CONTEST" | "PRACTICE" | "ASSESSMENT") =>
      (
        await db.submission.create({
          data: {
            userId,
            problemId: problem.id,
            problemVersionId: version.id,
            languageConfigId: language.id,
            language: language.key,
            lane,
            status: "QUEUED",
            sourceSha256: randomBytes(32).toString("hex"),
            sourceBytes: 32,
          } as never,
          select: { id: true },
        })
      ).id;

    return {
      contestId: await make("CONTEST"),
      practiceId: await make("PRACTICE"),
      assessmentId: await make("ASSESSMENT"),
    };
  }
});
