import { z } from "zod";

/**
 * Assessment policy (Phase 6a). Pure, and the server-boundary half of the
 * rules the database also enforces, so a mistake is a readable message
 * rather than a constraint violation.
 *
 * SPEC §5, stated as a comment in the spec itself:
 *
 *   // Assessment.affectsPlacementEligibility = true REQUIRES
 *   //   proctorMode = LAB_SUPERVISED
 *   Enforce with a zod refinement at the server boundary and a Postgres
 *   CHECK. Only a lab-proctored result may ever feed shortlisting,
 *   certificates or placement eligibility. This stops the predictable drift
 *   where an admin flips a Friday quiz into a shortlisting criterion because
 *   it was convenient.
 *
 * This file is the refinement. `Assessment_placement_requires_lab` is the
 * CHECK. Both exist on purpose: the refinement gives the admin a sentence
 * they can act on, and the CHECK makes the rule true of the DATA — no
 * action, script, psql session or future UI can get round it.
 */

export const PROCTOR_MODES = ["NONE", "ADVISORY", "REMOTE_MONITORED", "KIOSK_SEB", "LAB_SUPERVISED"] as const;
export type ProctorMode = (typeof PROCTOR_MODES)[number];

/**
 * The ONE mode a placement-bearing assessment may use. Not a list: the spec
 * names exactly one, and a list invites a well-meaning addition later.
 * KIOSK_SEB is deliberately not here — Safe Exam Browser is the strongest
 * software lockdown and still not enough (docs/PROCTORING.md).
 */
export const PLACEMENT_PROCTOR_MODE: ProctorMode = "LAB_SUPERVISED";

export const PLACEMENT_REQUIRES_LAB_MESSAGE =
  "Only a lab-supervised assessment can count towards placement eligibility. " +
  "Set the proctor mode to Lab supervised, or turn placement eligibility off.";

export function mayAffectPlacement(proctorMode: ProctorMode): boolean {
  return proctorMode === PLACEMENT_PROCTOR_MODE;
}

/** What happens at maxFocusWarnings. There is deliberately no "void". */
export const FOCUS_LIMIT_ACTIONS = ["AUTOSUBMIT", "FLAG_ONLY"] as const;
export type FocusLimitAction = (typeof FOCUS_LIMIT_ACTIONS)[number];

export const ASSESSMENT_STATUSES = ["DRAFT", "PUBLISHED", "OPEN", "CLOSED", "ARCHIVED"] as const;
export type AssessmentStatus = (typeof ASSESSMENT_STATUSES)[number];

/** Bounds kept identical to the CHECKs in 20261019140000. */
export const ASSESSMENT_LIMITS = Object.freeze({
  durationSec: { min: 60, max: 21_600 },
  maxFocusWarnings: { min: 1, max: 10 },
  maxAttempts: { min: 1, max: 5 },
  title: { min: 1, max: 160 },
  instructions: { min: 1, max: 20_000 },
  position: { min: 1, max: 200 },
  capacity: { min: 1, max: 2000 },
});

export const assessmentPolicySchema = z
  .object({
    proctorMode: z.enum(PROCTOR_MODES),
    affectsPlacementEligibility: z.boolean(),
    durationSec: z
      .number()
      .int()
      .min(ASSESSMENT_LIMITS.durationSec.min, "An assessment runs for at least a minute.")
      .max(ASSESSMENT_LIMITS.durationSec.max, "An assessment runs for at most six hours."),
    maxAttempts: z.number().int().min(ASSESSMENT_LIMITS.maxAttempts.min).max(ASSESSMENT_LIMITS.maxAttempts.max),
    maxFocusWarnings: z
      .number()
      .int()
      .min(ASSESSMENT_LIMITS.maxFocusWarnings.min)
      .max(ASSESSMENT_LIMITS.maxFocusWarnings.max),
    onLimit: z.enum(FOCUS_LIMIT_ACTIONS),
    strictMode: z.boolean(),
  })
  .superRefine((value, ctx) => {
    if (value.affectsPlacementEligibility && !mayAffectPlacement(value.proctorMode)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        // Reported on the flag, not the mode: the flag is the thing being
        // claimed, and an admin who meant to run an unproctored quiz should
        // be told to drop the claim rather than to escalate the proctoring.
        path: ["affectsPlacementEligibility"],
        message: PLACEMENT_REQUIRES_LAB_MESSAGE,
      });
    }
  });
export type AssessmentPolicy = z.infer<typeof assessmentPolicySchema>;

/**
 * The window a sitting is open for. Separate from the policy because the
 * window may be edited while an assessment is still a draft, and is frozen
 * by the database the moment it is published.
 */
export const assessmentWindowSchema = z
  .object({ opensAt: z.date(), closesAt: z.date() })
  .superRefine((value, ctx) => {
    if (value.closesAt <= value.opensAt) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["closesAt"],
        message: "The assessment must close after it opens.",
      });
    }
  });

/**
 * Does this sitting need a network allowlist? A lab sitting's allowlist IS
 * the enforcement (SPEC §5), so an empty one would be a lab-proctored
 * session with nothing proctoring it — refused by the server and by
 * `ExamSession_lab_allowlist`.
 */
export function requiresCidrAllowlist(proctorMode: ProctorMode): boolean {
  return proctorMode === "LAB_SUPERVISED";
}

export const LAB_NEEDS_ALLOWLIST_MESSAGE =
  "A lab-supervised sitting must list the lab's network ranges: the allowlist is what ends a session when a candidate leaves the lab network.";
