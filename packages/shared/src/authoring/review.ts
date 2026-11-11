/**
 * The review lifecycle of a problem revision, as one pure function.
 *
 * The database keeps the spec's ProblemStatus enum unchanged
 * (DRAFT / IN_REVIEW / PUBLISHED / RETIRED). The review stages an author
 * sees are derived from it:
 *
 *   DRAFT       ProblemVersion.status DRAFT, not frozen
 *   IN_REVIEW   status IN_REVIEW, approvedAt null
 *   APPROVED    status IN_REVIEW, approvedAt set (the approval freezes with
 *               the version on publish, so it records who approved what
 *               students see)
 *   PUBLISHED   frozen and the problem's live version
 *   SUPERSEDED  frozen but no longer live (a newer revision was published)
 *   RETIRED     the live version of a problem whose Problem.status is RETIRED
 *               (a frozen version cannot be written, so RETIRED lives on
 *               Problem only)
 *
 * A "problem draft" is a ProblemVersion whose frozenAt is null; there is no
 * separate table.
 */

export const PROBLEM_STATUSES = ["DRAFT", "IN_REVIEW", "PUBLISHED", "RETIRED"] as const;
export type ProblemStatusValue = (typeof PROBLEM_STATUSES)[number];

export const REVIEW_STAGES = ["DRAFT", "IN_REVIEW", "APPROVED", "PUBLISHED", "SUPERSEDED", "RETIRED"] as const;
export type ReviewStage = (typeof REVIEW_STAGES)[number];

export const REVIEW_STAGE_LABEL: Readonly<Record<ReviewStage, string>> = {
  DRAFT: "Draft",
  IN_REVIEW: "In review",
  APPROVED: "Approved",
  PUBLISHED: "Published",
  SUPERSEDED: "Superseded",
  RETIRED: "Retired",
};

export const REVIEW_ACTIONS = ["SUBMIT", "WITHDRAW", "RETURN", "APPROVE", "REVOKE", "PUBLISH", "RETIRE"] as const;
export type ReviewAction = (typeof REVIEW_ACTIONS)[number];

export function isReviewStage(value: unknown): value is ReviewStage {
  return typeof value === "string" && (REVIEW_STAGES as readonly string[]).includes(value);
}

export interface ReviewVersionState {
  id: string;
  status: ProblemStatusValue;
  approvedAt: Date | string | null;
  frozenAt: Date | string | null;
}

export interface ReviewProblemState {
  status: ProblemStatusValue;
  liveVersionId: string | null;
}

/** The review stage of one revision of a problem. */
export function reviewStageOf(v: ReviewVersionState, p: ReviewProblemState): ReviewStage {
  if (v.frozenAt !== null) {
    if (p.liveVersionId === v.id) return p.status === "RETIRED" ? "RETIRED" : "PUBLISHED";
    return "SUPERSEDED";
  }
  if (v.status === "IN_REVIEW") return v.approvedAt !== null ? "APPROVED" : "IN_REVIEW";
  return "DRAFT";
}

const TRANSITIONS: Readonly<Record<ReviewAction, { from: readonly ReviewStage[]; to: ReviewStage; verb: string }>> = {
  SUBMIT: { from: ["DRAFT"], to: "IN_REVIEW", verb: "submit for review" },
  WITHDRAW: { from: ["IN_REVIEW", "APPROVED"], to: "DRAFT", verb: "withdraw" },
  RETURN: { from: ["IN_REVIEW", "APPROVED"], to: "DRAFT", verb: "return to the author" },
  APPROVE: { from: ["IN_REVIEW"], to: "APPROVED", verb: "approve" },
  REVOKE: { from: ["APPROVED"], to: "IN_REVIEW", verb: "revoke the approval of" },
  PUBLISH: { from: ["APPROVED"], to: "PUBLISHED", verb: "publish" },
  RETIRE: { from: ["PUBLISHED"], to: "RETIRED", verb: "retire" },
};

export type ReviewTransition = { ok: true; next: ReviewStage } | { ok: false; reason: string };

/** Whether `action` is allowed from `stage`, and where it leads. */
export function planReviewTransition(stage: ReviewStage, action: ReviewAction): ReviewTransition {
  const t = TRANSITIONS[action];
  if (t.from.includes(stage)) return { ok: true, next: t.to };
  const label = REVIEW_STAGE_LABEL[stage].toLowerCase();
  const needs = t.from.map((s) => REVIEW_STAGE_LABEL[s].toLowerCase()).join(" or ");
  return { ok: false, reason: `You cannot ${t.verb} a revision that is ${label}; it must be ${needs}.` };
}
