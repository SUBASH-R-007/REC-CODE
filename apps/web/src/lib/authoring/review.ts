import "server-only";
import type { DbTx, ProblemReviewAction } from "@recx/db";
import { contentErrors, planReviewTransition, reviewStageOf, versionContentIssues, type ReviewAction } from "@recx/shared/authoring";
import { audit } from "@/lib/audit";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { getValidationStatusTx, lockVersion } from "@/lib/judge/validation";
import { loadVersionContentInput } from "./content-input";
import { DRAFT_CONFLICT } from "./draft";
import { retryingTransaction } from "./retry";

/**
 * The review flow of a revision: DRAFT → IN_REVIEW → APPROVED → PUBLISHED.
 *
 *   submit    DRAFT → IN_REVIEW. Needs no content errors and the submitter's
 *             attestation that the content is originally authored.
 *   withdraw  IN_REVIEW | APPROVED → DRAFT (clears submission and approval).
 *   return    the same, by a reviewer, with a comment for the author.
 *   approve   IN_REVIEW → APPROVED. The approver must not be the revision's
 *             creator, its last editor or its submitter (the operator CLI's
 *             --approve, actorId null, is the one exception); validation
 *             must be publishable and the content free of errors.
 *   revoke    APPROVED → IN_REVIEW (check-approved --revoke, or a reviewer).
 *
 * Each step locks the revision, changes it with an update conditional on
 * the state it read (0 rows → ConflictError), writes a ProblemReview row and
 * is audited. A never-published problem mirrors its first revision's review
 * state on Problem.status (DRAFT ↔ IN_REVIEW).
 */

export interface ReviewActor {
  actorId: string | null;
  via: string;
  ipHash?: string | null;
}

export interface ReviewOutcome {
  versionId: string;
  problemId: string;
  revision: number;
}

const SELF_APPROVAL =
  "You created, edited or submitted this revision, so you cannot approve it. Another admin must review and approve it.";

async function loadHead(tx: DbTx, versionId: string) {
  await lockVersion(tx, versionId);
  const v = await tx.problemVersion.findUnique({
    where: { id: versionId },
    select: {
      id: true,
      problemId: true,
      revision: true,
      status: true,
      approvedAt: true,
      frozenAt: true,
      editSeq: true,
      createdById: true,
      submittedById: true,
      lastEditedById: true,
      problem: { select: { status: true, liveVersionId: true } },
    },
  });
  if (!v) throw new NotFoundError("That revision was not found.");
  return v;
}

function assertTransition(v: Awaited<ReturnType<typeof loadHead>>, action: ReviewAction): void {
  if (v.frozenAt) throw new ConflictError(DRAFT_CONFLICT.frozen);
  const plan = planReviewTransition(reviewStageOf(v, v.problem), action);
  if (!plan.ok) throw new ConflictError(plan.reason);
}

async function record(
  tx: DbTx,
  versionId: string,
  action: ProblemReviewAction,
  actorId: string | null,
  comment: string | null,
  attestedOriginal = false,
): Promise<void> {
  await tx.problemReview.create({ data: { problemVersionId: versionId, action, actorId, comment, attestedOriginal } });
}

async function contentErrorMessages(tx: DbTx, versionId: string): Promise<string[]> {
  const input = await loadVersionContentInput(tx, versionId);
  return input ? contentErrors(versionContentIssues(input)).map((i) => i.message) : ["The revision has no content."];
}

function blockedMessage(prefix: string, reasons: readonly string[]): string {
  const more = reasons.length > 1 ? ` (+${reasons.length - 1} more — see the validation report)` : "";
  return `${prefix}: ${reasons[0]}${more}`;
}

export async function submitVersionForReview(
  input: { versionId: string; expectedEditSeq: number; attestedOriginal: true; comment?: string | null },
  actor: ReviewActor,
): Promise<ReviewOutcome> {
  if (input.attestedOriginal !== true) throw new ValidationError("Confirm that the content is originally authored.");
  const out = await retryingTransaction(
    async (tx) => {
      const v = await loadHead(tx, input.versionId);
      assertTransition(v, "SUBMIT");
      if (v.editSeq !== input.expectedEditSeq) throw new ConflictError(DRAFT_CONFLICT.stale);
      const errors = await contentErrorMessages(tx, v.id);
      if (errors.length > 0) throw new ValidationError(blockedMessage("Fix the content before submitting it", errors));
      const moved = await tx.problemVersion.updateMany({
        where: { id: v.id, status: "DRAFT", frozenAt: null, editSeq: input.expectedEditSeq },
        data: {
          status: "IN_REVIEW",
          submittedForReviewAt: new Date(),
          submittedById: actor.actorId,
          approvedAt: null,
          approvedById: null,
        },
      });
      if (moved.count === 0) throw new ConflictError(DRAFT_CONFLICT.stale);
      await tx.problem.updateMany({
        where: { id: v.problemId, liveVersionId: null, status: "DRAFT" },
        data: { status: "IN_REVIEW" },
      });
      await record(tx, v.id, "SUBMITTED", actor.actorId, input.comment ?? null, true);
      return { versionId: v.id, problemId: v.problemId, revision: v.revision };
    },
    { timeout: 30_000 },
  );
  await audit({
    actorId: actor.actorId,
    action: "problem.review.submitted",
    entityType: "ProblemVersion",
    entityId: out.versionId,
    sensitivity: "NORMAL",
    metadata: { problemId: out.problemId, revision: out.revision, attestedOriginal: true, via: actor.via },
    ipHash: actor.ipHash ?? null,
  });
  return out;
}

async function backToDraft(
  input: { versionId: string; comment: string | null },
  actor: ReviewActor,
  action: "WITHDRAW" | "RETURN",
): Promise<ReviewOutcome & { wasApproved: boolean }> {
  return retryingTransaction(
    async (tx) => {
      const v = await loadHead(tx, input.versionId);
      assertTransition(v, action);
      const moved = await tx.problemVersion.updateMany({
        where: { id: v.id, status: "IN_REVIEW", frozenAt: null },
        data: { status: "DRAFT", submittedForReviewAt: null, submittedById: null, approvedAt: null, approvedById: null },
      });
      if (moved.count === 0) throw new ConflictError(DRAFT_CONFLICT.stale);
      await tx.problem.updateMany({
        where: { id: v.problemId, liveVersionId: null, status: "IN_REVIEW" },
        data: { status: "DRAFT" },
      });
      await record(tx, v.id, action === "WITHDRAW" ? "WITHDRAWN" : "RETURNED", actor.actorId, input.comment);
      return { versionId: v.id, problemId: v.problemId, revision: v.revision, wasApproved: v.approvedAt !== null };
    },
    { timeout: 30_000 },
  );
}

export async function withdrawVersion(input: { versionId: string; comment?: string | null }, actor: ReviewActor): Promise<ReviewOutcome> {
  const out = await backToDraft({ versionId: input.versionId, comment: input.comment ?? null }, actor, "WITHDRAW");
  await audit({
    actorId: actor.actorId,
    action: "problem.review.withdrawn",
    entityType: "ProblemVersion",
    entityId: out.versionId,
    sensitivity: "NORMAL",
    metadata: { problemId: out.problemId, revision: out.revision, approvalCleared: out.wasApproved, via: actor.via },
    ipHash: actor.ipHash ?? null,
  });
  return out;
}

export async function returnVersion(input: { versionId: string; comment: string }, actor: ReviewActor): Promise<ReviewOutcome> {
  if (input.comment.trim().length < 5) throw new ValidationError("Tell the author what to change (at least 5 characters).");
  const out = await backToDraft({ versionId: input.versionId, comment: input.comment.trim() }, actor, "RETURN");
  await audit({
    actorId: actor.actorId,
    action: "problem.review.returned",
    entityType: "ProblemVersion",
    entityId: out.versionId,
    sensitivity: "NORMAL",
    metadata: { problemId: out.problemId, revision: out.revision, approvalCleared: out.wasApproved, via: actor.via },
    ipHash: actor.ipHash ?? null,
  });
  return out;
}

export async function approveVersion(input: { versionId: string; comment?: string | null }, actor: ReviewActor): Promise<ReviewOutcome> {
  const out = await retryingTransaction(
    async (tx) => {
      const v = await loadHead(tx, input.versionId);
      assertTransition(v, "APPROVE");
      if (actor.actorId !== null && [v.createdById, v.submittedById, v.lastEditedById].includes(actor.actorId)) {
        throw new ValidationError(SELF_APPROVAL);
      }
      const status = await getValidationStatusTx(tx, v.id);
      const reasons = [...status.blockers, ...(await contentErrorMessages(tx, v.id))];
      if (!status.publishable || reasons.length > 0) {
        throw new ValidationError(blockedMessage("Approval is blocked", reasons.length > 0 ? reasons : ["validation is not complete"]));
      }
      const moved = await tx.problemVersion.updateMany({
        where: { id: v.id, status: "IN_REVIEW", approvedAt: null, frozenAt: null },
        data: { approvedAt: new Date(), approvedById: actor.actorId },
      });
      if (moved.count === 0) throw new ConflictError("This revision was approved or changed a moment ago. Reload the page.");
      await record(tx, v.id, "APPROVED", actor.actorId, input.comment ?? null);
      return { versionId: v.id, problemId: v.problemId, revision: v.revision, judgeSeq: status.judgeSeq };
    },
    { timeout: 30_000 },
  );
  await audit({
    actorId: actor.actorId,
    action: "problem.review.approved",
    entityType: "ProblemVersion",
    entityId: out.versionId,
    sensitivity: "SENSITIVE",
    metadata: {
      problemId: out.problemId,
      revision: out.revision,
      judgeSeq: out.judgeSeq,
      operatorApproval: actor.actorId === null,
      via: actor.via,
    },
    ipHash: actor.ipHash ?? null,
  });
  return { versionId: out.versionId, problemId: out.problemId, revision: out.revision };
}

/** APPROVED → IN_REVIEW: the approval no longer holds (e.g. a toolchain change broke a reference solution). */
export async function revokeApproval(input: { versionId: string; reason: string }, actor: ReviewActor): Promise<ReviewOutcome> {
  if (input.reason.trim().length < 5) throw new ValidationError("Give a reason of at least 5 characters — it is recorded in the audit log.");
  const out = await retryingTransaction(
    async (tx) => {
      const v = await loadHead(tx, input.versionId);
      assertTransition(v, "REVOKE");
      const moved = await tx.problemVersion.updateMany({
        where: { id: v.id, status: "IN_REVIEW", approvedAt: { not: null }, frozenAt: null },
        data: { approvedAt: null, approvedById: null },
      });
      if (moved.count === 0) throw new ConflictError(DRAFT_CONFLICT.stale);
      await record(tx, v.id, "APPROVAL_REVOKED", actor.actorId, input.reason.trim());
      return { versionId: v.id, problemId: v.problemId, revision: v.revision };
    },
    { timeout: 30_000 },
  );
  await audit({
    actorId: actor.actorId,
    action: "problem.review.approval_revoked",
    entityType: "ProblemVersion",
    entityId: out.versionId,
    sensitivity: "SENSITIVE",
    metadata: { problemId: out.problemId, revision: out.revision, reason: input.reason.trim(), via: actor.via },
    ipHash: actor.ipHash ?? null,
  });
  return out;
}
