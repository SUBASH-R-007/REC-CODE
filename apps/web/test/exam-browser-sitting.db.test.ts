import { createHmac, randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The sitting a KIOSK_RECX paper is sat in (Phase 14h), against a real
 * PostgreSQL.
 *
 * This file exists for the same reason `exam-start-hall.db.test.ts` does,
 * and pins the same shape of defect one phase later. `checkContainment`
 * reads the expected sitting off `AssessmentAttempt.examBrowserSittingId`,
 * and **nothing in the application ever wrote that column.** Every unit test
 * passed a sitting id as a fixture, so they were all green, and the function
 * they tested was right. What was missing was anybody writing the column it
 * reads — so a `KIOSK_RECX` paper was refused by the very request trying to
 * begin it, `unknown_sitting`, from a correctly signed exam browser.
 *
 * And nothing ever ended a sitting, so no session issued to one was ever
 * revoked.
 *
 * So this drives the real `exchangeLaunchToken` and the real
 * `startOrResumeAttempt` against a real database, with real attestation
 * headers, and then LOOKS AT THE ROWS.
 *
 * Opt-in: RECX_DB_TESTS=1.
 */

const ENABLED = process.env.RECX_DB_TESTS === "1";
const URL_ = () => process.env.RECX_TEST_DATABASE_URL ?? "postgresql://recx:recx-dev-only@127.0.0.1:5433/recx_test";

vi.hoisted(() => {
  if (process.env.RECX_DB_TESTS === "1") {
    process.env.DATABASE_URL =
      process.env.RECX_TEST_DATABASE_URL ?? "postgresql://recx:recx-dev-only@127.0.0.1:5433/recx_test";
    // `deriveSittingKey` reads the deployment secret through `env()`, which
    // validates the whole server environment, so this file needs the same
    // minimum every other database test here sets.
    process.env.IP_HASH_PEPPER ??= "exam-browser-sitting-test-pepper";
  }
});

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "user-agent": "exam-test" }),
  cookies: async () => ({ get: () => undefined, set: () => undefined, delete: () => undefined }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined, revalidateTag: () => undefined }));

vi.mock("@/lib/ip", async () => {
  const { createHash } = await import("node:crypto");
  const hash = (value: string) => createHash("sha256").update(`${value}:test-pepper`).digest("hex");
  return {
    requestIp: async () => "10.12.3.4",
    requestIpHash: async () => hash("10.12.3.4"),
    hashIp: (ip: string) => hash(ip),
    hashUserAgent: (ua: string) => hash(ua),
  };
});

vi.mock("@/lib/exam/webauthn", () => ({
  freshAssertionFor: async () => ({ deviceId: null, isLoaner: false }),
  consumeLoaner: async () => undefined,
}));

describe.skipIf(!ENABLED)("a KIOSK_RECX sitting, against recx_test", () => {
  const tag = `recx-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
  const START_URL = `https://code.rec.edu.in/api/exam/start/${tag}`;

  let db: import("@recx/db").Db;
  let start: typeof import("@/lib/exam/start");
  let browser: typeof import("@/lib/exam/exam-browser");
  let shared: typeof import("@recx/shared");

  let actorId = "";
  let studentId = "";
  let otherStudentId = "";
  let assessmentId = "";

  /**
   * Mint a launch token and spend it, exactly as the readiness page and the
   * application do. Returns what the application would then be holding.
   */
  async function liveSitting(userId: string): Promise<{ sittingId: string; sittingKey: string }> {
    const { token } = await browser.mintLaunchToken({ userId, assessmentId });
    const result = await browser.exchangeLaunchToken(token);
    if (!result.ok) throw new Error(`exchange failed: ${result.reason}`);
    return { sittingId: result.sittingId, sittingKey: result.sittingKey };
  }

  /** A start request carrying the attestation a real exam browser would send. */
  function signedRequest(sitting: { sittingId: string; sittingKey: string }): Request {
    const nonce = randomBytes(16).toString("base64url");
    const timestamp = Date.now();
    const signature = createHmac("sha256", sitting.sittingKey)
      .update(
        shared.examBrowserSigningInput({
          method: "POST",
          url: START_URL,
          nonce,
          timestamp,
          sittingId: sitting.sittingId,
        }),
      )
      .digest("hex");
    return new Request(START_URL, {
      method: "POST",
      headers: {
        [shared.RECX_PROTOCOL_HEADER]: String(shared.EXAM_BROWSER_PROTOCOL_VERSION),
        [shared.RECX_VERSION_HEADER]: "1.0.0",
        [shared.RECX_SITTING_HEADER]: sitting.sittingId,
        [shared.RECX_NONCE_HEADER]: nonce,
        [shared.RECX_TIMESTAMP_HEADER]: String(timestamp),
        [shared.RECX_SIGNATURE_HEADER]: signature,
      },
    });
  }

  async function clearSittings(): Promise<void> {
    await db.$executeRawUnsafe(
      `DELETE FROM "AuditLog" WHERE "entityType" = 'AssessmentAttempt' AND "entityId" IN (SELECT id FROM "AssessmentAttempt" WHERE "assessmentId" = $1)`,
      assessmentId,
    );
    // An attempt row is never deleted by the application; the trigger says
    // so, and it refused the first draft of this teardown.
    await db.$executeRawUnsafe(`ALTER TABLE "public"."AssessmentAttempt" DISABLE TRIGGER "AssessmentAttempt_machine"`);
    try {
      await db.$executeRawUnsafe(`DELETE FROM "AssessmentAttempt" WHERE "assessmentId" = $1`, assessmentId);
    } finally {
      await db.$executeRawUnsafe(`ALTER TABLE "public"."AssessmentAttempt" ENABLE TRIGGER "AssessmentAttempt_machine"`);
    }
    // The sessions before the sittings that point at them: deleting a
    // sitting first would leave a live session nobody can account for.
    const sittings = await db.examBrowserSitting.findMany({
      where: { assessmentId },
      select: { sessionId: true },
    });
    const sessionIds = sittings.map((row) => row.sessionId).filter((id): id is string => id !== null);
    if (sessionIds.length > 0) await db.session.deleteMany({ where: { id: { in: sessionIds } } });
    await db.examBrowserSitting.deleteMany({ where: { assessmentId } });
  }

  beforeAll(async () => {
    const { createPrismaClient } = await import("@recx/db");
    db = createPrismaClient({ url: URL_(), log: [] });
    start = await import("@/lib/exam/start");
    browser = await import("@/lib/exam/exam-browser");
    shared = await import("@recx/shared");

    const staff = await db.user.create({
      data: {
        collegeId: `${tag}-staff`,
        email: `${tag}-staff@rec-code.example`,
        firstName: "Paper",
        lastName: "Setter",
        handle: `${tag}-staff`,
        role: "ADMIN",
      },
      select: { id: true },
    });
    actorId = staff.id;

    for (const who of ["stu", "other"]) {
      const row = await db.user.create({
        data: {
          collegeId: `${tag}-${who}`,
          email: `${tag}-${who}@rec-code.example`,
          firstName: "Kiosk",
          lastName: who === "stu" ? "Candidate" : "Neighbour",
          handle: `${tag}-${who}`,
          role: "STUDENT",
        },
        select: { id: true },
      });
      if (who === "stu") studentId = row.id;
      else otherStudentId = row.id;
    }

    // One multiple-choice question: sittable, and it needs no problem
    // version, so the setup here is the sitting and nothing else.
    const assessment = await db.assessment.create({
      data: {
        slug: tag,
        title: "A paper sat in REC Exam Browser",
        instructions: "Answer it.",
        status: "OPEN",
        proctorMode: "KIOSK_RECX",
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
  }, 90_000);

  afterAll(async () => {
    if (!db) return;
    try {
      await clearSittings();
      await db.$executeRawUnsafe(`DELETE FROM "AssessmentMcq" WHERE "assessmentId" = $1`, assessmentId);
      await db.$executeRawUnsafe(`ALTER TABLE "public"."Assessment" DISABLE TRIGGER "Assessment_published_immutable"`);
      try {
        await db.$executeRawUnsafe(`DELETE FROM "Assessment" WHERE id = $1`, assessmentId);
      } finally {
        await db.$executeRawUnsafe(`ALTER TABLE "public"."Assessment" ENABLE TRIGGER "Assessment_published_immutable"`);
      }
      await db.user.deleteMany({ where: { id: { in: [actorId, studentId, otherStudentId] } } });
    } finally {
      await db.$disconnect();
    }
  }, 90_000);

  beforeEach(async () => {
    await clearSittings();
  });

  it("writes the sitting onto the attempt, which is the column containment reads", async () => {
    const sitting = await liveSitting(studentId);
    const result = await start.startOrResumeAttempt({
      request: signedRequest(sitting),
      slug: tag,
      userId: studentId,
      sessionId: null,
    });

    expect(result.ok, result.ok ? "" : result.message).toBe(true);
    const row = await db.assessmentAttempt.findFirstOrThrow({
      where: { assessmentId, userId: studentId },
      select: { examBrowserSittingId: true, proctorMode: true, status: true },
    });
    expect(row.examBrowserSittingId).toBe(sitting.sittingId);
    expect(row.proctorMode).toBe("KIOSK_RECX");
    expect(row.status).toBe("IN_PROGRESS");
  });

  it("refuses an ordinary browser, and spends no attempt doing it", async () => {
    /**
     * The refusal has to come BEFORE the row: a paper with
     * `maxAttempts: 1` would otherwise charge a candidate their only
     * attempt for pressing Start in the wrong browser (Phase 12s).
     */
    await liveSitting(studentId);
    const result = await start.startOrResumeAttempt({
      request: new Request(START_URL, { method: "POST" }),
      slug: tag,
      userId: studentId,
      sessionId: null,
    });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.refusal).toBe("recx_browser_required");
    expect(await db.assessmentAttempt.count({ where: { assessmentId } })).toBe(0);
  });

  it("refuses a sitting that belongs to the candidate at the next desk", async () => {
    /**
     * The signature is perfectly valid — it is made with that sitting's own
     * derived key. What refuses it is the ownership lookup: a sitting is
     * resolved only among those launched by THIS candidate for THIS paper,
     * so a header naming somebody else's never reaches the comparison.
     */
    const neighbour = await liveSitting(otherStudentId);
    const result = await start.startOrResumeAttempt({
      request: signedRequest(neighbour),
      slug: tag,
      userId: studentId,
      sessionId: null,
    });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.refusal).toBe("recx_browser_required");
    expect(await db.assessmentAttempt.count({ where: { assessmentId } })).toBe(0);
  });

  it("refuses a sitting whose launch token was never spent", async () => {
    // Minted but not exchanged: no application is holding a key for it, so
    // it is not a sitting anything may be sat in.
    const { token } = await browser.mintLaunchToken({ userId: studentId, assessmentId });
    expect(token.length).toBeGreaterThan(32);
    const unbound = await db.examBrowserSitting.findFirstOrThrow({
      where: { assessmentId, userId: studentId, boundAt: null },
      select: { id: true },
    });

    const result = await start.startOrResumeAttempt({
      request: signedRequest({ sittingId: unbound.id, sittingKey: browser.deriveSittingKey(unbound.id) }),
      slug: tag,
      userId: studentId,
      sessionId: null,
    });
    expect(result.ok === false && result.refusal).toBe("recx_browser_required");
  });

  it("follows a relaunch onto the new sitting, and ends the one left behind", async () => {
    /**
     * An exam browser that crashed is relaunched, which spends a new launch
     * token and mints a new sitting. The attempt has to follow: the old
     * sitting's key is held by a process that no longer exists. And the old
     * sitting is ended, because a signed-in window nothing is watching is
     * exactly what the session revocation is for.
     */
    const first = await liveSitting(studentId);
    await start.startOrResumeAttempt({
      request: signedRequest(first),
      slug: tag,
      userId: studentId,
      sessionId: null,
    });

    const second = await liveSitting(studentId);
    const resumed = await start.startOrResumeAttempt({
      request: signedRequest(second),
      slug: tag,
      userId: studentId,
      sessionId: null,
    });

    expect(resumed.ok, resumed.ok ? "" : resumed.message).toBe(true);
    expect(resumed.ok === true && resumed.resumed).toBe(true);

    const row = await db.assessmentAttempt.findFirstOrThrow({
      where: { assessmentId, userId: studentId },
      select: { examBrowserSittingId: true },
    });
    expect(row.examBrowserSittingId).toBe(second.sittingId);

    const old = await db.examBrowserSitting.findUniqueOrThrow({
      where: { id: first.sittingId },
      select: { endedAt: true, sessionId: true, sessionIssuedAt: true },
    });
    expect(old.endedAt).not.toBeNull();
    // Revoked, and the row still says there WAS one.
    expect(old.sessionId).toBeNull();
    expect(old.sessionIssuedAt).not.toBeNull();
  });

  it("revokes the attestation and the session when the sitting ends", async () => {
    const sitting = await liveSitting(studentId);
    await start.startOrResumeAttempt({
      request: signedRequest(sitting),
      slug: tag,
      userId: studentId,
      sessionId: null,
    });
    const before = await db.examBrowserSitting.findUniqueOrThrow({
      where: { id: sitting.sittingId },
      select: { sessionId: true },
    });
    expect(before.sessionId).not.toBeNull();

    await browser.endExamBrowserSitting(sitting.sittingId);

    const attempt = await db.assessmentAttempt.findFirstOrThrow({
      where: { assessmentId, userId: studentId },
      select: { examBrowserSittingId: true },
    });
    // Clearing this is what stops the key working: the containment check
    // compares against it and never loads the sitting row.
    expect(attempt.examBrowserSittingId).toBeNull();

    const after = await db.examBrowserSitting.findUniqueOrThrow({
      where: { id: sitting.sittingId },
      select: { endedAt: true, sessionId: true, sessionIssuedAt: true },
    });
    expect(after.endedAt).not.toBeNull();
    expect(after.sessionId).toBeNull();
    expect(after.sessionIssuedAt).not.toBeNull();
    // And the session is gone from the database, not merely unpointed.
    expect(await db.session.count({ where: { id: before.sessionId as string } })).toBe(0);
    // The sitting row itself stays: which browser sat which paper is part
    // of the record of the sitting.
    expect(await db.examBrowserSitting.count({ where: { id: sitting.sittingId } })).toBe(1);
  });

  it("is idempotent, so two things finishing one sitting keep the first time", async () => {
    const sitting = await liveSitting(studentId);
    await browser.endExamBrowserSitting(sitting.sittingId);
    const first = await db.examBrowserSitting.findUniqueOrThrow({
      where: { id: sitting.sittingId },
      select: { endedAt: true },
    });

    await browser.endExamBrowserSitting(sitting.sittingId);
    const second = await db.examBrowserSitting.findUniqueOrThrow({
      where: { id: sitting.sittingId },
      select: { endedAt: true },
    });
    expect(second.endedAt?.getTime()).toBe(first.endedAt?.getTime());
  });
});
