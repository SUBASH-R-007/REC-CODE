import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Banding a finished sitting, against the real tables (Phase 11b).
 *
 * `flagAttemptIfNeeded` was written in Phase 6 and called by nothing: no
 * attempt was ever flagged, no result was ever withheld, and the 72-hour
 * SLA had nothing to act on. Phase 11b connected it to `submitAttempt`;
 * this is the proof that what it does when called is what SPEC §0 allows
 * and no more.
 *
 * The ceiling, which is the thing to hold: a flag, and the result kept off
 * the PUBLIC leaderboard until a human looks or 72 hours pass. Nothing
 * here may void a result, change a score or restrict an account.
 *
 * Opt-in: RECX_DB_TESTS=1.
 */
const ENABLED = process.env.RECX_DB_TESTS === "1";

vi.hoisted(() => {
  if (process.env.RECX_DB_TESTS === "1") {
    process.env.DATABASE_URL =
      process.env.RECX_TEST_DATABASE_URL ?? "postgresql://recx:recx-dev-only@127.0.0.1:5433/recx_test";
    process.env.IP_HASH_PEPPER ??= "integrity-flag-test-pepper";
  }
});

describe.skipIf(!ENABLED)("banding a sitting against recx_test", () => {
  const tag = `flag-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
  let db: (typeof import("@/lib/db"))["db"];
  let flagAttemptIfNeeded: (typeof import("@/lib/integrity/flag"))["flagAttemptIfNeeded"];
  const userIds: string[] = [];
  const attemptIds: string[] = [];
  let assessmentId = "";
  let examSessionId = "";

  async function attempt(suffix: string) {
    const user = await db.user.create({
      data: {
        collegeId: `${tag}-${suffix}`.toUpperCase().slice(0, 32),
        email: `${tag}-${suffix}@rajalakshmi.edu.invalid`,
        firstName: "Band",
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
        status: "SUBMITTED",
        seed: 1,
        proctorMode: "LAB_SUPERVISED",
        startedAt: new Date(Date.now() - 3_600_000),
        expiresAt: new Date(Date.now() - 60_000),
        submittedAt: new Date(),
        tokenHash: randomBytes(32).toString("hex"),
        layout: { questions: [] },
      },
      select: { id: true },
    });
    attemptIds.push(row.id);
    return row.id;
  }

  /** One client event, as the exam client would have sent it. */
  async function event(
    attemptId: string,
    kind: "EXTERNAL_PASTE" | "FOCUS_LOSS" | "MULTI_MONITOR" | "DEVTOOLS_HEURISTIC" | "IDLE_GAP",
    extra: { atMs: number; size?: number; durationMs?: number; seq: number },
  ) {
    await db.proctorEvent.create({
      data: {
        attemptId,
        kind,
        source: "CLIENT",
        severity: "LOW",
        clientSeq: extra.seq,
        atMs: extra.atMs,
        ...(extra.size === undefined ? {} : { size: extra.size }),
        ...(extra.durationMs === undefined ? {} : { durationMs: extra.durationMs }),
      },
    });
  }

  beforeAll(async () => {
    ({ db } = await import("@/lib/db"));
    ({ flagAttemptIfNeeded } = await import("@/lib/integrity/flag"));

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
      /**
       * The flags, the attempts and the candidates all stay, and the
       * database is right about each: "IntegrityFlag … is never deleted (a
       * student may appeal it)", "AssessmentAttempt … is never deleted (it
       * is the record of a sitting)", and a student is never hard-deleted.
       * Every row is tagged with this run's id.
       */
    }
    if (examSessionId) await db.examSession.deleteMany({ where: { id: examSessionId } });
    if (assessmentId) {
      await db.assessment.updateMany({ where: { id: assessmentId }, data: { status: "ARCHIVED" } });
    }
    await db.user
      .deleteMany({ where: { id: { in: userIds }, assessmentAttempts: { none: {} } } })
      .catch(() => undefined);
  }, 60_000);

  it("leaves a clean sitting alone", async () => {
    const id = await attempt("clean");
    const result = await flagAttemptIfNeeded(id);
    expect(result.flagged).toBe(false);
    expect(result.triage.band).toBe("NONE");
    expect(await db.integrityFlag.findUnique({ where: { attemptId: id } })).toBeNull();
  }, 60_000);

  it("does not flag on context alone, however much of it there is", async () => {
    const id = await attempt("context");
    await event(id, "MULTI_MONITOR", { atMs: 0, seq: 1 });
    await event(id, "DEVTOOLS_HEURISTIC", { atMs: 1_000, seq: 2 });
    await event(id, "IDLE_GAP", { atMs: 2_000, durationMs: 120_000, seq: 3 });

    const result = await flagAttemptIfNeeded(id);
    expect(result.triage.contextPoints).toBeGreaterThan(0);
    expect(result.triage.substantivePoints).toBe(0);
    expect(result.triage.band).toBe("NONE");
    expect(result.flagged).toBe(false);
  }, 60_000);

  it("flags a sitting with substantive signals, withholds the result, and sets the 72-hour deadline", async () => {
    const id = await attempt("pasted");
    // Three big pastes from outside the editor, and a two-minute absence.
    await event(id, "EXTERNAL_PASTE", { atMs: 10_000, size: 900, seq: 1 });
    await event(id, "EXTERNAL_PASTE", { atMs: 20_000, size: 700, seq: 2 });
    await event(id, "EXTERNAL_PASTE", { atMs: 30_000, size: 650, seq: 3 });
    await event(id, "FOCUS_LOSS", { atMs: 40_000, durationMs: 130_000, seq: 4 });

    const result = await flagAttemptIfNeeded(id);
    expect(result.flagged).toBe(true);
    expect(result.triage.band).not.toBe("NONE");

    const flag = await db.integrityFlag.findUniqueOrThrow({ where: { attemptId: id } });
    expect(flag.status).toBe("OPEN");
    // The one automatic consequence, and the whole of it.
    expect(flag.withheld).toBe(true);
    expect(flag.resolvedAt).toBeNull();
    const hours = (flag.reviewDeadline.getTime() - flag.flaggedAt.getTime()) / 3_600_000;
    expect(hours).toBeCloseTo(72, 0);
    /**
     * Counts and sentences, never content. Asserted as a closed set of keys
     * rather than by looking for suspicious words: `contextOnly` contains
     * "text", which is how the first version of this test fooled itself.
     */
    const contributions = flag.signals as Array<Record<string, unknown>>;
    expect(contributions.length).toBeGreaterThan(0);
    for (const contribution of contributions) {
      for (const key of Object.keys(contribution)) {
        expect(["kind", "points", "contextOnly", "note", "exempt", "meta"]).toContain(key);
      }
      // A note is a sentence about shape: "3 pastes of 200+ characters".
      expect(typeof contribution.note).toBe("string");
      expect((contribution.note as string).length).toBeLessThan(200);
    }

    // And the student's own record says what happened, in the audit log.
    const entry = await db.auditLog.findFirst({
      where: { action: "integrity.flag.raised", entityId: flag.id },
      select: { actorId: true, metadata: true },
    });
    expect(entry).not.toBeNull();
    // Nobody raised it: it is automatic, and the row says so with a null actor.
    expect(entry!.actorId).toBeNull();
  }, 60_000);

  it("is idempotent: banding twice does not raise a second flag", async () => {
    const id = await attempt("twice");
    await event(id, "EXTERNAL_PASTE", { atMs: 10_000, size: 900, seq: 1 });
    await event(id, "EXTERNAL_PASTE", { atMs: 20_000, size: 900, seq: 2 });
    await event(id, "EXTERNAL_PASTE", { atMs: 30_000, size: 900, seq: 3 });

    const first = await flagAttemptIfNeeded(id);
    const second = await flagAttemptIfNeeded(id);
    expect(first.flagged).toBe(true);
    expect(second.flagged).toBe(true);
    expect(second.flagId).toBe(first.flagId);
    expect(await db.integrityFlag.count({ where: { attemptId: id } })).toBe(1);
  }, 60_000);

  it("never touches the score, the attempt's status or the account", async () => {
    const id = await attempt("ceiling");
    await event(id, "EXTERNAL_PASTE", { atMs: 10_000, size: 1_200, seq: 1 });
    await event(id, "EXTERNAL_PASTE", { atMs: 20_000, size: 1_200, seq: 2 });
    await event(id, "EXTERNAL_PASTE", { atMs: 30_000, size: 1_200, seq: 3 });
    await event(id, "FOCUS_LOSS", { atMs: 40_000, durationMs: 200_000, seq: 4 });

    const before = await db.assessmentAttempt.findUniqueOrThrow({
      where: { id },
      select: { status: true, totalScore: true, userId: true },
    });
    await flagAttemptIfNeeded(id);
    const after = await db.assessmentAttempt.findUniqueOrThrow({
      where: { id },
      select: { status: true, totalScore: true },
    });
    expect(after.status).toBe(before.status);
    expect(after.totalScore).toBe(before.totalScore);
    const account = await db.user.findUniqueOrThrow({ where: { id: before.userId }, select: { status: true } });
    expect(account.status).toBe("ACTIVE");
  }, 60_000);
});
