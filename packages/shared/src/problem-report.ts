/**
 * A student says this problem is wrong (Phase 16a).
 *
 * Every problem in this catalogue was authored here. There is no upstream to
 * inherit a corrected test case from and no million-submission population to
 * surface a bad one by statistics: on the day a problem is published, the
 * only people who will ever read it carefully are the students sitting in
 * front of it. A platform in that position with no way for them to say "the
 * expected output for case 3 looks wrong" discovers its defects through a
 * staff member who happens to hear about one in a corridor.
 *
 * Discussion is not that channel. `docs/ROADMAP.md` §3.2 says why: a thread
 * is a conversation, and a conversation has no queue, no owner and no state
 * — three students can each say the same thing, a mentor can answer the
 * third one, and the author never learns. A report is a row with a decision
 * on it.
 *
 * **Three decisions inside it.**
 *
 * It attaches to a `ProblemVersion`, not a `Problem`. A revision is frozen on
 * publish and immutable thereafter, so "case 3 is wrong" is a statement about
 * exact bytes. A report against the problem would survive the edit that fixed
 * it and read as still open; one against the revision is answered by the
 * revision that replaced it.
 *
 * It never withholds anything by itself. An OPEN report has no effect on
 * anything — no unpublish, no delisting, no refusal. That is not timidity: a
 * report that automatically kept a problem out of a paper would hand every
 * student a veto over the paper they are about to sit, which is the clearest
 * abuse vector this product could grow. Withholding follows a staff member
 * UPHOLDING the report and choosing a hold, which is the project's rule
 * everywhere else — the maximum automatic consequence is that a human is
 * told.
 *
 * One open report per student per revision. Not a rate limit in disguise: a
 * student who has already said this revision is wrong has nothing to add by
 * saying it again, and a queue with four rows from one person is a queue
 * somebody stops reading. They may file again on the next revision, and they
 * may file a second report once the first is decided.
 */

export const PROBLEM_REPORT_REASONS = [
  "WRONG_EXPECTED_OUTPUT",
  "STATEMENT_UNCLEAR",
  "STATEMENT_CONTRADICTS_SAMPLES",
  "LIMITS_TOO_TIGHT",
  "MISSING_CONSTRAINT",
  "OTHER",
] as const;
export type ProblemReportReason = (typeof PROBLEM_REPORT_REASONS)[number];

/** What a student picks from. Written as the student's own sentence, not as a category name. */
export const PROBLEM_REPORT_REASON_LABEL: Readonly<Record<ProblemReportReason, string>> = Object.freeze({
  WRONG_EXPECTED_OUTPUT: "A test case looks wrong",
  STATEMENT_UNCLEAR: "The statement does not say what to do",
  STATEMENT_CONTRADICTS_SAMPLES: "The statement and the samples disagree",
  LIMITS_TOO_TIGHT: "The time or memory limit looks too tight",
  MISSING_CONSTRAINT: "A constraint is missing or wrong",
  OTHER: "Something else",
});

/**
 * The reasons that are a claim about the problem being WRONG rather than
 * unclear. Nothing in the engine treats them differently; the staff queue
 * sorts by them, because a wrong expected output invalidates marks and an
 * unclear sentence does not.
 */
export const PROBLEM_REPORT_CORRECTNESS_REASONS: readonly ProblemReportReason[] = Object.freeze([
  "WRONG_EXPECTED_OUTPUT",
  "STATEMENT_CONTRADICTS_SAMPLES",
  "MISSING_CONSTRAINT",
]);

export function isCorrectnessReport(reason: ProblemReportReason): boolean {
  return PROBLEM_REPORT_CORRECTNESS_REASONS.includes(reason);
}

export const PROBLEM_REPORT_LIMITS = Object.freeze({
  /** Long enough for "case 3 expects 7 but 1+2+3 is 6"; short enough that it is read. */
  detail: 1_000,
  /** The staff member's answer, which the student is shown. */
  resolution: 1_000,
  /** Why a problem is being withheld from new papers. Read by the next examiner, so it is required. */
  holdReason: 300,
});

export const PROBLEM_REPORT_STATUSES = ["OPEN", "UPHELD", "DISMISSED"] as const;
export type ProblemReportStatus = (typeof PROBLEM_REPORT_STATUSES)[number];

/** The sentence a student is shown while their report is unanswered. */
export const PROBLEM_REPORT_OPEN_NOTE =
  "Reported. A staff member reads these; you will see their answer here. Nothing about your submissions changes in the meantime.";

/** The sentence a student is shown when they have already reported this revision. */
export const PROBLEM_REPORT_DUPLICATE =
  "You have already reported this revision and it has not been answered yet. Add nothing further — a second report says the same thing to the same person.";

/**
 * The sentence an examiner reads when a held problem is refused a pin. The
 * database raises its own version of this; this is the one the action says,
 * before the constraint fires.
 */
export function problemHeldMessage(reason: string): string {
  const why = reason.trim();
  return `That problem is withheld from new papers while a reported defect is open: ${
    why.length > 0 ? why : "no reason was recorded"
  }. Pick another problem, or clear the hold on the problem's page.`;
}

/** A decision needs an answer. An UPHELD report with no sentence is a decision nobody can read. */
export interface ProblemReportDecision {
  readonly status: Exclude<ProblemReportStatus, "OPEN">;
  readonly resolution: string;
  /** Only meaningful when upholding: withhold the problem from NEW papers. */
  readonly hold: boolean;
  readonly holdReason: string | null;
}

export type ProblemReportDecisionProblem =
  | "resolution-missing"
  | "resolution-too-long"
  | "hold-reason-missing"
  | "hold-reason-too-long"
  | "hold-without-upholding";

/**
 * Pure, so the rule is testable without a database and identical in the
 * action and in the form. Returns null when the decision is well formed.
 */
export function problemReportDecisionProblem(input: ProblemReportDecision): ProblemReportDecisionProblem | null {
  const resolution = input.resolution.trim();
  if (resolution.length === 0) return "resolution-missing";
  if (resolution.length > PROBLEM_REPORT_LIMITS.resolution) return "resolution-too-long";
  if (!input.hold) return null;
  if (input.status !== "UPHELD") return "hold-without-upholding";
  const reason = (input.holdReason ?? "").trim();
  if (reason.length === 0) return "hold-reason-missing";
  if (reason.length > PROBLEM_REPORT_LIMITS.holdReason) return "hold-reason-too-long";
  return null;
}

export const PROBLEM_REPORT_DECISION_MESSAGE: Readonly<Record<ProblemReportDecisionProblem, string>> = Object.freeze({
  "resolution-missing": "Write what you decided. The student is shown this sentence.",
  "resolution-too-long": `Keep the answer under ${PROBLEM_REPORT_LIMITS.resolution} characters.`,
  "hold-reason-missing": "A hold needs a reason: the next examiner reads it instead of guessing.",
  "hold-reason-too-long": `Keep the hold reason under ${PROBLEM_REPORT_LIMITS.holdReason} characters.`,
  "hold-without-upholding": "A problem is only withheld when the report is upheld.",
});
