import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Starting a sitting: containment, and the hall it is checked against
 * (Phase 12s), against a real PostgreSQL.
 *
 * Two defects are pinned here, and the second one is why the first was
 * worth writing a test for rather than a comment.
 *
 * 1. `startOrResumeAttempt` never checked containment. `guardAttempt` does,
 *    on every request a sitting makes — but not on the one that CREATES it.
 *    So a candidate who pressed Start from the wrong network, or in an
 *    ordinary browser instead of Safe Exam Browser, got a sitting: the row
 *    was written, the clock started, an attempt was spent, and the very
 *    next request refused it. On a paper with `maxAttempts: 1` that is the
 *    whole paper, lost to a check that was always going to fail.
 *
 * 2. Nothing in the application ever wrote `AssessmentAttempt.examSessionId`.
 *    `checkContainment` tests the CIDR allowlist only when that column is
 *    not null — correctly, since an unseated candidate has no hall to be
 *    inside — so the allowlist never ran ONCE, on any request, for any
 *    sitting. `docs/PROCTORING.md` §4 lists it among the controls that
 *    actually enforce and says it is "re-verified on every heartbeat"; it
 *    was re-verified against null. The hall's own roster page reads
 *    `where: { examSessionId }` too, so every invigilator saw an empty room.
 *
 * The unit tests for containment pass `examSessionId: "sess_1"` as a
 * fixture, which is why they were green throughout: they test the function,
 * and the function was right. What was missing was anybody writing the
 * column it reads. So this file drives the real `startOrResumeAttempt`
 * against a real database and then LOOKS AT THE ROW.
 *
 * Opt-in: RECX_DB_TESTS=1.
 */

const ENABLED = process.env.RECX_DB_TESTS === "1";
const URL_ = () => process.env.RECX_TEST_DATABASE_URL ?? "postgresql://recx:recx-dev-only@127.0.0.1:5433/recx_test";

vi.hoisted(() => {
  if (process.env.RECX_DB_TESTS === "1") {
    process.env.DATABASE_URL =
      process.env.RECX_TEST_DATABASE_URL ?? "postgresql://recx:recx-dev-only@127.0.0.1:5433/recx_test";
  }
});

/** Where the candidate is sitting, which the allowlist is compared against. */
const where = vi.hoisted(() => ({ ip: "10.12.3.4" as string | null }));

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "user-agent": "exam-test" }),
  cookies: async () => ({ get: () => undefined, set: () => undefined, delete: () => undefined }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined, revalidateTag: () => undefined }));

/**
 * The address, mocked rather than forged through headers: `requestIp` reads
 * forwarding headers only when TRUST_PROXY is set, and a test that had to
 * turn that on would be testing the proxy policy instead of this.
 */
vi.mock("@/lib/ip", async () => {
  const { createHash } = await import("node:crypto");
  const hash = (value: string) => createHash("sha256").update(`${value}:test-pepper`).digest("hex");
  return {
    requestIp: async () => where.ip,
    requestIpHash: async () => (where.ip === null ? null : hash(where.ip)),
    hashIp: (ip: string) => hash(ip),
    hashUserAgent: (ua: string) => hash(ua),
  };
});

/**
 * The device assertion, which LAB_SUPERVISED requires and which happened in
 * its own earlier request. Mocked to a seated candidate; refusing for want
 * of a device is `needs_device` and is not what this file is about.
 */
vi.mock("@/lib/exam/webauthn", () => ({
  freshAssertionFor: async () => ({ deviceId: null, isLoaner: false }),
  consumeLoaner: async () => undefined,
}));

describe.skipIf(!ENABLED)("starting a sitting, against recx_test", () => {
  const tag = `start-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
  let db: import("@recx/db").Db;
  let start: typeof import("@/lib/exam/start");
  let actorId = "";
  let studentId = "";
  let assessmentId = "";
  let hallId = "";

  const request = () => new Request("https://code.rec.edu.in/api/exam/start/" + tag, { method: "POST" });

  /** A hall that is live now, with the allowlist the test needs. */
  async function hall(allowedCidrs: string[]): Promise<string> {
    const row = await db.examSession.create({
      data: {
        assessmentId,
        label: "Lab 3",
        startsAt: new Date(Date.now() - 60_000),
        endsAt: new Date(Date.now() + 3_600_000),
        allowedCidrs,
        createdById: actorId,
      },
      select: { id: true },
    });
    return row.id;
  }

  async function clearSittings(): Promise<void> {
    /**
     * A sitting is never deleted by the application — `AssessmentAttempt`
     * carries a trigger that says so, and it refused the first draft of this
     * teardown, which is the trigger doing its job. So the guard comes off
     * for the delete and goes straight back on, the same way
     * `student-exposure.db.test.ts` does it, and the audit rows that point at
     * the sitting go first.
     */
    await db.$executeRawUnsafe(
      `DELETE FROM "AuditLog" WHERE "entityType" = 'AssessmentAttempt' AND "entityId" IN (SELECT id FROM "AssessmentAttempt" WHERE "assessmentId" = $1)`,
      assessmentId,
    );
    await db.$executeRawUnsafe(`ALTER TABLE "public"."AssessmentAttempt" DISABLE TRIGGER "AssessmentAttempt_machine"`);
    try {
      await db.$executeRawUnsafe(`DELETE FROM "AssessmentAttempt" WHERE "assessmentId" = $1`, assessmentId);
    } finally {
      await db.$executeRawUnsafe(`ALTER TABLE "public"."AssessmentAttempt" ENABLE TRIGGER "AssessmentAttempt_machine"`);
    }
  }

  beforeAll(async () => {
    const { createPrismaClient } = await import("@recx/db");
    db = createPrismaClient({ url: URL_(), log: [] });
    start = await import("@/lib/exam/start");

    const staff = await db.user.create({
      data: {
        collegeId: `${tag}-staff`,
        email: `${tag}-staff@rec-code.example`,
        firstName: "Hall",
        lastName: "Keeper",
        handle: `${tag}-staff`,
        role: "ADMIN",
      },
      select: { id: true },
    });
    actorId = staff.id;
    const student = await db.user.create({
      data: {
        collegeId: `${tag}-stu`,
        email: `${tag}-stu@rec-code.example`,
        firstName: "Seated",
        lastName: "Candidate",
        handle: `${tag}-stu`,
        role: "STUDENT",
      },
      select: { id: true },
    });
    studentId = student.id;

    // A paper of one multiple-choice question: sittable (12r), and it needs
    // no problem version, so the setup here is the sitting and nothing else.
    const assessment = await db.assessment.create({
      data: {
        slug: tag,
        title: "A supervised paper",
        instructions: "Answer it.",
        status: "OPEN",
        proctorMode: "LAB_SUPERVISED",
        opensAt: new Date(Date.now() - 3_600_000),
        closesAt: new Date(Date.now() + 3_600_000),
        durationSec: 3_600,
        maxAttempts: 1,
        createdById: actorId,
      } as never,
      select: { id: true },
    });
    assessmentId = assessment.id;
    await db.assessmentMcq.create({
      data: {
        assessmentId,
        position: 1,
        stem: "Which of these is a stable sort?",
        options: ["Quicksort", "Merge sort"],
        correctIndex: 1,
        points: 1,
      } as never,
      select: { id: true },
    });
    hallId = await hall(["10.12.0.0/16"]);
  }, 90_000);

  afterAll(async () => {
    if (!db) return;
    try {
      await clearSittings();
      await db.$executeRawUnsafe(`DELETE FROM "ExamSession" WHERE "assessmentId" = $1`, assessmentId);
      await db.$executeRawUnsafe(`DELETE FROM "AssessmentMcq" WHERE "assessmentId" = $1`, assessmentId);
      // Same as above: a published paper is archived, not deleted, so the
      // guard comes off only for this teardown.
      await db.$executeRawUnsafe(
        `ALTER TABLE "public"."Assessment" DISABLE TRIGGER "Assessment_published_immutable"`,
      );
      try {
        await db.$executeRawUnsafe(`DELETE FROM "Assessment" WHERE id = $1`, assessmentId);
      } finally {
        await db.$executeRawUnsafe(
          `ALTER TABLE "public"."Assessment" ENABLE TRIGGER "Assessment_published_immutable"`,
        );
      }
      await db.user.deleteMany({ where: { id: { in: [actorId, studentId] } } });
    } finally {
      await db.$disconnect();
    }
  }, 90_000);

  beforeEach(async () => {
    where.ip = "10.12.3.4";
    await clearSittings();
  });

  it("records the hall, which is what makes the allowlist apply to this sitting at all", async () => {
    const result = await start.startOrResumeAttempt({
      request: request(),
      slug: tag,
      userId: studentId,
      sessionId: null,
    });
    expect(result.ok, result.ok ? "" : result.message).toBe(true);
    const row = await db.assessmentAttempt.findFirstOrThrow({
      where: { assessmentId, userId: studentId },
      select: { examSessionId: true, proctorMode: true },
    });
    // The regression: this was null on every attempt ever created, so
    // `checkContainment` skipped the allowlist on every request.
    expect(row.examSessionId).toBe(hallId);
  });

  it("refuses a candidate outside the hall's network WITHOUT spending an attempt", async () => {
    where.ip = "203.0.113.9";
    const result = await start.startOrResumeAttempt({
      request: request(),
      slug: tag,
      userId: studentId,
      sessionId: null,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal).toBe("outside_allowlist");
    // The sentence a candidate reads sends them to the invigilator, and does
    // not accuse them of anything.
    expect(result.message).toMatch(/exam hall network/i);
    // The point of the fix: nothing was created, so the one attempt this
    // paper allows is still theirs.
    expect(await db.assessmentAttempt.count({ where: { assessmentId, userId: studentId } })).toBe(0);
  });

  it("still refuses on a second press, rather than letting the next one through", async () => {
    where.ip = "203.0.113.9";
    for (let i = 0; i < 3; i += 1) {
      const result = await start.startOrResumeAttempt({
        request: request(),
        slug: tag,
        userId: studentId,
        sessionId: null,
      });
      expect(result.ok).toBe(false);
    }
    expect(await db.assessmentAttempt.count({ where: { assessmentId, userId: studentId } })).toBe(0);
  });

  it("refuses to RESUME from outside the hall, instead of admitting and cutting off a second later", async () => {
    const started = await start.startOrResumeAttempt({
      request: request(),
      slug: tag,
      userId: studentId,
      sessionId: null,
    });
    expect(started.ok).toBe(true);
    where.ip = "203.0.113.9";
    const again = await start.startOrResumeAttempt({
      request: request(),
      slug: tag,
      userId: studentId,
      sessionId: null,
    });
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.refusal).toBe("outside_allowlist");
    // And the sitting is untouched: refusing to let somebody back in is not
    // the same as ending their attempt, which only the guard may do.
    const row = await db.assessmentAttempt.findFirstOrThrow({
      where: { assessmentId, userId: studentId },
      select: { status: true },
    });
    expect(row.status).toBe("IN_PROGRESS");
  });

  it("seats a sitting on resume if it began before the hall existed", async () => {
    // Which is every sitting started before this slice, and any sitting an
    // invigilator seats after a candidate has begun.
    const started = await start.startOrResumeAttempt({
      request: request(),
      slug: tag,
      userId: studentId,
      sessionId: null,
    });
    expect(started.ok).toBe(true);
    await db.$executeRawUnsafe(
      `UPDATE "AssessmentAttempt" SET "examSessionId" = NULL WHERE "assessmentId" = $1`,
      assessmentId,
    );
    const resumed = await start.startOrResumeAttempt({
      request: request(),
      slug: tag,
      userId: studentId,
      sessionId: null,
    });
    expect(resumed.ok).toBe(true);
    if (resumed.ok) expect(resumed.resumed).toBe(true);
    const row = await db.assessmentAttempt.findFirstOrThrow({
      where: { assessmentId, userId: studentId },
      select: { examSessionId: true },
    });
    expect(row.examSessionId).toBe(hallId);
  });

  it("does not move a seated sitting to another hall", async () => {
    // A hall is a fact about where somebody sat. A sitting that could be
    // re-pointed could be re-pointed at a room whose allowlist admits
    // anyone, which is the one thing the allowlist exists to prevent.
    const started = await start.startOrResumeAttempt({
      request: request(),
      slug: tag,
      userId: studentId,
      sessionId: null,
    });
    expect(started.ok).toBe(true);
    const other = await hall(["10.12.0.0/16"]);
    try {
      const resumed = await start.startOrResumeAttempt({
        request: request(),
        slug: tag,
        userId: studentId,
        sessionId: null,
      });
      expect(resumed.ok).toBe(true);
      const row = await db.assessmentAttempt.findFirstOrThrow({
        where: { assessmentId, userId: studentId },
        select: { examSessionId: true },
      });
      expect([hallId, other]).toContain(row.examSessionId);
      expect(row.examSessionId).toBe(hallId);
    } finally {
      await db.$executeRawUnsafe(`DELETE FROM "ExamSession" WHERE id = $1`, other);
    }
  });

  it("tells a candidate an unopened paper is unopened, even when they are also outside the hall", async () => {
    /**
     * Both refusals are true at once, and only one of them is the reason.
     * A candidate reading "this assessment can only be sat from the exam
     * hall network" about a paper that is not open yet would go and find a
     * lab. So the paper-level facts — open, in its window, has questions,
     * has an attempt left — are checked BEFORE containment, which is also
     * why they are cheap: no request state and no hall lookup.
     *
     * A DRAFT paper of its own, because the window of a published one is
     * fixed by a trigger (which refused the first draft of this test, and
     * was right to).
     */
    const draft = await db.assessment.create({
      data: {
        slug: `${tag}-draft`,
        title: "Not open yet",
        instructions: "Later.",
        status: "DRAFT",
        proctorMode: "LAB_SUPERVISED",
        opensAt: new Date(Date.now() + 86_400_000),
        closesAt: new Date(Date.now() + 90_000_000),
        durationSec: 3_600,
        createdById: actorId,
      } as never,
      select: { id: true },
    });
    const room = await db.examSession.create({
      data: {
        assessmentId: draft.id,
        label: "Lab 4",
        startsAt: new Date(Date.now() - 60_000),
        endsAt: new Date(Date.now() + 3_600_000),
        // An allowlist this candidate is outside of, so containment would
        // refuse if it were asked first.
        allowedCidrs: ["10.12.0.0/16"],
        createdById: actorId,
      },
      select: { id: true },
    });
    where.ip = "203.0.113.9";
    try {
      const result = await start.startOrResumeAttempt({
        request: request(),
        slug: `${tag}-draft`,
        userId: studentId,
        sessionId: null,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.refusal).toBe("not_open");
    } finally {
      await db.$executeRawUnsafe(`DELETE FROM "ExamSession" WHERE id = $1`, room.id);
      await db.$executeRawUnsafe(`DELETE FROM "Assessment" WHERE id = $1`, draft.id);
    }
  });

  it("refuses when there is no hall at all, which is the older rule and still right", async () => {
    await db.$executeRawUnsafe(`UPDATE "ExamSession" SET "endsAt" = now() - interval '1 minute' WHERE id = $1`, hallId);
    try {
      const result = await start.startOrResumeAttempt({
        request: request(),
        slug: tag,
        userId: studentId,
        sessionId: null,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.refusal).toBe("needs_lab_session");
      expect(await db.assessmentAttempt.count({ where: { assessmentId, userId: studentId } })).toBe(0);
    } finally {
      await db.$executeRawUnsafe(
        `UPDATE "ExamSession" SET "endsAt" = now() + interval '1 hour' WHERE id = $1`,
        hallId,
      );
    }
  });
});
