import "server-only";
import type { DbTx } from "@recx/db";
import { ConflictError, FROZEN_VERSION_CONFLICT_MESSAGE, NotFoundError, isFrozenVersionError } from "@/lib/errors";
import { lockProblem, lockVersion } from "@/lib/judge/validation";

/**
 * The single edit chokepoint for a draft revision. Every content edit goes
 * through touchDraft() inside the edit's own transaction:
 *
 *   - only a DRAFT (unfrozen, not in review) revision is editable — to edit
 *     something under review the author withdraws it first, which clears
 *     any approval;
 *   - optimistic concurrency on ProblemVersion.editSeq: the form carries the
 *     editSeq it was rendered with, and a stale form gets a conflict instead
 *     of silently overwriting someone else's edit;
 *   - an edit that changes judging (tests, subtasks, reference solutions,
 *     limits, io / compare / scoring mode, signature, checker) also bumps
 *     judgeSeq, so validation runs of the earlier content stop counting,
 *     and cancels the version's queued or running validation runs.
 *
 * Statement-only edits ("content") leave judgeSeq — and so validation — alone.
 */

export type EditKind = "content" | "judging";

export interface DraftHead {
  versionId: string;
  problemId: string;
  revision: number;
  editSeq: number;
  judgeSeq: number;
}

export { lockProblem, lockVersion };

/** Serialises creation of a problem by slug (the problem row may not exist yet). */
export const lockSlug = (tx: DbTx, slug: string) =>
  tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"problem-slug:" + slug}))`;

export const DRAFT_CONFLICT = {
  frozen: FROZEN_VERSION_CONFLICT_MESSAGE,
  inReview: "This revision is in review. Withdraw it to draft before editing it.",
  stale: "This revision was changed by someone else since you opened it. Reload the page and try again.",
} as const;

export async function touchDraft(
  tx: DbTx,
  input: { versionId: string; expectedEditSeq: number; actorId: string | null; kind: EditKind },
): Promise<DraftHead> {
  await lockVersion(tx, input.versionId);
  const judging = input.kind === "judging";
  const updated = await tx.problemVersion.updateMany({
    where: { id: input.versionId, frozenAt: null, status: "DRAFT", editSeq: input.expectedEditSeq },
    data: {
      editSeq: { increment: 1 },
      lastEditedById: input.actorId,
      ...(judging ? { judgeSeq: { increment: 1 }, bundleKey: null, manifestSha256: null } : {}),
    },
  });
  if (updated.count === 0) {
    const row = await tx.problemVersion.findUnique({
      where: { id: input.versionId },
      select: { frozenAt: true, status: true },
    });
    if (!row) throw new NotFoundError("That revision was not found.");
    if (row.frozenAt) throw new ConflictError(DRAFT_CONFLICT.frozen);
    if (row.status !== "DRAFT") throw new ConflictError(DRAFT_CONFLICT.inReview);
    throw new ConflictError(DRAFT_CONFLICT.stale);
  }
  if (judging) {
    // Results of the earlier content no longer count; stop the runs judging it.
    await tx.validationRun.updateMany({
      where: { problemVersionId: input.versionId, status: { in: ["QUEUED", "JUDGING"] } },
      data: { status: "CANCELLED", judgeState: "CANCELLED", claimToken: null, leaseExpiresAt: null },
    });
  }
  const head = await tx.problemVersion.findUniqueOrThrow({
    where: { id: input.versionId },
    select: { id: true, problemId: true, revision: true, editSeq: true, judgeSeq: true },
  });
  return { versionId: head.id, problemId: head.problemId, revision: head.revision, editSeq: head.editSeq, judgeSeq: head.judgeSeq };
}

/** A FrozenVersionError (the repository guard) becomes the user-facing conflict. */
export function rethrowFrozen(error: unknown): never {
  if (isFrozenVersionError(error)) throw new ConflictError(FROZEN_VERSION_CONFLICT_MESSAGE);
  throw error;
}
