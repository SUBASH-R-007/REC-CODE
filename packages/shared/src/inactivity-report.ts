import { z } from "zod";
import { SWEEP_HOLDBACKS, type SweepHoldback } from "./inactivity";

/**
 * What the inactivity sweep reports, as one definition (Phase 12w).
 *
 * The job writes this object to `SchedulerJobStatus.lastReport` on every
 * tick, and from 12w a super-admin reads it on `/super/jobs` before deciding
 * whether to let the policy act at all. That makes it a contract between two
 * packages rather than a job's private summary: the scheduler produces it and
 * the web app renders it, and neither imports the other.
 *
 * So the shape lives here, in the package both of them already depend on, and
 * the scheduler's `InactivitySweepReport` is this type. The alternative — an
 * interface in the job and a zod schema in the query that reads it — is two
 * lists kept in step by hand, and the first field anybody adds to one of them
 * would render as `undefined` on a page a restriction decision is taken from.
 *
 * Every count has a default, because a row written before the field existed
 * is a row that still has to render. Nothing here is `.strict()`: a stored
 * report from a newer scheduler than the page must not fail to parse.
 */

const count = z.number().int().nonnegative().catch(0).default(0);

/** One line of the sample a human reads: codes and counts, never a name. */
export const inactivitySweepSampleSchema = z.object({
  collegeId: z.string(),
  stage: z.string(),
  toStage: z.string(),
  kind: z.string(),
  countedInactiveDays: count,
  excludedDays: count,
  holdback: z.enum(SWEEP_HOLDBACKS).nullable().catch(null).default(null),
  reason: z.string().default(""),
});

export const inactivitySweepReportSchema = z.object({
  /** The campus day evaluated, or null when the hour gate said not yet. */
  evaluationDay: z.string().nullable().default(null),
  ran: z.boolean().default(false),
  /** Why it did not run, when it did not. */
  skipped: z.enum(["not-the-hour", "already-run-today", "no-active-policy"]).optional(),
  considered: count,
  /**
   * What it did, by kind — or would have done under `--dry-run` or a
   * report-only policy, which is what the names still say. Kept as `would…`
   * because the report is read for exactly that comparison, and renaming
   * them would make the two runs harder to compare, which is the one thing
   * the report exists for.
   */
  wouldEscalate: count,
  wouldClear: count,
  held: count,
  /** Held back, by reason — the number an administrator acts on. */
  heldBy: z.record(z.enum(SWEEP_HOLDBACKS), z.number()).default({}),
  /** Students the job would stop at SOFT_RESTRICTED and hand to a human. */
  adminReview: count,
  /** Actually written. Zero in dry-run mode, by construction. */
  escalated: count,
  cleared: count,
  /**
   * Writes WITHHELD because the policy that produced them is report-only
   * (Phase 12w) — the counterpart of `--dry-run` for one policy rather than
   * the whole process.
   */
  reportOnly: count,
  /** Active policies that do not enforce. The mode, stated whatever happened. */
  reportOnlyPolicies: count,
  /** Another writer got there first: a solve, a staff member, or the other instance. */
  racedAway: count,
  mentorsNotified: count,
  contestSubmissionsCancelled: count,
  /** True when the calendar did not cover the window for anybody at all. */
  calendarIncomplete: z.boolean().default(false),
  /** A readable sample, for the report a human reads. Counts and codes only. */
  sample: z.array(inactivitySweepSampleSchema).default([]),
  failed: z.boolean().default(false),
  error: z.string().optional(),
});

export type InactivitySweepReport = z.infer<typeof inactivitySweepReportSchema>;
export type InactivitySweepSample = z.infer<typeof inactivitySweepSampleSchema>;

/** Zero of everything, which is also what an empty `heldBy` has to mean. */
export function emptyHeldBy(): Record<SweepHoldback, number> {
  return Object.fromEntries(SWEEP_HOLDBACKS.map((key) => [key, 0])) as Record<SweepHoldback, number>;
}

/**
 * What mode a stored report was produced in, for the one line a page leads
 * with and the one an operator greps for.
 *
 * There are three, and telling them apart is the whole point of 12w: a
 * process-wide dry run, a policy that does not enforce, and a sweep that
 * acted. The report alone cannot see `--dry-run` (that is a field on the
 * scheduler's own log line), so this answers the question the report CAN
 * answer: did anything get written, and if not, why not.
 */
export function describeSweepMode(report: InactivitySweepReport): {
  readonly wrote: boolean;
  readonly reportOnly: boolean;
  readonly line: string;
} {
  const wrote = report.escalated + report.cleared > 0;
  const reportOnly = report.reportOnlyPolicies > 0;
  if (!report.ran) {
    return {
      wrote: false,
      reportOnly,
      line:
        report.skipped === "no-active-policy"
          ? "No policy is live, so the engine did nothing — which is a choice, not a gap."
          : report.skipped === "already-run-today"
            ? "Already run for this campus day."
            : "Not the hour: the sweep runs once a day, at 02:00 campus time.",
    };
  }
  if (!reportOnly) {
    return {
      wrote,
      reportOnly: false,
      line: wrote
        ? "Enforcing: the decisions below were written."
        : "Enforcing, and there was nothing to write.",
    };
  }
  return {
    wrote,
    reportOnly: true,
    line: wrote
      ? "Partly report-only: some policies acted and others only reported."
      : "Report-only: the engine worked all of this out and wrote none of it.",
  };
}
