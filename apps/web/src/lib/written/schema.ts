import { z } from "zod";
import { WRITTEN_KINDS, WRITTEN_LIMITS, WRITTEN_MARK_MAX, WRITTEN_MARK_MIN } from "@recx/shared";

/**
 * The written-answer boundary (Phase 12i). Strict: the status, the author,
 * the grader and every timestamp are the server's, so a client that sends
 * one is refused rather than having it quietly dropped.
 */

const id = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/, "That id is not valid.");

export const criterionSchema = z
  .object({
    label: z
      .string()
      .trim()
      .min(WRITTEN_LIMITS.criterionLabel.min, "Name what you are looking for.")
      .max(WRITTEN_LIMITS.criterionLabel.max),
    guidance: z.string().trim().max(WRITTEN_LIMITS.criterionGuidance.max).optional().default(""),
    weight: z.number().int().min(WRITTEN_LIMITS.weight.min).max(WRITTEN_LIMITS.weight.max),
  })
  .strict();

export const createPromptSchema = z
  .object({
    kind: z.enum(WRITTEN_KINDS),
    title: z.string().trim().min(WRITTEN_LIMITS.title.min).max(WRITTEN_LIMITS.title.max),
    promptMd: z
      .string()
      .trim()
      .min(WRITTEN_LIMITS.prompt.min, "Say what you are asking, in at least 50 characters.")
      .max(WRITTEN_LIMITS.prompt.max),
    timeBoxMinutes: z
      .number()
      .int()
      .min(WRITTEN_LIMITS.timeBoxMinutes.min)
      .max(WRITTEN_LIMITS.timeBoxMinutes.max),
    criteria: z
      .array(criterionSchema)
      .min(WRITTEN_LIMITS.criteriaPerPrompt.min, "A question needs at least two criteria.")
      .max(WRITTEN_LIMITS.criteriaPerPrompt.max),
  })
  .strict();
export type CreatePromptInput = z.input<typeof createPromptSchema>;

export const promptIdSchema = z.object({ promptId: id }).strict();
export type PromptIdInput = z.input<typeof promptIdSchema>;

export const saveDraftSchema = z
  .object({
    promptId: id,
    /** A draft may be empty; only handing it in has a floor. */
    bodyMd: z.string().max(WRITTEN_LIMITS.answer.max, "That is longer than this box takes."),
  })
  .strict();
export type SaveDraftInput = z.input<typeof saveDraftSchema>;

export const submitAnswerSchema = z
  .object({
    promptId: id,
    bodyMd: z
      .string()
      .trim()
      .min(WRITTEN_LIMITS.answer.min, "There is not enough here to mark. Say what you would build and why.")
      .max(WRITTEN_LIMITS.answer.max),
  })
  .strict();
export type SubmitAnswerInput = z.input<typeof submitAnswerSchema>;

export const markSchema = z
  .object({
    criterionId: id,
    points: z.number().int().min(WRITTEN_MARK_MIN).max(WRITTEN_MARK_MAX),
    note: z.string().trim().max(WRITTEN_LIMITS.markNote.max).optional().default(""),
  })
  .strict();

export const gradeAnswerSchema = z
  .object({
    answerId: id,
    marks: z.array(markSchema).min(WRITTEN_LIMITS.criteriaPerPrompt.min).max(WRITTEN_LIMITS.criteriaPerPrompt.max),
    overallMd: z
      .string()
      .trim()
      .min(WRITTEN_LIMITS.overallNote.min, "Write something the student can act on — at least 30 characters.")
      .max(WRITTEN_LIMITS.overallNote.max),
  })
  .strict();
export type GradeAnswerInput = z.input<typeof gradeAnswerSchema>;

export const handBackSchema = z
  .object({
    answerId: id,
    note: z
      .string()
      .trim()
      .min(10, "Say what is missing, in at least 10 characters. They are shown it.")
      .max(500),
  })
  .strict();
export type HandBackInput = z.input<typeof handBackSchema>;
