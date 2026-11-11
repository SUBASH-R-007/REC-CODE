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

  /** A request carrying the attestation a real exam browser would send. */
  function signedFor(
    sitting: { sittingId: string; sittingKey: string },
    options: { url?: string; body?: unknown; key?: string } = {},
  ): Request {
    const url = options.url ?? START_URL;
    const nonce = randomBytes(16).toString("base64url");
    const timestamp = Date.now();
    const signature = createHmac("sha256", options.key ?? sitting.sittingKey)
      .update(
        shared.examBrowserSigningInput({
          method: "POST",
          url,
          nonce,
          timestamp,
          sittingId: sitting.sittingId,
        }),
      )
      .digest("hex");
    return new Request(url, {
      method: "POST",
      headers: {
        [shared.RECX_PROTOCOL_HEADER]: String(shared.EXAM_BROWSER_PROTOCOL_VERSION),
        [shared.RECX_VERSION_HEADER]: "1.0.0",
        [shared.RECX_SITTING_HEADER]: sitting.sittingId,
        [shared.RECX_NONCE_HEADER]: nonce,
        [shared.RECX_TIMESTAMP_HEADER]: String(timestamp),
        [shared.RECX_SIGNATURE_HEADER]: signature,
        ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
  }

  const signedRequest = (sitting: { sittingId: string; sittingKey: string }) => signedFor(sitting);

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

    /**
     * Phase 16e. `startAttempt` refuses with `needs_consent` until the
     * candidate has agreed, which is what happens on the readiness page
     * before Start — in REC Exam Browser too. Through the same function the
     * application uses, so a change to what is recorded travels here.
     */
    const { recordConsent } = await import("@/lib/exam/consent");
    await recordConsent({ userId: studentId, assessmentId, ipHash: null });
  }, 90_000);

  afterAll(async () => {
    if (!db) return;
    try {
      // Phase 16e: both of ConsentRecord's foreign keys are RESTRICT and the
      // table is append-only, so the agreement goes before the PAPER as well
      // as before the candidate — which is why this is here and not further
      // down beside the user delete.
      await db.$executeRawUnsafe(`ALTER TABLE "ConsentRecord" DISABLE TRIGGER "ConsentRecord_append_only"`);
      await db.$executeRawUnsafe(`DELETE FROM "ConsentRecord" WHERE "assessmentId" = $1`, assessmentId);
      await db.$executeRawUnsafe(`ALTER TABLE "ConsentRecord" ENABLE TRIGGER "ConsentRecord_append_only"`);
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

  // ── What the browser itself reports (Phase 15a) ────────────────────────

  /**
   * The signals the exam browser sends about its own window, end to end:
   * the real route, a real signature, a real attempt, and then the rows.
   *
   * These exist because the page's account of its own focus, fullscreen
   * state and monitor count is falsifiable -- the exam page is the one
   * place a candidate can run their own JavaScript. A unit test can show
   * the handler parses a payload; only this can show that a correctly
   * signed request from a bound sitting lands in `ProctorEvent`, that a
   * wrong one does not, and that neither of them moves a counter that
   * could end somebody's paper.
   */
  const SIGNALS_URL = "https://code.rec.edu.in/api/exam/browser/signals";
  const BODY = {
    signals: [
      { kind: "FOCUS_LOSS", atMs: 1_000, durationMs: 90_000 },
      { kind: "MULTI_MONITOR", atMs: 2_000, displays: 2 },
    ],
  };

  async function startedSitting(): Promise<{ sittingId: string; sittingKey: string; attemptId: string }> {
    const sitting = await liveSitting(studentId);
    const result = await start.startOrResumeAttempt({
      request: signedRequest(sitting),
      slug: tag,
      userId: studentId,
      sessionId: null,
    });
    if (!result.ok) throw new Error(`start failed: ${result.message}`);
    const attempt = await db.assessmentAttempt.findFirstOrThrow({
      where: { assessmentId, userId: studentId },
      select: { id: true },
    });
    return { ...sitting, attemptId: attempt.id };
  }

  const attested = (attemptId: string) =>
    db.proctorEvent.findMany({
      where: { attemptId, source: "EXAM_BROWSER" },
      orderBy: { atMs: "asc" },
      select: { kind: true, source: true, clientSeq: true, severity: true, atMs: true, durationMs: true, meta: true },
    });

  it("records what a correctly signed browser says about its own window", async () => {
    const sitting = await startedSitting();
    const route = await import("@/app/api/exam/browser/signals/route");
    const response = await route.POST(signedFor(sitting, { url: SIGNALS_URL, body: BODY }));

    expect(response.status).toBe(204);
    const rows = await attested(sitting.attemptId);
    expect(rows.map((r) => r.kind)).toEqual(["FOCUS_LOSS", "MULTI_MONITOR"]);
    expect(rows[0]).toMatchObject({ source: "EXAM_BROWSER", clientSeq: null, severity: "LOW", durationMs: 90_000 });
    expect(rows[1]).toMatchObject({ severity: "INFO", meta: { displays: 2 } });
  });

  it("moves no counter on the attempt, so a second witness cannot end a paper", async () => {
    /**
     * The page reports the same alt-tab. If the browser's report were
     * counted as well, every assessment's configured focus limit would
     * quietly halve -- a candidate allowed three warnings would get one
     * and a half, in a hall, with nothing on any screen to explain it.
     */
    const sitting = await startedSitting();
    const before = await db.assessmentAttempt.findUniqueOrThrow({
      where: { id: sitting.attemptId },
      select: { blurEventCount: true, fullscreenExitCount: true, pasteEventCount: true },
    });
    const route = await import("@/app/api/exam/browser/signals/route");
    await route.POST(
      signedFor(sitting, {
        url: SIGNALS_URL,
        body: { signals: [{ kind: "FOCUS_LOSS", atMs: 1, durationMs: 600_000 }] },
      }),
    );
    const after = await db.assessmentAttempt.findUniqueOrThrow({
      where: { id: sitting.attemptId },
      select: { blurEventCount: true, fullscreenExitCount: true, pasteEventCount: true },
    });
    expect(after).toEqual(before);
    expect(await attested(sitting.attemptId)).toHaveLength(1);
  });

  it("records nothing for a signature made with the wrong key", async () => {
    // The whole value of these signals is that the page cannot write
    // them. A page that could reach this route with a guess would be a
    // page that could forge the one witness it does not control.
    const sitting = await startedSitting();
    const route = await import("@/app/api/exam/browser/signals/route");
    const response = await route.POST(
      signedFor(sitting, { url: SIGNALS_URL, body: BODY, key: "not-the-sitting-key" }),
    );
    expect(response.status, "the refusal looks exactly like the acceptance").toBe(204);
    expect(await attested(sitting.attemptId)).toHaveLength(0);
  });

  it("records nothing once the sitting has ended", async () => {
    const sitting = await startedSitting();
    await browser.endExamBrowserSitting(sitting.sittingId);
    const route = await import("@/app/api/exam/browser/signals/route");
    const response = await route.POST(signedFor(sitting, { url: SIGNALS_URL, body: BODY }));
    expect(response.status).toBe(204);
    expect(await attested(sitting.attemptId)).toHaveLength(0);
  });

  it("records nothing for a payload it does not accept", async () => {
    const sitting = await startedSitting();
    const route = await import("@/app/api/exam/browser/signals/route");
    for (const body of [
      { signals: [{ kind: "INVIGILATOR_NOTE", atMs: 0 }] },
      { signals: [{ kind: "EXTERNAL_PASTE", atMs: 0, size: 900 }] },
      { signals: [] },
      { nonsense: true },
    ]) {
      const response = await route.POST(signedFor(sitting, { url: SIGNALS_URL, body }));
      expect(response.status, JSON.stringify(body)).toBe(204);
    }
    expect(await attested(sitting.attemptId)).toHaveLength(0);
  });

  it("clamps a time from the candidate's machine into the attempt", async () => {
    const sitting = await startedSitting();
    const route = await import("@/app/api/exam/browser/signals/route");
    await route.POST(
      signedFor(sitting, {
        url: SIGNALS_URL,
        body: { signals: [{ kind: "FULLSCREEN_EXIT", atMs: 23 * 60 * 60_000 }] },
      }),
    );
    const rows = await attested(sitting.attemptId);
    expect(rows).toHaveLength(1);
    // The attempt started seconds ago, so a claim of 23 hours cannot survive.
    expect(rows[0]!.atMs).toBeLessThan(60_000);
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
