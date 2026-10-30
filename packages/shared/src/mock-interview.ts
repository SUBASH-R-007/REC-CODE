/**
 * Mock interviews (Phase 12h).
 *
 * SPEC §11: "mock-interview scheduler with read-only spectate mode (full
 * Yjs collaborative editing is Phase 12)".
 *
 * **"Spectate" here means the interviewer, and nobody else.** The spec
 * contrasts it with collaborative editing, so the thing being described is
 * a TA watching a candidate work rather than typing alongside them. Read
 * as "an audience", it would be a surface that shows one student's draft
 * code to others — the exact thing SPEC §9 forbids a placement officer,
 * and not something to build on an inference. So: one interviewer, one
 * candidate, and the mirror exists only while the interview is running.
 *
 * **The mirror is a snapshot, not a stream of keystrokes.** The candidate's
 * editor posts its text every few seconds and the interviewer's page reads
 * the latest row over SSE, the same shape as the invigilation dashboard
 * (one indexed read per viewer, nothing per keystroke). Keystroke-level
 * mirroring would be a second telemetry channel with none of the exam's
 * consent framing around it.
 *
 * **Nothing here feeds readiness or XP.** A mock interview is a
 * conversation; scoring it would make the scheduler a thing students game
 * instead of a thing they use. The feedback is written for the candidate
 * and shown to the candidate.
 */

export const MOCK_INTERVIEW_STATUSES = [
  "OPEN",
  "BOOKED",
  "IN_PROGRESS",
  "COMPLETED",
  "CANCELLED",
  "NO_SHOW",
] as const;
export type MockInterviewStatus = (typeof MOCK_INTERVIEW_STATUSES)[number];

export const MOCK_INTERVIEW_STATUS_LABEL: Readonly<Record<MockInterviewStatus, string>> = Object.freeze({
  OPEN: "Open for booking",
  BOOKED: "Booked",
  IN_PROGRESS: "Running now",
  COMPLETED: "Done",
  CANCELLED: "Cancelled",
  NO_SHOW: "Nobody came",
});

/** What a slot may become next. Anything not listed is refused. */
export const MOCK_INTERVIEW_NEXT: Readonly<Record<MockInterviewStatus, readonly MockInterviewStatus[]>> = Object.freeze({
  OPEN: ["BOOKED", "CANCELLED"],
  BOOKED: ["IN_PROGRESS", "OPEN", "CANCELLED", "NO_SHOW"],
  IN_PROGRESS: ["COMPLETED", "CANCELLED"],
  COMPLETED: [],
  CANCELLED: [],
  NO_SHOW: [],
});

/**
 * Named for its own lifecycle, because `canTransition` is already the
 * attempt clock's (and `canTransitionMock` the aptitude sitting's). Three
 * state machines, three names: a shared one would make the import line the
 * only thing saying which machine a call belongs to.
 */
export function canTransitionInterview(from: MockInterviewStatus, to: MockInterviewStatus): boolean {
  return MOCK_INTERVIEW_NEXT[from].includes(to);
}

export const MOCK_INTERVIEW_LIMITS = Object.freeze({
  durationMinutes: { min: 15, max: 120 },
  /** How far ahead a mentor may offer a slot. */
  offerDaysAhead: { min: 0, max: 60 },
  /** Bounded, because the mirror stores it and the interviewer reads it. */
  snapshotChars: 40_000,
  feedback: { min: 30, max: 4_000 },
  /** A student may hold this many future bookings at once. */
  concurrentBookings: 2,
});

export const MOCK_INTERVIEW_RATINGS = ["communication", "problemSolving", "code"] as const;
export type MockInterviewRating = (typeof MOCK_INTERVIEW_RATINGS)[number];

export const MOCK_INTERVIEW_RATING_LABEL: Readonly<Record<MockInterviewRating, string>> = Object.freeze({
  communication: "Explained their thinking",
  problemSolving: "Got to a working approach",
  code: "Wrote code they could defend",
});

export const RATING_MIN = 1;
export const RATING_MAX = 5;

/**
 * How late a candidate can be before the interviewer may mark NO_SHOW.
 *
 * Long enough that a slow lift or a lab that would not log in is not a
 * no-show on somebody's record; short enough that a mentor is not sitting
 * there for half an hour.
 */
export const MOCK_NO_SHOW_AFTER_MINUTES = 10;

/** How close to the start a candidate may still cancel without it being a no-show. */
export const MOCK_CANCEL_CUTOFF_MINUTES = 60;

export const MOCK_INTERVIEW_REFUSALS = Object.freeze({
  notYours: "That is not yours to change.",
  notOpen: "Somebody has already taken that slot.",
  past: "That slot has already started.",
  tooMany: `You already hold ${MOCK_INTERVIEW_LIMITS.concurrentBookings} bookings. Sit one of those first — a slot you hold is a slot nobody else can take.`,
  cancelTooLate: `A slot can be given up until ${MOCK_CANCEL_CUTOFF_MINUTES} minutes before it starts. After that, tell your interviewer.`,
  notRunning: "That interview is not running.",
  alreadyEnded: "That interview is over.",
  noCandidate: "Nobody has booked that slot.",
  tooEarlyForNoShow: `Give them ${MOCK_NO_SHOW_AFTER_MINUTES} minutes before marking a no-show.`,
});

/** The window in which the session page lets either side in. */
export const MOCK_JOIN_BEFORE_MINUTES = 10;

export interface MockWindow {
  readonly startsAt: Date;
  readonly durationMinutes: number;
}

export function joinOpensAt(slot: MockWindow): Date {
  return new Date(slot.startsAt.getTime() - MOCK_JOIN_BEFORE_MINUTES * 60_000);
}

export function endsAt(slot: MockWindow): Date {
  return new Date(slot.startsAt.getTime() + slot.durationMinutes * 60_000);
}

/** Either side may be in the room from ten minutes before until the end. */
export function isJoinable(slot: MockWindow, now: Date): boolean {
  return now.getTime() >= joinOpensAt(slot).getTime() && now.getTime() <= endsAt(slot).getTime();
}

export function mayCancel(slot: MockWindow, now: Date): boolean {
  return now.getTime() < slot.startsAt.getTime() - MOCK_CANCEL_CUTOFF_MINUTES * 60_000;
}

export function mayMarkNoShow(slot: MockWindow, now: Date): boolean {
  return now.getTime() >= slot.startsAt.getTime() + MOCK_NO_SHOW_AFTER_MINUTES * 60_000;
}

/**
 * What the candidate is told about the mirror, on the page, before they
 * type anything.
 *
 * Not a tooltip and not a one-time dialog: the interviewer can see the
 * editor for as long as the interview runs, and the sentence saying so
 * stays on screen for exactly that long.
 */
export const MOCK_MIRROR_NOTICE =
  "Your interviewer can see this editor while the interview is running. They cannot type in it, and nobody else can see it.";

export const MOCK_FEEDBACK_NOTICE =
  "Written for the candidate, and shown to them as soon as you finish. It is not a score, it goes on no record, and readiness does not read it.";
