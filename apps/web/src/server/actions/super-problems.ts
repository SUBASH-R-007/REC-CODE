"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { audit } from "@/lib/audit";
import { requireSuperAdmin } from "@/lib/auth/guards";
import { db } from "@/lib/db";
import { ConflictError, NotFoundError, ValidationError, runAction, type ActionResult } from "@/lib/errors";
import { requestIpHash } from "@/lib/ip";
import { problemDeletionCheck, versionDeletionCheck } from "@/lib/privileged/executors/problem-delete";
import { createPrivilegedOperation } from "@/lib/privileged/operations";
import { enforcePrivilegedRequestRate } from "@/lib/privileged/rate";
import { revalidateProblems } from "@/lib/problems/cache";

/**
 * Problem lifecycle, SUPER_ADMIN only (capability "problems.lifecycle"):
 *
 *   retireProblem            problem.retired (SENSITIVE)       PUBLISHED → RETIRED under optimistic concurrency
 *   requestProblemDeletion   privileged.requested (SENSITIVE)  PROBLEM_DELETE, two-person approval
 *   requestVersionDeletion   privileged.requested (SENSITIVE)  VERSION_DELETE, two-person approval
 *
 * The authoring pages render these controls only for SUPER_ADMIN, but the
 * guard here is what enforces it. Only never-frozen, unreferenced content
 * can be deleted (lib/privileged/executors/problem-delete.ts); a frozen
 * revision is retired instead.
 */

const idSchema = z.string().trim().min(1).max(64);
const reasonSchema = z
  .string()
  .trim()
  .min(10, "Give a reason of at least 10 characters. It is recorded in the audit log.")
  .max(500, "Keep the reason under 500 characters.");

const retireSchema = z.object({
  problemId: idSchema,
  expectedProblemVersion: z.number().int().min(0),
  reason: reasonSchema,
});
export type RetireProblemInput = z.input<typeof retireSchema>;

/**
 * Retire a PUBLISHED problem: it leaves the catalog and the workspace, while
 * old submissions keep their pinned revision. Conditional on the problem
 * still being PUBLISHED at `expectedProblemVersion` (Problem.version); a
 * concurrent publish or retire makes this a ConflictError.
 */
export async function retireProblem(
  input: RetireProblemInput,
): Promise<ActionResult<{ problemId: string; version: number }>> {
  return runAction(async () => {
    const actor = await requireSuperAdmin();
    const parsed = retireSchema.parse(input);
    const moved = await db.problem.updateMany({
      where: { id: parsed.problemId, status: "PUBLISHED", version: parsed.expectedProblemVersion },
      data: { status: "RETIRED", version: { increment: 1 } },
    });
    if (moved.count !== 1) {
      const current = await db.problem.findUnique({
        where: { id: parsed.problemId },
        select: { status: true },
      });
      if (!current) throw new NotFoundError("That problem was not found.");
      if (current.status !== "PUBLISHED") throw new ValidationError("Only a published problem can be retired.");
      throw new ConflictError("This problem changed in the meantime. Reload the page and try again.");
    }
    const problem = await db.problem.findUniqueOrThrow({
      where: { id: parsed.problemId },
      select: { displayCode: true, slug: true, version: true, liveVersionId: true },
    });
    await audit({
      actorId: actor.id,
      action: "problem.retired",
      entityType: "Problem",
      entityId: parsed.problemId,
      sensitivity: "SENSITIVE",
      metadata: {
        displayCode: problem.displayCode,
        liveVersionId: problem.liveVersionId,
        fromVersion: parsed.expectedProblemVersion,
        toVersion: problem.version,
        reason: parsed.reason,
      },
      ipHash: await requestIpHash(),
    });
    revalidatePath("/problems");
    revalidatePath(`/problems/${problem.slug}`);
    /**
     * Phase 10c. `revalidatePath` clears the rendered pages; the cached
     * LIVE POINTER is a data cache entry and survives it, so without this a
     * retired problem stays openable for up to a minute. The retire also
     * bumped `Problem.version`, which orphans the content entry — the
     * statement is not deleted from the cache, it simply stops being asked
     * for, which is the whole point of a versioned key.
     */
    revalidateProblems();
    return { problemId: parsed.problemId, version: problem.version };
  }, "retireProblem");
}

const problemDeletionSchema = z.object({ problemId: idSchema, reason: reasonSchema });
export type RequestProblemDeletionInput = z.input<typeof problemDeletionSchema>;

/** Ask for a second super-admin to approve deleting a never-published, unreferenced problem. */
export async function requestProblemDeletion(
  input: RequestProblemDeletionInput,
): Promise<ActionResult<{ id: string; expiresAt: string }>> {
  return runAction(async () => {
    const actor = await requireSuperAdmin();
    const parsed = problemDeletionSchema.parse(input);
    await enforcePrivilegedRequestRate(actor.id);
    const check = await problemDeletionCheck(db, parsed.problemId);
    if (check.blockers.length > 0) throw new ValidationError(check.blockers.join(" "));
    const op = await createPrivilegedOperation({
      kind: "PROBLEM_DELETE",
      payload: { problemId: parsed.problemId },
      summary: `Delete problem ${check.label}`,
      affectedCount: 1,
      reason: parsed.reason,
      actor,
    });
    return { id: op.id, expiresAt: op.expiresAt.toISOString() };
  }, "requestProblemDeletion");
}

const versionDeletionSchema = z.object({ problemVersionId: idSchema, reason: reasonSchema });
export type RequestVersionDeletionInput = z.input<typeof versionDeletionSchema>;

/** Ask for a second super-admin to approve deleting a never-frozen draft revision. */
export async function requestVersionDeletion(
  input: RequestVersionDeletionInput,
): Promise<ActionResult<{ id: string; expiresAt: string }>> {
  return runAction(async () => {
    const actor = await requireSuperAdmin();
    const parsed = versionDeletionSchema.parse(input);
    await enforcePrivilegedRequestRate(actor.id);
    const check = await versionDeletionCheck(db, parsed.problemVersionId);
    if (check.blockers.length > 0) throw new ValidationError(check.blockers.join(" "));
    const op = await createPrivilegedOperation({
      kind: "VERSION_DELETE",
      payload: { problemVersionId: parsed.problemVersionId },
      summary: `Delete draft ${check.label}`,
      affectedCount: 1,
      reason: parsed.reason,
      actor,
    });
    return { id: op.id, expiresAt: op.expiresAt.toISOString() };
  }, "requestVersionDeletion");
}
