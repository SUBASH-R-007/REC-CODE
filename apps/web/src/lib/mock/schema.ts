import { z } from "zod";
import { MOCK_INTERVIEW_LIMITS, RATING_MAX, RATING_MIN } from "@recx/shared";
import { problemIdSchema } from "@/lib/help/schema";

/**
 * The mock-interview boundary (Phase 12h). Strict: the status, the
 * candidate and every timestamp are the server's, so a client that sends
 * one is refused rather than having it dropped.
 */

const id = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/, "That id is not valid.");

const reason = (what: string) =>
  z.string().trim().min(10, `Say why, in at least 10 characters. ${what}`).max(500, "Keep it under 500 characters.");

export const offerSlotSchema = z
  .object({
    /** "2026-11-07T15:30" as IST, the way the form gives it. */
    startsAtLocal: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, "Give the start as a date and a time."),
    durationMinutes: z
      .number()
      .int()
      .min(MOCK_INTERVIEW_LIMITS.durationMinutes.min)
      .max(MOCK_INTERVIEW_LIMITS.durationMinutes.max),
  })
  .strict();
export type OfferSlotInput = z.input<typeof offerSlotSchema>;

export const slotIdSchema = z.object({ interviewId: id }).strict();
export type SlotIdInput = z.input<typeof slotIdSchema>;

export const cancelSlotSchema = z
  .object({ interviewId: id, reason: reason("The other person is shown it.") })
  .strict();
export type CancelSlotInput = z.input<typeof cancelSlotSchema>;

export const startInterviewSchema = z
  .object({ interviewId: id, problemId: problemIdSchema.nullable().default(null) })
  .strict();
export type StartInterviewInput = z.input<typeof startInterviewSchema>;

const rating = z
  .number({ invalid_type_error: "Give each one a mark out of 5." })
  .int()
  .min(RATING_MIN)
  .max(RATING_MAX);

export const finishInterviewSchema = z
  .object({
    interviewId: id,
    communication: rating,
    problemSolving: rating,
    code: rating,
    feedbackMd: z
      .string()
      .trim()
      .min(MOCK_INTERVIEW_LIMITS.feedback.min, "Write something the candidate can act on — at least 30 characters.")
      .max(MOCK_INTERVIEW_LIMITS.feedback.max),
  })
  .strict();
export type FinishInterviewInput = z.input<typeof finishInterviewSchema>;

/** The candidate's editor, pushed every few seconds while the interview runs. */
export const snapshotSchema = z
  .object({
    language: z.string().trim().min(1).max(32),
    source: z.string().max(MOCK_INTERVIEW_LIMITS.snapshotChars),
  })
  .strict();
export type SnapshotInput = z.input<typeof snapshotSchema>;
