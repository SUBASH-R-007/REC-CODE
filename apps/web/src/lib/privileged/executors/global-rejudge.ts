import "server-only";
import { Prisma } from "@recx/db";
import { GLOBAL_REJUDGE_MAX } from "@recx/shared";
import { auditMany } from "@/lib/audit";
import { db } from "@/lib/db";
import { resetForRejudge, SOURCE_NOT_ARCHIVED_SQL } from "@/lib/judge/rejudge";
import { EXECUTOR_BATCH, type Executor } from "@/lib/privileged/types";

/**
 * GLOBAL_REJUDGE: every judged submission of one problem (optionally one
 * pinned version, some languages, some verdicts) queued before the approval
 * goes back to the queue on lane REJUDGE. Rows are claimed in batches with
 * FOR UPDATE SKIP LOCKED (a row being finalised right now is skipped, not
 * waited for) and reset with lib/judge/rejudge.ts. The reset moves queuedAt
 * past decidedAt, so a batch never picks the same row twice. Nothing is
 * enqueued here: the scheduler's reconciler dispatches QUEUED rows, and the
 * REJUDGE lane's slot ceiling protects every other lane. Uses the
 * [problemId, verdict, createdAt] index. Capped at 25,000 rows.
 */
export const executeGlobalRejudge: Executor<"GLOBAL_REJUDGE"> = async (op, actor) => {
  const { problemId, problemVersionId, languages, verdicts } = op.payload;
  const filters: Prisma.Sql[] = [
    Prisma.sql`"problemId" = ${problemId}`,
    Prisma.sql`status IN ('DONE', 'INTERNAL_ERROR')`,
    Prisma.sql`"queuedAt" < ${op.decidedAt}`,
    SOURCE_NOT_ARCHIVED_SQL,
  ];
  if (problemVersionId) filters.push(Prisma.sql`"problemVersionId" = ${problemVersionId}`);
  if (languages.length > 0) filters.push(Prisma.sql`language = ANY(${[...languages]}::text[])`);
  if (verdicts.length > 0) filters.push(Prisma.sql`verdict::text = ANY(${[...verdicts]}::text[])`);
  const where = Prisma.join(filters, " AND ");

  let reset = 0;
  let batches = 0;
  const byVerdict: Record<string, number> = {};
  while (reset < GLOBAL_REJUDGE_MAX) {
    const take = Math.min(EXECUTOR_BATCH, GLOBAL_REJUDGE_MAX - reset);
    const now = new Date();
    const rows = await db.$transaction(async (tx) => {
      const picked = await tx.$queryRaw<{ id: string; verdict: string | null; userId: string }[]>`
        SELECT id, verdict::text AS verdict, "userId" FROM "Submission"
         WHERE ${where}
         ORDER BY id
         LIMIT ${take}
         FOR UPDATE SKIP LOCKED`;
      if (picked.length > 0) await resetForRejudge(tx, picked.map((r) => r.id), now);
      return picked;
    });
    if (rows.length === 0) break;
    batches++;
    reset += rows.length;
    for (const r of rows) byVerdict[r.verdict ?? "none"] = (byVerdict[r.verdict ?? "none"] ?? 0) + 1;
    await auditMany([
      {
        actorId: actor.id,
        action: "judge.rejudge",
        entityType: "Problem",
        entityId: problemId,
        sensitivity: "SENSITIVE",
        ipHash: actor.ipHash,
        metadata: {
          scope: "global",
          operationId: op.id,
          batch: batches,
          count: rows.length,
          // Compact previous verdicts: [submissionId, verdict] pairs.
          previous: rows.map((r) => [r.id, r.verdict]),
        },
      },
    ]);
    if (rows.length < take) break;
  }

  return {
    result: {
      problemId,
      problemVersionId,
      reset,
      batches,
      capped: reset >= GLOBAL_REJUDGE_MAX,
      previousVerdicts: byVerdict,
    },
  };
};
