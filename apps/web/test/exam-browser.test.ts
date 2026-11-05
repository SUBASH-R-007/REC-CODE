import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  EXAM_BROWSER_PROTOCOL_VERSION,
  RECX_NONCE_HEADER,
  RECX_PROTOCOL_HEADER,
  RECX_SIGNATURE_HEADER,
  RECX_SITTING_HEADER,
  RECX_TIMESTAMP_HEADER,
  RECX_VERSION_HEADER,
  examBrowserSigningInput,
} from "@recx/shared";

/**
 * The server half of the REC Exam Browser attestation (Phase 14b) —
 * `src/lib/exam/exam-browser.ts`.
 *
 * The shared module's own tests cover the wire rules. What can only be
 * tested here is the part that needs a server, and all three of those are
 * the kind of thing that looks fine in review and is wrong in production:
 *
 *   - the key is DERIVED, so nothing stores one and a database dump signs
 *     nothing;
 *   - a launch token is spent exactly once, even by two applications
 *     racing it;
 *   - a signature that verifies under some OTHER sitting is not a pass.
 */

const SECRET = "a-test-exam-browser-secret-of-32-chars-plus";

const h = vi.hoisted(() => ({
  sitting: null as null | { id: string; assessmentId: string; expiresAt: Date; boundAt: Date | null },
  findUnique: vi.fn(),
  updateMany: vi.fn(),
  attemptUpdateMany: vi.fn(),
  redisSet: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    examBrowserSitting: { findUnique: h.findUnique, updateMany: h.updateMany, create: vi.fn() },
    assessmentAttempt: { updateMany: h.attemptUpdateMany },
  },
}));
vi.mock("@/lib/env", () => ({ env: () => ({ EXAM_BROWSER_SECRET: SECRET }) }));
vi.mock("@/lib/ip", () => ({ requestIpHash: async () => "f".repeat(64) }));
vi.mock("@/lib/redis", () => ({ redis: () => ({ set: h.redisSet }) }));

const { deriveSittingKey, exchangeLaunchToken, verifyExamBrowserRequest, endExamBrowserSitting } = await import(
  "@/lib/exam/exam-browser"
);

const SITTING = "sit_abc";
const URL_UNDER_TEST = "https://code.rec.edu.in/api/exam/att_1/hb";

beforeEach(() => {
  vi.clearAllMocks();
  h.findUnique.mockResolvedValue(null);
  h.updateMany.mockResolvedValue({ count: 1 });
  h.attemptUpdateMany.mockResolvedValue({ count: 0 });
  // A fresh nonce: SET NX returns "OK" when the key did not exist.
  h.redisSet.mockResolvedValue("OK");
});

/** Build the headers a correct application would send. */
function headersFor(over: Partial<Record<string, string>> = {}, key = deriveSittingKey(SITTING)) {
  const nonce = over.nonce ?? "nonce-1";
  const timestamp = over.timestamp ?? String(Date.now());
  const sittingId = over.sittingId ?? SITTING;
  const signature = createHmac("sha256", key)
    .update(
      examBrowserSigningInput({
        method: "POST",
        url: URL_UNDER_TEST,
        nonce,
        timestamp: Number(timestamp),
        sittingId,
      }),
    )
    .digest("hex");
  return new Headers({
    [RECX_PROTOCOL_HEADER]: String(EXAM_BROWSER_PROTOCOL_VERSION),
    [RECX_VERSION_HEADER]: over.version ?? "1.0.0",
    [RECX_SITTING_HEADER]: sittingId,
    [RECX_NONCE_HEADER]: nonce,
    [RECX_TIMESTAMP_HEADER]: timestamp,
    [RECX_SIGNATURE_HEADER]: over.signature ?? signature,
  });
}

const request = (headers: Headers) => new Request(URL_UNDER_TEST, { method: "POST", headers });

const verify = (headers: Headers, expectedSittingId: string | null = SITTING) =>
  verifyExamBrowserRequest({
    request: request(headers),
    absoluteUrl: URL_UNDER_TEST,
    expectedSittingId,
    versionFloor: null,
  });

describe("the sitting key is derived, never stored", () => {
  it("is stable for one sitting", () => {
    expect(deriveSittingKey(SITTING)).toBe(deriveSittingKey(SITTING));
  });

  it("differs per sitting, so one extracted key is worth one sitting", () => {
    expect(deriveSittingKey("sit_a")).not.toBe(deriveSittingKey("sit_b"));
  });

  it("is domain-separated, so it cannot collide with another use of the same secret", () => {
    // The literal prefix is what stops `hmac(secret, id)` somewhere else in
    // the product ever producing a usable exam-browser key by accident.
    expect(deriveSittingKey(SITTING)).not.toBe(createHmac("sha256", SECRET).update(SITTING).digest("hex"));
  });

  it("is a sha256 hex digest", () => {
    expect(deriveSittingKey(SITTING)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("spending a launch token", () => {
  const live = () => ({
    id: SITTING,
    assessmentId: "asm_1",
    // The application needs the slug, because the readiness page is
    // addressed by slug and the id would 404.
    assessment: { slug: "mid-term-ds" },
    expiresAt: new Date(Date.now() + 60_000),
    boundAt: null as Date | null,
  });

  it("hands back the sitting and its derived key", async () => {
    h.findUnique.mockResolvedValue(live());
    const result = await exchangeLaunchToken("t".repeat(43));
    expect(result).toEqual({
      ok: true,
      sittingId: SITTING,
      sittingKey: deriveSittingKey(SITTING),
      assessmentId: "asm_1",
      assessmentSlug: "mid-term-ds",
    });
  });

  it("looks the token up by its digest, never by the token", async () => {
    h.findUnique.mockResolvedValue(live());
    await exchangeLaunchToken("t".repeat(43));
    const where = h.findUnique.mock.calls[0]![0]!.where as { launchTokenHash: string };
    expect(where.launchTokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(where.launchTokenHash).not.toContain("t".repeat(10));
  });

  it("refuses one we never issued", async () => {
    h.findUnique.mockResolvedValue(null);
    expect(await exchangeLaunchToken("t".repeat(43))).toMatchObject({ ok: false, reason: "unknown" });
  });

  it("refuses one that has expired", async () => {
    h.findUnique.mockResolvedValue({ ...live(), expiresAt: new Date(Date.now() - 1_000) });
    expect(await exchangeLaunchToken("t".repeat(43))).toMatchObject({ ok: false, reason: "expired" });
  });

  it("refuses a second exchange", async () => {
    h.findUnique.mockResolvedValue({ ...live(), boundAt: new Date() });
    expect(await exchangeLaunchToken("t".repeat(43))).toMatchObject({ ok: false, reason: "already_used" });
  });

  it("lets the database settle a race rather than reading then writing", async () => {
    /**
     * Two applications exchanging one token at the same moment both pass
     * the read. The claim is an UPDATE filtered on `boundAt: null`, so
     * exactly one of them updates a row and the other is told
     * `already_used` -- which is the sentence an invigilator should hear,
     * because two copies holding one sitting's key is the event worth
     * seeing.
     */
    h.findUnique.mockResolvedValue(live());
    h.updateMany.mockResolvedValue({ count: 0 });
    expect(await exchangeLaunchToken("t".repeat(43))).toMatchObject({ ok: false, reason: "already_used" });

    const where = h.updateMany.mock.calls[0]![0]!.where as { boundAt: null };
    expect(where.boundAt).toBeNull();
  });
});

describe("verifying a request against the attempt's own sitting", () => {
  it("accepts the sitting the attempt is being sat under", async () => {
    const verdict = await verify(headersFor());
    expect(verdict).toMatchObject({ ok: true, sittingId: SITTING, version: "1.0.0" });
  });

  it("refuses a signature that is perfectly valid for another sitting", async () => {
    /**
     * The one that would be easy to ship broken. A signature verifying
     * under SOME key proves only that a holder of A key signed it. The
     * question is whether THIS attempt's browser did -- so the expected
     * sitting comes off the attempt, and a request naming another one
     * never reaches the HMAC at all.
     */
    const other = headersFor({ sittingId: "sit_other" }, deriveSittingKey("sit_other"));
    expect(await verify(other, SITTING)).toMatchObject({ ok: false, refusal: "unknown_sitting" });
  });

  it("refuses when the attempt names no sitting, which is how one is revoked", async () => {
    expect(await verify(headersFor(), null)).toMatchObject({ ok: false, refusal: "unknown_sitting" });
  });

  it("refuses a signature made with a key that is not the derived one", async () => {
    expect(await verify(headersFor({}, "not-the-derived-key"))).toMatchObject({ ok: false, refusal: "mismatch" });
  });

  it("refuses a nonce it has already seen", async () => {
    // SET NX returns null when the key existed: that is the replay.
    h.redisSet.mockResolvedValue(null);
    expect(await verify(headersFor())).toMatchObject({ ok: false, refusal: "mismatch" });
  });

  it("remembers the nonce only after the signature has held", async () => {
    /**
     * Order, not politeness. If a nonce were recorded before verification,
     * anybody who can reach the exam URL -- which is anybody -- could
     * spend the nonce the real browser was about to use and end a
     * candidate's sitting from outside.
     */
    await verify(headersFor({ signature: "0".repeat(64) }));
    expect(h.redisSet).not.toHaveBeenCalled();

    await verify(headersFor());
    expect(h.redisSet).toHaveBeenCalledTimes(1);
  });

  it("never puts the nonce itself in the Redis key", async () => {
    await verify(headersFor({ nonce: "a-very-distinctive-nonce" }));
    expect(String(h.redisSet.mock.calls[0]![0])).not.toContain("a-very-distinctive-nonce");
  });

  it("accepts a verified signature when the nonce store is down", async () => {
    /**
     * Redis is transport, Postgres is truth, and every caller here
     * tolerates it being down. Refusing a signature that verified because
     * a cache blipped would end an honest candidate's sitting, while what
     * it would have caught needs a signature captured from inside the
     * candidate's own machine inside two minutes.
     */
    h.redisSet.mockRejectedValue(new Error("connection refused"));
    expect(await verify(headersFor())).toMatchObject({ ok: true });
  });
});

describe("ending a sitting", () => {
  it("releases the attempts first, because that is what the hot path reads", async () => {
    await endExamBrowserSitting(SITTING);
    expect(h.attemptUpdateMany).toHaveBeenCalledWith({
      where: { examBrowserSittingId: SITTING },
      data: { examBrowserSittingId: null },
    });
    expect(h.updateMany).toHaveBeenCalled();
  });

  it("keeps the row, because which browser sat which paper is part of the record", async () => {
    await endExamBrowserSitting(SITTING);
    const call = h.updateMany.mock.calls[0]![0] as { data: Record<string, unknown> };
    expect(call.data).toHaveProperty("endedAt");
    expect(call.data).not.toHaveProperty("deleted");
  });
});
