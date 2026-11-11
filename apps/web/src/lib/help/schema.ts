import { z } from "zod";
import { ACTIVITY_POLICY } from "@/lib/help/activity-policy";

/**
 * Zod boundaries for the help actions and the activity route. Every schema is
 * strict: the help context is decided on the server, so a client that adds
 * `context`, `userId` or anything else is refused outright rather than
 * having the extra field silently dropped.
 */

/** A Problem id (cuid). The same shape the submissions routes accept. */
export const problemIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/, "That problem id is not valid.");

export const HINT_TIERS = [1, 2, 3] as const;
export type HintTier = (typeof HINT_TIERS)[number];

export const revealHintSchema = z
  .object({
    problemId: problemIdSchema,
    tier: z.union([z.literal(1), z.literal(2), z.literal(3)], {
      errorMap: () => ({ message: "Hints come in tiers 1, 2 and 3." }),
    }),
  })
  .strict();
export type RevealHintInput = z.infer<typeof revealHintSchema>;

export const viewEditorialSchema = z.object({ problemId: problemIdSchema }).strict();
export type ViewEditorialInput = z.infer<typeof viewEditorialSchema>;

/** POST /api/activity body. Seconds above the per-ping credit cap are accepted and capped, not refused. */
export const activityPingSchema = z
  .object({
    problemId: problemIdSchema,
    seconds: z.number().int().min(0).max(ACTIVITY_POLICY.maxClaimSeconds),
  })
  .strict();
export type ActivityPingInput = z.infer<typeof activityPingSchema>;
