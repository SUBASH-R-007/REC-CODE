import "server-only";
import {
  DISCONNECTED_AFTER_SECONDS,
  IDLE_AFTER_SECONDS,
  isDisconnected,
  isIdle,
  maxGapSeconds,
  msRemaining,
  presenceTimeline,
  slotOf,
  type AttemptStatus,
  type PresenceRun,
} from "@recx/shared";
import { db } from "@/lib/db";

/**
 * The invigilator's view of a hall (Phase 6e).
 *
 * SPEC §5 on what an invigilator is shown, and what they are NOT:
 *
 *   Show evidence chips, never a guilt verdict, and never a student's photo
 *   next to a flag count.
 *
 *   Missing heartbeats for 45s → DISCONNECTED, amber on the invigilator
 *   dashboard.
 *
 * So this returns presence, a clock, and counts of what was recorded. It does
 * NOT return a band, a points total or an integrity score: those are the
 * review queue's business, and putting them in front of someone who is
 * invigilating turns a supervisor into a judge mid-exam.
 *
 * The presence timeline comes from the bitmap the server owns, which is why
 * it can be trusted: a client that stops reporting leaves zeros in it (SPEC
 * §5), and the bitmap is 90 bytes rather than 3.6M rows for a college-wide
 * sitting.
 */

export type PresenceState = "CONNECTED" | "IDLE" | "DISCONNECTED" | "NOT_STARTED" | "FINISHED";

export interface HallCandidate {
  readonly attemptId: string;
  readonly name: string;
  readonly collegeId: string;
  readonly seatLabel: string | null;
  readonly status: AttemptStatus;
  readonly presence: PresenceState;
  /** Server-authoritative; the invigilator's screen never computes a clock. */
  readonly msRemaining: number;
  readonly lastHeartbeatAt: Date | null;
  /** Seconds of the longest missed run, computed by the server from the bitmap. */
  readonly maxGapSeconds: number;
  /** Runs of present/absent time, for a timeline strip. */
  readonly timeline: readonly PresenceRun[];
  /** What was RECORDED. Counts, never a verdict. */
  readonly counts: {
    readonly focusLosses: number;
    readonly fullscreenExits: number;
    readonly pastes: number;
  };
  /** Granted breaks, so an invigilator can see the clock they moved. */
  readonly pausedMs: number;
  /** Unacknowledged messages, so a message is not sent twice. */
  readonly pendingMessages: number;
  /** A termination asked for and waiting on a second staff member. */
  readonly terminationPending: boolean;
  /** Signals this candidate is exempt from, so a supervisor reads a gap right. */
  readonly accommodationFlags: readonly string[];
}

export interface HallView {
  readonly sessionId: string;
  readonly label: string;
  readonly room: string | null;
  readonly assessmentTitle: string;
  readonly startsAt: Date;
  readonly endsAt: Date;
  readonly candidates: readonly HallCandidate[];
  readonly counts: {
    readonly sitting: number;
    readonly disconnected: number;
    readonly finished: number;
    readonly notStarted: number;
  };
  readonly serverNow: Date;
}

function presenceOf(args: {
  status: AttemptStatus;
  lastHeartbeatAt: Date | null;
  now: Date;
}): PresenceState {
  if (args.status === "NOT_STARTED") return "NOT_STARTED";
  if (args.status !== "IN_PROGRESS" && args.status !== "DISCONNECTED") return "FINISHED";
  // DISCONNECTED is a presence state and NEVER a flag (SPEC §5): a candidate
  // whose wifi dropped is amber on this screen and nothing else.
  if (args.status === "DISCONNECTED") return "DISCONNECTED";
  if (isDisconnected(args.lastHeartbeatAt, args.now)) return "DISCONNECTED";
  if (isIdle(args.lastHeartbeatAt, args.now)) return "IDLE";
  return "CONNECTED";
}

export async function getHallView(sessionId: string): Promise<HallView | null> {
  const now = new Date();
  const session = await db.examSession.findUnique({
    where: { id: sessionId },
    select: {
      id: true,
      label: true,
      room: true,
      startsAt: true,
      endsAt: true,
      assessment: { select: { title: true } },
    },
  });
  if (!session) return null;

  const attempts = await db.assessmentAttempt.findMany({
    where: { examSessionId: sessionId },
    orderBy: [{ seatLabel: "asc" }, { startedAt: "asc" }],
    select: {
      id: true,
      status: true,
      seatLabel: true,
      startedAt: true,
      expiresAt: true,
      pausedMs: true,
      lastHeartbeatAt: true,
      heartbeatBitmap: true,
      heartbeatSlotSeconds: true,
      blurEventCount: true,
      fullscreenExitCount: true,
      pasteEventCount: true,
      accommodationFlags: true,
      user: { select: { firstName: true, lastName: true, collegeId: true } },
      invigilatorMessages: { where: { acknowledgedAt: null, requiresAck: true }, select: { id: true } },
      termination: { select: { confirmedAt: true } },
    },
  });

  const candidates: HallCandidate[] = attempts.map((attempt) => {
    const status = attempt.status as AttemptStatus;
    const slotSeconds = attempt.heartbeatSlotSeconds || 15;
    const bitmap = attempt.heartbeatBitmap ?? new Uint8Array(0);
    // +1 so the slot in progress is inside the window the gap is measured
    // over; otherwise a candidate offline right now reads as present.
    const slotsElapsed = slotOf(attempt.startedAt, now, slotSeconds) + 1;
    return {
      attemptId: attempt.id,
      name: `${attempt.user.firstName} ${attempt.user.lastName}`.trim(),
      collegeId: attempt.user.collegeId,
      seatLabel: attempt.seatLabel,
      status,
      presence: presenceOf({ status, lastHeartbeatAt: attempt.lastHeartbeatAt, now }),
      msRemaining: msRemaining({ expiresAt: attempt.expiresAt, pausedMs: attempt.pausedMs, now }),
      lastHeartbeatAt: attempt.lastHeartbeatAt,
      maxGapSeconds: maxGapSeconds(bitmap, slotsElapsed, slotSeconds),
      timeline: presenceTimeline(bitmap, slotsElapsed),
      counts: {
        focusLosses: attempt.blurEventCount,
        fullscreenExits: attempt.fullscreenExitCount,
        pastes: attempt.pasteEventCount,
      },
      pausedMs: attempt.pausedMs,
      pendingMessages: attempt.invigilatorMessages.length,
      terminationPending: attempt.termination !== null && attempt.termination.confirmedAt === null,
      accommodationFlags: attempt.accommodationFlags,
    };
  });

  return {
    sessionId: session.id,
    label: session.label,
    room: session.room,
    assessmentTitle: session.assessment.title,
    startsAt: session.startsAt,
    endsAt: session.endsAt,
    candidates,
    counts: {
      sitting: candidates.filter((c) => c.presence === "CONNECTED" || c.presence === "IDLE").length,
      disconnected: candidates.filter((c) => c.presence === "DISCONNECTED").length,
      finished: candidates.filter((c) => c.presence === "FINISHED").length,
      notStarted: candidates.filter((c) => c.presence === "NOT_STARTED").length,
    },
    serverNow: now,
  };
}

/** Halls an invigilator can open right now: running, or about to. */
export async function listLiveHalls(): Promise<
  Array<{ id: string; label: string; room: string | null; assessmentTitle: string; startsAt: Date; endsAt: Date; candidates: number }>
> {
  const now = new Date();
  const sessions = await db.examSession.findMany({
    where: { endsAt: { gt: new Date(now.getTime() - 60 * 60_000) }, startsAt: { lt: new Date(now.getTime() + 24 * 3_600_000) } },
    orderBy: { startsAt: "asc" },
    take: 50,
    select: {
      id: true,
      label: true,
      room: true,
      startsAt: true,
      endsAt: true,
      assessment: { select: { title: true } },
      _count: { select: { attempts: true } },
    },
  });
  return sessions.map((session) => ({
    id: session.id,
    label: session.label,
    room: session.room,
    assessmentTitle: session.assessment.title,
    startsAt: session.startsAt,
    endsAt: session.endsAt,
    candidates: session._count.attempts,
  }));
}

export { DISCONNECTED_AFTER_SECONDS, IDLE_AFTER_SECONDS };
