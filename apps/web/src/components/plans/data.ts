import "server-only";
import { cache } from "react";
import type { Difficulty, StudyPlanKind } from "@recx/db";
import { db } from "@/lib/db";
import type { SolveState } from "@/server/queries/problems";

/**
 * Read side of study plans (/sheets, /learn). Only published plans are ever
 * returned; the viewer's own enrolment and solve states are the only
 * per-user data read, always keyed by the session user's id.
 */

export interface PlanSummary {
  id: string;
  slug: string;
  kind: StudyPlanKind;
  title: string;
  description: string;
  itemCount: number;
  sectionCount: number;
  /** The viewer's enrolment (maintained counters), or null when not enrolled. */
  enrollment: { itemsDone: number; itemsTotal: number; completed: boolean } | null;
}

export async function listPublishedPlans(kind: StudyPlanKind, userId: string): Promise<PlanSummary[]> {
  const plans = await db.studyPlan.findMany({
    where: { kind, published: true },
    orderBy: [{ sortOrder: "asc" }, { title: "asc" }],
    select: {
      id: true,
      slug: true,
      kind: true,
      title: true,
      description: true,
      _count: { select: { items: true, sections: true } },
      enrollments: {
        where: { userId },
        select: { itemsDone: true, itemsTotal: true, completedAt: true },
      },
    },
  });
  return plans.map((p) => {
    const e = p.enrollments[0];
    return {
      id: p.id,
      slug: p.slug,
      kind: p.kind,
      title: p.title,
      description: p.description,
      itemCount: p._count.items,
      sectionCount: p._count.sections,
      enrollment: e
        ? { itemsDone: e.itemsDone, itemsTotal: e.itemsTotal, completed: e.completedAt !== null }
        : null,
    };
  });
}

export interface PlanItemView {
  id: string;
  problemSlug: string;
  displayCode: string;
  title: string;
  difficulty: Difficulty;
  /** False when the problem has since been unpublished: shown, but not linked. */
  available: boolean;
  solve: SolveState;
}

export interface PlanSectionView {
  id: string;
  title: string;
  items: PlanItemView[];
  solved: number;
}

export interface PlanDetail {
  id: string;
  slug: string;
  kind: StudyPlanKind;
  title: string;
  description: string;
  sections: PlanSectionView[];
  itemCount: number;
  /** Items the viewer has solved (UserProblemStatus = SOLVED), enrolled or not. */
  solvedCount: number;
  enrollment: { itemsDone: number; itemsTotal: number; completed: boolean } | null;
}

/** The published plan's identity, for metadata and the kind check. Cached per request. */
export const getPublishedPlanMeta = cache(async (slug: string) =>
  db.studyPlan.findFirst({
    where: { slug, published: true },
    select: { id: true, slug: true, kind: true, title: true },
  }),
);

/**
 * A published plan with its sections and items in authored order and the
 * viewer's solve state on every item (one UserProblemStatus query).
 */
export async function getPlanDetail(slug: string, userId: string): Promise<PlanDetail | null> {
  const plan = await db.studyPlan.findFirst({
    where: { slug, published: true },
    select: {
      id: true,
      slug: true,
      kind: true,
      title: true,
      description: true,
      sections: {
        orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
        select: {
          id: true,
          title: true,
          items: {
            orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
            select: {
              id: true,
              problem: {
                select: {
                  id: true,
                  slug: true,
                  displayCode: true,
                  title: true,
                  difficulty: true,
                  status: true,
                  liveVersionId: true,
                },
              },
            },
          },
        },
      },
      enrollments: {
        where: { userId },
        select: { itemsDone: true, itemsTotal: true, completedAt: true },
      },
    },
  });
  if (!plan) return null;

  const problemIds = plan.sections.flatMap((s) => s.items.map((i) => i.problem.id));
  const statuses =
    problemIds.length === 0
      ? []
      : await db.userProblemStatus.findMany({
          where: { userId, problemId: { in: problemIds } },
          select: { problemId: true, status: true },
        });
  const statusOf = new Map(statuses.map((s) => [s.problemId, s.status]));

  let solvedCount = 0;
  const sections: PlanSectionView[] = plan.sections.map((section) => {
    let solved = 0;
    const items = section.items.map((item): PlanItemView => {
      const status = statusOf.get(item.problem.id);
      const solve: SolveState = status === "SOLVED" ? "solved" : status === "ATTEMPTED" ? "attempted" : null;
      if (solve === "solved") solved += 1;
      return {
        id: item.id,
        problemSlug: item.problem.slug,
        displayCode: item.problem.displayCode,
        title: item.problem.title,
        difficulty: item.problem.difficulty,
        available: item.problem.status === "PUBLISHED" && item.problem.liveVersionId !== null,
        solve,
      };
    });
    solvedCount += solved;
    return { id: section.id, title: section.title, items, solved };
  });

  const e = plan.enrollments[0];
  return {
    id: plan.id,
    slug: plan.slug,
    kind: plan.kind,
    title: plan.title,
    description: plan.description,
    sections,
    itemCount: problemIds.length,
    solvedCount,
    enrollment: e ? { itemsDone: e.itemsDone, itemsTotal: e.itemsTotal, completed: e.completedAt !== null } : null,
  };
}
