/**
 * Where a revision's content came from. Every problem is originally authored;
 * the origin records by whom (and whether AI assisted the author).
 * Mirror: the Prisma enum ContentOrigin (same members, same order —
 * packages/db/test/enum-parity.test.ts).
 */
export const CONTENT_ORIGINS = ["FACULTY", "SENIOR_STUDENT", "AI_ASSISTED"] as const;

export type ContentOrigin = (typeof CONTENT_ORIGINS)[number];

/** The same list, for zod enums inside this module (avoids an import cycle through index.ts). */
export const CONTENT_ORIGINS_LIST = CONTENT_ORIGINS;

export const CONTENT_ORIGIN_LABEL: Readonly<Record<ContentOrigin, string>> = {
  FACULTY: "Faculty",
  SENIOR_STUDENT: "Senior student (reviewed by faculty)",
  AI_ASSISTED: "AI-assisted draft (reviewed by faculty)",
};

export const DIFFICULTIES = ["EASY", "MEDIUM", "HARD"] as const;
export type Difficulty = (typeof DIFFICULTIES)[number];
