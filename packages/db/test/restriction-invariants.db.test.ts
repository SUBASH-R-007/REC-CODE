import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_INACTIVITY_POLICY, REQUIRED_EVIDENCE_KEYS } from "@recx/shared";
import {
  applyMigrations,
  disabledTriggers,
  openTestDb,
  RUN_DB_TESTS,
  testDatabaseName,
  type TestDb,
} from "./support/test-db";

/**
 * The restriction and status-history invariants (migration 20261019260200).
 *
 * SPEC §5: "a disputed lockout must be explainable months later." Everything
 * here serves that sentence, and three of these tests are the phase's whole
 * safety argument expressed as SQL:
 *
 *   - a sweep row reaching DISABLED is refused while the policy it cites has
 *     autoDisableEnabled false — through raw SQL, with the triggers in force,
 *     so "no account is hard-disabled by a cron job" is a property of the
 *     DATABASE and not of a code path one refactor from untrue;
 *   - NONE → DISABLED is refused in one step, even by raw SQL;
 *   - a system transition cannot be recorded without its evidence, and the
 *     key list the CHECK requires is parsed out of the migration and compared
 *     against the zod schema, so the two are provably one list.
 *
 * And the case the draft design made impossible: a same-day escalate then
 * clear, which must write BOTH rows.
 */

const run = (randomBytes(3).readUIntBE(0, 3) % 90_000) + 10_000;
const TITLE = RUN_DB_TESTS
  ? "restriction and status history invariants (live database)"
  : "restriction and status history invariants (set RECX_DB_TESTS=1 to run)";

const MIGRATION = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../prisma/migrations/20261019260200_phase8c_restriction/migration.sql",
);

/** The eight-key list, as the migration's own CHECK spells it. */
function evidenceKeysInMigration(): string[] {
  const sql = readFileSync(MIGRATION, "utf8");
  const start = sql.indexOf("AccountStatusEvent_system_evidence_check");
  expect(start, "the evidence CHECK is not in the migration").toBeGreaterThan(-1);
  const clause = sql.slice(start, sql.indexOf(";", start));
  const match = /\?&\s*array\[([^\]]+)\]/i.exec(clause);
  expect(match, "the CHECK no longer uses ?& array[...]").not.toBeNull();
  return match![1]!
    .split(",")
    .map((part) => part.trim().replace(/^'|'$/g, ""))
    .filter((part) => part.length > 0);
}

const SWEEP_EVIDENCE = {
  lastActiveAt: "2026-10-01T04:30:00.000Z",
  calendarDaysElapsed: 10,
  countedInactiveDays: 10,
  excludedDates: [],
  excludedReason: [],
  thresholdDays: 10,
  policyVersion: 0,
  evaluatedAt: "2026-10-11T20:30:00.000Z",
  loginSignalAvailable: false,
  lessonSignalAvailable: false,
  calendarIncomplete: false,
};

const CLEAR_EVIDENCE = { clearedBy: "self", clearedAt: "2026-10-12T04:00:00.000Z" };

describe.skipIf(!RUN_DB_TESTS)(TITLE, () => {
  let db: TestDb;
  let restoreEnv: () => void;
  let studentId = "";
  let staffId = "";
  /** A policy with auto-disable OFF (the shipped default) and one with it on. */
  let safeVersion = 0;
  let disablingVersion = 0;
  const policyVersions: number[] = [];
  let evalDay = 0;

  async function refused(fn: () => Promise<unknown>): Promise<string> {
    try {
      await fn();
    } catch (error) {
      return String((error as Error).message);
    }
    throw new Error("the write was expected to be refused, but it went through");
  }

  /**
   * A fresh evaluation date per sweep row.
   *
   * `AccountStatusEvent_sweep_once_per_day` is unique on
   * `(userId, evaluationDate)` for sweep rows, which is the idempotence this
   * suite also tests — so a fixture reusing one date would collide with
   * itself and fail for the suite's reason rather than the code's.
   */
  const nextEvalDay = () => {
    evalDay += 1;
    const date = new Date(Date.UTC(2097, 0, 1));
    date.setUTCDate(date.getUTCDate() + evalDay);
    return date.toISOString().slice(0, 10);
  };

  /** Insert an event through raw SQL, so every trigger and CHECK is in force. */
  const event = (over: Record<string, unknown> = {}) => {
    const row = {
      userId: studentId,
      fromStage: "NONE",
      toStage: "NUDGED",
      fromStatus: "ACTIVE",
      toStatus: "ACTIVE",
      source: "INACTIVITY_SWEEP",
      policyVersion: safeVersion,
      evidence: { ...SWEEP_EVIDENCE, policyVersion: safeVersion },
      triggeredBySystem: true,
      actorId: null,
      reason: null,
      evaluationDate: nextEvalDay(),
      ...over,
    };
    return db.$queryRawUnsafe<Array<{ id: bigint }>>(
      `INSERT INTO "AccountStatusEvent"
         ("userId","fromStage","toStage","fromStatus","toStatus","source","policyVersion",
          "evidence","triggeredBySystem","actorId","reason","evaluationDate")
       VALUES ($1,$2::"RestrictionStage",$3::"RestrictionStage",$4::"AccountStatus",$5::"AccountStatus",
               $6::"AccountStatusSource",$7,$8::jsonb,$9,$10,$11,$12::date)
       RETURNING "id"`,
      row.userId,
      row.fromStage,
      row.toStage,
      row.fromStatus,
      row.toStatus,
      row.source,
      row.policyVersion,
      JSON.stringify(row.evidence),
      row.triggeredBySystem,
      row.actorId,
      row.reason,
      row.evaluationDate,
    );
  };

  beforeAll(async () => {
    const dbName = testDatabaseName();
    applyMigrations();
    ({ db, restore: restoreEnv } = await openTestDb());
    const [current] = await db.$queryRawUnsafe<Array<{ name: string }>>("SELECT current_database() AS name");
    expect(current?.name).toBe(dbName);
    expect(await disabledTriggers(db)).toEqual([]);

    const mk = async (suffix: string, role: "STUDENT" | "SUPER_ADMIN") =>
      (
        await db.user.create({
          data: {
            collegeId: `RST${run}${suffix}`,
            email: `rst-${run}-${suffix}@example.test`,
            firstName: "A",
            lastName: suffix,
            handle: `rst-${run}-${suffix}`,
            role,
          },
          select: { id: true },
        })
      ).id;
    studentId = await mk("s", "STUDENT");
    staffId = await mk("t", "SUPER_ADMIN");

    const policy = async (autoDisableEnabled: boolean) => {
      const row = await db.inactivityPolicy.create({
        data: {
          ...DEFAULT_INACTIVITY_POLICY,
          isActive: false,
          autoDisableEnabled,
          countsAsActivity: DEFAULT_INACTIVITY_POLICY.countsAsActivity as never,
          createdById: staffId,
        },
        select: { version: true },
      });
      policyVersions.push(row.version);
      return row.version;
    };
    safeVersion = await policy(false);
    disablingVersion = await policy(true);
  });

  afterAll(async () => {
    if (!db) return;
    try {
      const lift = (table: string, trigger: string) =>
        db.$executeRawUnsafe(`ALTER TABLE "${table}" DISABLE TRIGGER "${trigger}"`);
      const drop = (table: string, trigger: string) =>
        db.$executeRawUnsafe(`ALTER TABLE "${table}" ENABLE TRIGGER "${trigger}"`);
      // Every one of these refuses DELETE on purpose; only teardown lifts them.
      await lift("AccountStatusEvent", "AccountStatusEvent_append_only");
      await db.accountRestriction.deleteMany({ where: { userId: { in: [studentId, staffId] } } });
      await db.$executeRawUnsafe(`DELETE FROM "AccountStatusEvent" WHERE "userId" = ANY($1::text[])`, [
        studentId,
        staffId,
      ]);
      await drop("AccountStatusEvent", "AccountStatusEvent_append_only");
      await db.assessmentAttempt.deleteMany({ where: { userId: studentId } });
      await lift("InactivityPolicy", "InactivityPolicy_version_immutable");
      await db.inactivityPolicy.deleteMany({ where: { version: { in: policyVersions } } });
      await drop("InactivityPolicy", "InactivityPolicy_version_immutable");
      await db.user.deleteMany({ where: { id: { in: [studentId, staffId] } } });
      expect(await disabledTriggers(db)).toEqual([]);
    } finally {
      await db.$disconnect();
      restoreEnv?.();
    }
  });

  describe("no account is hard-disabled by a cron job", () => {
    it("refuses a sweep row reaching DISABLED while the cited policy forbids it", async () => {
      /**
       * The single most important assertion in Phase 8, and it goes through
       * RAW SQL with every trigger in force — because the claim is not "the
       * job does not do this" but "the DATABASE will not store it". A future
       * job, a future migration and a future psql session all hit this.
       */
      const message = await refused(() =>
        event({
          fromStage: "SOFT_RESTRICTED",
          toStage: "DISABLED",
          toStatus: "DISABLED",
          policyVersion: safeVersion,
        }),
      );
      expect(message).toMatch(/AccountStatusEvent_system_disable_opt_in/);
      expect(message).toMatch(/does not permit automatic disabling/);
    });

    it("refuses it on the STATUS alone, not only the stage", async () => {
      const message = await refused(() =>
        event({ fromStage: "SOFT_RESTRICTED", toStage: "SOFT_RESTRICTED", toStatus: "DISABLED" }),
      );
      expect(message).toMatch(/AccountStatusEvent_system_disable_opt_in/);
    });

    it("refuses it when the sweep cites no policy at all", async () => {
      // Either refusal is the right one: the BEFORE trigger runs first and
      // finds no permitting policy, and the CHECK would have refused the
      // missing version anyway. What matters is that nothing is stored.
      const message = await refused(() =>
        event({ fromStage: "SOFT_RESTRICTED", toStage: "DISABLED", toStatus: "DISABLED", policyVersion: null }),
      );
      expect(message).toMatch(/AccountStatusEvent_system_disable_opt_in|AccountStatusEvent_system_policy_check/);
    });

    it("allows it once a policy with the switch ON is cited", async () => {
      const rows = await event({
        fromStage: "SOFT_RESTRICTED",
        toStage: "DISABLED",
        toStatus: "DISABLED",
        policyVersion: disablingVersion,
        evidence: { ...SWEEP_EVIDENCE, policyVersion: disablingVersion, countedInactiveDays: 40, thresholdDays: 30 },
      });
      expect(rows[0]?.id).toBeTruthy();
    });

    it("allows a MANUAL super-admin disable, which is the only other way in", async () => {
      const rows = await event({
        fromStage: "SOFT_RESTRICTED",
        toStage: "DISABLED",
        toStatus: "DISABLED",
        source: "MANUAL_SUPER",
        policyVersion: null,
        evidence: { note: "Withdrawn from the college; confirmed with the office." },
        triggeredBySystem: false,
        actorId: staffId,
        reason: "Withdrawn from the college, confirmed with the office.",
        evaluationDate: null,
      });
      expect(rows[0]?.id).toBeTruthy();
    });
  });

  describe("one rung at a time", () => {
    it("refuses NONE to DISABLED through raw SQL", async () => {
      const message = await refused(() =>
        event({ fromStage: "NONE", toStage: "DISABLED", toStatus: "DISABLED", policyVersion: disablingVersion }),
      );
      expect(message).toMatch(/AccountStatusEvent_single_step/);
    });

    it("refuses NONE to SOFT_RESTRICTED", async () => {
      expect(
        await refused(() => event({ fromStage: "NONE", toStage: "SOFT_RESTRICTED", toStatus: "SOFT_RESTRICTED" })),
      ).toMatch(/AccountStatusEvent_single_step/);
    });

    it("allows each single rung up", async () => {
      for (const [from, to] of [
        ["NONE", "NUDGED"],
        ["NUDGED", "WARNED"],
        ["WARNED", "SOFT_RESTRICTED"],
      ] as const) {
        const rows = await event({
          fromStage: from,
          toStage: to,
          toStatus: to === "SOFT_RESTRICTED" ? "SOFT_RESTRICTED" : "ACTIVE",
          fromStatus: "ACTIVE",
        });
        expect(rows[0]?.id, `${from} -> ${to}`).toBeTruthy();
      }
    });

    it("allows a drop straight to NONE from any rung — a restoration is never rate-limited", async () => {
      for (const from of ["NUDGED", "WARNED", "SOFT_RESTRICTED"] as const) {
        const rows = await event({
          fromStage: from,
          toStage: "NONE",
          fromStatus: from === "SOFT_RESTRICTED" ? "SOFT_RESTRICTED" : "ACTIVE",
          toStatus: "ACTIVE",
          source: "AUTO_CLEAR_ON_SOLVE",
          policyVersion: null,
          evidence: CLEAR_EVIDENCE,
          evaluationDate: null,
        });
        expect(rows[0]?.id, from).toBeTruthy();
      }
    });

    it("allows a single rung DOWN, which is a staff de-escalation", async () => {
      const rows = await event({
        fromStage: "SOFT_RESTRICTED",
        toStage: "WARNED",
        fromStatus: "SOFT_RESTRICTED",
        toStatus: "ACTIVE",
        source: "MANUAL_ADMIN",
        policyVersion: null,
        evidence: { note: "Spoke to them; they were at a family funeral." },
        triggeredBySystem: false,
        actorId: staffId,
        reason: "Spoke to them; they were at a family funeral.",
        evaluationDate: null,
      });
      expect(rows[0]?.id).toBeTruthy();
    });
  });

  describe("the evidence a dispute reads", () => {
    it("has exactly the key set the zod schema requires", () => {
      // Parsed out of the migration SQL, not retyped. The database constraint
      // and `inactivityEvidenceSchema` are provably one list.
      expect(evidenceKeysInMigration().sort()).toEqual([...REQUIRED_EVIDENCE_KEYS].sort());
    });

    it.each([...REQUIRED_EVIDENCE_KEYS])("refuses a sweep row whose evidence is missing %s", async (key) => {
      const evidence = { ...SWEEP_EVIDENCE, policyVersion: safeVersion } as Record<string, unknown>;
      delete evidence[key];
      expect(await refused(() => event({ evidence }))).toMatch(/AccountStatusEvent_system_evidence_check/);
    });

    it("refuses excluded dates that are not an array", async () => {
      expect(
        await refused(() => event({ evidence: { ...SWEEP_EVIDENCE, policyVersion: safeVersion, excludedDates: "none" } })),
      ).toMatch(/AccountStatusEvent_system_evidence_check/);
    });

    it("refuses excluded dates and reasons of different lengths", async () => {
      // The two arrays are read positionally: one date with no reason beside
      // it is an exclusion nobody can explain.
      expect(
        await refused(() =>
          event({
            evidence: {
              ...SWEEP_EVIDENCE,
              policyVersion: safeVersion,
              excludedDates: ["2026-10-04", "2026-10-05"],
              excludedReason: ["HOLIDAY"],
            },
          }),
        ),
      ).toMatch(/AccountStatusEvent_system_evidence_check/);
    });

    it("accepts aligned arrays", async () => {
      const rows = await event({
        evidence: {
          ...SWEEP_EVIDENCE,
          policyVersion: safeVersion,
          excludedDates: ["2026-10-04", "2026-10-05"],
          excludedReason: ["HOLIDAY", "MEDICAL_LEAVE"],
        },
      });
      expect(rows[0]?.id).toBeTruthy();
    });

    it("refuses evidence that is not an object, whatever the source", async () => {
      for (const evidence of [[], 7, "nothing"]) {
        expect(await refused(() => event({ evidence })), JSON.stringify(evidence)).toMatch(
          /AccountStatusEvent_evidence_object_check|invalid input syntax/i,
        );
      }
    });

    it("requires a clear to say what cleared it and when", async () => {
      for (const source of ["AUTO_CLEAR_ON_SOLVE", "SELF_CLEAR", "LEAVE_REVERSAL"] as const) {
        const base = {
          fromStage: "NUDGED",
          toStage: "NONE",
          source,
          policyVersion: null,
          evidence: { note: "cleared" },
          triggeredBySystem: source !== "SELF_CLEAR",
          actorId: source === "SELF_CLEAR" ? studentId : null,
          evaluationDate: null,
        };
        expect(await refused(() => event(base)), source).toMatch(/AccountStatusEvent_clear_evidence_check/);
        const rows = await event({ ...base, evidence: CLEAR_EVIDENCE });
        expect(rows[0]?.id, source).toBeTruthy();
      }
    });
  });

  describe("who may have written a row", () => {
    it("refuses a system row with an actor", async () => {
      expect(await refused(() => event({ actorId: staffId }))).toMatch(/AccountStatusEvent_actor_check/);
    });

    it("refuses a manual row with no actor", async () => {
      expect(
        await refused(() =>
          event({
            source: "MANUAL_ADMIN",
            policyVersion: null,
            evidence: { note: "x" },
            triggeredBySystem: false,
            actorId: null,
            reason: "A reason long enough.",
            evaluationDate: null,
          }),
        ),
      ).toMatch(/AccountStatusEvent_actor_check/);
    });

    it("refuses a row whose triggeredBySystem disagrees with its source", async () => {
      // The flag is derivable from the source, so a row where they disagree
      // is a row that would read two different ways.
      expect(await refused(() => event({ triggeredBySystem: false, actorId: staffId }))).toMatch(
        /AccountStatusEvent_actor_check/,
      );
    });

    it("makes SELF_CLEAR carry the student as its actor", async () => {
      const rows = await event({
        fromStage: "SOFT_RESTRICTED",
        toStage: "NONE",
        fromStatus: "SOFT_RESTRICTED",
        toStatus: "ACTIVE",
        source: "SELF_CLEAR",
        policyVersion: null,
        evidence: CLEAR_EVIDENCE,
        triggeredBySystem: false,
        actorId: studentId,
        evaluationDate: null,
      });
      expect(rows[0]?.id).toBeTruthy();
    });

    it("requires a reason of real length on a manual row, and refuses a null one", async () => {
      const base = {
        source: "MANUAL_ADMIN" as const,
        policyVersion: null,
        evidence: { note: "x" },
        triggeredBySystem: false,
        actorId: staffId,
        evaluationDate: null,
      };
      // NULL is the case a CHECK without COALESCE would have let straight
      // through, since char_length(NULL) >= 10 is NULL.
      expect(await refused(() => event({ ...base, reason: null }))).toMatch(
        /AccountStatusEvent_manual_reason_check/,
      );
      expect(await refused(() => event({ ...base, reason: "too short" }))).toMatch(
        /AccountStatusEvent_manual_reason_check/,
      );
      expect(await refused(() => event({ ...base, reason: "          " }))).toMatch(
        /AccountStatusEvent_manual_reason_check/,
      );
      const rows = await event({ ...base, reason: "They asked to be taken off the board for a term." });
      expect(rows[0]?.id).toBeTruthy();
    });

    it("needs no typed reason from a student or from the system", async () => {
      const rows = await event({
        fromStage: "NUDGED",
        toStage: "NONE",
        source: "SELF_CLEAR",
        policyVersion: null,
        evidence: CLEAR_EVIDENCE,
        triggeredBySystem: false,
        actorId: studentId,
        reason: null,
        evaluationDate: null,
      });
      expect(rows[0]?.id).toBeTruthy();
    });
  });

  describe("only a super-admin or a leave reopens a closed account", () => {
    it.each(["MANUAL_ADMIN", "SELF_CLEAR", "AUTO_CLEAR_ON_SOLVE", "INACTIVITY_SWEEP"] as const)(
      "refuses %s leaving DISABLED",
      async (source) => {
        const system = source === "INACTIVITY_SWEEP" || source === "AUTO_CLEAR_ON_SOLVE";
        const message = await refused(() =>
          event({
            fromStage: "DISABLED",
            toStage: "SOFT_RESTRICTED",
            fromStatus: "DISABLED",
            toStatus: "SOFT_RESTRICTED",
            source,
            policyVersion: source === "INACTIVITY_SWEEP" ? safeVersion : null,
            evidence:
              source === "INACTIVITY_SWEEP"
                ? { ...SWEEP_EVIDENCE, policyVersion: safeVersion }
                : source === "MANUAL_ADMIN"
                  ? { note: "x" }
                  : CLEAR_EVIDENCE,
            triggeredBySystem: system,
            actorId: system ? null : staffId,
            reason: source === "MANUAL_ADMIN" ? "They are back from a long illness." : null,
            evaluationDate: source === "INACTIVITY_SWEEP" ? nextEvalDay() : null,
          }),
        );
        expect(message).toMatch(/AccountStatusEvent_undisable_check/);
      },
    );

    it("allows a super-admin to reopen it", async () => {
      const rows = await event({
        fromStage: "DISABLED",
        toStage: "NONE",
        fromStatus: "DISABLED",
        toStatus: "ACTIVE",
        source: "MANUAL_SUPER",
        policyVersion: null,
        evidence: { note: "Reopened after they produced a hospital discharge summary." },
        triggeredBySystem: false,
        actorId: staffId,
        reason: "Reopened after they produced a hospital discharge summary.",
        evaluationDate: null,
      });
      expect(rows[0]?.id).toBeTruthy();
    });

    it("allows a retroactive leave to reverse it", async () => {
      const rows = await event({
        fromStage: "DISABLED",
        toStage: "NONE",
        fromStatus: "DISABLED",
        toStatus: "ACTIVE",
        source: "LEAVE_REVERSAL",
        policyVersion: null,
        evidence: { clearedBy: "leave_abc123", clearedAt: "2026-10-20T04:00:00.000Z" },
        triggeredBySystem: true,
        actorId: null,
        evaluationDate: null,
      });
      expect(rows[0]?.id).toBeTruthy();
    });
  });

  describe("idempotence per campus day", () => {
    it("refuses a second SWEEP row for one student on one day", async () => {
      const date = nextEvalDay();
      await event({ evaluationDate: date });
      const message = await refused(() => event({ fromStage: "NUDGED", toStage: "WARNED", evaluationDate: date }));
      expect(message).toMatch(/evaluationDate|sweep_once_per_day/i);
    });

    it("ALLOWS a same-day escalate then clear — both rows, which is what happened", async () => {
      /**
       * The case the draft design made impossible, and the reason `source`
       * exists. A student escalated by the 02:00 sweep who solves a problem
       * at 09:00 has had two things happen to them that day, and the history
       * has to say so. An index scoped to `triggeredBySystem` rather than to
       * the sweep would have made the clear collide with the escalation.
       */
      const date = nextEvalDay();
      const escalated = await event({ fromStage: "NONE", toStage: "NUDGED", evaluationDate: date });
      const cleared = await event({
        fromStage: "NUDGED",
        toStage: "NONE",
        source: "AUTO_CLEAR_ON_SOLVE",
        policyVersion: null,
        evidence: CLEAR_EVIDENCE,
        evaluationDate: null,
      });
      expect(escalated[0]?.id).toBeTruthy();
      expect(cleared[0]?.id).toBeTruthy();
      expect(cleared[0]!.id).not.toBe(escalated[0]!.id);
    });

    it("allows many non-sweep rows on one day", async () => {
      for (let i = 0; i < 3; i += 1) {
        const rows = await event({
          fromStage: "NUDGED",
          toStage: "NONE",
          source: "SELF_CLEAR",
          policyVersion: null,
          evidence: CLEAR_EVIDENCE,
          triggeredBySystem: false,
          actorId: studentId,
          evaluationDate: null,
        });
        expect(rows[0]?.id, String(i)).toBeTruthy();
      }
    });
  });

  describe("never swept mid-attempt", () => {
    let assessmentId = "";
    let attemptId = "";

    beforeAll(async () => {
      const assessment = await db.assessment.create({
        data: {
          slug: `rst-${run}-exam`,
          title: "An assessment",
          instructions: "Sit it.",
          status: "OPEN",
          opensAt: new Date("2097-01-01T00:00:00.000Z"),
          closesAt: new Date("2097-12-31T00:00:00.000Z"),
          durationSec: 3_600,
          createdById: staffId,
        },
        select: { id: true },
      });
      assessmentId = assessment.id;
      const attempt = await db.assessmentAttempt.create({
        data: {
          assessmentId,
          userId: studentId,
          status: "IN_PROGRESS",
          attemptNumber: 1,
          startedAt: new Date(),
          expiresAt: new Date(Date.now() + 3_600_000),
          // `seed` is an Int (HMAC-derived per candidate), not a hex string.
          seed: 1_234_567,
          layout: {} as never,
          tokenHash: "b".repeat(64),
          proctorMode: "ADVISORY",
        } as never,
        select: { id: true },
      });
      attemptId = attempt.id;
    });

    afterAll(async () => {
      await db.$executeRawUnsafe(`ALTER TABLE "AssessmentAttempt" DISABLE TRIGGER "AssessmentAttempt_machine"`);
      await db.assessmentAttempt.deleteMany({ where: { id: attemptId } });
      await db.$executeRawUnsafe(`ALTER TABLE "AssessmentAttempt" ENABLE TRIGGER "AssessmentAttempt_machine"`);
      // A PUBLISHED/OPEN assessment refuses DELETE — "archive it instead" —
      // so the status comes down before the row goes. The same shape as
      // Phase 7's seeded patterns, and the same reason: a teardown that
      // ignores a Phase 6 guard is a teardown that fails a suite whose every
      // test passed.
      await db.assessment.update({ where: { id: assessmentId }, data: { status: "DRAFT" } });
      await db.assessment.deleteMany({ where: { id: assessmentId } });
    });

    it("refuses an escalating sweep row while an attempt is IN_PROGRESS", async () => {
      // "Locking a student out of a graded assessment because they were ill
      // is a worse failure than under-enforcing."
      const message = await refused(() => event({ fromStage: "NONE", toStage: "NUDGED" }));
      expect(message).toMatch(/AccountStatusEvent_no_sweep_mid_attempt/);
    });

    it("allows a CLEAR during an attempt — that is a kindness, not a sweep", async () => {
      const rows = await event({
        fromStage: "NUDGED",
        toStage: "NONE",
        source: "AUTO_CLEAR_ON_SOLVE",
        policyVersion: null,
        evidence: CLEAR_EVIDENCE,
        evaluationDate: null,
      });
      expect(rows[0]?.id).toBeTruthy();
    });

    it("allows a MANUAL row during an attempt — a human has looked", async () => {
      const rows = await event({
        fromStage: "NONE",
        toStage: "NUDGED",
        source: "MANUAL_ADMIN",
        policyVersion: null,
        evidence: { note: "x" },
        triggeredBySystem: false,
        actorId: staffId,
        reason: "Nudged by hand after a conversation.",
        evaluationDate: null,
      });
      expect(rows[0]?.id).toBeTruthy();
    });
  });

  describe("the history is append-only", () => {
    it("allows notifiedAt to be set exactly once", async () => {
      const rows = await event();
      const id = rows[0]!.id;
      const first = await db.$executeRawUnsafe(
        `UPDATE "AccountStatusEvent" SET "notifiedAt" = now() WHERE "id" = ${id}`,
      );
      expect(first).toBe(1);
      expect(
        await refused(() =>
          db.$executeRawUnsafe(`UPDATE "AccountStatusEvent" SET "notifiedAt" = now() WHERE "id" = ${id}`),
        ),
      ).toMatch(/AccountStatusEvent_append_only/);
    });

    it("refuses setting notifiedAt together with anything else", async () => {
      const rows = await event();
      const id = rows[0]!.id;
      expect(
        await refused(() =>
          db.$executeRawUnsafe(
            `UPDATE "AccountStatusEvent" SET "notifiedAt" = now(), "reason" = 'rewritten' WHERE "id" = ${id}`,
          ),
        ),
      ).toMatch(/AccountStatusEvent_append_only/);
    });

    it("refuses an edit to the evidence", async () => {
      const rows = await event();
      expect(
        await refused(() =>
          db.$executeRawUnsafe(
            `UPDATE "AccountStatusEvent" SET "evidence" = '{}'::jsonb WHERE "id" = ${rows[0]!.id}`,
          ),
        ),
      ).toMatch(/AccountStatusEvent_append_only/);
    });

    it("refuses DELETE and TRUNCATE", async () => {
      const rows = await event();
      expect(
        await refused(() => db.$executeRawUnsafe(`DELETE FROM "AccountStatusEvent" WHERE "id" = ${rows[0]!.id}`)),
      ).toMatch(/AccountStatusEvent_append_only/);
      expect(await refused(() => db.$executeRawUnsafe(`TRUNCATE "AccountStatusEvent"`))).toMatch(/TRUNCATE/i);
    });

    it("refuses a no-op row where neither stage nor status moved", async () => {
      expect(await refused(() => event({ fromStage: "NUDGED", toStage: "NUDGED" }))).toMatch(
        /AccountStatusEvent_change_check/,
      );
    });

    it("allows a row where only the STATUS moved", async () => {
      // A student an admin suspends while already WARNED: the stage is the
      // same, the consequence is not.
      const rows = await event({
        fromStage: "WARNED",
        toStage: "WARNED",
        fromStatus: "ACTIVE",
        toStatus: "SOFT_RESTRICTED",
        source: "MANUAL_ADMIN",
        policyVersion: null,
        evidence: { note: "x" },
        triggeredBySystem: false,
        actorId: staffId,
        reason: "Taken off the board at their own request.",
        evaluationDate: null,
      });
      expect(rows[0]?.id).toBeTruthy();
    });
  });

  describe("a stage never moves without its explanation", () => {
    it("refuses a restriction whose stage has no event, at COMMIT", async () => {
      /**
       * The deferred constraint trigger. This is what makes "every automatic
       * decision carries its evidence" true of the STATE and not only of the
       * history — a stage set by hand in psql, with no event, does not
       * commit.
       */
      const message = await refused(() =>
        db.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(
            `INSERT INTO "AccountRestriction" ("userId","stage","countedInactiveDays")
             VALUES ($1,'SOFT_RESTRICTED',11)`,
            staffId,
          );
        }),
      );
      expect(message).toMatch(/AccountRestriction_requires_event/);
    });

    it("accepts the restriction and its event written in EITHER order in one transaction", async () => {
      // Deferred is the point: the sweep writes both and must not have to
      // care which statement goes first.
      const date = nextEvalDay();
      await db.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
          `INSERT INTO "AccountRestriction" ("userId","stage","countedInactiveDays","stageEnteredAt")
           VALUES ($1,'NUDGED',3, now())
           ON CONFLICT ("userId") DO UPDATE SET "stage" = 'NUDGED', "countedInactiveDays" = 3, "stageEnteredAt" = now()`,
          studentId,
        );
        await tx.$executeRawUnsafe(
          `INSERT INTO "AccountStatusEvent"
             ("userId","fromStage","toStage","fromStatus","toStatus","source","policyVersion",
              "evidence","triggeredBySystem","evaluationDate")
           VALUES ($1,'NONE','NUDGED','ACTIVE','ACTIVE','INACTIVITY_SWEEP',$2,$3::jsonb,true,$4::date)`,
          studentId,
          safeVersion,
          JSON.stringify({ ...SWEEP_EVIDENCE, policyVersion: safeVersion, countedInactiveDays: 3, thresholdDays: 3 }),
          date,
        );
      });
      const row = await db.accountRestriction.findUnique({ where: { userId: studentId }, select: { stage: true } });
      expect(row?.stage).toBe("NUDGED");
    });

    it("accepts a fresh row at NONE with nothing counted, which is the absence of a restriction", async () => {
      const row = await db.accountRestriction.upsert({
        where: { userId: staffId },
        create: { userId: staffId },
        update: {},
        select: { stage: true, countedInactiveDays: true },
      });
      expect(row).toMatchObject({ stage: "NONE", countedInactiveDays: 0 });
      await db.accountRestriction.delete({ where: { userId: staffId } });
    });
  });

  describe("the restriction row's own shape", () => {
    const restriction = (over: Record<string, unknown> = {}) =>
      db.$executeRawUnsafe(
        `INSERT INTO "AccountRestriction"
           ("userId","stage","countedInactiveDays","graceEndsAt","selfClearedCount","selfClearedTermKey",
            "ownsAccountStatus","adminReviewOpenedAt","adminReviewClearedAt")
         VALUES ($1,$2::"RestrictionStage",$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT ("userId") DO UPDATE SET
           "stage" = EXCLUDED."stage",
           "countedInactiveDays" = EXCLUDED."countedInactiveDays",
           "graceEndsAt" = EXCLUDED."graceEndsAt",
           "selfClearedCount" = EXCLUDED."selfClearedCount",
           "selfClearedTermKey" = EXCLUDED."selfClearedTermKey",
           "ownsAccountStatus" = EXCLUDED."ownsAccountStatus",
           "adminReviewOpenedAt" = EXCLUDED."adminReviewOpenedAt",
           "adminReviewClearedAt" = EXCLUDED."adminReviewClearedAt"`,
        staffId,
        over.stage ?? "NONE",
        over.countedInactiveDays ?? 0,
        over.graceEndsAt ?? null,
        over.selfClearedCount ?? 0,
        over.selfClearedTermKey ?? null,
        over.ownsAccountStatus ?? false,
        over.adminReviewOpenedAt ?? null,
        over.adminReviewClearedAt ?? null,
      );

    afterAll(async () => {
      await db.accountRestriction.deleteMany({ where: { userId: staffId } });
    });

    it("refuses a negative day count", async () => {
      expect(await refused(() => restriction({ countedInactiveDays: -1 }))).toMatch(
        /AccountRestriction_counted_check/,
      );
    });

    it("refuses a NONE row that still carries a count or a grace window", async () => {
      // Otherwise a cleared account keeps rendering a dormancy countdown.
      expect(await refused(() => restriction({ stage: "NONE", countedInactiveDays: 4 }))).toMatch(
        /AccountRestriction_none_check/,
      );
      // A grace window in the FUTURE, so `AccountRestriction_grace_check`
      // (graceEndsAt >= stageEnteredAt) is satisfied and the constraint
      // actually under test is the one that fires.
      expect(
        await refused(() => restriction({ stage: "NONE", graceEndsAt: new Date(Date.now() + 86_400_000) })),
      ).toMatch(/AccountRestriction_none_check/);
    });

    it("pairs the self-clear count with the term it belongs to", async () => {
      expect(await refused(() => restriction({ selfClearedCount: 1, selfClearedTermKey: null }))).toMatch(
        /AccountRestriction_self_cleared_check/,
      );
      expect(await refused(() => restriction({ selfClearedCount: 0, selfClearedTermKey: "AY2026" }))).toMatch(
        /AccountRestriction_self_cleared_check/,
      );
      expect(await refused(() => restriction({ selfClearedCount: 9, selfClearedTermKey: "AY2026" }))).toMatch(
        /AccountRestriction_self_cleared_check/,
      );
    });

    it("lets the engine claim User.status only at the rungs that move it", async () => {
      expect(await refused(() => restriction({ stage: "NONE", ownsAccountStatus: true }))).toMatch(
        /AccountRestriction_owns_status_check/,
      );
      expect(await refused(() => restriction({ stage: "WARNED", countedInactiveDays: 5, ownsAccountStatus: true }))).toMatch(
        /AccountRestriction_owns_status_check/,
      );
    });

    it("refuses a review cleared before it was opened, or cleared with none open", async () => {
      const now = new Date();
      const earlier = new Date(now.getTime() - 60_000);
      expect(
        await refused(() => restriction({ adminReviewOpenedAt: now, adminReviewClearedAt: earlier })),
      ).toMatch(/AccountRestriction_review_check/);
      expect(await refused(() => restriction({ adminReviewClearedAt: now }))).toMatch(
        /AccountRestriction_review_check/,
      );
    });

    it("refuses TRUNCATE", async () => {
      expect(await refused(() => db.$executeRawUnsafe(`TRUNCATE "AccountRestriction"`))).toMatch(/TRUNCATE/i);
    });
  });
});
