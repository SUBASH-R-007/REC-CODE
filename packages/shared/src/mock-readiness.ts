import { missing, present, type ComponentValue } from "./readiness";

/**
 * `mockInterviewScore` finally has a source (Phase 16c).
 *
 * `docs/OPEN-QUESTIONS.md` has carried this since Phase 9b: *"`mockInterviewScore`
 * has no source, and will not have one this year… the mock-interview
 * scheduler is Phase 11 or later. So it is permanently `MISSING /
 * NO_SOURCE_YET` at launch, and no TOP score can exceed 85."*
 *
 * The scheduler shipped in Phase 12h. An interviewer writes three 1–5
 * ratings and a feedback note when they finish, and that is exactly the
 * measurement the component was defined for — so the sentence above has
 * stopped being true, and leaving it in place would mean a readiness score
 * that is permanently 15 points short of itself for no reason anybody can
 * point at.
 *
 * **Four decisions, because turning three opinions into a number is not
 * obvious.**
 *
 * **The mean of the three ratings, mapped so that 1 is 0 and 5 is 1.** Not a
 * weighted mean: nothing here knows whether communication matters more than
 * code for a given company, and inventing a weight would be inventing the
 * part of the judgement the interviewer was asked to make. `(mean - 1) / 4`,
 * so a straight-3s interview is 0.5 rather than 0.6 — a 1 is the bottom of
 * the scale, not a twentieth of it.
 *
 * **The most recent three, not all of them, and not the best.** A student
 * who was poor in October and good in February is good in February; an
 * average over everything would hold them to a version of themselves they
 * have replaced. Taking the BEST would make the number a high-water mark,
 * and a mock interview is practice — the point of practice is the trend.
 * Three is the window because two is a pair of opinions and four reaches
 * back further than a semester of improvement.
 *
 * **Two interviews minimum, and below that `NO_DATA_YET`.** One interview is
 * one mentor's reading on one afternoon, and this component carries 15% of
 * the TOP tier: a single generous or harsh interviewer should not move a
 * placement signal by fifteen points. `NO_DATA_YET` and never
 * `NO_SOURCE_YET`, because the reason is now the student's to fix — the
 * scheduler exists and the slots are bookable.
 *
 * **A NO_SHOW or a CANCELLED interview is not a zero.** It is not a
 * measurement at all. Only an interview the interviewer finished AND rated
 * counts; one they finished without writing ratings counts as nothing
 * either, because the number would then depend on whether a mentor filled
 * in a form.
 */

/** The window: the most recent interviews that count towards the component. */
export const MOCK_READINESS_WINDOW = 3;

/** Below this many rated interviews the component is MISSING, not low. */
export const MOCK_READINESS_MIN = 2;

export interface MockRating {
  readonly communication: number;
  readonly problemSolving: number;
  readonly code: number;
}

/** One interview's 0–1 value. Each rating is 1–5; `(mean - 1) / 4` maps that onto 0–1. */
export function mockInterviewValue(rating: MockRating): number {
  const mean = (rating.communication + rating.problemSolving + rating.code) / 3;
  const scaled = (mean - 1) / 4;
  return Math.min(1, Math.max(0, scaled));
}

/**
 * The component, from a student's rated interviews **most recent first**.
 *
 * The caller orders them; this does not sort, because "most recent" is a
 * question about `feedbackAt` and `endedAt` that belongs next to the rows.
 */
export function mockInterviewComponent(ratingsNewestFirst: readonly MockRating[]): ComponentValue {
  if (ratingsNewestFirst.length < MOCK_READINESS_MIN) return missing("NO_DATA_YET");
  const window = ratingsNewestFirst.slice(0, MOCK_READINESS_WINDOW);
  const total = window.reduce((sum, rating) => sum + mockInterviewValue(rating), 0);
  return present(total / window.length);
}

/** What a student is told about the component when it is present. */
export function mockInterviewNote(count: number): string {
  const counted = Math.min(count, MOCK_READINESS_WINDOW);
  return counted === 1
    ? "From your most recent rated mock interview."
    : `From your ${counted} most recent rated mock interviews.`;
}
