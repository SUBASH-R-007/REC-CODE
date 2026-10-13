import type { DbTx } from "@recx/db";

/**
 * Recount a study plan after its items change (admin edits and the seed
 * sync): StudyPlan.itemsTotal = the number of items, then every enrolment's
 * itemsTotal, itemsDone ("done" = UserProblemStatus SOLVED, the one source of
 * truth) and completedAt in ONE statement. completedAt is kept when the
 * enrolment stays complete, set when it becomes complete and cleared when the
 * plan grows past it (the seed sync's long-standing rule).
 *
 * No `server-only` marker and only a type import, so scripts
 * (scripts/content/study-plans.ts) can use it by relative path. Call it
 * inside the transaction that changed the items.
 */
export async function recountStudyPlan(
  tx: DbTx,
  planId: string,
): Promise<{ itemsTotal: number; enrollmentsUpdated: number }> {
  const [plan] = await tx.$queryRaw<{ itemsTotal: number }[]>`
    UPDATE "StudyPlan"
    SET "itemsTotal" = (SELECT count(*)::int FROM "StudyPlanItem" WHERE "planId" = ${planId}),
        "updatedAt" = now()
    WHERE id = ${planId}
    RETURNING "itemsTotal"`;
  const itemsTotal = plan?.itemsTotal ?? 0;

  const enrollmentsUpdated = await tx.$executeRaw`
    WITH counted AS (
      SELECT e."userId",
             (SELECT count(*)::int
                FROM "StudyPlanItem" i
                JOIN "UserProblemStatus" ups
                  ON ups."problemId" = i."problemId" AND ups."userId" = e."userId" AND ups.status = 'SOLVED'
               WHERE i."planId" = ${planId}) AS done
      FROM "StudyPlanEnrollment" e
      WHERE e."planId" = ${planId}
    )
    UPDATE "StudyPlanEnrollment" e
    SET "itemsTotal" = ${itemsTotal}::int,
        "itemsDone" = c.done,
        "completedAt" = CASE
          WHEN ${itemsTotal}::int > 0 AND c.done >= ${itemsTotal}::int THEN COALESCE(e."completedAt", now())
          ELSE NULL
        END
    FROM counted c
    WHERE e."planId" = ${planId}
      AND e."userId" = c."userId"
      AND (
        e."itemsTotal" <> ${itemsTotal}::int
        OR e."itemsDone" <> c.done
        OR (e."completedAt" IS NOT NULL) <> (${itemsTotal}::int > 0 AND c.done >= ${itemsTotal}::int)
      )`;

  return { itemsTotal, enrollmentsUpdated };
}
