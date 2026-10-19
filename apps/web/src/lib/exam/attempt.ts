import "server-only";
import { autoSubmitExpired } from "@recx/db/attempt";
import type { AssessmentAttempt } from "@recx/db";
import {
  ATTEMPT_REVOKE_MESSAGES,
  acceptsWork,
  computeExpiresAt,
  isFinished,
  msRemaining,
  type AttemptRevokeReason,
  type AttemptStatus,
} from "@recx/shared";
import { audit } from "@/lib/audit";
import { db } from "@/lib/db";
import { attemptTokenMatches, clearAttemptCookie, presentedAttemptToken } from "@/lib/exam/attempt-token";

/**
 * The attempt guard (Phase 6b): what every exam request goes through before
 * it is allowed to touch a sitting.
 *
 * Three checks, in this order, because each one is cheaper and more certain
 * than the next:
 *
 *   1. The signed-in user owns this attempt.
 *   2. This browser holds the attempt token (Phase 6b).
 *   3. The deadline has not passed — the LAZY EXPIRY CHECK. SPEC §5: the 15s
 *      sweeper runs "plus a lazy expiry check in the attempt guard on every
 *      exam request, so a dead worker cannot grant anyone extra time." If
 *      the scheduler is down, the first request after the deadline finalises
 *      the attempt itself; the candidate cannot buy time by killing a job.
 *
 * Phase 6d adds the hall allowlist and the device check to this same guard.
 * Nothing here penalises anybody: the one write it can make is the
 * auto-submit the sweeper would have made, which is a deadline, not a
 * verdict (SPEC §0).
 */

/**
 * What the guard noticed about the session this request arrived on.
 * "rebind": the sitting's original session is gone and this one takes over.
 * "concurrent": the original session is still live and this is a second one.
 */
export type AttemptSessionNotice = "rebind" | "concurrent" | null;

export interface AttemptGuardOk {
  readonly ok: true;
  readonly attempt: AssessmentAttempt;
  readonly status: AttemptStatus;
  readonly msRemaining: number;
  readonly now: Date;
  readonly sessionNotice: AttemptSessionNotice;
  /** The session this request came on, when the caller supplied one. */
  readonly sessionId: string | null;
}

export interface AttemptGuardRefused {
  readonly ok: false;
  readonly reason: AttemptRevokeReason;
  readonly message: string;
  /**
   * The attempt, when the refusal is about its state rather than its
   * identity — so the caller can still report a status and a remaining time
   * of zero instead of a bare error.
   */
  readonly attempt: AssessmentAttempt | null;
  readonly now: Date;
}

export type AttemptGuardResult = AttemptGuardOk | AttemptGuardRefused;

const refuse = (
  reason: AttemptRevokeReason,
  now: Date,
  attempt: AssessmentAttempt | null = null,
): AttemptGuardRefused => ({
  ok: false,
  reason,
  message: ATTEMPT_REVOKE_MESSAGES[reason],
  attempt,
  now,
});

/** Which finished statuses map to which sentence for the candidate. */
function finishedReason(status: AttemptStatus): AttemptRevokeReason {
  switch (status) {
    case "EXPIRED":
    case "AUTO_SUBMITTED":
      return "expired";
    case "TERMINATED":
      return "terminated";
    default:
      // SUBMITTED, and VOIDED — which only a recorded human verdict can set,
      // and which the candidate is told about through their report, not here.
      return "submitted";
  }
}

/**
 * Load an attempt for an exam request, verifying ownership, the token and
 * the deadline.
 *
 * `userId` comes from the signed-in session the caller has already resolved,
 * so this module never decides who the user is — one place does that
 * (src/lib/auth), and this one decides whether that user may touch this
 * sitting right now.
 */
export async function guardAttempt(args: {
  readonly request: Request;
  readonly attemptId: string;
  readonly userId: string;
  readonly sessionId?: string | null;
}): Promise<AttemptGuardResult> {
  const now = new Date();
  const attempt = await db.assessmentAttempt.findUnique({ where: { id: args.attemptId } });

  // An attempt that is not this user's is refused with the SAME reason a bad
  // token gets, and without saying which of the two it was: a candidate who
  // can tell "wrong token" from "not your attempt" can enumerate other
  // people's attempt ids.
  if (!attempt || attempt.userId !== args.userId) return refuse("bad_token", now, null);

  const presented = await presentedAttemptToken(args.request, args.attemptId);
  if (!attemptTokenMatches(presented, attempt.tokenHash)) return refuse("bad_token", now, null);

  // ── The session lock ───────────────────────────────────────────────────
  // The attempt is pinned to the signed-in session that started it
  // (`lockSessionId`). Two different things make a request arrive on another
  // session, and they deserve opposite treatment:
  //
  //   * the original session is GONE (expired, signed out, force-logged-out
  //     by an admin) and the candidate has signed in again. That is a resume,
  //     and the lock moves to the new session. Refusing here would cost a
  //     candidate their exam for an expiring cookie, which no reading of
  //     SPEC §5's "resume on the same token, deadline unchanged" supports.
  //   * the original session is STILL ALIVE and a second one is beating. That
  //     is a genuine CONCURRENT_SESSION — one of the 25 kinds — so it is
  //     recorded for a human to read, the first session keeps the lock, and
  //     the request is still allowed, because no signal auto-penalises (§0).
  //
  // `lockSessionId` is deliberately not in the write-once tuple the
  // `AssessmentAttempt_machine` trigger freezes: re-binding is intended.
  let sessionNotice: AttemptSessionNotice = null;
  if (attempt.lockSessionId !== null && args.sessionId != null && args.sessionId !== attempt.lockSessionId) {
    const original = await db.session.findUnique({
      where: { id: attempt.lockSessionId },
      select: { id: true },
    });
    sessionNotice = original ? "concurrent" : "rebind";
  }

  const status = attempt.status as AttemptStatus;
  if (isFinished(status)) return refuse(finishedReason(status), now, attempt);
  if (!acceptsWork(status)) {
    // NOT_STARTED: the row exists but the sitting has not begun. Start it
    // through startAttempt(), not by beating at it.
    return refuse("bad_token", now, attempt);
  }

  // ── The lazy expiry check ──────────────────────────────────────────────
  const left = msRemaining({ expiresAt: attempt.expiresAt, pausedMs: attempt.pausedMs, now });
  if (left === 0) {
    const [finalised] = await autoSubmitExpired(db, { limit: 1, attemptId: attempt.id });
    if (finalised) {
      console.warn(
        `[exam] attempt ${attempt.id} auto-submitted by the lazy guard ${Math.round(finalised.lateMs)}ms past its deadline (the sweeper did not get there first)`,
      );
      await audit({
        actorId: null,
        action: "assessment.attempt.auto_submitted",
        entityType: "AssessmentAttempt",
        entityId: attempt.id,
        targetUserId: attempt.userId,
        metadata: {
          by: "lazy_guard",
          previousStatus: finalised.previousStatus,
          expiresAt: finalised.expiresAt.toISOString(),
          pausedMs: finalised.pausedMs,
          lateMs: Math.round(finalised.lateMs),
        },
      });
    }
    // Refused either way: whether this request or the sweeper finalised it,
    // the deadline has passed and no more work is accepted.
    const fresh = await db.assessmentAttempt.findUnique({ where: { id: attempt.id } });
    return refuse("expired", now, fresh ?? attempt);
  }

  return {
    ok: true,
    attempt,
    status,
    msRemaining: left,
    now,
    sessionNotice,
    sessionId: args.sessionId ?? null,
  };
}

/**
 * Drop the attempt cookie once a sitting is over. Called after a refusal that
 * is final, so a finished attempt stops carrying a credential in the browser.
 */
export async function endAttemptSession(attemptId: string, reason: AttemptRevokeReason): Promise<void> {
  if (reason === "session_revoked" || reason === "outside_allowlist") return; // Resumable: keep the token.
  await clearAttemptCookie(attemptId);
}

/**
 * The deadline for a sitting about to start. Exported so the start path and
 * any staff-facing "when would this end?" view compute it exactly once.
 */
export function attemptDeadline(args: {
  readonly startedAt: Date;
  readonly durationSec: number;
  readonly closesAt: Date;
  readonly extraTimePercent?: number;
  readonly extraTimeMinutes?: number;
}) {
  return computeExpiresAt({
    startedAt: args.startedAt,
    durationSec: args.durationSec,
    closesAt: args.closesAt,
    accommodation: { extraTimePercent: args.extraTimePercent ?? 0, extraTimeMinutes: args.extraTimeMinutes ?? 0 },
  });
}
