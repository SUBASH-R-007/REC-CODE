import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  applyMigrations,
  disabledTriggers,
  openTestDb,
  RUN_DB_TESTS,
  testDatabaseName,
  type DbModule,
  type TestDb,
} from "./support/test-db";

/**
 * Phase 6a invariants (migration 20261019140000_phase6a_assessments), and
 * above all THE HARD RULE.
 *
 * SPEC §5: "Assessment.affectsPlacementEligibility = true REQUIRES
 * proctorMode = LAB_SUPERVISED. Enforce with a zod refinement at the server
 * boundary and a Postgres CHECK. Only a lab-proctored result may ever feed
 * shortlisting, certificates or placement eligibility. This stops the
 * predictable drift where an admin flips a Friday quiz into a shortlisting
 * criterion because it was convenient."
 *
 * The zod half is packages/shared/test/assessment.test.ts. This proves the
 * DATABASE half — the one that holds when the write does not come through a
 * server action at all. Both doors are tested: creating a placement-bearing
 * assessment outside LAB_SUPERVISED, and publishing a harmless one and then
 * switching the flag on.
 */

const tag = `as-${randomBytes(4).toString("hex")}`;
const TITLE = RUN_DB_TESTS
  ? "assessment invariants (live database)"
  : "assessment invariants (set RECX_DB_TESTS=1 to run)";

const NON_LAB_MODES = ["NONE", "ADVISORY", "REMOTE_MONITORED", "KIOSK_SEB"] as const;

describe.skipIf(!RUN_DB_TESTS)(TITLE, () => {
  let db: TestDb;
  let mod: DbModule;
  let restoreEnv: () => void;

  let superId = "";
  let frozenVersionId = "";
  let draftVersionId = "";
  const slugs: string[] = [];

  const OPENS = new Date("2026-12-01T10:00:00.000Z");
  const CLOSES = new Date("2026-12-01T13:00:00.000Z");

  async function refused(fn: () => Promise<unknown>): Promise<string> {
    try {
      await fn();
    } catch (error) {
      return String((error as Error).message);
    }
    throw new Error("the write was expected to be refused, but it went through");
  }

  /** A minimal assessment; `over` varies the one thing under test. */
  function assessment(over: Record<string, unknown> = {}) {
    const slug = `${tag}-${slugs.length}`;
    slugs.push(slug);
    return {
      slug,
      title: `Assessment ${slug}`,
      instructions: "Answer the questions.",
      opensAt: OPENS,
      closesAt: CLOSES,
      durationSec: 3600,
      createdById: superId,
      ...over,
    };
  }

  beforeAll(async () => {
    const dbName = testDatabaseName();
    applyMigrations();
    ({ db, mod, restore: restoreEnv } = await openTestDb());
    const [current] = await db.$queryRawUnsafe<Array<{ name: string }>>("SELECT current_database() AS name");
    expect(current?.name).toBe(dbName);
    expect(await disabledTriggers(db)).toEqual([]);

    const handle = `${tag}-super`;
    const user = await db.user.create({
      data: {
        collegeId: handle.toUpperCase(),
        email: `${handle}@example.test`,
        firstName: "A",
        lastName: "Super",
        handle,
        role: "SUPER_ADMIN",
      },
      select: { id: true },
    });
    superId = user.id;

    const problem = await db.problem.create({
      data: {
        slug: `${tag}-p`,
        displayCode: tag.slice(0, 8).toUpperCase(),
        title: "Assessment fixture",
        difficulty: "EASY",
        status: "PUBLISHED",
      },
      select: { id: true },
    });
    const frozen = await db.problemVersion.create({
      data: {
        problemId: problem.id,
        revision: 1,
        title: "Assessment fixture",
        difficulty: "EASY",
        statementMd: "Solve it.",
        ioMode: "STDIN",
        timeLimitMs: 1000,
      },
      select: { id: true },
    });
    await db.$executeRawUnsafe(`UPDATE "public"."ProblemVersion" SET "frozenAt" = now() WHERE "id" = $1`, frozen.id);
    frozenVersionId = frozen.id;
    const draft = await db.problemVersion.create({
      data: {
        problemId: problem.id,
        revision: 2,
        title: "Assessment fixture r2",
        difficulty: "EASY",
        statementMd: "Solve it again.",
        ioMode: "STDIN",
        timeLimitMs: 1000,
      },
      select: { id: true },
    });
    draftVersionId = draft.id;
  });

  afterAll(async () => {
    if (!db) return;
    try {
      const raw = (sql: string, ...params: unknown[]) => db.$executeRawUnsafe(sql, ...params);
      const off = [
        ["Assessment", "Assessment_published_immutable"],
        ["AssessmentProblem", "AssessmentProblem_frozen_version"],
        ["ExamSession", "ExamSession_lab_allowlist"],
        ["ProblemVersion", "ProblemVersion_frozen_guard"],
      ] as const;
      await db.$transaction([
        ...off.map(([t, g]) => raw(`ALTER TABLE "public"."${t}" DISABLE TRIGGER "${g}"`)),
        raw(`DELETE FROM "public"."ExamSession" WHERE "assessmentId" IN (SELECT "id" FROM "public"."Assessment" WHERE "createdById" = $1)`, superId),
        raw(`DELETE FROM "public"."AssessmentProblem" WHERE "assessmentId" IN (SELECT "id" FROM "public"."Assessment" WHERE "createdById" = $1)`, superId),
        raw(`DELETE FROM "public"."Assessment" WHERE "createdById" = $1`, superId),
        raw(`DELETE FROM "public"."ProblemVersion" WHERE "id" = ANY($1::text[])`, [frozenVersionId, draftVersionId]),
        raw(`DELETE FROM "public"."Problem" WHERE "slug" = $1`, `${tag}-p`),
        raw(`DELETE FROM "public"."User" WHERE "id" = $1`, superId),
        ...off.map(([t, g]) => raw(`ALTER TABLE "public"."${t}" ENABLE TRIGGER "${g}"`)),
      ]);
    } finally {
      await db.$disconnect();
      restoreEnv?.();
    }
  });

  describe("THE HARD RULE: only a lab-proctored result may feed placement", () => {
    it.each(NON_LAB_MODES)("refuses placement eligibility under %s", async (mode) => {
      const message = await refused(() =>
        db.assessment.create({
          data: assessment({ proctorMode: mode, affectsPlacementEligibility: true }),
        }),
      );
      expect(message).toMatch(/Assessment_placement_requires_lab/);
    });

    it("refuses it under KIOSK_SEB — the strongest software lockdown is still not a lab", async () => {
      const message = await refused(() =>
        db.assessment.create({
          data: assessment({ proctorMode: "KIOSK_SEB", affectsPlacementEligibility: true }),
        }),
      );
      expect(message).toMatch(/Assessment_placement_requires_lab/);
    });

    it("allows it under LAB_SUPERVISED", async () => {
      const row = await db.assessment.create({
        data: assessment({ proctorMode: "LAB_SUPERVISED", affectsPlacementEligibility: true }),
        select: { id: true, affectsPlacementEligibility: true },
      });
      expect(row.affectsPlacementEligibility).toBe(true);
    });

    it("refuses raw SQL too — the rule is on the data, not on the code path", async () => {
      const message = await refused(() =>
        db.$executeRawUnsafe(
          `INSERT INTO "public"."Assessment" (id, slug, title, instructions, "proctorMode", "affectsPlacementEligibility", "opensAt", "closesAt", "durationSec", "createdById", "updatedAt")
           VALUES ($1, $1, 'Raw', 'x', 'ADVISORY', true, $2, $3, 3600, $4, now())`,
          `${tag}-raw`,
          OPENS,
          CLOSES,
          superId,
        ),
      );
      expect(message).toMatch(/Assessment_placement_requires_lab/);
    });

    it("refuses switching the flag on after publishing (the other door)", async () => {
      const row = await db.assessment.create({
        data: assessment({ proctorMode: "NONE", affectsPlacementEligibility: false }),
        select: { id: true },
      });
      await db.assessment.update({ where: { id: row.id }, data: { status: "PUBLISHED" } });
      const message = await refused(() =>
        db.assessment.update({
          where: { id: row.id },
          data: { proctorMode: "LAB_SUPERVISED", affectsPlacementEligibility: true },
        }),
      );
      expect(message).toMatch(/is published: its window, duration, proctor mode/);
    });

    it("also refuses moving the window or the clock after publishing", async () => {
      const row = await db.assessment.create({ data: assessment({ status: "PUBLISHED" }), select: { id: true } });
      for (const data of [
        { opensAt: new Date("2026-12-02T10:00:00.000Z") },
        { closesAt: new Date("2026-12-02T13:00:00.000Z") },
        { durationSec: 1800 },
        { maxAttempts: 3 },
      ]) {
        const message = await refused(() => db.assessment.update({ where: { id: row.id }, data }));
        expect(message).toMatch(/is published/);
      }
    });

    it("a draft may still be edited freely", async () => {
      const row = await db.assessment.create({ data: assessment(), select: { id: true } });
      const updated = await db.assessment.update({
        where: { id: row.id },
        data: { durationSec: 1800, proctorMode: "ADVISORY" },
        select: { durationSec: true, proctorMode: true },
      });
      expect(updated).toEqual({ durationSec: 1800, proctorMode: "ADVISORY" });
    });
  });

  describe("Assessment bounds", () => {
    it.each([
      ["durationSec", 59, /Assessment_duration_check/],
      ["durationSec", 21_601, /Assessment_duration_check/],
      ["maxFocusWarnings", 0, /Assessment_warnings_check/],
      ["maxFocusWarnings", 11, /Assessment_warnings_check/],
      ["maxAttempts", 0, /Assessment_attempts_check/],
      ["maxAttempts", 6, /Assessment_attempts_check/],
    ])("refuses %s = %d", async (field, value, pattern) => {
      const message = await refused(() => db.assessment.create({ data: assessment({ [field]: value }) }));
      expect(message).toMatch(pattern);
    });

    it("refuses a window that closes before it opens", async () => {
      const message = await refused(() =>
        db.assessment.create({ data: assessment({ opensAt: CLOSES, closesAt: OPENS }) }),
      );
      expect(message).toMatch(/Assessment_window_check/);
    });

    it("refuses a section without a batch and a department", async () => {
      const message = await refused(() =>
        db.assessment.create({ data: assessment({ audienceSection: "A" }) }),
      );
      expect(message).toMatch(/Assessment_audience_check/);
    });

    it("refuses deleting a published assessment (archive it instead)", async () => {
      const row = await db.assessment.create({ data: assessment({ status: "PUBLISHED" }), select: { id: true } });
      const message = await refused(() => db.assessment.delete({ where: { id: row.id } }));
      expect(message).toMatch(/published and cannot be deleted/);
    });

    it("refuses reopening an ARCHIVED assessment", async () => {
      const row = await db.assessment.create({ data: assessment({ status: "ARCHIVED" }), select: { id: true } });
      const message = await refused(() =>
        db.assessment.update({ where: { id: row.id }, data: { status: "OPEN" } }),
      );
      expect(message).toMatch(/ARCHIVED \(final\)/);
    });
  });

  describe("AssessmentProblem pins a frozen version", () => {
    it("refuses a draft (unfrozen) version", async () => {
      const a = await db.assessment.create({ data: assessment(), select: { id: true } });
      const message = await refused(() =>
        db.assessmentProblem.create({
          data: { assessmentId: a.id, problemVersionId: draftVersionId, position: 1 },
        }),
      );
      expect(message).toMatch(/is not frozen/);
    });

    it("accepts a frozen version, and then refuses repointing it", async () => {
      const a = await db.assessment.create({ data: assessment(), select: { id: true } });
      const p = await db.assessmentProblem.create({
        data: { assessmentId: a.id, problemVersionId: frozenVersionId, position: 1 },
        select: { id: true },
      });
      const message = await refused(() =>
        db.assessmentProblem.update({ where: { id: p.id }, data: { position: 2 } }),
      );
      expect(message).toMatch(/never change/);
    });
  });

  describe("ExamSession: the allowlist IS the enforcement", () => {
    it("refuses a LAB_SUPERVISED sitting with no CIDR", async () => {
      const a = await db.assessment.create({
        data: assessment({ proctorMode: "LAB_SUPERVISED" }),
        select: { id: true },
      });
      const message = await refused(() =>
        db.examSession.create({
          data: {
            assessmentId: a.id,
            label: "Hall 1",
            startsAt: OPENS,
            endsAt: CLOSES,
            createdById: superId,
          },
        }),
      );
      expect(message).toMatch(/must name at least one allowed CIDR/);
    });

    it("accepts one with a CIDR", async () => {
      const a = await db.assessment.create({
        data: assessment({ proctorMode: "LAB_SUPERVISED" }),
        select: { id: true },
      });
      const row = await db.examSession.create({
        data: {
          assessmentId: a.id,
          label: "Hall 2",
          startsAt: OPENS,
          endsAt: CLOSES,
          allowedCidrs: ["10.21.0.0/16"],
          createdById: superId,
        },
        select: { allowedCidrs: true },
      });
      expect(row.allowedCidrs).toEqual(["10.21.0.0/16"]);
    });

    it("does not require one for a non-lab sitting", async () => {
      const a = await db.assessment.create({ data: assessment({ proctorMode: "ADVISORY" }), select: { id: true } });
      const row = await db.examSession.create({
        data: { assessmentId: a.id, label: "Remote", startsAt: OPENS, endsAt: CLOSES, createdById: superId },
        select: { id: true },
      });
      expect(row.id).toBeTruthy();
    });
  });

  it("SNAPSHOT_JUMP is a ProctorEventKind, so an accommodation can exempt it", async () => {
    const [row] = await db.$queryRawUnsafe<Array<{ ok: boolean }>>(
      `SELECT 'SNAPSHOT_JUMP' = ANY(enum_range(NULL::"public"."ProctorEventKind")::text[]) AS ok`,
    );
    expect(row?.ok, "Phase 4 left this kind to Phase 6; 6a adds it").toBe(true);
    expect(typeof mod.PrismaClient).toBe("function");
  });
});
