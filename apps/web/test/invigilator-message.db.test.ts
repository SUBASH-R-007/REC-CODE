import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * An invigilator's message actually reaching the candidate (Phase 12v),
 * against a real PostgreSQL.
 *
 * `messageCandidate` has existed since Phase 6e. The desk says "Message
 * sent.", the hall page counts what is unacknowledged so the same thing is
 * not said twice, and the dialog the invigilator reads promises the
 * candidate "must acknowledge it before continuing". The heartbeat route
 * answered with a hard-coded `pendingInvigilatorMessages: []` for five
 * phases. Every message was written to the database and delivered to
 * nobody.
 *
 * So this drives the real `applyHeartbeat` against a real row and looks at
 * what comes back, and then at what the acknowledgement writes. The parts
 * worth pinning are the ones that are easy to get subtly wrong:
 *
 *   - an acknowledgement is scoped to the ATTEMPT, not just to the ids a
 *     client sent, or one candidate's client could clear another's message;
 *   - acknowledging and reading happen in that order on the same beat, so
 *     nobody is asked twice about something they just answered;
 *   - it is idempotent, because the client resends until the server stops
 *     calling the message pending.
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

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "user-agent": "exam-test" }),
  cookies: async () => ({ get: () => undefined, set: () => undefined, delete: () => undefined }),
}));

describe.skipIf(!ENABLED)("an invigilator's message, against recx_test", () => {
  const tag = `msg-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
  let db: import("@recx/db").Db;
  let heartbeat: typeof import("@/lib/exam/heartbeat");
  let staffId = "";
  let studentId = "";
  let otherStudentId = "";
  let assessmentId = "";
  let attemptId = "";
  let otherAttemptId = "";

  /** A sitting, created in SQL so the write-once guard has nothing to say. */
  async function sitting(userId: string, attemptNumber: number): Promise<string> {
    const row = await db.assessmentAttempt.create({
      data: {
        assessmentId,
        userId,
        attemptNumber,
        status: "IN_PROGRESS",
        seed: 1,
        startedAt: new Date(Date.now() - 60_000),
        expiresAt: new Date(Date.now() + 3_600_000),
        layout: { v: 1, questions: [] } as never,
        tokenHash: randomBytes(16).toString("hex"),
        proctorMode: "ADVISORY",
      } as never,
      select: { id: true },
    });
    return row.id;
  }

  /** The guard the heartbeat applier takes, for a live sitting. */
  async function guardFor(id: string) {
    const attempt = await db.assessmentAttempt.findUniqueOrThrow({ where: { id } });
    return {
      ok: true as const,
      attempt,
      status: "IN_PROGRESS" as const,
      msRemaining: 3_600_000,
      now: new Date(),
      sessionNotice: null,
      sessionId: null,
    };
  }

  const say = (id: string, body: string, requiresAck = true) =>
    db.invigilatorMessage.create({
      data: { attemptId: id, body, requiresAck, sentById: staffId },
      select: { id: true },
    });

  beforeAll(async () => {
    const { createPrismaClient } = await import("@recx/db");
    db = createPrismaClient({ url: URL_(), log: [] });
    heartbeat = await import("@/lib/exam/heartbeat");

    const staff = await db.user.create({
      data: {
        collegeId: `${tag}-staff`,
        email: `${tag}-staff@rec-code.example`,
        firstName: "Invigilator",
        lastName: "One",
        handle: `${tag}-staff`,
        role: "ADMIN",
      },
      select: { id: true },
    });
    staffId = staff.id;
    for (const [which, slot] of [
      ["a", (id: string) => (studentId = id)],
      ["b", (id: string) => (otherStudentId = id)],
    ] as const) {
      const user = await db.user.create({
        data: {
          collegeId: `${tag}-${which}`,
          email: `${tag}-${which}@rec-code.example`,
          firstName: "Seated",
          lastName: which.toUpperCase(),
          handle: `${tag}-${which}`,
          role: "STUDENT",
        },
        select: { id: true },
      });
      slot(user.id);
    }

    const assessment = await db.assessment.create({
      data: {
        slug: tag,
        title: "A watched paper",
        instructions: "Answer it.",
        status: "OPEN",
        proctorMode: "ADVISORY",
        opensAt: new Date(Date.now() - 3_600_000),
        closesAt: new Date(Date.now() + 3_600_000),
        durationSec: 3_600,
        createdById: staffId,
      } as never,
      select: { id: true },
    });
    assessmentId = assessment.id;
    attemptId = await sitting(studentId, 1);
    otherAttemptId = await sitting(otherStudentId, 1);
  }, 90_000);

  afterAll(async () => {
    if (!db) return;
    try {
      await forget();
      await db.$executeRawUnsafe(
        `DELETE FROM "ProctorEvent" WHERE "attemptId" IN (SELECT id FROM "AssessmentAttempt" WHERE "assessmentId" = $1)`,
        assessmentId,
      );
      // A sitting is never deleted by the application; the guard comes off
      // only for this teardown.
      await db.$executeRawUnsafe(`ALTER TABLE "public"."AssessmentAttempt" DISABLE TRIGGER "AssessmentAttempt_machine"`);
      try {
        await db.$executeRawUnsafe(`DELETE FROM "AssessmentAttempt" WHERE "assessmentId" = $1`, assessmentId);
      } finally {
        await db.$executeRawUnsafe(`ALTER TABLE "public"."AssessmentAttempt" ENABLE TRIGGER "AssessmentAttempt_machine"`);
      }
      await db.$executeRawUnsafe(`ALTER TABLE "public"."Assessment" DISABLE TRIGGER "Assessment_published_immutable"`);
      try {
        await db.$executeRawUnsafe(`DELETE FROM "Assessment" WHERE id = $1`, assessmentId);
      } finally {
        await db.$executeRawUnsafe(`ALTER TABLE "public"."Assessment" ENABLE TRIGGER "Assessment_published_immutable"`);
      }
      await db.user.deleteMany({ where: { id: { in: [staffId, studentId, otherStudentId] } } });
    } finally {
      await db.$disconnect();
    }
  }, 90_000);

  /**
   * A message is append-only as well — `InvigilatorMessage_write_once`
   * refused the first draft of this cleanup, which is the trigger being
   * right: what an invigilator said to a candidate is part of the record of
   * the sitting. So the guard comes off only for the teardown.
   */
  async function forget(): Promise<void> {
    await db.$executeRawUnsafe(
      `ALTER TABLE "public"."InvigilatorMessage" DISABLE TRIGGER "InvigilatorMessage_write_once"`,
    );
    try {
      await db.$executeRawUnsafe(
        `DELETE FROM "InvigilatorMessage" WHERE "attemptId" IN ($1, $2)`,
        attemptId,
        otherAttemptId,
      );
    } finally {
      await db.$executeRawUnsafe(
        `ALTER TABLE "public"."InvigilatorMessage" ENABLE TRIGGER "InvigilatorMessage_write_once"`,
      );
    }
  }

  beforeEach(forget);

  it("arrives on the next beat, oldest first", async () => {
    const first = await say(attemptId, "Please raise your hand.");
    const second = await say(attemptId, "Your clock has been extended.");
    const outcome = await heartbeat.applyHeartbeat(await guardFor(attemptId), { clientSeq: 1 }, {
      ipHash: null,
      uaHash: null,
    });
    expect(outcome.messages.map((m) => m.id)).toEqual([first.id, second.id]);
    expect(outcome.messages[0]?.body).toBe("Please raise your hand.");
    expect(outcome.messages[0]?.requiresAck).toBe(true);
  });

  it("stops arriving once the candidate has acknowledged it, and is recorded", async () => {
    const sent = await say(attemptId, "Please raise your hand.");
    const acked = await heartbeat.applyHeartbeat(
      await guardFor(attemptId),
      { clientSeq: 2, acknowledgedMessageIds: [sent.id] },
      { ipHash: null, uaHash: null },
    );
    // Acknowledged BEFORE the pending list is read, so nobody is asked
    // again about something they just answered on the same beat.
    expect(acked.messages).toEqual([]);
    const row = await db.invigilatorMessage.findUniqueOrThrow({
      where: { id: sent.id },
      select: { acknowledgedAt: true },
    });
    expect(row.acknowledgedAt).not.toBeNull();
  });

  it("is idempotent, because the client resends until the server stops asking", async () => {
    const sent = await say(attemptId, "Please raise your hand.");
    await heartbeat.applyHeartbeat(
      await guardFor(attemptId),
      { clientSeq: 3, acknowledgedMessageIds: [sent.id] },
      { ipHash: null, uaHash: null },
    );
    const first = await db.invigilatorMessage.findUniqueOrThrow({
      where: { id: sent.id },
      select: { acknowledgedAt: true },
    });
    await heartbeat.applyHeartbeat(
      await guardFor(attemptId),
      { clientSeq: 4, acknowledgedMessageIds: [sent.id] },
      { ipHash: null, uaHash: null },
    );
    const again = await db.invigilatorMessage.findUniqueOrThrow({
      where: { id: sent.id },
      select: { acknowledgedAt: true },
    });
    // The recorded time is the first one: a replay must not move it.
    expect(again.acknowledgedAt?.toISOString()).toBe(first.acknowledgedAt?.toISOString());
  });

  it("cannot be acknowledged by another candidate's client", async () => {
    /**
     * The ids are cuids a client sends us. Acknowledging by id alone would
     * let one candidate clear a message meant for somebody else — and the
     * hall page would then show it as read.
     */
    const theirs = await say(otherAttemptId, "Stop writing, please.");
    await heartbeat.applyHeartbeat(
      await guardFor(attemptId),
      { clientSeq: 5, acknowledgedMessageIds: [theirs.id] },
      { ipHash: null, uaHash: null },
    );
    const row = await db.invigilatorMessage.findUniqueOrThrow({
      where: { id: theirs.id },
      select: { acknowledgedAt: true },
    });
    expect(row.acknowledgedAt).toBeNull();
    // And it is still waiting for the candidate it was sent to.
    const outcome = await heartbeat.applyHeartbeat(await guardFor(otherAttemptId), { clientSeq: 6 }, {
      ipHash: null,
      uaHash: null,
    });
    expect(outcome.messages.map((m) => m.id)).toEqual([theirs.id]);
  });

  it("shows at most a handful, because a pile of them is not a conversation", async () => {
    for (let i = 0; i < 7; i += 1) await say(attemptId, `Message number ${i}.`);
    const outcome = await heartbeat.applyHeartbeat(await guardFor(attemptId), { clientSeq: 7 }, {
      ipHash: null,
      uaHash: null,
    });
    expect(outcome.messages).toHaveLength(5);
  });

  it("delivers a message that needs no acknowledgement too", async () => {
    const sent = await say(attemptId, "Ten minutes left.", false);
    const outcome = await heartbeat.applyHeartbeat(await guardFor(attemptId), { clientSeq: 8 }, {
      ipHash: null,
      uaHash: null,
    });
    expect(outcome.messages.map((m) => m.id)).toEqual([sent.id]);
    expect(outcome.messages[0]?.requiresAck).toBe(false);
  });
});
