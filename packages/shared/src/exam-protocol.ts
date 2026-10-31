import { z } from "zod";

/**
 * The exam wire contract (Phase 6b). Pure: zod schemas, cadence constants and
 * the small arithmetic the server does to a client's claims before it trusts
 * them. No I/O, no ambient clock.
 *
 * This file exists because the heartbeat is the load-bearing part of the
 * attempt engine, and SPEC §5 is exact about it:
 *
 *   Heartbeat POST /api/exam/[attemptId]/hb every 10s returns
 *   { serverNow, msRemaining, pendingInvigilatorMessages, revokeReason? }.
 *   The client renders msRemaining and never consults local Date.now() for
 *   anything authoritative. Measure serverSkewMs at start, re-sync every
 *   30s, correct and log drift over 5s.
 *
 * The clock arithmetic itself lives in ./attempt-clock. This is the envelope
 * around it.
 */

// ── Cadence ──────────────────────────────────────────────────────────────

/** How often a client beats. */
export const EXAM_HEARTBEAT_INTERVAL_MS = 10_000;

/** How often the client re-measures its offset from the server's clock. */
export const EXAM_CLOCK_RESYNC_INTERVAL_MS = 30_000;

/** Drift beyond this is corrected and logged (SPEC §5). */
export const EXAM_CLOCK_DRIFT_TOLERANCE_MS = 5_000;

/**
 * The auto-submit sweep cadence. SPEC §5: "a 15s worker finalising
 * status = IN_PROGRESS AND expiresAt <= now() inside SELECT ... FOR UPDATE
 * SKIP LOCKED, plus a lazy expiry check in the attempt guard on every exam
 * request, so a dead worker cannot grant anyone extra time."
 */
export const ATTEMPT_AUTO_SUBMIT_INTERVAL_MS = 15_000;

/** Attempts finalised per sweep. Bounded so one tick cannot run long. */
export const ATTEMPT_AUTO_SUBMIT_BATCH = 200;

/** Attempt token size. 32 bytes, sha256 at rest (SPEC §5). */
export const ATTEMPT_TOKEN_BYTES = 32;

/**
 * A client's `atMs` is clamped into [0, elapsed + grace] (SPEC §5). The grace
 * absorbs honest in-flight latency and a small forward skew; past it, the
 * client is either broken or lying, and either way the server's own elapsed
 * time is the better number.
 */
export const ATTEMPT_AT_MS_GRACE_MS = 5_000;

// ── Token cookie ─────────────────────────────────────────────────────────

/**
 * The attempt cookie is scoped to one attempt's path, so a second attempt in
 * another tab cannot read or clobber this one's token, and the token is not
 * sent with any request outside the exam.
 */
export function attemptCookiePath(attemptId: string): string {
  return "/api/exam/" + attemptId;
}

/** Header the token is mirrored in, for telemetry (SPEC §5). */
export const ATTEMPT_TOKEN_HEADER = "x-attempt-token";

export const ATTEMPT_COOKIE_NAME = "recx_attempt";

// ── Why a client was turned away ─────────────────────────────────────────

/**
 * A closed set, because the client renders a sentence for each one and an
 * unrecognised reason would render as nothing. Note what is NOT here:
 * "disconnected". SPEC §5: "DISCONNECTED is never a flag. Resume on the same
 * token with the same frozen paper, deadline unchanged" — a candidate whose
 * wifi dropped is not revoked, so there is no reason string for it.
 */
export const ATTEMPT_REVOKE_REASONS = [
  /** The clock ran out and the server submitted the work it had. */
  "expired",
  /** Already submitted — usually a second tab still beating. */
  "submitted",
  /** An invigilator ended the sitting (a recorded human action; Phase 6e). */
  "terminated",
  /** The signed-in session holding this attempt was revoked. */
  "session_revoked",
  /** The request came from outside the hall's allowlist (Phase 6d). */
  "outside_allowlist",
  /** A kiosk assessment, and Safe Exam Browser could not be verified (Phase 6d). */
  "seb_required",
  /** The token did not match this attempt. */
  "bad_token",
] as const;
export type AttemptRevokeReason = (typeof ATTEMPT_REVOKE_REASONS)[number];

/** What the candidate is shown. Never an accusation — a statement of fact. */
export const ATTEMPT_REVOKE_MESSAGES: Readonly<Record<AttemptRevokeReason, string>> = Object.freeze({
  expired: "Time is up. Your work was submitted automatically at the deadline.",
  submitted: "This attempt has already been submitted.",
  terminated: "An invigilator has ended this sitting. Speak to them before leaving the hall.",
  session_revoked: "You have been signed out. Sign in again to resume this attempt.",
  outside_allowlist: "This attempt can only be sat from the exam hall network. Tell your invigilator.",
  seb_required:
    "This assessment must be sat in Safe Exam Browser. Open it from the .seb file your department gave you.",
  bad_token: "This attempt could not be verified in this browser. Reopen it from your assessment list.",
});

// ── Heartbeat ────────────────────────────────────────────────────────────

export const examHeartbeatRequestSchema = z
  .object({
    /**
     * Monotonic per attempt. The server keeps the high-water mark, so a
     * missing run of numbers is visible as a SEQUENCE_GAP even if the events
     * themselves never arrived — which is the point of sequencing a client
     * that may be tampered with.
     */
    clientSeq: z.number().int().min(0).max(2_147_483_647),
    /**
     * The client's own Date.now(). Advisory only: used to log drift, never to
     * decide anything. The server's clock is the clock.
     */
    clientNowMs: z.number().int().optional(),
    /** Is the exam tab the foreground tab right now? A hint for the dashboard. */
    visible: z.boolean().optional(),
  })
  .strict();
export type ExamHeartbeatRequest = z.infer<typeof examHeartbeatRequestSchema>;

export const invigilatorMessageSchema = z
  .object({
    id: z.string().min(1),
    body: z.string().min(1).max(2_000),
    /** The candidate must acknowledge it, and the acknowledgement is recorded. */
    requiresAck: z.boolean(),
    sentAt: z.string(),
  })
  .strict();
export type InvigilatorMessage = z.infer<typeof invigilatorMessageSchema>;

export const examHeartbeatResponseSchema = z
  .object({
    /** The server's clock, which is the only clock that counts. */
    serverNow: z.string(),
    /** What the candidate's timer renders. Never computed on the client. */
    msRemaining: z.number().int().min(0),
    /**
     * Sent so a client that was auto-submitted while its tab was asleep stops
     * beating and shows the right screen, instead of counting down from a
     * stale number against an attempt that is already over.
     */
    status: z.string(),
    /** Empty until Phase 6e builds the invigilator desk. */
    pendingInvigilatorMessages: z.array(invigilatorMessageSchema),
    revokeReason: z.enum(ATTEMPT_REVOKE_REASONS).nullable(),
    /** When to beat again. Lets the server slow clients down under load. */
    nextHeartbeatMs: z.number().int().min(1_000),
  })
  .strict();
export type ExamHeartbeatResponse = z.infer<typeof examHeartbeatResponseSchema>;

// ── What the server does to a client's claims ────────────────────────────

/**
 * Clamp a client-reported offset into the attempt. SPEC §5 specifies
 * `atMs Int (server-clamped to [0, elapsed+5000])`.
 *
 * Both ends matter: a negative offset would sort an event before the attempt
 * began, and an inflated one would park a paste in the future, past the
 * window a reviewer is looking at.
 */
export function clampAtMs(claimed: number, elapsed: number, grace = ATTEMPT_AT_MS_GRACE_MS): number {
  const ceiling = Math.max(0, Math.floor(elapsed) + grace);
  if (!Number.isFinite(claimed)) return ceiling;
  return Math.min(ceiling, Math.max(0, Math.floor(claimed)));
}

/**
 * Elapsed milliseconds of a sitting, as the server measures it. Never
 * negative — a clock adjustment on the server must not make an attempt
 * younger than its own start.
 */
export function elapsedMs(startedAt: Date, now: Date): number {
  return Math.max(0, now.getTime() - startedAt.getTime());
}

export interface SequenceCheck {
  /** The number to store as the new high-water mark. */
  readonly highWater: number;
  /** Numbers the server never saw — a gap worth recording once. */
  readonly skipped: number;
  /** A repeat or a rewind: a replayed or a reset client. */
  readonly regressed: boolean;
}

/**
 * Compare a claimed sequence number against the high-water mark.
 *
 * `highWater` is null when the server has not seen a client message for this
 * attempt yet. Then there is no baseline, so there is no gap to report —
 * whatever number the client opens with becomes the baseline. Treating null
 * as -1 instead would report a gap on every attempt whose client happens to
 * start counting at 1, which is a signal about a convention, not about a
 * candidate.
 *
 * A gap is not an accusation in any case — a dropped request produces one,
 * and so does a tab the OS froze. It is recorded as a SERVER-sourced event
 * for a human to read alongside everything else, which is the most any
 * signal in this system is allowed to do (SPEC §0).
 */
export function checkSequence(claimed: number, highWater: number | null): SequenceCheck {
  if (highWater === null) return { highWater: claimed, skipped: 0, regressed: false };
  if (claimed <= highWater) return { highWater, skipped: 0, regressed: true };
  return { highWater: claimed, skipped: claimed - highWater - 1, regressed: false };
}

/**
 * Is the client's clock far enough off to be worth correcting and logging?
 * `driftMs` is positive when the client is ahead of the server.
 */
export function clockDrift(
  clientNowMs: number | undefined,
  serverNow: Date,
): { driftMs: number; notable: boolean } {
  if (clientNowMs === undefined || !Number.isFinite(clientNowMs)) return { driftMs: 0, notable: false };
  const driftMs = clientNowMs - serverNow.getTime();
  return { driftMs, notable: Math.abs(driftMs) > EXAM_CLOCK_DRIFT_TOLERANCE_MS };
}
