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
import { endExamBrowserSittings } from "@recx/db/exam-browser";
import { hashSessionToken } from "@/lib/auth/session-token";
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
 * How much longer than the paper the sitting's own session lasts.
 *
 * The session exists so the application never meets a sign-in form, and the
 * one thing it must not do is expire while a candidate is still answering:
 * `liveSession` deletes an expired row, and the next render inside the
 * kiosk window would be the sign-in form -- the precise outcome this slice
 * exists to remove.
 *
 * So the slack is four hours rather than the one this was first written
 * with. An hour looked generous until the arithmetic was done against what
 * actually extends a sitting: `computeExpiresAt` applies an accommodation's
 * extra time, and 25% on a four-hour paper is already sixty minutes, before
 * any pause an invigilator grants. Four hours covers those with room, and
 * it is deliberately not capped from above -- a paper that runs four hours
 * needs a session that runs four hours.
 *
 * What makes that cheap rather than careless is that the real bound is not
 * the clock: `endExamBrowserSitting` deletes the session when the paper is
 * handed in, so the slack is only what happens to a sitting nobody ever
 * finished.
 */
export const EXAM_BROWSER_SESSION_SLACK_MS = 4 * 60 * 60_000;

/**
 * What the sitting's session calls itself.
 *
 * `Session.userAgent` is shown on the candidate's own devices screen, so
 * this is the line they read there. Naming it plainly is the point: a second
 * live session on their account that they did not create by signing in is
 * something they are entitled to see and to end.
 */
export const EXAM_BROWSER_SESSION_AGENT = "REC Exam Browser";

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
      /**
       * The session this sitting's window holds. Returned ONCE, like the
       * launch token it was traded for, and stored only as a digest.
       */
      readonly sessionToken: string;
      readonly sessionExpiresAt: Date;
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
    select: {
      id: true,
      userId: true,
      assessmentId: true,
      expiresAt: true,
      boundAt: true,
      assessment: { select: { slug: true, durationSec: true } },
    },
  });
  if (!row) return { ok: false, reason: "unknown", message: EXCHANGE_MESSAGES.unknown };
  if (row.boundAt !== null) return { ok: false, reason: "already_used", message: EXCHANGE_MESSAGES.already_used };
  if (row.expiresAt.getTime() <= Date.now()) {
    return { ok: false, reason: "expired", message: EXCHANGE_MESSAGES.expired };
  }

  // Read outside the transaction: it reads request headers, which a
  // transaction callback has no business doing, and a hash computed a
  // millisecond early is the same hash.
  const ipHash = await requestIpHash();
  const sessionToken = randomBytes(32).toString("base64url");
  const sessionExpiresAt = new Date(Date.now() + row.assessment.durationSec * 1000 + EXAM_BROWSER_SESSION_SLACK_MS);

  /**
   * All three writes or none (Phase 14g).
   *
   * Spending the token, issuing the session and recording which session was
   * issued are one fact. Done as three statements, a failure in the middle
   * leaves a token spent with no session to show for it: the candidate
   * cannot launch again, because the token is gone, and cannot sit, because
   * the window has no cookie. Inside a transaction the single-use guarantee
   * is unchanged -- `updateMany` filtered on `boundAt: null` either claims
   * the row or claims nothing, and two applications racing one token still
   * cannot both win.
   */
  const claimed = await db.$transaction(async (tx) => {
    const spent = await tx.examBrowserSitting.updateMany({
      where: { id: row.id, boundAt: null, expiresAt: { gt: new Date() } },
      data: { boundAt: new Date(), ipHashBound: ipHash },
    });
    if (spent.count !== 1) return false;

    const session = await tx.session.create({
      data: {
        tokenHash: hashSessionToken(sessionToken),
        userId: row.userId,
        expiresAt: sessionExpiresAt,
        userAgent: EXAM_BROWSER_SESSION_AGENT,
        ipHash,
        /**
         * The line the real application taught us (Phase 14g, second pass).
         *
         * Without it, `currentSession()` renewed this session on its very
         * first request -- `needsRenew` is true for anything expiring
         * inside seven days -- so the expiry computed just above became
         * fourteen days and every sentence written about this session's
         * lifetime was false. A session issued for one paper does not get
         * to extend itself.
         */
        renewable: false,
      },
      select: { id: true },
    });
    await tx.examBrowserSitting.update({
      where: { id: row.id },
      data: { sessionId: session.id, sessionIssuedAt: new Date() },
    });
    return true;
  });
  if (!claimed) return { ok: false, reason: "already_used", message: EXCHANGE_MESSAGES.already_used };

  return {
    ok: true,
    sittingId: row.id,
    sittingKey: deriveSittingKey(row.id),
    assessmentId: row.assessmentId,
    assessmentSlug: row.assessment.slug,
    sessionToken,
    sessionExpiresAt,
  };
}

/**
 * Which sitting is this request being made from (Phase 14h)?
 *
 * For the one request that cannot read the answer off the attempt, because
 * it is the request that creates it. `checkContainment` compares the
 * presented sitting against `AssessmentAttempt.examBrowserSittingId`, and at
 * Start there is no attempt yet -- which is why, before this existed, a
 * `KIOSK_RECX` paper was refused by the very request trying to begin it.
 *
 * **This performs no cryptography and proves nothing on its own.** It reads
 * an attacker-supplied header and asks the database one question: is there a
 * live sitting with that id, launched by THIS candidate, for THIS paper?
 * That is what stops a request naming somebody else's sitting. What stops a
 * request naming this candidate's own sitting without holding its key is the
 * signature, verified once by `checkContainment` on the same request, before
 * anything is written. Doing it in one place rather than two matters: the
 * nonce is spent by verification, so a second verification of the same
 * request would refuse it as a replay.
 */
export async function examBrowserSittingClaimedBy(args: {
  readonly request: Request;
  readonly userId: string;
  readonly assessmentId: string;
}): Promise<string | null> {
  const claimed = args.request.headers.get(RECX_SITTING_HEADER)?.trim() ?? "";
  // A cuid is 25 characters; this is only to keep something absurd out of a
  // query, since the lookup below is what actually decides.
  if (claimed === "" || claimed.length > 64) return null;

  const row = await db.examBrowserSitting.findFirst({
    where: {
      id: claimed,
      userId: args.userId,
      assessmentId: args.assessmentId,
      // Bound means the launch token was spent for it, so a key exists.
      boundAt: { not: null },
      // And not one that has already been ended.
      endedAt: null,
    },
    select: { id: true },
  });
  return row?.id ?? null;
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
   * The work is in `packages/db` (Phase 14h), because the scheduler ends
   * sittings too: `autoSubmitExpired` closes an attempt at its deadline
   * without any request from the browser that was sitting it. One
   * implementation, so the order of the three writes -- release the
   * attempts, revoke the session, stamp `endedAt` -- cannot drift between
   * the two processes that do it.
   */
  await endExamBrowserSittings(db, [sittingId]);
}
