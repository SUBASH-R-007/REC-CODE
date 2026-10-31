import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Deriving SNAPSHOT_JUMP against the real tables (Phase 11b).
 *
 * This is the signal SPEC §5 calls "the most probative artefact" and "the
 * one piece of evidence that survives client tampering": the heaviest
 * substantive contribution in the triage engine, thirty points. Its pure
 * half — `countTokens`, `isSnapshotJump`, the 60 % share, the 40-token
 * floor — was written and tested in Phase 6. Nothing ever called it, so no
 * exam before Phase 11b was ever reviewed with it.
 *
 * What these tests hold:
 *
 *   * code appearing in one interval with no paste is derived as a jump;
 *   * the same growth WITH a paste in the interval is not (that is an
 *     ordinary paste, already recorded as itself);
 *   * a file that grows steadily produces nothing — the signal exonerates
 *     as often as it accuses, and a derivation that fired on honest work
 *     would be worse than none;
 *   * deriving twice does not double a candidate's evidence.
 *
 * Opt-in: RECX_DB_TESTS=1.
 */
const ENABLED = process.env.RECX_DB_TESTS === "1";

vi.hoisted(() => {
  if (process.env.RECX_DB_TESTS === "1") {
    process.env.DATABASE_URL =
      process.env.RECX_TEST_DATABASE_URL ?? "postgresql://recx:recx-dev-only@127.0.0.1:5433/recx_test";
    process.env.IP_HASH_PEPPER ??= "snapshot-jump-test-pepper";
  }
});

describe.skipIf(!ENABLED)("SNAPSHOT_JUMP derivation against recx_test", () => {
  const tag = `jump-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
  let db: (typeof import("@/lib/db"))["db"];
  let deriveSnapshotJumps: (typeof import("@/lib/exam/snapshot-jump"))["deriveSnapshotJumps"];
  const userIds: string[] = [];
  const attemptIds: string[] = [];
  let assessmentId = "";
  let examSessionId = "";

  /** ~90 tokens of plausible code, so the 40-token floor is cleared. */
  const SOLUTION = [
    "def two_sum(nums, target):",
    "    seen = {}",
    "    for index, value in enumerate(nums):",
    "        need = target - value",
    "        if need in seen:",
    "            return [seen[need], index]",
    "        seen[value] = index",
    "    return []",
    "",
    "if __name__ == '__main__':",
    "    print(two_sum([2, 7, 11, 15], 9))",
  ].join("\n");

  async function attempt(suffix: string) {
    const user = await db.user.create({
      data: {
        collegeId: `${tag}-${suffix}`.toUpperCase().slice(0, 32),
        email: `${tag}-${suffix}@rajalakshmi.edu.invalid`,
        firstName: "Jump",
        lastName: suffix,
        handle: `${tag}-${suffix}`.slice(0, 30),
        role: "STUDENT",
        status: "ACTIVE",
      },
      select: { id: true },
    });
    userIds.push(user.id);
    const row = await db.assessmentAttempt.create({
      data: {
        assessmentId,
        examSessionId,
        userId: user.id,
        status: "IN_PROGRESS",
        seed: 1,
        // Required, and the point of the fixture: this is an exam.
        proctorMode: "LAB_SUPERVISED",
        startedAt: new Date(Date.now() - 3_600_000),
        expiresAt: new Date(Date.now() + 3_600_000),
        tokenHash: randomBytes(32).toString("hex"),
        layout: { questions: [{ questionId: `${tag}-q1`, problemVersionId: `${tag}-v1`, position: 1 }] },
      },
      select: { id: true, startedAt: true },
    });
    attemptIds.push(row.id);
    return row;
  }

  /** One whole snapshot per call, which is what the derivation reads back. */
  async function snapshot(attemptId: string, atMs: number, source: string) {
    await db.attemptSnapshot.create({
      data: {
        attemptId,
        questionId: `${tag}-q1`,
        atMs,
        language: "py312",
        content: source,
        contentHash: randomBytes(32).toString("hex"),
        isDiff: false,
        trigger: "TICK",
      },
    });
  }

  const jumpsOf = (attemptId: string) =>
    db.proctorEvent.findMany({ where: { attemptId, kind: "SNAPSHOT_JUMP" }, orderBy: { atMs: "asc" } });

  beforeAll(async () => {
    ({ db } = await import("@/lib/db"));
    ({ deriveSnapshotJumps } = await import("@/lib/exam/snapshot-jump"));

    const owner = await db.user.create({
      data: {
        collegeId: `${tag}-OWNER`.toUpperCase().slice(0, 32),
        email: `${tag}-owner@rajalakshmi.edu.invalid`,
        firstName: "Hall",
        lastName: "Owner",
        handle: `${tag}-owner`.slice(0, 30),
        role: "ADMIN",
        status: "ACTIVE",
      },
      select: { id: true },
    });
    userIds.push(owner.id);

    const assessment = await db.assessment.create({
      data: {
        slug: `${tag}-assessment`,
        title: `${tag} assessment`,
        instructions: "Drill fixture.",
        status: "OPEN",
        proctorMode: "LAB_SUPERVISED",
        durationSec: 3_600,
        opensAt: new Date(Date.now() - 7_200_000),
        closesAt: new Date(Date.now() + 7_200_000),
        createdById: owner.id,
      },
      select: { id: true },
    });
    assessmentId = assessment.id;

    const session = await db.examSession.create({
      data: {
        assessmentId: assessment.id,
        label: `${tag} hall`,
        startsAt: new Date(Date.now() - 7_200_000),
        endsAt: new Date(Date.now() + 7_200_000),
        /**
         * The database insists, and it is right to: "ExamSession … is for a
         * LAB_SUPERVISED assessment and must name at least one allowed
         * CIDR: the allowlist is the enforcement".
         */
        allowedCidrs: ["10.0.0.0/8"],
        createdById: owner.id,
      },
      select: { id: true },
    });
    examSessionId = session.id;
  }, 120_000);

  afterAll(async () => {
    if (!ENABLED) return;
    if (attemptIds.length > 0) {
      await db.proctorEvent.deleteMany({ where: { attemptId: { in: attemptIds } } });
      await db.attemptSnapshot.deleteMany({ where: { attemptId: { in: attemptIds } } });
      /**
       * The attempts themselves stay. The database refuses to delete one —
       * "AssessmentAttempt … is never deleted (it is the record of a
       * sitting)" — which is exactly right and not something a test should
       * route around. They are tagged, so they are identifiable, and the
       * users they belong to go below.
       */
    }
    if (examSessionId) await db.examSession.deleteMany({ where: { id: examSessionId } });
    if (assessmentId) {
      // "Assessment … is published and cannot be deleted (archive it
      // instead)" — the database's own words, and the right rule: a
      // published paper somebody sat does not vanish.
      await db.assessment.updateMany({ where: { id: assessmentId }, data: { status: "ARCHIVED" } });
    }
    /**
     * And the candidates stay with them: a student is never hard-deleted
     * here (SPEC §0), least of all one with a sitting on record. Both are
     * tagged with this run's id.
     */
    await db.user.deleteMany({ where: { id: { in: userIds }, assessmentAttempts: { none: {} } } }).catch(() => undefined);
  }, 60_000);

  it("derives a jump when the answer appears in one interval with no paste", async () => {
    const row = await attempt("blind");
    await snapshot(row.id, 30_000, "def two_sum(nums, target):\n    pass\n");
    await snapshot(row.id, 60_000, SOLUTION);

    const derived = await deriveSnapshotJumps(row);
    expect(derived).toHaveLength(1);
    expect(derived[0]!.atMs).toBe(60_000);

    const events = await jumpsOf(row.id);
    expect(events).toHaveLength(1);
    expect(events[0]!.source).toBe("SERVER");
    // Evidence, not a verdict: the heaviest signal here is still MEDIUM.
    expect(events[0]!.severity).toBe("MEDIUM");
    expect(events[0]!.clientSeq).toBeNull();
    const meta = events[0]!.meta as { addedTokens?: number; finalTokens?: number };
    expect(meta.addedTokens).toBeGreaterThan(0);
    expect(meta.finalTokens).toBeGreaterThanOrEqual(40);
  }, 60_000);

  it("derives nothing when a paste explains the same interval", async () => {
    const row = await attempt("pasted");
    await snapshot(row.id, 30_000, "def two_sum(nums, target):\n    pass\n");
    await snapshot(row.id, 60_000, SOLUTION);
    // The paste the candidate's own client reported, in the same interval.
    await db.proctorEvent.create({
      data: {
        attemptId: row.id,
        kind: "EXTERNAL_PASTE",
        source: "CLIENT",
        severity: "MEDIUM",
        clientSeq: 1,
        atMs: 45_000,
        size: 400,
      },
    });

    expect(await deriveSnapshotJumps(row)).toEqual([]);
    expect(await jumpsOf(row.id)).toHaveLength(0);
  }, 60_000);

  it("derives nothing from a file that grows steadily, which is somebody working", async () => {
    const row = await attempt("working");
    const lines = SOLUTION.split("\n");
    for (let i = 1; i <= lines.length; i++) {
      await snapshot(row.id, i * 30_000, lines.slice(0, i).join("\n"));
    }
    expect(await deriveSnapshotJumps(row)).toEqual([]);
    expect(await jumpsOf(row.id)).toHaveLength(0);
  }, 120_000);

  it("does not double a candidate's evidence when it runs again", async () => {
    const row = await attempt("twice");
    await snapshot(row.id, 30_000, "x = 1\n");
    await snapshot(row.id, 60_000, SOLUTION);

    expect(await deriveSnapshotJumps(row)).toHaveLength(1);
    expect(await deriveSnapshotJumps(row)).toEqual([]);
    expect(await jumpsOf(row.id)).toHaveLength(1);
  }, 60_000);

  it("derives nothing for an attempt with no snapshots at all", async () => {
    const row = await attempt("empty");
    expect(await deriveSnapshotJumps(row)).toEqual([]);
  }, 60_000);
});
