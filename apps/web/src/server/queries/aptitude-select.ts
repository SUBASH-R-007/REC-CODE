import "server-only";

/**
 * What a student may see of an aptitude question, and when (Phase 7).
 *
 * `correctOptionIndexes`, `numericAnswer`, `numericTolerance` and
 * `explanation` are a new class of student-unreachable data. The Phase 4
 * student-exposure fence knows nothing about these columns, so Phase 7 adds
 * these two selects and `tests/repo/aptitude-answer-exposure.test.ts`, which
 * requires every `aptitudeQuestion` read reachable from a student entry point
 * to use one of them by name — plus a live canary that asserts the practice
 * and sitting queries return rows without those fields.
 *
 * Hiding the key only in the component is not a fence: the key would still be
 * in the page's serialised props, which is a view-source away.
 */

/**
 * Everything needed to ASK a question, and nothing needed to answer it.
 *
 * Used by the sitting page, the practice page and the clock route. Note what
 * is absent: there is no `correctOptionIndexes`, no `numericAnswer`, no
 * `numericTolerance` and no `explanation`.
 */
export const APTITUDE_PUBLIC_SELECT = {
  id: true,
  displayCode: true,
  area: true,
  topic: true,
  kind: true,
  difficulty: true,
  stem: true,
  options: true,
  numericUnit: true,
  expectedSeconds: true,
  passageId: true,
} as const;

/**
 * The key and the worked explanation, for a student who has already answered.
 *
 * The ONLY student paths that may use this are the review of a finalised
 * sitting and a practice question whose answer is already committed. Both
 * check that before selecting, and the fence lists them.
 */
export const APTITUDE_ANSWER_SELECT = {
  ...APTITUDE_PUBLIC_SELECT,
  correctOptionIndexes: true,
  numericAnswer: true,
  numericTolerance: true,
  explanation: true,
} as const;

/**
 * The least a draw needs: enough to shuffle a paper, and nothing to read.
 *
 * `buildMockLayout()` needs a question's id, its topic, how many options it
 * has and which passage it belongs to. It does not need the stem, so the
 * pool read for a 2,000-question bank does not carry 2,000 stems across the
 * wire — and naming the select is what lets
 * `tests/repo/aptitude-answer-exposure.test.ts` require a NAMED select on
 * every student-reachable read rather than merely the absence of the key.
 */
export const APTITUDE_POOL_SELECT = {
  id: true,
  topic: true,
  options: true,
  passageId: true,
} as const;

/**
 * Just enough to recognise a question an import might be about.
 *
 * The importer matches a row by code and then by content hash, and needs the
 * status to refuse an edit to a published one. Named, like every other read,
 * so `tests/repo/aptitude-answer-exposure.test.ts` can require a NAMED select
 * everywhere rather than merely the absence of the key — which is the
 * difference between a fence and a habit.
 */
export const APTITUDE_IDENTITY_SELECT = {
  id: true,
  displayCode: true,
  contentHash: true,
  status: true,
} as const;

/** The passage body, which carries no key at all and is public with the question. */
export const APTITUDE_PASSAGE_SELECT = {
  id: true,
  title: true,
  body: true,
  wordCount: true,
} as const;

/** The four fields that must never reach a student before they have answered. */
export const APTITUDE_ANSWER_KEY_FIELDS = [
  "correctOptionIndexes",
  "numericAnswer",
  "numericTolerance",
  "explanation",
] as const;
