import { z } from "zod";
import {
  INTERVIEW_EARLIEST_YEAR,
  INTERVIEW_LIMITS,
  INTERVIEW_MODES,
  INTERVIEW_OUTCOMES,
  INTERVIEW_PREPARATION,
  INTERVIEW_ROUND_KINDS,
  TOPICS,
  type InterviewMode,
  type InterviewOutcome,
  type Topic,
} from "@recx/shared";

/**
 * The archive's boundary (Phase 12e). Strict, and almost entirely closed
 * lists — which is the feature, not an accident of validation. The only
 * free text a student can send is a company name, and even that is
 * bounded and trimmed.
 *
 * The author, the status and the decision fields are not here at all: a
 * client that sends one is refused rather than having it dropped, because
 * "the field was ignored" and "the field was honoured" look identical from
 * the outside.
 */

const id = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/, "That id is not valid.");

const enumList = <T extends string>(values: readonly T[], min: number, max: number, what: string) =>
  z
    .array(z.enum(values as unknown as [T, ...T[]]))
    .min(min, `Choose at least ${min} ${what}.`)
    .max(max)
    .refine((list) => new Set(list).size === list.length, { message: `Choose each ${what} once.` });

export const submitExperienceSchema = z
  .object({
    companyName: z
      .string()
      .trim()
      .min(INTERVIEW_LIMITS.companyName.min, "Say which company it was.")
      .max(INTERVIEW_LIMITS.companyName.max),
    role: z.string().trim().min(2, "Say which role you interviewed for.").max(80),
    mode: z.enum(INTERVIEW_MODES as unknown as [InterviewMode, ...InterviewMode[]]),
    heldYear: z.number().int().min(INTERVIEW_EARLIEST_YEAR).max(2100),
    heldMonth: z.number().int().min(1).max(12),
    rounds: z.number().int().min(INTERVIEW_LIMITS.rounds.min).max(INTERVIEW_LIMITS.rounds.max),
    longestRoundMinutes: z
      .number()
      .int()
      .min(INTERVIEW_LIMITS.durationMinutes.min)
      .max(INTERVIEW_LIMITS.durationMinutes.max)
      .nullable()
      .default(null),
    outcome: z.enum(INTERVIEW_OUTCOMES as unknown as [InterviewOutcome, ...InterviewOutcome[]]),
    roundKinds: enumList(INTERVIEW_ROUND_KINDS, 1, INTERVIEW_LIMITS.rounds.max, "kind of round"),
    topics: enumList(TOPICS, 0, INTERVIEW_LIMITS.topics.max, "topic"),
    preparation: enumList(INTERVIEW_PREPARATION, 0, INTERVIEW_PREPARATION.length, "thing that helped"),
    /** Catalogue problems, which is what becomes an "asked at" count. */
    problemIds: z
      .array(id)
      .max(INTERVIEW_LIMITS.problems.max)
      .default([])
      .refine((list) => new Set(list).size === list.length, { message: "Name each problem once." }),
  })
  .strict();
export type SubmitExperienceInput = z.input<typeof submitExperienceSchema>;

export const withdrawExperienceSchema = z.object({ experienceId: id }).strict();
export type WithdrawExperienceInput = z.input<typeof withdrawExperienceSchema>;

export const decideExperienceSchema = z
  .object({
    experienceId: id,
    approve: z.boolean(),
    reason: z
      .string()
      .trim()
      .min(INTERVIEW_LIMITS.decisionReason.min, "The student is shown this.")
      .max(INTERVIEW_LIMITS.decisionReason.max),
    /**
     * The catalogue company this account is about, chosen by the moderator
     * at approval time. Approving without one is allowed and useful — the
     * account is still worth reading — but it contributes no company tag
     * until somebody says which company it was.
     */
    companyId: id.nullable().default(null),
    /**
     * Create a catalogue company from the name the student typed, and use
     * it. The moderator is looking at the whole existing list in the same
     * control when they tick this, which is the difference between a human
     * deciding "this one is new" and a free-text field quietly producing
     * "Zoho", "zoho corp" and "ZOHO".
     */
    createCompany: z.boolean().default(false),
  })
  .strict()
  .refine((value) => !(value.createCompany && value.companyId), {
    message: "Pick a company or create one, not both.",
  });
export type DecideExperienceInput = z.input<typeof decideExperienceSchema>;

export type { Topic };
