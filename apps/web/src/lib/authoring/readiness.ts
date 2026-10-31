import "server-only";
import { reviewStageOf, versionContentIssues, type ContentIssue, type ReviewStage } from "@recx/shared/authoring";
import { db } from "@/lib/db";
import { NotFoundError } from "@/lib/errors";
import {
  ALREADY_PUBLISHED_MESSAGE,
  NOT_APPROVED_BLOCKER,
  RETIRED_BLOCKER,
  getValidationStatus,
  type ValidationStatus,
} from "@/lib/judge/validation";
import { loadVersionContentInput } from "./content-input";

/**
 * Everything that stands between a revision and publishing, in the order
 * publishVersion checks it: validation, content (including the declared
 * comparator), approval, the problem not being retired. The validation
 * page renders `blockers` in its status region; the Publish button is
 * enabled only when `publishable`.
 */
export interface PublishReadiness {
  versionId: string;
  problemId: string;
  revision: number;
  stage: ReviewStage;
  approved: boolean;
  frozen: boolean;
  contentIssues: ContentIssue[];
  validation: ValidationStatus;
  /** Problem.version now — the Publish form carries it as expectedProblemVersion. */
  problemVersion: number;
  publishable: boolean;
  blockers: string[];
}

export async function getPublishReadiness(versionId: string): Promise<PublishReadiness> {
  const v = await db.problemVersion.findUnique({
    where: { id: versionId },
    select: {
      id: true,
      problemId: true,
      revision: true,
      status: true,
      approvedAt: true,
      frozenAt: true,
      problem: { select: { status: true, liveVersionId: true, version: true } },
    },
  });
  if (!v) throw new NotFoundError("That revision was not found.");
  const [validation, content] = await Promise.all([getValidationStatus(versionId), loadVersionContentInput(db, versionId)]);
  const contentIssues = content ? versionContentIssues(content) : [];
  const approved = v.status === "IN_REVIEW" && v.approvedAt !== null;
  const blockers: string[] = [];
  if (v.frozenAt) blockers.push(ALREADY_PUBLISHED_MESSAGE);
  else {
    blockers.push(...validation.blockers);
    blockers.push(...contentIssues.filter((i) => i.severity === "error").map((i) => i.message));
    if (!approved) blockers.push(NOT_APPROVED_BLOCKER);
    if (v.problem.status === "RETIRED") blockers.push(RETIRED_BLOCKER);
  }
  return {
    versionId: v.id,
    problemId: v.problemId,
    revision: v.revision,
    stage: reviewStageOf(v, v.problem),
    approved,
    frozen: v.frozenAt !== null,
    contentIssues,
    validation,
    problemVersion: v.problem.version,
    publishable: blockers.length === 0,
    blockers,
  };
}
