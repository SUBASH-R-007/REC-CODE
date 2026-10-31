import "server-only";
import { RETENTION_SETTING_KEY } from "@recx/shared";
import { audit } from "@/lib/audit";
import { db } from "@/lib/db";
import { ValidationError } from "@/lib/errors";
import { LEGAL_HOLD_MESSAGE, readRetention } from "@/lib/privileged/retention";
import { EXECUTOR_BATCH, type Executor } from "@/lib/privileged/types";

/** Start of a yyyy-mm-dd campus (Asia/Kolkata) day. */
export function purgeCutoff(before: string): Date {
  return new Date(`${before}T00:00:00+05:30`);
}

/**
 * SUBMISSION_PURGE: one student's PRACTICE submissions created before a
 * date lose their source (set to '' with archivedAt) and their visible-test
 * details. The verdict rows are kept forever: profile counters, acceptance
 * rates, past standings and plagiarism history depend on them. Contest and
 * assessment sources are never purged; accepted sources only when the
 * request said so. Refused while a legal hold is in force (checked again
 * here, at execution).
 */
export const executeSubmissionPurge: Executor<"SUBMISSION_PURGE"> = async (op, actor) => {
  const { userId, before, includeAccepted } = op.payload;
  if ((await readRetention()).legalHold) throw new ValidationError(LEGAL_HOLD_MESSAGE);
  const cutoff = purgeCutoff(before);

  let sources = 0;
  let details = 0;
  for (;;) {
    const ids = await db.$transaction(async (tx) => {
      // A legal hold set while this runs stops the remaining batches. The
      // shared lock conflicts with setLegalHold's exclusive one on the same
      // key, so a hold either commits before this batch (and is seen here)
      // or waits for it to finish.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(hashtext(${"setting:" + RETENTION_SETTING_KEY}))`;
      if ((await readRetention(tx)).legalHold) {
        throw new ValidationError(
          `${LEGAL_HOLD_MESSAGE} The purge stopped after ${sources} source(s); those stay archived.`,
        );
      }
      const picked = await tx.$queryRaw<{ id: string }[]>`
        SELECT s.id FROM "Submission" s
          JOIN "SubmissionSource" src ON src."submissionId" = s.id
         WHERE s."userId" = ${userId}
           AND s.origin = 'PRACTICE'
           AND s."createdAt" < ${cutoff}
           AND s.status IN ('DONE', 'INTERNAL_ERROR', 'CANCELLED')
           AND src."archivedAt" IS NULL
           AND (${includeAccepted} OR s.verdict IS DISTINCT FROM 'AC')
         ORDER BY s.id
         LIMIT ${EXECUTOR_BATCH}
         FOR UPDATE OF s, src SKIP LOCKED`;
      const list = picked.map((r) => r.id);
      if (list.length === 0) return list;
      const archived = await tx.submissionSource.updateMany({
        where: { submissionId: { in: list }, archivedAt: null },
        data: { source: "", archivedAt: new Date() },
      });
      const removed = await tx.submissionTestDetail.deleteMany({ where: { submissionId: { in: list } } });
      sources += archived.count;
      details += removed.count;
      return list;
    });
    if (ids.length < EXECUTOR_BATCH) break;
  }

  await audit({
    actorId: actor.id,
    action: "submission.sources_purged",
    entityType: "User",
    entityId: userId,
    targetUserId: userId,
    sensitivity: "SENSITIVE",
    metadata: { operationId: op.id, before, includeAccepted, sources, details },
    ipHash: actor.ipHash,
  });
  return { result: { userId, before, includeAccepted, sources, details } };
};
