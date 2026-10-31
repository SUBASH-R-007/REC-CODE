"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireActionRole } from "@/lib/auth/guards";
import { audit } from "@/lib/audit";
import {
  commentSchema,
  createProblemSchema,
  idSchema,
  previewSchema,
  problemIdSchema,
  publishSchema,
  reasonSchema,
  returnSchema,
  submitSchema,
  topicsSchema,
  versionIdSchema,
  type CreateProblemInput,
} from "@/lib/authoring/schemas";
import { createProblemWithDraft, setProblemTopics as setTopics, startRevision as openRevision } from "@/lib/authoring/lifecycle";
import { approveVersion as approve, returnVersion, revokeApproval, submitVersionForReview, withdrawVersion } from "@/lib/authoring/review";
import { db } from "@/lib/db";
import { ConflictError, NotFoundError, ValidationError, runAction, type ActionResult } from "@/lib/errors";
import { requestIpHash } from "@/lib/ip";
import {
  ValidationSetupError,
  advanceValidation,
  publishVersion,
  redispatchQueuedRuns,
  startValidation,
} from "@/lib/judge/validation";
import { renderMarkdown } from "@/lib/markdown";

/**
 * Problem authoring: lifecycle, review and publish. Every export is guarded
 * server-side (ADMIN or SUPER_ADMIN — the guard is the first statement),
 * validated with zod and audited:
 *
 *   createProblem            problem.created                    NORMAL
 *   startRevision            problem.revision.created           NORMAL
 *   setProblemTopics         problem.topics.changed             NORMAL
 *   submitForReview          problem.review.submitted           NORMAL (originality attestation required)
 *   withdrawFromReview       problem.review.withdrawn           NORMAL
 *   returnToDraft            problem.review.returned            NORMAL
 *   approveVersion           problem.review.approved            SENSITIVE (approver ≠ creator, editor, submitter)
 *   revokeVersionApproval    problem.review.approval_revoked    SENSITIVE
 *   startProblemValidation   problem.validation.started         NORMAL
 *   refreshValidation        — (idempotent advance + re-dispatch)
 *   publishProblemVersion    problem.published                  SENSITIVE
 *   validateImportedDrafts   problem.validation.started (per version)
 *   previewStatement         — (pure render)
 *
 * Retiring a problem and deleting a problem or a revision are SUPER_ADMIN
 * operations with their own actions (src/server/actions/super-problems.ts).
 */

const STAFF = ["ADMIN", "SUPER_ADMIN"] as const;

function revalidateProblem(problemId: string) {
  revalidatePath("/admin/problems");
  revalidatePath(`/admin/problems/${problemId}`);
  revalidatePath(`/admin/problems/${problemId}/testcases`);
  revalidatePath(`/admin/problems/${problemId}/validate`);
}

async function problemOfVersion(versionId: string): Promise<string> {
  const v = await db.problemVersion.findUnique({ where: { id: versionId }, select: { problemId: true } });
  if (!v) throw new NotFoundError("That revision was not found.");
  return v.problemId;
}

export async function createProblem(input: CreateProblemInput): Promise<ActionResult<{ problemId: string; versionId: string }>> {
  return runAction(async () => {
    const actor = await requireActionRole(...STAFF);
    const data = createProblemSchema.parse(input);
    if (data.ioMode === "FUNCTION" && !data.functionSignature) {
      throw new ValidationError("A function problem needs its signature (JSON), including the comparator.");
    }
    const created = await createProblemWithDraft(
      {
        slug: data.slug,
        displayCode: data.displayCode,
        title: data.title,
        difficulty: data.difficulty,
        ioMode: data.ioMode,
        compareMode: data.compareMode,
        functionSignature: data.functionSignature ?? null,
        statementMd: data.statementMd,
        timeLimitMs: data.timeLimitMs,
        memoryLimitKb: data.memoryLimitMb * 1024,
        origin: data.origin,
        topics: data.topics,
      },
      { actorId: actor.id, via: "admin", ipHash: await requestIpHash() },
    );
    revalidatePath("/admin/problems");
    return created;
  }, "createProblem");
}

/** "Edit problem" / "Create new revision": the open draft, or a new one cloned from the live revision. */
export async function startRevision(input: { problemId: string }): Promise<ActionResult<{ versionId: string; revision: number; existing: boolean }>> {
  return runAction(async () => {
    const actor = await requireActionRole(...STAFF);
    const { problemId } = problemIdSchema.parse(input);
    const out = await openRevision(problemId, { actorId: actor.id, via: "admin", ipHash: await requestIpHash() });
    revalidateProblem(problemId);
    return out;
  }, "startRevision");
}

export async function setProblemTopics(input: { problemId: string; topics: string[] }): Promise<ActionResult<{ topics: string[] }>> {
  return runAction(async () => {
    const actor = await requireActionRole(...STAFF);
    const data = topicsSchema.parse(input);
    const out = await setTopics(data.problemId, data.topics, { actorId: actor.id, via: "admin", ipHash: await requestIpHash() });
    revalidateProblem(data.problemId);
    return out;
  }, "setProblemTopics");
}

export async function submitForReview(input: {
  versionId: string;
  expectedEditSeq: number;
  attestOriginal: boolean;
  comment?: string;
}): Promise<ActionResult<{ revision: number }>> {
  return runAction(async () => {
    const actor = await requireActionRole(...STAFF);
    const data = submitSchema.parse(input);
    const out = await submitVersionForReview(
      { versionId: data.versionId, expectedEditSeq: data.expectedEditSeq, attestedOriginal: true, comment: data.comment || null },
      { actorId: actor.id, via: "admin", ipHash: await requestIpHash() },
    );
    revalidateProblem(out.problemId);
    return { revision: out.revision };
  }, "submitForReview");
}

export async function withdrawFromReview(input: { versionId: string; comment?: string }): Promise<ActionResult<{ revision: number }>> {
  return runAction(async () => {
    const actor = await requireActionRole(...STAFF);
    const data = versionIdSchema.extend({ comment: commentSchema.optional() }).parse(input);
    const out = await withdrawVersion(
      { versionId: data.versionId, comment: data.comment || null },
      { actorId: actor.id, via: "admin", ipHash: await requestIpHash() },
    );
    revalidateProblem(out.problemId);
    return { revision: out.revision };
  }, "withdrawFromReview");
}

export async function returnToDraft(input: { versionId: string; comment: string }): Promise<ActionResult<{ revision: number }>> {
  return runAction(async () => {
    const actor = await requireActionRole(...STAFF);
    const data = returnSchema.parse(input);
    const out = await returnVersion(data, { actorId: actor.id, via: "admin", ipHash: await requestIpHash() });
    revalidateProblem(out.problemId);
    return { revision: out.revision };
  }, "returnToDraft");
}

export async function approveVersion(input: { versionId: string; comment?: string }): Promise<ActionResult<{ revision: number }>> {
  return runAction(async () => {
    const actor = await requireActionRole(...STAFF);
    const data = versionIdSchema.extend({ comment: commentSchema.optional() }).parse(input);
    const out = await approve(
      { versionId: data.versionId, comment: data.comment || null },
      { actorId: actor.id, via: "admin", ipHash: await requestIpHash() },
    );
    revalidateProblem(out.problemId);
    return { revision: out.revision };
  }, "approveVersion");
}

export async function revokeVersionApproval(input: { versionId: string; reason: string }): Promise<ActionResult<{ revision: number }>> {
  return runAction(async () => {
    const actor = await requireActionRole(...STAFF);
    const data = versionIdSchema.extend({ reason: reasonSchema }).parse(input);
    const out = await revokeApproval(data, { actorId: actor.id, via: "admin", ipHash: await requestIpHash() });
    revalidateProblem(out.problemId);
    return { revision: out.revision };
  }, "revokeVersionApproval");
}

export async function startProblemValidation(input: { versionId: string }): Promise<ActionResult<{ runs: number; notes: string[] }>> {
  return runAction(async () => {
    const actor = await requireActionRole(...STAFF);
    const { versionId } = versionIdSchema.parse(input);
    const problemId = await problemOfVersion(versionId);
    try {
      const started = await startValidation(versionId, { requestedById: actor.id, via: "admin", ipHash: await requestIpHash() });
      revalidateProblem(problemId);
      return { runs: started.runIds.length, notes: started.notes };
    } catch (error) {
      if (error instanceof ValidationSetupError) throw new ValidationError(error.message);
      throw error;
    }
  }, "startProblemValidation");
}

/** Move validation forward and re-dispatch queued runs (idempotent; no audit). */
export async function refreshValidation(input: { versionId: string }): Promise<ActionResult<{ requeued: number }>> {
  return runAction(async () => {
    await requireActionRole(...STAFF);
    const { versionId } = versionIdSchema.parse(input);
    const problemId = await problemOfVersion(versionId);
    await advanceValidation(versionId);
    const requeued = await redispatchQueuedRuns(versionId);
    revalidateProblem(problemId);
    return { requeued };
  }, "refreshValidation");
}

/**
 * Publish an APPROVED, validated revision. expectedProblemVersion is
 * required (the Problem.version the form was rendered with): a stale form
 * can never publish over a newer revision. Of two concurrent publishes
 * exactly one succeeds; the other gets the conflict message.
 */
export async function publishProblemVersion(input: {
  versionId: string;
  expectedProblemVersion: number;
}): Promise<ActionResult<{ problemId: string; revision: number }>> {
  return runAction(async () => {
    const actor = await requireActionRole(...STAFF);
    const data = publishSchema.parse(input);
    const result = await publishVersion(data.versionId, {
      actorId: actor.id,
      via: "admin",
      expectedProblemVersion: data.expectedProblemVersion,
      requireApproval: true,
      ipHash: await requestIpHash(),
    });
    if (!result.ok) {
      if (result.reason === "CONFLICT") throw new ConflictError(result.message);
      const more = result.blockers.length > 1 ? ` (+${result.blockers.length - 1} more — see the validation report)` : "";
      throw new ValidationError(`Publishing is blocked: ${result.blockers[0] ?? "unknown reason"}${more}`);
    }
    revalidateProblem(result.problemId);
    revalidatePath("/problems");
    return { problemId: result.problemId, revision: result.revision };
  }, "publishProblemVersion");
}

/** Start validation for every draft an import created or revised (skips drafts that cannot run yet). */
export async function validateImportedDrafts(input: { importId: string }): Promise<ActionResult<{ started: number; skipped: number }>> {
  return runAction(async () => {
    const actor = await requireActionRole(...STAFF);
    const { importId } = z.object({ importId: idSchema }).parse(input);
    const rows = await db.problemImportRow.findMany({
      where: { importId, status: { in: ["CREATED", "NEW_REVISION"] }, problemVersionId: { not: null } },
      select: { problemVersionId: true },
    });
    if (rows.length === 0) throw new NotFoundError("This import created no drafts.");
    const ipHash = await requestIpHash();
    let started = 0;
    let skipped = 0;
    for (const row of rows) {
      try {
        await startValidation(row.problemVersionId!, { requestedById: actor.id, via: `admin:import:${importId}`, ipHash });
        started++;
      } catch (error) {
        if (!(error instanceof ValidationSetupError)) throw error;
        skipped++;
      }
    }
    await audit({
      actorId: actor.id,
      action: "problem.import.validation_requested",
      entityType: "ProblemImport",
      entityId: importId,
      sensitivity: "NORMAL",
      metadata: { started, skipped },
      ipHash,
    });
    revalidatePath(`/admin/problems/import/${importId}`);
    return { started, skipped };
  }, "validateImportedDrafts");
}

/** Render statement Markdown exactly as students will see it (sanitised server-side). */
export async function previewStatement(input: { markdown: string }): Promise<ActionResult<{ html: string }>> {
  return runAction(async () => {
    await requireActionRole(...STAFF);
    const { markdown } = previewSchema.parse(input);
    return { html: renderMarkdown(markdown) };
  }, "previewStatement");
}
