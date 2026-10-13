import "server-only";
import type { RosterImportStatus, User } from "@recx/db";
import { isoWeekKey } from "@recx/shared";
import { db } from "@/lib/db";
import {
  ACTIVE_STUDENT_STATUSES,
  isEmptyScope,
  scopeCovers,
  scopedStudentWhere,
  type StudentScope,
} from "@/lib/auth/scope";
import { campusWeekStart } from "@/lib/admin/campus-week";
import { cohortKey } from "@/lib/admin/cohort";

/**
 * The /admin cohort dashboard: a handful of counts over the viewer's scope,
 * all from maintained read models (User, UserStats, the WEEK XpBucket,
 * Accommodation, RosterImport, Announcement) — never the XP ledger.
 */

export interface OverviewCohort {
  key: string | null;
  batchYear: number | null;
  departmentCode: string | null;
  section: string | null;
  students: number;
}

export interface AdminOverview {
  emptyScope: boolean;
  students: number;
  activeThisWeek: number;
  solvesThisWeek: number;
  zeroSolve: number;
  inactive14Days: number;
  pendingAccommodations: number;
  liveAnnouncements: number;
  topCohorts: OverviewCohort[];
  lastImport: { id: string; status: RosterImportStatus; createdAt: Date; fileName: string } | null;
  weekStart: Date;
}

const current = () => ({ status: { in: [...ACTIVE_STUDENT_STATUSES] } });

export async function getAdminOverview(
  scope: StudentScope,
  viewer: Pick<User, "id">,
  now = new Date(),
): Promise<AdminOverview> {
  const weekStart = campusWeekStart(now);
  const inactiveSince = new Date(now.getTime() - 14 * 86_400_000);
  const [students, activeThisWeek, solves, zeroSolve, inactive14Days, pendingAccommodations, cohorts, lastImport, live] =
    await Promise.all([
      db.user.count({ where: scopedStudentWhere(scope, current()) }),
      db.user.count({ where: scopedStudentWhere(scope, { ...current(), lastActiveAt: { gte: weekStart } }) }),
      db.xpBucket.aggregate({
        where: { period: "WEEK", periodKey: isoWeekKey(now), user: scopedStudentWhere(scope, current()) },
        _sum: { solvedEasy: true, solvedMedium: true, solvedHard: true },
      }),
      db.user.count({
        where: scopedStudentWhere(scope, {
          ...current(),
          OR: [{ stats: { is: null } }, { stats: { is: { solvedTotal: 0 } } }],
        }),
      }),
      db.user.count({
        where: scopedStudentWhere(scope, {
          ...current(),
          OR: [{ lastActiveAt: null }, { lastActiveAt: { lt: inactiveSince } }],
        }),
      }),
      db.accommodation.count({ where: { status: "REQUESTED", user: scopedStudentWhere(scope) } }),
      db.user.groupBy({
        by: ["batchYear", "departmentCode", "section"],
        where: scopedStudentWhere(scope, current()),
        _count: { id: true },
        orderBy: { _count: { id: "desc" } },
        take: 8,
      }),
      db.rosterImport.findFirst({
        where: { createdById: viewer.id },
        orderBy: { createdAt: "desc" },
        select: { id: true, status: true, createdAt: true, fileName: true },
      }),
      db.announcement.findMany({
        where: { publishedAt: { not: null }, archivedAt: null, endsAt: { gt: now } },
        select: { audienceBatchYear: true, audienceDepartmentCode: true },
        take: 500,
      }),
    ]);
  const sum = solves._sum;
  return {
    emptyScope: isEmptyScope(scope),
    students,
    activeThisWeek,
    solvesThisWeek: (sum.solvedEasy ?? 0) + (sum.solvedMedium ?? 0) + (sum.solvedHard ?? 0),
    zeroSolve,
    inactive14Days,
    pendingAccommodations,
    liveAnnouncements: live.filter((a) =>
      scopeCovers(scope, { batchYear: a.audienceBatchYear, departmentCode: a.audienceDepartmentCode }),
    ).length,
    topCohorts: cohorts.map((c) => ({
      key: cohortKey(c),
      batchYear: c.batchYear,
      departmentCode: c.departmentCode,
      section: c.section,
      students: c._count.id,
    })),
    lastImport,
    weekStart,
  };
}
