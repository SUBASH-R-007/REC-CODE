import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_INACTIVITY_POLICY, campusDay } from "@recx/shared";
import { evaluate, loadSweepContext, sweepCandidates } from "../src/inactivity";
import {
  applyMigrations,
  disabledTriggers,
  openTestDb,
  RUN_DB_TESTS,
  testDatabaseName,
  type TestDb,
} from "./support/test-db";

/**
 * The sweep's candidate query (Phase 8c).
 *
 * The counting and planning are pure and tested in
 * `packages/shared/test/inactivity.test.ts`. What can only be tested here is
 * the SQL: the three `NOT EXISTS` fragments that resolve the spec's
 * never-sweep rules, and the join that reads a student's current stage.
 *
 * SPEC §5, as an anti-requirement: "Never sweep a student with an open
 * attempt, a pending appeal, or an assessment scheduled in the next 72
 * hours." Each of those is a real row in this suite rather than a boolean
 * somebody passed in — because a holdback that is only ever exercised as a
 * parameter is a holdback whose query has never run.
 */

const run = (randomBytes(3).readUIntBE(0, 3) % 90_000) + 10_000;
const TITLE = RUN_DB_TESTS
  ? "the inactivity sweep's candidate query (live database)"
  : "the inactivity sweep's candidate query (set RECX_DB_TESTS=1 to run)";

const NOW = new Date();

describe.skipIf(!RUN_DB_TESTS)(TITLE, () => {
  let db: TestDb;
  let restoreEnv: () => void;
  let policyVersion = 0;
  let holdPolicyVersion = 0;
  let staffId = "";
  const userIds: string[] = [];
  const assessmentIds: string[] = [];
  const attemptIds: string[] = [];
  const calendarDays: Date[] = [];
  /**
   * TWO cohorts, because an assessment scoped to a cohort holds back every
   * student in it — which is the correct behaviour and makes it impossible to
   * test the counting and the holdbacks on the same students.
   *
   * `DEPT` is the quiet cohort: no assessment or open attempt ever targets
   * it, so the counting tests see the arithmetic. `HOLD_DEPT` is where the
   * holdback fixtures live. Both are unique to this run, so another suite's
   * rows cannot change the answer and a leftover cannot collide with
   * `InactivityPolicy_active_scope_key`.
   */
  const BATCH_YEAR = 2091;
  const DEPT = `SW${run % 100}`;
  const HOLD_DEPT = `HD${run % 100}`;

  const student = async (suffix: string, over: Record<string, unknown> = {}) => {
    const row = await db.user.create({
      data: {
        collegeId: `SWP${run}${suffix}`,
        email: `swp-${run}-${suffix}@example.test`,
        firstName: "A",
        lastName: suffix,
        handle: `swp-${run}-${suffix}`,
        role: "STUDENT",
        batchYear: BATCH_YEAR,
        departmentCode: DEPT,
        ...over,
      } as never,
      select: { id: true },
    });
    userIds.push(row.id);
    return row.id;
  };

  /** Only the quiet cohort, so another suite's rows cannot change the answer. */
  const ours = async () => {
    const all = await sweepCandidates(db as never, { now: NOW, limit: 500 });
    return all.filter((c) => c.batchYear === BATCH_YEAR && c.departmentCode === DEPT);
  };

  /** The cohort the holdback fixtures belong to. */
  const theirs = async () => {
    const all = await sweepCandidates(db as never, { now: NOW, limit: 500 });
    return all.filter((c) => c.batchYear === BATCH_YEAR && c.departmentCode === HOLD_DEPT);
  };

  beforeAll(async () => {
    const dbName = testDatabaseName();
    applyMigrations();
    ({ db, restore: restoreEnv } = await openTestDb());
    const [current] = await db.$queryRawUnsafe<Array<{ name: string }>>("SELECT current_database() AS name");
    expect(current?.name).toBe(dbName);
    expect(await disabledTriggers(db)).toEqual([]);

    staffId = (
      await db.user.create({
        data: {
          collegeId: `SWPS${run}`,
          email: `swps-${run}@example.test`,
          firstName: "A",
          lastName: "Super",
          handle: `swps-${run}`,
          role: "SUPER_ADMIN",
        },
        select: { id: true },
      })
    ).id;
    userIds.push(staffId);

    const policy = await db.inactivityPolicy.create({
      data: {
        ...DEFAULT_INACTIVITY_POLICY,
        isActive: true,
        // Scoped to batch AND department, both unique to this run.
        // `InactivityPolicy_active_scope_key` allows one active row per
        // scope across the whole table, so a policy scoped only by batch
        // would collide with a leftover from an earlier run of this file —
        // the constraint doing its job, failing the suite for its own reason.
        batchYear: BATCH_YEAR,
        departmentCode: DEPT,
        countsAsActivity: DEFAULT_INACTIVITY_POLICY.countsAsActivity as never,
        createdById: staffId,
      },
      select: { version: true },
    });
    policyVersion = policy.version;

    // A second active policy for the holdback cohort, so those students are
    // in scope and a holdback is what stops them rather than "no policy".
    const holdPolicy = await db.inactivityPolicy.create({
      data: {
        ...DEFAULT_INACTIVITY_POLICY,
        isActive: true,
        batchYear: BATCH_YEAR,
        departmentCode: HOLD_DEPT,
        countsAsActivity: DEFAULT_INACTIVITY_POLICY.countsAsActivity as never,
        createdById: staffId,
      },
      select: { version: true },
    });
    holdPolicyVersion = holdPolicy.version;

    // A calendar covering the whole window, so `calendarIncomplete` is false
    // and the holdbacks under test are the ones that fire.
    const today = campusDay(NOW);
    const start = new Date(`${today}T00:00:00.000Z`);
    start.setUTCDate(start.getUTCDate() - 70);
    for (let i = 0; i <= 70; i += 1) {
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
      await db.$executeRawUnsafe(`ALTER TABLE "AssessmentAttempt" DISABLE TRIGGER "AssessmentAttempt_machine"`);
      await db.assessmentAttempt.deleteMany({ where: { id: { in: attemptIds } } });
      await db.$executeRawUnsafe(`ALTER TABLE "AssessmentAttempt" ENABLE TRIGGER "AssessmentAttempt_machine"`);
      // A published assessment refuses DELETE — "archive it instead".
      await db.assessment.updateMany({ where: { id: { in: assessmentIds } }, data: { status: "DRAFT" } });
      await db.assessment.deleteMany({ where: { id: { in: assessmentIds } } });
      // An event CITES a policy version, and
      // AccountStatusEvent_policyVersion_fkey is RESTRICT on purpose: the
      // version an event names must never vanish. So the events go before the
      // policy, with the append-only guard lifted for them.
      await db.$executeRawUnsafe(`ALTER TABLE "AccountStatusEvent" DISABLE TRIGGER "AccountStatusEvent_append_only"`);
      await db.$executeRawUnsafe(`DELETE FROM "AccountStatusEvent" WHERE "userId" = ANY($1::text[])`, userIds);
      await db.$executeRawUnsafe(`ALTER TABLE "AccountStatusEvent" ENABLE TRIGGER "AccountStatusEvent_append_only"`);
      await db.leaveException.deleteMany({ where: { userId: { in: userIds } } });
      await db.activityDay.deleteMany({ where: { userId: { in: userIds } } });
      await db.accountRestriction.deleteMany({ where: { userId: { in: userIds } } });
      await db.$executeRawUnsafe(
        `ALTER TABLE "InactivityPolicy" DISABLE TRIGGER "InactivityPolicy_version_immutable"`,
      );
      await db.inactivityPolicy.deleteMany({ where: { version: { in: [policyVersion, holdPolicyVersion] } } });
      await db.$executeRawUnsafe(
        `ALTER TABLE "InactivityPolicy" ENABLE TRIGGER "InactivityPolicy_version_immutable"`,
      );
      // Every day this suite wrote is in the PAST, and
      // `CalendarDay_past_immutable` refuses to delete one — correctly, since
      // evidence rows cite days by date. Only the teardown lifts it, and only
      // for the days this suite created (`createdById`), so a day another
      // suite or the seed entered stays.
      await db.$executeRawUnsafe(`ALTER TABLE "CalendarDay" DISABLE TRIGGER "CalendarDay_past_immutable"`);
      await db.calendarDay.deleteMany({ where: { date: { in: calendarDays }, createdById: staffId } });
      await db.$executeRawUnsafe(`ALTER TABLE "CalendarDay" ENABLE TRIGGER "CalendarDay_past_immutable"`);
      await db.user.deleteMany({ where: { id: { in: userIds } } });
      expect(await disabledTriggers(db)).toEqual([]);
    } finally {
      await db.$disconnect();
      restoreEnv?.();
    }
  });

  /** An assessment opening in `hours`, scoped to our cohort. */
  const assessment = async (suffix: string, hours: number) => {
    const opensAt = new Date(NOW.getTime() + hours * 3_600_000);
    const row = await db.assessment.create({
      data: {
        slug: `swp-${run}-${suffix}`,
        title: "An assessment",
        instructions: "Sit it.",
        status: "PUBLISHED",
        opensAt,
        closesAt: new Date(opensAt.getTime() + 7 * 86_400_000),
        durationSec: 3_600,
        audienceBatchYear: BATCH_YEAR,
        // The holdback cohort only, never the quiet one.
        audienceDepartmentCode: HOLD_DEPT,
        createdById: staffId,
      },
      select: { id: true },
    });
    assessmentIds.push(row.id);
    return row.id;
  };

  describe("who is a candidate at all", () => {
    it("reads a student with no restriction row as NONE", async () => {
      const id = await student("a", { lastActiveAt: new Date(NOW.getTime() - 20 * 86_400_000) });
      const found = (await ours()).find((c) => c.userId === id);
      expect(found).toMatchObject({ stage: "NONE", selfClearedCount: 0, hasOpenAttempt: false });
    });

    it("reads the stage from an existing restriction row", async () => {
      const id = await student("b", { lastActiveAt: new Date(NOW.getTime() - 20 * 86_400_000) });
      await db.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
          `INSERT INTO "AccountRestriction" ("userId","stage","countedInactiveDays","stageEnteredAt")
           VALUES ($1,'NUDGED',3, now())`,
          id,
        );
        await tx.$executeRawUnsafe(
          `INSERT INTO "AccountStatusEvent"
             ("userId","fromStage","toStage","fromStatus","toStatus","source","policyVersion",
              "evidence","triggeredBySystem","evaluationDate")
           VALUES ($1,'NONE','NUDGED','ACTIVE','ACTIVE','INACTIVITY_SWEEP',$2,$3::jsonb,true,$4::date)`,
          id,
          policyVersion,
          JSON.stringify({
            lastActiveAt: null,
            calendarDaysElapsed: 3,
            countedInactiveDays: 3,
            excludedDates: [],
            excludedReason: [],
            thresholdDays: 3,
            policyVersion,
            evaluatedAt: NOW.toISOString(),
          }),
          campusDay(NOW),
        );
      });
      const found = (await ours()).find((c) => c.userId === id);
      expect(found?.stage).toBe("NUDGED");
    });

    it("excludes a GRADUATED or ARCHIVED account — an end state has no inactivity", async () => {
      const graduated = await student("g", { status: "GRADUATED" });
      const archived = await student("h", { status: "ARCHIVED" });
      const ids = (await ours()).map((c) => c.userId);
      expect(ids).not.toContain(graduated);
      expect(ids).not.toContain(archived);
    });

    it("excludes a member of staff — the policy is about students", async () => {
      expect((await ours()).map((c) => c.userId)).not.toContain(staffId);
    });

    it("includes a SOFT_RESTRICTED account, which is how a clear is ever found", async () => {
      const id = await student("i", { status: "SOFT_RESTRICTED" });
      expect((await ours()).map((c) => c.userId)).toContain(id);
    });
  });

  describe("never sweep a student with an open attempt", () => {
    it("reports hasOpenAttempt for IN_PROGRESS and for DISCONNECTED", async () => {
      for (const [suffix, status] of [
        ["j", "IN_PROGRESS"],
        ["k", "DISCONNECTED"],
      ] as const) {
        const id = await student(suffix, { departmentCode: HOLD_DEPT });
        const assessmentId = await assessment(suffix, 100);
        const attempt = await db.assessmentAttempt.create({
          data: {
            assessmentId,
            userId: id,
            status,
            attemptNumber: 1,
            startedAt: new Date(),
            expiresAt: new Date(NOW.getTime() + 3_600_000),
            seed: 1_234_567,
            layout: {} as never,
            tokenHash: randomBytes(32).toString("hex"),
            proctorMode: "NONE",
          } as never,
          select: { id: true },
        });
        attemptIds.push(attempt.id);
        const found = (await theirs()).find((c) => c.userId === id);
        expect(found?.hasOpenAttempt, status).toBe(true);
      }
    });

    it("does NOT report it for a submitted attempt", async () => {
      const id = await student("l", { departmentCode: HOLD_DEPT });
      const assessmentId = await assessment("l", 100);
      const attempt = await db.assessmentAttempt.create({
        data: {
          assessmentId,
          userId: id,
          status: "SUBMITTED",
          attemptNumber: 1,
          startedAt: new Date(),
          expiresAt: new Date(NOW.getTime() + 3_600_000),
          submittedAt: new Date(),
          seed: 1_234_567,
          layout: {} as never,
          tokenHash: randomBytes(32).toString("hex"),
          proctorMode: "NONE",
        } as never,
        select: { id: true },
      });
      attemptIds.push(attempt.id);
      const found = (await theirs()).find((c) => c.userId === id);
      expect(found?.hasOpenAttempt).toBe(false);
    });
  });

  describe("never sweep a student with an assessment inside 72 hours", () => {
    it("reports it for an assessment 48 hours out", async () => {
      const id = await student("m", { departmentCode: HOLD_DEPT });
      await assessment("m", 48);
      const found = (await theirs()).find((c) => c.userId === id);
      expect(found?.hasAssessmentWithin72h).toBe(true);
    });

    it("does not report it for one 100 hours out", async () => {
      // The 48-hour assessment above is scoped to the same cohort, so this is
      // checked on a fresh cohort member after it is archived.
      const id = await student("n", { batchYear: BATCH_YEAR + 1 });
      const opensAt = new Date(NOW.getTime() + 100 * 3_600_000);
      const row = await db.assessment.create({
        data: {
          slug: `swp-${run}-n`,
          title: "Later",
          instructions: "Sit it.",
          status: "PUBLISHED",
          opensAt,
          closesAt: new Date(opensAt.getTime() + 86_400_000),
          durationSec: 3_600,
          audienceBatchYear: BATCH_YEAR + 1,
          createdById: staffId,
        },
        select: { id: true },
      });
      assessmentIds.push(row.id);
      const all = await sweepCandidates(db as never, { now: NOW, limit: 500 });
      const found = all.find((c) => c.userId === id);
      expect(found?.hasAssessmentWithin72h).toBe(false);
    });

    it("does not report it for a DRAFT assessment", async () => {
      const id = await student("o", { batchYear: BATCH_YEAR + 2 });
      const opensAt = new Date(NOW.getTime() + 24 * 3_600_000);
      const row = await db.assessment.create({
        data: {
          slug: `swp-${run}-o`,
          title: "Unpublished",
          instructions: "Sit it.",
          status: "DRAFT",
          opensAt,
          closesAt: new Date(opensAt.getTime() + 86_400_000),
          durationSec: 3_600,
          audienceBatchYear: BATCH_YEAR + 2,
          createdById: staffId,
        },
        select: { id: true },
      });
      assessmentIds.push(row.id);
      const all = await sweepCandidates(db as never, { now: NOW, limit: 500 });
      expect(all.find((c) => c.userId === id)?.hasAssessmentWithin72h).toBe(false);
    });
  });

  describe("the whole decision, over real rows", () => {
    it("counts a quiet fortnight and plans one rung", async () => {
      const id = await student("p", { lastActiveAt: new Date(NOW.getTime() - 14 * 86_400_000) });
      const candidates = (await ours()).filter((c) => c.userId === id);
      const context = await loadSweepContext(db as never, candidates, NOW);
      const decision = evaluate(candidates[0]!, context);

      expect(decision.policy?.version).toBe(policyVersion);
      expect(decision.count.calendarIncomplete).toBe(false);
      expect(decision.count.countedInactiveDays).toBeGreaterThanOrEqual(13);
      expect(decision.plan).toMatchObject({ kind: "escalate", toStage: "NUDGED" });
      expect(decision.toStatus).toBe("ACTIVE");
    });

    it("excludes days covered by an approved leave, over real rows", async () => {
      const id = await student("q", { lastActiveAt: new Date(NOW.getTime() - 14 * 86_400_000) });
      const today = campusDay(NOW);
      const from = new Date(`${today}T00:00:00.000Z`);
      from.setUTCDate(from.getUTCDate() - 10);
      const to = new Date(`${today}T00:00:00.000Z`);
      to.setUTCDate(to.getUTCDate() - 5);
      await db.leaveException.create({
        data: {
          userId: id,
          kind: "MEDICAL",
          startDate: from,
          endDate: to,
          status: "APPROVED",
          reason: "Admitted with dengue; discharge summary attached.",
          requestedById: id,
          decidedById: staffId,
          decidedAt: new Date(),
        },
      });
      const candidates = (await ours()).filter((c) => c.userId === id);
      const context = await loadSweepContext(db as never, candidates, NOW);
      const decision = evaluate(candidates[0]!, context);
      expect(decision.count.excludedDates.length).toBe(6);
      expect(new Set(decision.count.excludedReason)).toEqual(new Set(["MEDICAL_LEAVE"]));
    });

    it("excludes days the student worked, over real ActivityDay rows", async () => {
      const id = await student("r", { lastActiveAt: new Date(NOW.getTime() - 14 * 86_400_000) });
      const today = campusDay(NOW);
      const worked = new Date(`${today}T00:00:00.000Z`);
      worked.setUTCDate(worked.getUTCDate() - 4);
      await db.activityDay.create({
        data: { userId: id, date: worked, submissions: 2, solved: 1 },
      });
      const candidates = (await ours()).filter((c) => c.userId === id);
      const context = await loadSweepContext(db as never, candidates, NOW);
      const decision = evaluate(candidates[0]!, context);
      expect(decision.count.excludedReason).toEqual(["ACTIVE"]);
    });

    it("builds the evidence the CHECK requires, from real rows", async () => {
      const id = await student("s", { lastActiveAt: new Date(NOW.getTime() - 14 * 86_400_000) });
      const candidates = (await ours()).filter((c) => c.userId === id);
      const context = await loadSweepContext(db as never, candidates, NOW);
      const decision = evaluate(candidates[0]!, context);
      expect(decision.evidence).not.toBeNull();
      // And it is storable: the CHECK accepts it.
      const inserted = await db.$queryRawUnsafe<Array<{ id: bigint }>>(
        `INSERT INTO "AccountStatusEvent"
           ("userId","fromStage","toStage","fromStatus","toStatus","source","policyVersion",
            "evidence","triggeredBySystem","evaluationDate")
         VALUES ($1,'NONE','NUDGED','ACTIVE','ACTIVE','INACTIVITY_SWEEP',$2,$3::jsonb,true,$4::date)
         RETURNING "id"`,
        id,
        policyVersion,
        JSON.stringify(decision.evidence),
        campusDay(NOW),
      );
      expect(inserted[0]?.id).toBeTruthy();
    });

    it("holds back a student whose cohort has an assessment inside 72 hours", async () => {
      const candidates = (await theirs()).filter((c) => c.hasAssessmentWithin72h);
      expect(candidates.length).toBeGreaterThan(0);
      const context = await loadSweepContext(db as never, candidates, NOW);
      for (const candidate of candidates) {
        const decision = evaluate(candidate, context);
        if (decision.plan.kind === "clear") continue;
        expect(decision.holdback, candidate.collegeId).not.toBeNull();
        expect(decision.plan.kind, candidate.collegeId).toBe("hold");
      }
    });
  });

  describe("paging", () => {
    it("pages by user id without repeating or skipping anybody", async () => {
      const all = await sweepCandidates(db as never, { now: NOW, limit: 500 });
      expect(all.length).toBeGreaterThan(3);
      const firstTwo = await sweepCandidates(db as never, { now: NOW, limit: 2 });
      const rest = await sweepCandidates(db as never, {
        now: NOW,
        limit: 500,
        afterUserId: firstTwo.at(-1)!.userId,
      });
      const paged = [...firstTwo, ...rest].map((c) => c.userId);
      expect(paged).toEqual(all.map((c) => c.userId));
      expect(new Set(paged).size).toBe(paged.length);
    });

    it("returns rows in a stable order, so paging cannot loop", async () => {
      const once = await sweepCandidates(db as never, { now: NOW, limit: 20 });
      const twice = await sweepCandidates(db as never, { now: NOW, limit: 20 });
      expect(once.map((c) => c.userId)).toEqual(twice.map((c) => c.userId));
      expect(once.map((c) => c.userId)).toEqual([...once.map((c) => c.userId)].sort());
    });
  });
});
