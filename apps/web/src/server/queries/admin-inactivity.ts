import "server-only";

import { Prisma } from "@recx/db";
import { RESTRICTION_STAGE_ADMIN_LABEL, type RestrictionStage } from "@recx/shared";
import { db } from "@/lib/db";
import { isEmptyScope, scopedStudentSql, type StudentScope } from "@/lib/auth/scope-where";

/**
 * The inactivity review queue, for `/admin/inactivity` (Phase 8d).
 *
 * SPEC §5: "otherwise the job stops at SOFT_RESTRICTED and raises an admin
 * review item." This is that queue, and the item is a ROW rather than a word:
 * `AccountRestriction.adminReviewOpenedAt` is set by the sweep and cleared
 * when a human has looked. The page therefore has a stated source, and the
 * count cannot drift from a definition recomputed in two places.
 *
 * Scoped through `scopedStudentSql`, fail-closed: an ADMIN with no active
 * grant sees nobody. A review queue that quietly showed the whole college to
 * somebody scoped to one department would be a privacy failure wearing a
 * useful feature's clothes.
 */

export const REVIEW_PAGE_SIZE = 50;

export interface ReviewRow {
  readonly userId: string;
  readonly collegeId: string;
  readonly name: string;
  readonly batchYear: number | null;
  readonly departmentCode: string | null;
  readonly stage: RestrictionStage;
  readonly stageLabel: string;
  readonly countedInactiveDays: number;
  readonly stageEnteredAt: Date;
  readonly lastEvaluatedAt: Date | null;
  readonly openedAt: Date;
  readonly policyVersion: number | null;
  /** From the sweep's own evidence, so a human sees the reasoning. */
  readonly excludedDays: number;
  readonly lastActiveAt: Date | null;
}

interface Row {
  userId: string;
  collegeId: string;
  firstName: string;
  lastName: string;
  batchYear: number | null;
  departmentCode: string | null;
  stage: RestrictionStage;
  countedInactiveDays: number;
  stageEnteredAt: Date;
  lastEvaluatedAt: Date | null;
  adminReviewOpenedAt: Date;
  policyVersion: number | null;
  lastActiveAt: Date | null;
  excludedDays: number | null;
}

/**
 * The open review items this admin may see, oldest first.
 *
 * `excludedDays` is read from the latest sweep event's evidence rather than
 * recounted. The number a human argues about has to be the number the
 * decision was taken on; recomputing it a week later against a calendar
 * somebody has since filled in would quietly answer a different question.
 */
export async function openReviewItems(scope: StudentScope, limit = REVIEW_PAGE_SIZE): Promise<ReviewRow[]> {
  if (isEmptyScope(scope)) return [];
  const rows = await db.$queryRaw<Row[]>(Prisma.sql`
    SELECT r."userId", u."collegeId", u."firstName", u."lastName", u."batchYear", u."departmentCode",
           r."stage", r."countedInactiveDays", r."stageEnteredAt", r."lastEvaluatedAt",
           r."adminReviewOpenedAt", r."policyVersion", u."lastActiveAt",
           (SELECT jsonb_array_length(e."evidence" -> 'excludedDates')
              FROM "AccountStatusEvent" e
             WHERE e."userId" = r."userId" AND e."source" = 'INACTIVITY_SWEEP'
             ORDER BY e."createdAt" DESC
             LIMIT 1) AS "excludedDays"
      FROM "AccountRestriction" r
      JOIN "User" u ON u."id" = r."userId"
     WHERE r."adminReviewOpenedAt" IS NOT NULL
       AND r."adminReviewClearedAt" IS NULL
       AND ${scopedStudentSql(scope)}
     ORDER BY r."adminReviewOpenedAt" ASC
     LIMIT ${limit}
  `);

  return rows.map((row) => ({
    userId: row.userId,
    collegeId: row.collegeId,
    name: `${row.firstName} ${row.lastName}`.trim(),
    batchYear: row.batchYear,
    departmentCode: row.departmentCode,
    stage: row.stage,
    stageLabel: RESTRICTION_STAGE_ADMIN_LABEL[row.stage],
    countedInactiveDays: row.countedInactiveDays,
    stageEnteredAt: row.stageEnteredAt,
    lastEvaluatedAt: row.lastEvaluatedAt,
    openedAt: row.adminReviewOpenedAt,
    policyVersion: row.policyVersion,
    excludedDays: row.excludedDays ?? 0,
    lastActiveAt: row.lastActiveAt,
  }));
}

/** How many are waiting, for the nav badge and the page header. */
export async function openReviewCount(scope: StudentScope): Promise<number> {
  if (isEmptyScope(scope)) return 0;
  const rows = await db.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
    SELECT count(*) AS count
      FROM "AccountRestriction" r
      JOIN "User" u ON u."id" = r."userId"
     WHERE r."adminReviewOpenedAt" IS NOT NULL
       AND r."adminReviewClearedAt" IS NULL
       AND ${scopedStudentSql(scope)}
  `);
  return Number(rows[0]?.count ?? 0n);
}
