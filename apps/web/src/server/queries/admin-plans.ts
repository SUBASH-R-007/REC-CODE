import "server-only";
import type { Difficulty, ProblemStatus, StudyPlanKind } from "@recx/db";
import { db } from "@/lib/db";
import { scopedStudentWhere, type StudentScope } from "@/lib/auth/scope";

/**
 * Read side of /admin/sheets and /admin/tracks. Plans are college-wide
 * content (no audience, no scope on the plan itself); the enrolment figures
 * shown to an admin count only the students in their scope.
 */

export interface AdminPlanRow {
  id: string;
  slug: string;
  title: string;
  published: boolean;
  seedManaged: boolean;
  itemsTotal: number;
  sections: number;
  sortOrder: number;
  updatedAt: Date;
  enrolledInScope: number;
  completedInScope: number;
}

async function enrolmentCounts(scope: StudentScope, planIds: string[]) {
  if (planIds.length === 0) return { enrolled: new Map<string, number>(), completed: new Map<string, number>() };
  const [enrolled, completed] = await Promise.all([
    db.studyPlanEnrollment.groupBy({
      by: ["planId"],
      where: { planId: { in: planIds }, user: scopedStudentWhere(scope) },
      _count: { _all: true },
    }),
    db.studyPlanEnrollment.groupBy({
      by: ["planId"],
      where: { planId: { in: planIds }, completedAt: { not: null }, user: scopedStudentWhere(scope) },
      _count: { _all: true },
    }),
  ]);
  return {
    enrolled: new Map(enrolled.map((g) => [g.planId, g._count._all])),
    completed: new Map(completed.map((g) => [g.planId, g._count._all])),
  };
}

export async function listPlansForAdmin(kind: StudyPlanKind, scope: StudentScope): Promise<AdminPlanRow[]> {
  const plans = await db.studyPlan.findMany({
    where: { kind },
    orderBy: [{ sortOrder: "asc" }, { title: "asc" }],
    select: {
      id: true,
      slug: true,
      title: true,
      published: true,
      seedManaged: true,
      itemsTotal: true,
      sortOrder: true,
      updatedAt: true,
      _count: { select: { sections: true } },
    },
  });
  const counts = await enrolmentCounts(
    scope,
    plans.map((p) => p.id),
  );
  return plans.map(({ _count, ...p }) => ({
    ...p,
    sections: _count.sections,
    enrolledInScope: counts.enrolled.get(p.id) ?? 0,
    completedInScope: counts.completed.get(p.id) ?? 0,
  }));
}

export interface AdminPlanItem {
  id: string;
  sortOrder: number;
  problemId: string;
  displayCode: string;
  title: string;
  difficulty: Difficulty;
  status: ProblemStatus;
}

export interface AdminPlanSection {
  id: string;
  title: string;
  sortOrder: number;
  items: AdminPlanItem[];
}

export interface AdminPlanDetail {
  id: string;
  slug: string;
  kind: StudyPlanKind;
  title: string;
  description: string;
  published: boolean;
  seedManaged: boolean;
  itemsTotal: number;
  sortOrder: number;
  updatedAt: Date;
  sections: AdminPlanSection[];
  enrolledInScope: number;
  completedInScope: number;
}

/** The plan with its sections and items, or null when it does not exist or is of another kind. */
export async function getPlanForEdit(
  id: string,
  kind: StudyPlanKind,
  scope: StudentScope,
): Promise<AdminPlanDetail | null> {
  const plan = await db.studyPlan.findFirst({
    where: { id, kind },
    select: {
      id: true,
      slug: true,
      kind: true,
      title: true,
      description: true,
      published: true,
      seedManaged: true,
      itemsTotal: true,
      sortOrder: true,
      updatedAt: true,
      sections: {
        orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
        select: {
          id: true,
          title: true,
          sortOrder: true,
          items: {
            orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
            select: {
              id: true,
              sortOrder: true,
              problemId: true,
              problem: { select: { displayCode: true, title: true, difficulty: true, status: true } },
            },
          },
        },
      },
    },
  });
  if (!plan) return null;
  const counts = await enrolmentCounts(scope, [plan.id]);
  return {
    ...plan,
    sections: plan.sections.map((s) => ({
      id: s.id,
      title: s.title,
      sortOrder: s.sortOrder,
      items: s.items.map((i) => ({
        id: i.id,
        sortOrder: i.sortOrder,
        problemId: i.problemId,
        displayCode: i.problem.displayCode,
        title: i.problem.title,
        difficulty: i.problem.difficulty,
        status: i.problem.status,
      })),
    })),
    enrolledInScope: counts.enrolled.get(plan.id) ?? 0,
    completedInScope: counts.completed.get(plan.id) ?? 0,
  };
}

export interface PickableProblem {
  displayCode: string;
  title: string;
  difficulty: Difficulty;
}

/** Published problems an admin may add to a plan (the picker's reference list). */
export async function listPickableProblems(): Promise<PickableProblem[]> {
  return db.problem.findMany({
    where: { status: "PUBLISHED", liveVersionId: { not: null } },
    orderBy: { displayCode: "asc" },
    take: 1000,
    select: { displayCode: true, title: true, difficulty: true },
  });
}
