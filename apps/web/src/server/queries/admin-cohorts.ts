import "server-only";
import type { AccountStatus } from "@recx/db";
import { db } from "@/lib/db";
import { ACTIVE_STUDENT_STATUSES, scopedStudentWhere, type StudentScope } from "@/lib/auth/scope";
import { cohortKey } from "@/lib/admin/cohort";

/**
 * /admin/cohorts: cohorts are derived from the LMS-owned User columns
 * (batchYear, departmentCode, section) — there is no Cohort model. Two
 * groupBy queries over the [batchYear, departmentCode, section] index, both
 * inside the viewer's scope.
 */

export interface CohortRow {
  /** "2027.CSE.A", or null when the students lack a batch or department. */
  key: string | null;
  batchYear: number | null;
  departmentCode: string | null;
  section: string | null;
  total: number;
  /** ACTIVE + SOFT_RESTRICTED. */
  current: number;
  byStatus: Partial<Record<AccountStatus, number>>;
  activeLast7Days: number;
}

const tupleKey = (r: { batchYear: number | null; departmentCode: string | null; section: string | null }) =>
  `${r.batchYear ?? ""}|${r.departmentCode ?? ""}|${r.section ?? ""}`;

export async function listCohorts(scope: StudentScope, now = new Date()): Promise<CohortRow[]> {
  const since = new Date(now.getTime() - 7 * 86_400_000);
  const [byStatus, active] = await Promise.all([
    db.user.groupBy({
      by: ["batchYear", "departmentCode", "section", "status"],
      where: scopedStudentWhere(scope),
      _count: { _all: true },
    }),
    db.user.groupBy({
      by: ["batchYear", "departmentCode", "section"],
      where: scopedStudentWhere(scope, {
        lastActiveAt: { gte: since },
        status: { in: [...ACTIVE_STUDENT_STATUSES] },
      }),
      _count: { _all: true },
    }),
  ]);
  const rows = new Map<string, CohortRow>();
  for (const g of byStatus) {
    const k = tupleKey(g);
    const row =
      rows.get(k) ??
      ({
        key: cohortKey(g),
        batchYear: g.batchYear,
        departmentCode: g.departmentCode,
        section: g.section,
        total: 0,
        current: 0,
        byStatus: {},
        activeLast7Days: 0,
      } satisfies CohortRow);
    row.total += g._count._all;
    row.byStatus[g.status] = (row.byStatus[g.status] ?? 0) + g._count._all;
    if ((ACTIVE_STUDENT_STATUSES as readonly AccountStatus[]).includes(g.status)) row.current += g._count._all;
    rows.set(k, row);
  }
  for (const g of active) {
    const row = rows.get(tupleKey(g));
    if (row) row.activeLast7Days = g._count._all;
  }
  return [...rows.values()].sort(
    (a, b) =>
      (b.batchYear ?? 0) - (a.batchYear ?? 0) ||
      (a.departmentCode ?? "~").localeCompare(b.departmentCode ?? "~") ||
      (a.section ?? "~").localeCompare(b.section ?? "~"),
  );
}
