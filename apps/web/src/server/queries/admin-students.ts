import "server-only";
import type { AccountStatus, JudgeLane, SubmissionOrigin, SubmissionStatus, StudyPlanKind } from "@recx/db";
import { isVerdict, type Verdict } from "@recx/shared";
import { db } from "@/lib/db";
import { scopedStudentWhere, type ScopedStudent, type StudentScope } from "@/lib/auth/scope";
import { filtersToWhere, STUDENT_PAGE_SIZE, type StudentFilters } from "@/lib/admin/student-filters";

/**
 * Read side of /admin/students. Every query is shaped by the viewer's scope
 * (scopedStudentWhere) or keyed by a ScopedStudent the page already resolved
 * through requireScopedStudentPage. Submissions are metadata only — never
 * source — and notes and drafts are never read (tests/repo/admin-scope.test.ts).
 */

export interface StudentListRow {
  id: string;
  collegeId: string;
  firstName: string;
  lastName: string;
  email: string;
  status: AccountStatus;
  batchYear: number | null;
  departmentCode: string | null;
  section: string | null;
  lastActiveAt: Date | null;
  solvedTotal: number;
  currentStreak: number;
}

export interface StudentList {
  rows: StudentListRow[];
  total: number;
  /** collegeId to continue after, or null on the last page. */
  nextAfter: string | null;
}

export async function listStudents(scope: StudentScope, filters: StudentFilters, now = new Date()): Promise<StudentList> {
  const base = filtersToWhere(filters, now);
  const [rows, total] = await Promise.all([
    db.user.findMany({
      where: scopedStudentWhere(scope, { AND: [base, filters.after ? { collegeId: { gt: filters.after } } : {}] }),
      orderBy: { collegeId: "asc" },
      take: STUDENT_PAGE_SIZE + 1,
      select: {
        id: true,
        collegeId: true,
        firstName: true,
        lastName: true,
        email: true,
        status: true,
        batchYear: true,
        departmentCode: true,
        section: true,
        lastActiveAt: true,
        stats: { select: { solvedTotal: true, currentStreak: true } },
      },
    }),
    db.user.count({ where: scopedStudentWhere(scope, base) }),
  ]);
  const page = rows.slice(0, STUDENT_PAGE_SIZE);
  return {
    rows: page.map(({ stats, ...r }) => ({
      ...r,
      solvedTotal: stats?.solvedTotal ?? 0,
      currentStreak: stats?.currentStreak ?? 0,
    })),
    total,
    nextAfter: rows.length > STUDENT_PAGE_SIZE ? (page.at(-1)?.collegeId ?? null) : null,
  };
}

export interface StudentSubmissionRow {
  id: string;
  createdAt: Date;
  language: string;
  status: SubmissionStatus;
  verdict: Verdict | null;
  origin: SubmissionOrigin;
  lane: JudgeLane;
  problemCode: string;
  problemTitle: string;
}

export interface StudentDetail {
  stats: {
    solvedEasy: number;
    solvedMedium: number;
    solvedHard: number;
    solvedTotal: number;
    assistedSolves: number;
    submissions: number;
    accepted: number;
    currentStreak: number;
    longestStreak: number;
    xpTotal: number;
  } | null;
  submissions: StudentSubmissionRow[];
  enrollments: {
    planTitle: string;
    kind: StudyPlanKind;
    itemsDone: number;
    itemsTotal: number;
    completedAt: Date | null;
    enrolledAt: Date;
  }[];
  accommodationOnFile: boolean;
  accommodationRequested: boolean;
  judgeOverrideActive: boolean;
  activeSessions: number;
}

/** One in-scope student's dashboard for staff. Takes a ScopedStudent, never a raw id. */
export async function getStudentDetail(student: ScopedStudent, now = new Date()): Promise<StudentDetail> {
  const [stats, submissions, enrollments, accommodations, overrides, activeSessions] = await Promise.all([
    db.userStats.findUnique({
      where: { userId: student.scopedId },
      select: {
        solvedEasy: true,
        solvedMedium: true,
        solvedHard: true,
        solvedTotal: true,
        assistedSolves: true,
        submissions: true,
        accepted: true,
        currentStreak: true,
        longestStreak: true,
        xpTotal: true,
      },
    }),
    db.submission.findMany({
      where: { userId: student.scopedId },
      orderBy: { createdAt: "desc" },
      take: 20,
      select: {
        id: true,
        createdAt: true,
        language: true,
        status: true,
        verdict: true,
        origin: true,
        lane: true,
        problem: { select: { displayCode: true, title: true } },
      },
    }),
    db.studyPlanEnrollment.findMany({
      where: { userId: student.scopedId },
      orderBy: { enrolledAt: "desc" },
      select: {
        itemsDone: true,
        itemsTotal: true,
        completedAt: true,
        enrolledAt: true,
        plan: { select: { title: true, kind: true } },
      },
    }),
    db.accommodation.findMany({
      where: { userId: student.scopedId, status: { in: ["APPROVED", "REQUESTED"] } },
      select: { status: true, validUntil: true },
    }),
    db.judgeQuotaOverride.count({
      where: { userId: student.scopedId, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
    }),
    db.session.count({ where: { userId: student.scopedId, expiresAt: { gt: now } } }),
  ]);
  return {
    stats,
    submissions: submissions.map((s) => ({
      id: s.id,
      createdAt: s.createdAt,
      language: s.language,
      status: s.status,
      verdict: isVerdict(s.verdict) ? s.verdict : null,
      origin: s.origin,
      lane: s.lane,
      problemCode: s.problem.displayCode,
      problemTitle: s.problem.title,
    })),
    enrollments: enrollments.map((e) => ({
      planTitle: e.plan.title,
      kind: e.plan.kind,
      itemsDone: e.itemsDone,
      itemsTotal: e.itemsTotal,
      completedAt: e.completedAt,
      enrolledAt: e.enrolledAt,
    })),
    accommodationOnFile: accommodations.some((a) => a.status === "APPROVED" && a.validUntil > now),
    accommodationRequested: accommodations.some((a) => a.status === "REQUESTED"),
    judgeOverrideActive: overrides > 0,
    activeSessions,
  };
}
