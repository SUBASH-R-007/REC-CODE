import type { MockAttemptStatus } from "./mock-pattern";

/**
 * Navigation inside a sitting, as pure predicates (Phase 7c).
 *
 * SPEC §5's gate for this phase, in its own words: *a test asserts
 * `allowBackNavigation: false` is enforced server-side, not just in the UI.*
 *
 * So the rule is a function here, called by the answer action before it
 * writes, and mirrored by `recx_refuse_closed_section_write` in the database.
 * Three fences for one rule, and the gating test never renders anything:
 *
 *   1. `canAnswer()` below — pure, and the action's first statement;
 *   2. `MockSectionState.highWaterIndex`, a server-written column the client
 *      cannot move backwards;
 *   3. the trigger, which refuses the same two writes as raw SQL.
 *
 * A client that forgets the rule is a client that hands back the advantage
 * the setting exists to remove, which is why none of the three is the UI.
 */

export const ANSWER_REFUSAL_REASONS = [
  /** The section's own deadline has passed, or it was submitted. */
  "section_closed",
  /** `allowBackNavigation: false` and this question is behind the high-water mark. */
  "no_back_navigation",
  /** Beyond the furthest question the server has served. */
  "not_yet_served",
  /** The paper's deadline has passed. */
  "attempt_expired",
  /** The attempt is not in progress at all. */
  "attempt_finished",
] as const;
export type AnswerRefusalReason = (typeof ANSWER_REFUSAL_REASONS)[number];

/** Why a candidate is being refused, in words they can act on. */
export const ANSWER_REFUSAL_MESSAGE: Readonly<Record<AnswerRefusalReason, string>> = Object.freeze({
  section_closed: "This section has closed. Your answers in it are saved and scored.",
  no_back_navigation:
    "This section does not allow going back to an earlier question. That is stated on the cover page before you start.",
  not_yet_served: "You have not reached that question yet.",
  attempt_expired: "Time is up for this paper. Everything you answered is saved and scored.",
  attempt_finished: "This sitting has already finished.",
});

export interface AnswerContext {
  readonly status: MockAttemptStatus;
  readonly attemptExpired: boolean;
  readonly allowBackNavigation: boolean;
  /** 0-based index within the section, as served. */
  readonly index: number;
  /** The furthest index the server has served in this section. */
  readonly highWaterIndex: number;
  readonly sectionSubmittedAt: Date | null;
  readonly sectionEnded: boolean;
}

export type AnswerDecision = { readonly allowed: true } | { readonly allowed: false; readonly reason: AnswerRefusalReason };

const ALLOWED: AnswerDecision = { allowed: true };

/**
 * May this answer be written?
 *
 * The order matters. A candidate whose time ran out is told that, not that
 * they cannot go back — the first true thing is the most useful one, and a
 * refusal that names the wrong cause is a refusal that reads as a bug.
 */
export function canAnswer(context: AnswerContext): AnswerDecision {
  if (context.status !== "IN_PROGRESS") return { allowed: false, reason: "attempt_finished" };
  if (context.attemptExpired) return { allowed: false, reason: "attempt_expired" };
  if (context.sectionSubmittedAt !== null || context.sectionEnded) {
    return { allowed: false, reason: "section_closed" };
  }
  if (context.index > context.highWaterIndex) return { allowed: false, reason: "not_yet_served" };
  // The rule the gate is about. `index === highWaterIndex` is the question in
  // front of the candidate and stays editable until they move on; anything
  // below it is behind them.
  if (!context.allowBackNavigation && context.index < context.highWaterIndex) {
    return { allowed: false, reason: "no_back_navigation" };
  }
  return ALLOWED;
}

/**
 * The next index the candidate may be shown, or null at the end of the
 * section.
 *
 * With back navigation off this only ever moves forward, so the high-water
 * mark can only rise.
 */
export function nextServableIndex(args: {
  readonly index: number;
  readonly questionCount: number;
  readonly allowBackNavigation: boolean;
  readonly highWaterIndex: number;
}): number | null {
  const next = args.index + 1;
  if (next >= args.questionCount) return null;
  if (!args.allowBackNavigation) return Math.max(next, args.highWaterIndex);
  return next;
}

/** Every index a candidate may jump to in this section right now. */
export function servableIndexes(args: {
  readonly questionCount: number;
  readonly allowBackNavigation: boolean;
  readonly highWaterIndex: number;
}): number[] {
  const highest = Math.min(args.highWaterIndex, args.questionCount - 1);
  if (highest < 0) return [];
  if (!args.allowBackNavigation) return [highest];
  return Array.from({ length: highest + 1 }, (_, i) => i);
}

/**
 * May the candidate move to the next section?
 *
 * Yes when this one is over, by their own hand or by its clock. "Yes, with
 * questions unanswered" is deliberately allowed: a candidate who wants to
 * move on is entitled to, and an unanswered question costs them nothing extra
 * (`gradeAnswer()` rule 1).
 */
export function canAdvanceSection(args: {
  readonly status: MockAttemptStatus;
  readonly attemptExpired: boolean;
  readonly hasNextSection: boolean;
}): { allowed: boolean; reason?: AnswerRefusalReason } {
  if (args.status !== "IN_PROGRESS") return { allowed: false, reason: "attempt_finished" };
  if (args.attemptExpired) return { allowed: false, reason: "attempt_expired" };
  if (!args.hasNextSection) return { allowed: false, reason: "section_closed" };
  return { allowed: true };
}

/**
 * The attempt status machine, mirrored by `recx_refuse_mock_attempt_change`.
 *
 * IN_PROGRESS is the only state with exits, and all three are terminal: a
 * finished sitting never restarts, because its answers have been scored and
 * its XP written. There is no VOIDED and no TERMINATED to reach — a practice
 * mock has no invigilator, and an enum with no voiding value is an enum no
 * future code path can void from.
 */
export function canTransitionMock(from: MockAttemptStatus, to: MockAttemptStatus): boolean {
  if (from === to) return true;
  if (from !== "IN_PROGRESS") return false;
  return to === "SUBMITTED" || to === "AUTO_SUBMITTED" || to === "ABANDONED";
}

/** The statuses that mean the paper is over and scored. */
export const FINALISED_MOCK_STATUSES = ["SUBMITTED", "AUTO_SUBMITTED"] as const;

export function isFinalisedMock(status: MockAttemptStatus): boolean {
  return (FINALISED_MOCK_STATUSES as readonly string[]).includes(status);
}
