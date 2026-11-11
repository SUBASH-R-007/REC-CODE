/**
 * Moderating a question after the paper has been sat (Phase 13i).
 *
 * Every examiner needs this and no exam system is honest without it: a
 * question turns out to be wrong — an ambiguous stem, two correct options,
 * a test case that was never satisfiable — and it is discovered after
 * three hundred people have answered it. Re-sitting the paper is not an
 * option, and leaving it is a mark nobody can defend.
 *
 * Two remedies, which are the two every examination board uses:
 *
 *   - **FULL_MARKS**: everybody gets the question's marks. The right
 *     answer when the question was answerable but unfairly marked — a
 *     second option that was also correct, a checker that rejected a
 *     correct program. Nobody is disadvantaged by having tried it.
 *   - **DROPPED**: the question leaves the paper. Its marks come out of
 *     the total as well as out of everybody's score, so a paper of 50
 *     becomes a paper of 47 and the percentages stay honest. The right
 *     answer when the question should never have been asked.
 *
 * Deliberately not here: a third remedy that changes the correct answer
 * and re-marks. That is a different act with a different risk — it makes
 * somebody's wrong answer right and somebody else's right answer wrong —
 * and it belongs to editing the question and rejudging, where the full
 * history is kept.
 *
 * The arithmetic lives in `@recx/shared` with the rest of the marking, so
 * a disputed mark is reproducible from its inputs without a database.
 */

export const QUESTION_MODERATIONS = ["NONE", "FULL_MARKS", "DROPPED"] as const;
export type QuestionModeration = (typeof QUESTION_MODERATIONS)[number];

/** The outcomes only moderation can produce. */
export type ModeratedOutcome = "awarded" | "dropped";

export interface ModeratedMark {
  readonly outcome: ModeratedOutcome;
  readonly points: number;
  readonly maxPoints: number;
}

/**
 * What a moderated question is worth, or null when it is not moderated and
 * the ordinary marking applies.
 *
 * One function for both halves of a paper: a dropped multiple-choice
 * question and a dropped program have to come out of the total the same
 * way, and two copies of "maxPoints becomes 0" would eventually disagree.
 */
export function moderatedMark(
  moderation: QuestionModeration | undefined,
  maxPoints: number,
): ModeratedMark | null {
  if (moderation === "FULL_MARKS") return { outcome: "awarded", points: maxPoints, maxPoints };
  // Out of the score AND out of the total: a paper of 50 with a dropped
  // 3-mark question is a paper of 47, or every percentage on it is wrong.
  if (moderation === "DROPPED") return { outcome: "dropped", points: 0, maxPoints: 0 };
  return null;
}

/** What a candidate is told about a moderated question. Never the reason. */
export const MODERATION_STUDENT_NOTE: Record<ModeratedOutcome, string> = {
  awarded: "This question was marked for everyone — you have its full marks whatever you answered.",
  dropped: "This question was withdrawn after the paper. It counts for nobody, and its marks are out of the total.",
};
