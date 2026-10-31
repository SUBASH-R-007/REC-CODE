import { READINESS_TIERS, type ReadinessTier } from "./readiness";

/**
 * Placement drives, and the one thing the platform may never do about them
 * (Phase 9f).
 *
 * SPEC §5: eligibility is "a human decision recorded in the audit log". So
 * there is no function in this module that decides anything. What is here is
 * the COUNT an officer reads before deciding, and the words the surfaces use
 * to keep the distinction visible:
 *
 *   - `driveCount()` says how many students clear a threshold. That is a
 *     number, not a list and not a decision.
 *   - `ELIGIBILITY_FRAMING` is rendered beside it, because a page that shows
 *     "214 clear the bar" next to a button marked "mark eligible" invites
 *     exactly the automatic decision the spec forbids.
 *
 * The threshold is on the NORMALISED figure — score as a percentage of what
 * was measurable — and that is the correction the design's own review found.
 * With `mockInterviewScore` permanently unsourced, no TOP score can exceed
 * 85; counting "students at TOP >= 70" against a raw 70 would mark a whole
 * cohort as under-prepared because of a component nobody has built.
 */

export const DRIVE_ELIGIBILITY = ["ELIGIBLE", "NOT_ELIGIBLE"] as const;
export type DriveEligibility = (typeof DRIVE_ELIGIBILITY)[number];

export const DRIVE_ELIGIBILITY_LABEL: Readonly<Record<DriveEligibility, string>> = {
  ELIGIBLE: "Eligible",
  NOT_ELIGIBLE: "Not eligible",
};

/** The shortest reason a decision may carry. The database enforces it too. */
export const DRIVE_REASON_MIN = 10;

export interface DriveThreshold {
  readonly tier: ReadinessTier;
  /** 0–100 on the NORMALISED figure, or null for "no readiness bar at all". */
  readonly thresholdScore: number | null;
}

export interface MeasuredStudent {
  readonly score: number | null;
  readonly availableWeight: number;
}

export interface DriveCount {
  readonly tier: ReadinessTier;
  readonly thresholdScore: number | null;
  /** Students at or above the threshold, as a percentage of what was measurable. */
  readonly clearing: number;
  /** Students with a score at all. The count's denominator. */
  readonly measured: number;
  /** Students with nothing measurable in the tier — neither clearing nor not. */
  readonly unmeasurable: number;
}

/**
 * How many students clear a drive's bar.
 *
 * A student with nothing measurable in the tier is counted in neither
 * direction. That is the honest answer and it is not a convenience: they are
 * not "below the bar", they are unmeasured, and folding them into the second
 * number would let an officer read "40 of 214 fall short" when forty of them
 * were never assessed.
 */
export function driveCount(threshold: DriveThreshold, rows: readonly MeasuredStudent[]): DriveCount {
  let clearing = 0;
  let measured = 0;
  let unmeasurable = 0;

  for (const row of rows) {
    if (row.score === null || row.availableWeight <= 0) {
      unmeasurable += 1;
      continue;
    }
    measured += 1;
    const normalised = (row.score / row.availableWeight) * 100;
    if (threshold.thresholdScore === null || normalised >= threshold.thresholdScore) clearing += 1;
  }

  return { tier: threshold.tier, thresholdScore: threshold.thresholdScore, clearing, measured, unmeasurable };
}

/**
 * The sentence a count is rendered as.
 *
 * The denominator is in the words, not in a tooltip: the design's review
 * caught the draft printing "214 students at PRODUCT >= 70" with nothing to
 * say 70 of what.
 */
export function describeDriveCount(count: DriveCount): string {
  const bar =
    count.thresholdScore === null
      ? "with any readiness figure at all"
      : `at ${count.tier} ≥ ${count.thresholdScore}% of what was measurable for them`;
  const tail =
    count.unmeasurable > 0
      ? ` ${count.unmeasurable} more had nothing measurable in this tier, so they are counted neither way.`
      : "";
  return `${count.clearing} of ${count.measured} students ${bar}.${tail}`;
}

/**
 * The framing rendered beside every count and every decision form.
 *
 * SPEC §5 and §7 both land here: the platform produces a number, a human
 * makes the decision, and the decision is recorded with its reason. A page
 * that showed the number next to a one-click "mark all eligible" would be the
 * automatic decision the spec forbids, dressed as a convenience.
 */
export const ELIGIBILITY_FRAMING =
  "This count is information for a human decision, not the decision. Eligibility for a drive is recorded per student with the reason it was given, by the person who gave it — the platform never decides it, and a readiness figure on its own is never a reason.";

/** What a decision form says above the reason box. */
export const DECISION_REASON_HINT =
  "Say why, in a sentence. It is recorded against your name and it is what somebody reads months later when a student asks why.";

export function isDriveTier(value: unknown): value is ReadinessTier {
  return typeof value === "string" && (READINESS_TIERS as readonly string[]).includes(value);
}
