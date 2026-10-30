import "server-only";
import type { Role } from "@recx/db";
import {
  MOCK_INTERVIEW_LIMITS,
  MOCK_INTERVIEW_REFUSALS,
  canTransitionInterview,
  isJoinable,
  mayCancel,
  mayMarkNoShow,
  type MockInterviewStatus,
} from "@recx/shared";
import { db } from "@/lib/db";
import { parseIstLocalDateTime } from "@/lib/judge/caps";
import { ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import {
  cancelSlotSchema,
  finishInterviewSchema,
  offerSlotSchema,
  slotIdSchema,
  snapshotSchema,
  startInterviewSchema,
} from "@/lib/mock/schema";

/**
 * Mock interviews: the writes (Phase 12h).
 *
 * Every transition goes through `canTransition()` in @recx/shared rather
 * than an `if` per action, so the lifecycle is one table a reader can
 * check against the CHECKs in the migration — and a new status cannot be
 * reachable from somewhere nobody looked.
 *
 * Who may do what is decided here and not by the page: the mentor owns the
 * slot, the candidate owns the booking, and the only thing either of them
 * can do to the other's half is call it off with a reason the other is
 * shown.
 */

export interface InterviewId {
  id: string;
}

const NOT_FOUND = "That slot was not found.";

async function slotOrThrow(interviewId: string) {
  const slot = await db.mockInterview.findUnique({
    where: { id: interviewId },
    select: {
      id: true,
      mentorId: true,
      candidateId: true,
      status: true,
      startsAt: true,
      durationMinutes: true,
      startedAt: true,
    },
  });
  if (!slot) throw new NotFoundError(NOT_FOUND);
  return slot;
}

function move(from: MockInterviewStatus, to: MockInterviewStatus): void {
  if (!canTransitionInterview(from, to)) {
    throw new ValidationError(
      from === "CANCELLED" || from === "COMPLETED" || from === "NO_SHOW"
        ? MOCK_INTERVIEW_REFUSALS.alreadyEnded
        : `A ${from.toLowerCase().replace("_", " ")} slot cannot become ${to.toLowerCase().replace("_", " ")}.`,
    );
  }
}

// ── The mentor's half ───────────────────────────────────────────────────

export async function offerSlotAs(mentorId: string, input: unknown, now = new Date()): Promise<InterviewId> {
  const { startsAtLocal, durationMinutes } = offerSlotSchema.parse(input);
  const startsAt = parseIstLocalDateTime(startsAtLocal);
  if (!startsAt) throw new ValidationError("That is not a real date and time.");
  if (startsAt.getTime() <= now.getTime()) throw new ValidationError("Offer a slot in the future.");
  const horizon = now.getTime() + MOCK_INTERVIEW_LIMITS.offerDaysAhead.max * 86_400_000;
  if (startsAt.getTime() > horizon) {
    throw new ValidationError(`Offer a slot within the next ${MOCK_INTERVIEW_LIMITS.offerDaysAhead.max} days.`);
  }

  // Two slots of one mentor's that overlap is one mentor in two rooms.
  const endsAt = new Date(startsAt.getTime() + durationMinutes * 60_000);
  const clash = await db.mockInterview.findFirst({
    where: {
      mentorId,
      status: { in: ["OPEN", "BOOKED", "IN_PROGRESS"] },
      startsAt: { lt: endsAt },
    },
    select: { id: true, startsAt: true, durationMinutes: true },
  });
  if (clash && new Date(clash.startsAt.getTime() + clash.durationMinutes * 60_000) > startsAt) {
    throw new ValidationError("That overlaps a slot you are already offering.");
  }

  const created = await db.mockInterview.create({
    data: { mentorId, startsAt, durationMinutes },
    select: { id: true },
  });
  return created;
}

export async function startInterviewAs(mentorId: string, input: unknown, now = new Date()): Promise<InterviewId> {
  const { interviewId, problemId } = startInterviewSchema.parse(input);
  const slot = await slotOrThrow(interviewId);
  if (slot.mentorId !== mentorId) throw new ForbiddenError(MOCK_INTERVIEW_REFUSALS.notYours);
  if (!slot.candidateId) throw new ValidationError(MOCK_INTERVIEW_REFUSALS.noCandidate);
  move(slot.status, "IN_PROGRESS");
  if (!isJoinable(slot, now)) throw new ValidationError("It is not time for that one yet.");

  if (problemId) {
    const problem = await db.problem.findUnique({
      where: { id: problemId },
      select: { status: true, liveVersionId: true },
    });
    if (!problem || problem.status !== "PUBLISHED" || !problem.liveVersionId) {
      throw new ValidationError("Set a published problem.");
    }
  }

  await db.mockInterview.update({
    where: { id: slot.id },
    data: { status: "IN_PROGRESS", startedAt: now, problemId },
  });
  return { id: slot.id };
}

export async function finishInterviewAs(mentorId: string, input: unknown, now = new Date()): Promise<InterviewId> {
  const { interviewId, communication, problemSolving, code, feedbackMd } = finishInterviewSchema.parse(input);
  const slot = await slotOrThrow(interviewId);
  if (slot.mentorId !== mentorId) throw new ForbiddenError(MOCK_INTERVIEW_REFUSALS.notYours);
  move(slot.status, "COMPLETED");

  /**
   * The feedback and the ending are one write. The CHECK requires all
   * five feedback columns together, and the product reason is the same:
   * a finished interview with no feedback is a candidate refreshing a
   * page that will never change.
   */
  await db.$transaction([
    db.mockInterview.update({
      where: { id: slot.id },
      data: {
        status: "COMPLETED",
        endedAt: now,
        ratingCommunication: communication,
        ratingProblemSolving: problemSolving,
        ratingCode: code,
        feedbackMd,
        feedbackAt: now,
      },
    }),
    // The mirror existed for the conversation. It is over.
    db.mockInterviewSnapshot.deleteMany({ where: { interviewId: slot.id } }),
  ]);
  return { id: slot.id };
}

export async function markNoShowAs(mentorId: string, input: unknown, now = new Date()): Promise<InterviewId> {
  const { interviewId } = slotIdSchema.parse(input);
  const slot = await slotOrThrow(interviewId);
  if (slot.mentorId !== mentorId) throw new ForbiddenError(MOCK_INTERVIEW_REFUSALS.notYours);
  move(slot.status, "NO_SHOW");
  if (!mayMarkNoShow(slot, now)) throw new ValidationError(MOCK_INTERVIEW_REFUSALS.tooEarlyForNoShow);

  await db.mockInterview.update({ where: { id: slot.id }, data: { status: "NO_SHOW" } });
  return { id: slot.id };
}

// ── The candidate's half ────────────────────────────────────────────────

export async function bookSlotAs(candidateId: string, input: unknown, now = new Date()): Promise<InterviewId> {
  const { interviewId } = slotIdSchema.parse(input);
  const slot = await slotOrThrow(interviewId);
  if (slot.mentorId === candidateId) throw new ValidationError("You cannot book your own slot.");
  if (slot.status !== "OPEN") throw new ValidationError(MOCK_INTERVIEW_REFUSALS.notOpen);
  if (slot.startsAt.getTime() <= now.getTime()) throw new ValidationError(MOCK_INTERVIEW_REFUSALS.past);

  const held = await db.mockInterview.count({
    where: { candidateId, status: { in: ["BOOKED", "IN_PROGRESS"] }, startsAt: { gte: now } },
  });
  if (held >= MOCK_INTERVIEW_LIMITS.concurrentBookings) throw new ValidationError(MOCK_INTERVIEW_REFUSALS.tooMany);

  /**
   * `updateMany` with the status in the WHERE, so two students pressing
   * Book at the same moment cannot both get it: the second one updates
   * zero rows and is told somebody was quicker.
   */
  const taken = await db.mockInterview.updateMany({
    where: { id: slot.id, status: "OPEN", candidateId: null },
    data: { status: "BOOKED", candidateId, bookedAt: now },
  });
  if (taken.count === 0) throw new ValidationError(MOCK_INTERVIEW_REFUSALS.notOpen);
  return { id: slot.id };
}

/** A candidate giving the slot back. It becomes OPEN again for somebody else. */
export async function giveUpSlotAs(candidateId: string, input: unknown, now = new Date()): Promise<InterviewId> {
  const { interviewId } = slotIdSchema.parse(input);
  const slot = await slotOrThrow(interviewId);
  if (slot.candidateId !== candidateId) throw new ForbiddenError(MOCK_INTERVIEW_REFUSALS.notYours);
  move(slot.status, "OPEN");
  if (!mayCancel(slot, now)) throw new ValidationError(MOCK_INTERVIEW_REFUSALS.cancelTooLate);

  await db.mockInterview.update({
    where: { id: slot.id },
    data: { status: "OPEN", candidateId: null, bookedAt: null },
  });
  return { id: slot.id };
}

// ── Either side ─────────────────────────────────────────────────────────

/** Calling it off for good, with a reason the other person is shown. */
export async function cancelSlotAs(
  user: { id: string; role: Role },
  input: unknown,
): Promise<InterviewId> {
  const { interviewId, reason } = cancelSlotSchema.parse(input);
  const slot = await slotOrThrow(interviewId);
  if (slot.mentorId !== user.id && slot.candidateId !== user.id) {
    throw new ForbiddenError(MOCK_INTERVIEW_REFUSALS.notYours);
  }
  move(slot.status, "CANCELLED");

  await db.$transaction([
    db.mockInterview.update({
      where: { id: slot.id },
      data: { status: "CANCELLED", cancelledById: user.id, cancelReason: reason },
    }),
    db.mockInterviewSnapshot.deleteMany({ where: { interviewId: slot.id } }),
  ]);
  return { id: slot.id };
}

/**
 * The candidate's editor, pushed every few seconds while the interview is
 * running.
 *
 * Refused unless the caller IS the candidate and the interview IS
 * running: a mirror that kept accepting writes after the end would be a
 * channel nobody is watching and nobody closed.
 */
export async function pushSnapshotAs(candidateId: string, interviewId: string, input: unknown): Promise<void> {
  const { language, source } = snapshotSchema.parse(input);
  const slot = await slotOrThrow(interviewId);
  if (slot.candidateId !== candidateId) throw new ForbiddenError(MOCK_INTERVIEW_REFUSALS.notYours);
  if (slot.status !== "IN_PROGRESS") throw new ValidationError(MOCK_INTERVIEW_REFUSALS.notRunning);

  await db.mockInterviewSnapshot.upsert({
    where: { interviewId: slot.id },
    create: { interviewId: slot.id, language, source },
    update: { language, source },
  });
}
