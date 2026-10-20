import "server-only";
import { Prisma, type DbTx } from "@recx/db";

/**
 * Putting judged submissions back in the queue for a rejudge. Shared by the
 * single-submission rejudge (/admin/judge, server/actions/admin-judge.ts)
 * and the two-person-approved global rejudge
 * (lib/privileged/executors/global-rejudge.ts).
 *
 * The caller holds row locks on the submissions (SELECT … FOR UPDATE), so a
 * finalise committing concurrently is either fully before the reset (and
 * recorded as the previous verdict) or refused after it (its claimToken no
 * longer matches). Rows move to lane REJUDGE, whose weighted slot ceiling
 * keeps a big rejudge from starving the other lanes; enqueueing happens
 * after commit (or by the reconciler, which picks up QUEUED rows).
 */
export const REJUDGE_RESET_DATA = {
  status: "QUEUED",
  judgeState: "PENDING",
  lane: "REJUDGE",
  verdict: null,
  score: null,
  maxScore: null,
  subtaskResults: Prisma.DbNull,
  cpuMs: null,
  testResults: Prisma.DbNull,
  passedCases: 0,
  maxTimeMs: null,
  maxMemoryKb: null,
  firstFailedIndex: null,
  compileOutput: null,
  claimedByNodeId: null,
  claimToken: null,
  leaseExpiresAt: null,
  attemptCount: 0,
  judgeNodeId: null,
  calibrationScore: null,
  startedAt: null,
  judgedAt: null,
} as const satisfies Prisma.SubmissionUpdateManyMutationInput;

/**
 * Reset the given (already locked) submissions for a rejudge: their visible
 * test details are deleted and every judging field is cleared. `queuedAt`
 * is set to `now`, a fresh wait, so queue-latency figures measure the
 * rejudge itself. Returns the number of submissions reset.
 */
export async function resetForRejudge(tx: DbTx, ids: readonly string[], now: Date): Promise<number> {
  if (ids.length === 0) return 0;
  const list = [...ids];
  await tx.submissionTestDetail.deleteMany({ where: { submissionId: { in: list } } });
  const moved = await tx.submission.updateMany({
    where: { id: { in: list } },
    data: { ...REJUDGE_RESET_DATA, queuedAt: now },
  });
  return moved.count;
}
