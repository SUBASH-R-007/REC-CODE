import "server-only";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  RECX_NONCE_HEADER,
  RECX_PROTOCOL_HEADER,
  RECX_SIGNATURE_HEADER,
  RECX_SITTING_HEADER,
  RECX_TIMESTAMP_HEADER,
  RECX_VERSION_HEADER,
  EXAM_BROWSER_REFUSAL_MESSAGES,
  EXAM_BROWSER_SKEW_TOLERANCE_MS,
  verifyExamBrowser,
  type ExamBrowserVerdict,
} from "@recx/shared";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { requestIpHash } from "@/lib/ip";
import { redis } from "@/lib/redis";

/**
 * The server half of the REC Exam Browser attestation (Phase 14b).
 *
 * `packages/shared/src/exam-browser.ts` holds the rules; this holds the
 * three things that need a server: the derivation, the launch exchange, and
 * the replay memory.
 *
 * **Nothing here stores a sitting key.** It is derived per request from the
 * deployment's `EXAM_BROWSER_SECRET` and the sitting's id, so the database
 * holds no secret and a dump of it lets nobody sign anything
 * (`docs/EXAM-BROWSER.md` §5). Rotating `EXAM_BROWSER_SECRET` invalidates
 * every live sitting at once, which is the emergency control and a thing to
 * know before doing it mid-exam.
 */

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** How long a launch token stays usable. Long enough to install nothing. */
export const LAUNCH_TOKEN_TTL_MS = 5 * 60_000;

/**
 * How long a nonce is remembered, in seconds. The tolerance window either
 * side plus a minute, because a nonce only needs outliving the window in
 * which its timestamp would still be accepted.
 */
const NONCE_TTL_SECONDS = Math.ceil((EXAM_BROWSER_SKEW_TOLERANCE_MS * 2) / 1000) + 60;

/**
 * The key for one sitting.
 *
 * Domain-separated by a literal prefix so this secret can never produce the
 * same bytes as another use of the same HMAC construction, and bound to the
 * sitting id so one sitting's key is worth exactly one sitting.
 */
export function deriveSittingKey(sittingId: string): string {
  return createHmac("sha256", env().EXAM_BROWSER_SECRET).update(`recx-exam-sitting:v1:${sittingId}`).digest("hex");
}

const hmacHex = (key: string, message: string) => createHmac("sha256", key).update(message).digest("hex");

/**
 * Mint a launch token for this candidate and paper.
 *
 * Returns the token ONCE. It is stored as a digest and never again
 * recoverable, so a caller that loses it mints another — which is cheap,
 * and far better than a token readable out of a table.
 */
export async function mintLaunchToken(args: {
  readonly userId: string;
  readonly assessmentId: string;
}): Promise<{ readonly token: string; readonly expiresAt: Date }> {
  // 48 bytes of base64url is 64 characters, inside the shared pattern's
  // 32..128 and well past guessing.
  const token = randomBytes(48).toString("base64url");
  const expiresAt = new Date(Date.now() + LAUNCH_TOKEN_TTL_MS);
  await db.examBrowserSitting.create({
    data: { userId: args.userId, assessmentId: args.assessmentId, launchTokenHash: sha256(token), expiresAt },
  });
  return { token, expiresAt };
}

export type ExchangeResult =
  | {
      readonly ok: true;
      readonly sittingId: string;
      readonly sittingKey: string;
      readonly assessmentId: string;
      /** The application needs the slug, not the id: the readiness page is addressed by slug. */
      readonly assessmentSlug: string;
    }
  | { readonly ok: false; readonly reason: "unknown" | "expired" | "already_used"; readonly message: string };

const EXCHANGE_MESSAGES: Readonly<Record<"unknown" | "expired" | "already_used", string>> = Object.freeze({
  unknown: "That launch is not one we issued. Go back to the readiness check and launch the exam browser again.",
  expired: "That launch has expired. Go back to the readiness check and launch the exam browser again.",
  already_used:
    "That launch has already been used. If you did not open the exam browser twice, tell your invigilator before you start.",
});

/**
 * Spend a launch token and hand back the sitting's key.
 *
 * Single-use, and the single use is enforced by the database rather than by
 * reading then writing: `updateMany` with `boundAt: null` in its filter
 * either updates one row or none, so two applications racing the same token
 * cannot both win. The loser is told `already_used`, which is a sentence an
 * invigilator should hear about — two copies holding one sitting's key is
 * the event worth seeing.
 */
export async function exchangeLaunchToken(token: string): Promise<ExchangeResult> {
  const row = await db.examBrowserSitting.findUnique({
    where: { launchTokenHash: sha256(token) },
    select: { id: true, assessmentId: true, expiresAt: true, boundAt: true, assessment: { select: { slug: true } } },
  });
  if (!row) return { ok: false, reason: "unknown", message: EXCHANGE_MESSAGES.unknown };
  if (row.boundAt !== null) return { ok: false, reason: "already_used", message: EXCHANGE_MESSAGES.already_used };
  if (row.expiresAt.getTime() <= Date.now()) {
    return { ok: false, reason: "expired", message: EXCHANGE_MESSAGES.expired };
  }

  const claimed = await db.examBrowserSitting.updateMany({
    where: { id: row.id, boundAt: null, expiresAt: { gt: new Date() } },
    data: { boundAt: new Date(), ipHashBound: await requestIpHash() },
  });
  if (claimed.count !== 1) return { ok: false, reason: "already_used", message: EXCHANGE_MESSAGES.already_used };

  return {
    ok: true,
    sittingId: row.id,
    sittingKey: deriveSittingKey(row.id),
    assessmentId: row.assessmentId,
    assessmentSlug: row.assessment.slug,
  };
}

/**
 * Verify one request's attestation headers against an expected sitting.
 *
 * `expectedSittingId` comes from the attempt, not from the request: a
 * signature that verifies under *some* sitting proves only that the holder
 * of *a* key signed it, and the question being asked is whether THIS
 * sitting's browser did. Checking it before deriving anything also means a
 * request naming another candidate's sitting never reaches the HMAC.
 */
export async function verifyExamBrowserRequest(args: {
  readonly request: Request;
  readonly absoluteUrl: string;
  readonly expectedSittingId: string | null;
  readonly versionFloor: string | null;
}): Promise<ExamBrowserVerdict> {
  const header = (name: string) => args.request.headers.get(name);
  const presented = {
    protocol: header(RECX_PROTOCOL_HEADER),
    version: header(RECX_VERSION_HEADER),
    sittingId: header(RECX_SITTING_HEADER),
    nonce: header(RECX_NONCE_HEADER),
    timestamp: header(RECX_TIMESTAMP_HEADER),
    signature: header(RECX_SIGNATURE_HEADER),
  };

  const claimed = presented.sittingId?.trim() ?? "";
  const matchesExpected =
    args.expectedSittingId !== null && claimed !== "" && constantTimeEquals(claimed, args.expectedSittingId);

  const verdict = verifyExamBrowser({
    method: args.request.method,
    url: args.absoluteUrl,
    presented,
    // No key at all for a sitting that is not the one this attempt is being
    // sat under, so the shared module reaches `unknown_sitting` — the same
    // answer a revoked or finished sitting gets, which is what it is.
    sittingKey: matchesExpected ? deriveSittingKey(claimed) : null,
    versionFloor: args.versionFloor,
    now: Date.now(),
    hmac: hmacHex,
  });
  if (!verdict.ok) return verdict;

  /**
   * Only now. A nonce recorded before the signature verified would let
   * anybody who can reach the exam URL spend the nonce the real browser is
   * about to use, and end a candidate's sitting from outside.
   */
  if (await nonceAlreadySeen(verdict.sittingId, verdict.nonce)) {
    return { ok: false, refusal: "mismatch", message: EXAM_BROWSER_REFUSAL_MESSAGES.mismatch };
  }
  return verdict;
}

/**
 * Has this nonce been used on this sitting inside the window?
 *
 * Redis, with a TTL just past the window in which a timestamp is still
 * accepted — after that the timestamp check refuses the request anyway and
 * remembering the nonce buys nothing.
 *
 * **Redis being down accepts the request**, with a log line. Every caller
 * of Redis in this codebase tolerates it being down because Postgres is
 * truth and Redis is transport, and the alternative here is worse than the
 * risk it avoids: refusing a verified signature because a cache blipped
 * ends an honest candidate's sitting, while the thing it would have caught
 * requires having already captured a signature from inside the candidate's
 * own machine within two minutes.
 */
async function nonceAlreadySeen(sittingId: string, nonce: string): Promise<boolean> {
  const key = `recx:eb:nonce:${sittingId}:${sha256(nonce).slice(0, 32)}`;
  try {
    // NX returns null when the key already existed, which is the replay.
    const set = await redis().set(key, "1", "EX", NONCE_TTL_SECONDS, "NX");
    return set === null;
  } catch (error) {
    console.error("[exam-browser] nonce store unavailable, accepting a verified signature:", error);
    return false;
  }
}

/** Equal-length, constant-time compare that does not throw on a length mismatch. */
function constantTimeEquals(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Record what the application reported, for the invigilator's screen and
 * the audit row. Never the key, and never the nonce.
 *
 * Best-effort on purpose: this runs on the heartbeat path, and a write that
 * failed is a missing line on a screen, not a reason to refuse a candidate
 * whose signature verified.
 */
export async function noteExamBrowserSeen(sittingId: string, version: string): Promise<void> {
  try {
    await db.examBrowserSitting.updateMany({
      where: { id: sittingId, endedAt: null },
      data: { lastSeenVersion: version, lastSeenAt: new Date() },
    });
  } catch (error) {
    console.error("[exam-browser] could not record the version seen:", error);
  }
}

/**
 * End a sitting's attestation. The row stays — which browser sat which
 * paper is part of the record of the sitting — and the key stops working
 * because the attempt no longer names it.
 */
export async function endExamBrowserSitting(sittingId: string): Promise<void> {
  /**
   * Both halves, in this order. The attempt's column is what the hot path
   * compares -- the containment check never loads this row, which is how a
   * heartbeat every fifteen seconds stays one query lighter -- so clearing
   * it is the act that actually stops the key working. Stamping `endedAt`
   * after is the record of when.
   */
  await db.assessmentAttempt.updateMany({
    where: { examBrowserSittingId: sittingId },
    data: { examBrowserSittingId: null },
  });
  await db.examBrowserSitting.updateMany({ where: { id: sittingId, endedAt: null }, data: { endedAt: new Date() } });
}
