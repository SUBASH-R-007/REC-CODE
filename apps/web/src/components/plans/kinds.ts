import type { StudyPlanKind } from "@recx/db";

/**
 * The two kinds of study plan share every component; only their home and
 * wording differ. SHEET = a curated problem list (/sheets), TRACK = a guided
 * learning path (/learn).
 */
export interface PlanKindConfig {
  basePath: "/sheets" | "/learn";
  /** Page title of the index. */
  title: string;
  /** Lower-case singular noun used in sentences ("this sheet"). */
  noun: string;
  intro: string;
  emptyTitle: string;
  emptyDescription: string;
}

export const PLAN_KINDS: Readonly<Record<StudyPlanKind, PlanKindConfig>> = {
  SHEET: {
    basePath: "/sheets",
    title: "Sheets",
    noun: "sheet",
    intro: "Curated problem lists from the placement cell. Enroll to track how many you have solved.",
    emptyTitle: "No sheets published yet",
    emptyDescription: "Problem sheets appear here as soon as the placement cell publishes them.",
  },
  TRACK: {
    basePath: "/learn",
    title: "Learning tracks",
    noun: "track",
    intro: "Guided paths through a topic, one step at a time. Enroll to track your progress.",
    emptyTitle: "No learning tracks published yet",
    emptyDescription: "Learning tracks appear here as soon as they are published.",
  },
};

export function planHref(kind: StudyPlanKind, slug: string): string {
  return `${PLAN_KINDS[kind].basePath}/${slug}`;
}

const PLAN_SLUG = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;

/** Route params are untrusted: anything that is not slug-shaped is simply "not found". */
export function isPlanSlug(value: string): boolean {
  return PLAN_SLUG.test(value);
}

/** "4 of 12 solved". */
export function solvedText(done: number, total: number): string {
  return `${done} of ${total} solved`;
}
