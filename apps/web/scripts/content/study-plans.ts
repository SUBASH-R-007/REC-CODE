/**
 * The seeded study plans, and the one function that keeps them in step with
 * what is published. A plan only ever lists PUBLISHED problems, so the seed
 * (and validate-and-publish, after a successful publish) re-run the sync:
 * newly published problems join, sections and order are refreshed, and
 * StudyPlan.itemsTotal plus every enrollment's itemsTotal / itemsDone stay
 * correct ("done" = UserProblemStatus SOLVED, the one source of truth).
 *
 * Only plans whose slug is listed here are touched, and only while they are
 * seed-managed: a plan an admin detached from the seed in /admin/sheets or
 * /admin/tracks (StudyPlan.seedManaged = false) is left exactly as the admin
 * made it. Plans the seed creates are seed-managed.
 */
import { TOPIC_LABEL, TOPICS, type Topic } from "@recx/shared";
import type { Db } from "@recx/db";
import { recountStudyPlan } from "../../src/lib/plans/recount";
import { TOPICS_BY_SLUG } from "./index";

export interface CuratedSection {
  title: string;
  slugs: readonly string[];
}

export interface SeededPlan {
  slug: string;
  kind: "SHEET" | "TRACK";
  title: string;
  description: string;
  sortOrder: number;
  /**
   * "EASY_MEDIUM_BY_TOPIC": every published Easy and Medium problem, one
   * section per primary topic (in the 14-topic order). Otherwise a curated
   * list of sections; unpublished slugs are left out until they publish.
   */
  sections: "EASY_MEDIUM_BY_TOPIC" | readonly CuratedSection[];
}

export const SEEDED_PLANS: readonly SeededPlan[] = [
  {
    slug: "rec-starter-sheet",
    kind: "SHEET",
    title: "REC Starter Sheet",
    description:
      "Every published Easy and Medium problem, grouped by topic. Pick a topic, start with its first problem, and work down — each section opens with its gentlest problem.",
    sortOrder: 0,
    sections: "EASY_MEDIUM_BY_TOPIC",
  },
  {
    slug: "arrays-hashing-basics",
    kind: "TRACK",
    title: "Arrays & Hashing Basics",
    description:
      "A short path from one careful pass over an array to hash sets, hash maps and sorted arrays. Solve the problems in order: each one adds a single new idea to the last.",
    sortOrder: 1,
    sections: [
      { title: "One careful pass", slugs: ["handle-maker"] },
      { title: "Have I seen it before? Hash sets", slugs: ["second-swipe"] },
      { title: "Where did I see it? Hash maps", slugs: ["two-sum"] },
      { title: "Sorted arrays and two pointers", slugs: ["study-pairs"] },
    ],
  },
];

/** The section a sheet files a problem under that has no topic tag at all. */
export const UNTAGGED_SECTION = "Mixed practice";

export interface PublishedProblem {
  id: string;
  slug: string;
  displayCode: string;
  difficulty: "EASY" | "MEDIUM" | "HARD";
  tags: readonly Topic[];
}

const DIFFICULTY_ORDER = { EASY: 0, MEDIUM: 1, HARD: 2 } as const;

/** Primary topic: the authored one when the seed knows the problem, else the first tag in topic order. */
export function primaryTopic(problem: Pick<PublishedProblem, "slug" | "tags">): Topic | null {
  const authored = TOPICS_BY_SLUG.get(problem.slug)?.[0];
  if (authored) return authored;
  return TOPICS.find((t) => problem.tags.includes(t)) ?? null;
}

export interface DesiredSection {
  title: string;
  /** Problem ids in item order. */
  problemIds: string[];
}

/** Pure: the sections and items a plan should have, given what is published. */
export function desiredSections(plan: SeededPlan, published: readonly PublishedProblem[]): DesiredSection[] {
  if (plan.sections !== "EASY_MEDIUM_BY_TOPIC") {
    const bySlug = new Map(published.map((p) => [p.slug, p]));
    return plan.sections
      .map((s) => ({ title: s.title, problemIds: s.slugs.flatMap((slug) => bySlug.get(slug)?.id ?? []) }))
      .filter((s) => s.problemIds.length > 0);
  }
  const eligible = published
    .filter((p) => p.difficulty === "EASY" || p.difficulty === "MEDIUM")
    .sort((a, b) => DIFFICULTY_ORDER[a.difficulty] - DIFFICULTY_ORDER[b.difficulty] || a.displayCode.localeCompare(b.displayCode));
  const groups = new Map<Topic | null, string[]>();
  for (const p of eligible) {
    const topic = primaryTopic(p);
    groups.set(topic, [...(groups.get(topic) ?? []), p.id]);
  }
  const sections: DesiredSection[] = [];
  for (const topic of TOPICS) {
    const ids = groups.get(topic);
    if (ids) sections.push({ title: TOPIC_LABEL[topic], problemIds: ids });
  }
  const untagged = groups.get(null);
  if (untagged) sections.push({ title: UNTAGGED_SECTION, problemIds: untagged });
  return sections;
}

export interface PlanSyncResult {
  slug: string;
  created: boolean;
  itemsTotal: number;
  added: number;
  removed: number;
  moved: number;
  enrollmentsUpdated: number;
  /** True when the plan was detached from the seed in /admin, and so left unchanged. */
  detached: boolean;
}

async function loadPublished(db: Db): Promise<PublishedProblem[]> {
  const rows = await db.problem.findMany({
    where: { status: "PUBLISHED", liveVersionId: { not: null } },
    orderBy: { displayCode: "asc" },
    select: { id: true, slug: true, displayCode: true, difficulty: true, tags: { select: { topic: true } } },
  });
  return rows.map((r) => ({ ...r, tags: r.tags.map((t) => t.topic) }));
}

async function syncPlan(db: Db, plan: SeededPlan, published: readonly PublishedProblem[]): Promise<PlanSyncResult> {
  const sections = desiredSections(plan, published);
  const itemsTotal = sections.reduce((n, s) => n + s.problemIds.length, 0);
  return db.$transaction(
    async (tx) => {
      const existingPlan = await tx.studyPlan.findUnique({
        where: { slug: plan.slug },
        select: { id: true, seedManaged: true, itemsTotal: true },
      });
      if (existingPlan && !existingPlan.seedManaged) {
        console.log(`study plan ${plan.slug}: detached from the seed in /admin — left unchanged`);
        return {
          slug: plan.slug,
          created: false,
          itemsTotal: existingPlan.itemsTotal,
          added: 0,
          removed: 0,
          moved: 0,
          enrollmentsUpdated: 0,
          detached: true,
        };
      }
      const content = {
        kind: plan.kind,
        title: plan.title,
        description: plan.description,
        sortOrder: plan.sortOrder,
        // A plan with nothing published in it yet stays hidden rather than empty.
        published: itemsTotal > 0,
        itemsTotal,
      };
      const { id: planId } = existingPlan
        ? await tx.studyPlan.update({ where: { id: existingPlan.id }, data: content, select: { id: true } })
        : await tx.studyPlan.create({ data: { slug: plan.slug, seedManaged: true, ...content }, select: { id: true } });

      // Sections, matched by title.
      const oldSections = await tx.studyPlanSection.findMany({ where: { planId }, select: { id: true, title: true, sortOrder: true } });
      const sectionId = new Map<string, string>();
      for (const [order, s] of sections.entries()) {
        const found = oldSections.find((o) => o.title === s.title);
        if (found) {
          if (found.sortOrder !== order) await tx.studyPlanSection.update({ where: { id: found.id }, data: { sortOrder: order } });
          sectionId.set(s.title, found.id);
        } else {
          const created = await tx.studyPlanSection.create({ data: { planId, title: s.title, sortOrder: order }, select: { id: true } });
          sectionId.set(s.title, created.id);
        }
      }

      // Items: one per (plan, problem); move, add, remove.
      const want = new Map<string, { sectionId: string; sortOrder: number }>();
      for (const s of sections) {
        for (const [order, problemId] of s.problemIds.entries()) want.set(problemId, { sectionId: sectionId.get(s.title)!, sortOrder: order });
      }
      const oldItems = await tx.studyPlanItem.findMany({ where: { planId }, select: { id: true, problemId: true, sectionId: true, sortOrder: true } });
      let removed = 0;
      let moved = 0;
      for (const item of oldItems) {
        const target = want.get(item.problemId);
        if (!target) {
          await tx.studyPlanItem.delete({ where: { id: item.id } });
          removed++;
        } else if (target.sectionId !== item.sectionId || target.sortOrder !== item.sortOrder) {
          await tx.studyPlanItem.update({ where: { id: item.id }, data: target });
          moved++;
        }
      }
      const have = new Set(oldItems.map((i) => i.problemId));
      const fresh = [...want].filter(([problemId]) => !have.has(problemId));
      if (fresh.length > 0) {
        await tx.studyPlanItem.createMany({ data: fresh.map(([problemId, target]) => ({ planId, problemId, ...target })) });
      }
      const keep = new Set(sectionId.values());
      await tx.studyPlanSection.deleteMany({ where: { planId, id: { notIn: [...keep] } } });

      // StudyPlan.itemsTotal and every enrollment's itemsTotal / itemsDone /
      // completedAt from UserProblemStatus (SOLVED), in one statement — the
      // same recount /admin uses after an edit (src/lib/plans/recount.ts).
      const { enrollmentsUpdated } = await recountStudyPlan(tx, planId);
      return {
        slug: plan.slug,
        created: !existingPlan,
        itemsTotal,
        added: fresh.length,
        removed,
        moved,
        enrollmentsUpdated,
        detached: false,
      };
    },
    { timeout: 30_000 },
  );
}

/** Bring the given plans in step with the published problems. Idempotent. */
export async function syncStudyPlans(db: Db, plans: readonly SeededPlan[]): Promise<PlanSyncResult[]> {
  const published = await loadPublished(db);
  const results: PlanSyncResult[] = [];
  for (const plan of plans) results.push(await syncPlan(db, plan, published));
  return results;
}

/** Bring every seeded plan in step with the published problems. Idempotent. */
export function syncSeededStudyPlans(db: Db): Promise<PlanSyncResult[]> {
  return syncStudyPlans(db, SEEDED_PLANS);
}
