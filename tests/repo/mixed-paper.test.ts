import { describe, expect, it } from "vitest";
import { readRepoFile } from "./support/repo";

/**
 * A paper holds questions of two kinds, and every place that counts them
 * has to count both (Phase 12t).
 *
 * This is the same mistake five times. `AssessmentProblem` was the only
 * kind of question a paper could hold until Phase 12r added
 * `AssessmentMcq`, and every piece of code written before that said
 * "questions" when it meant "programs". Each of the five read correctly,
 * passed review, and was wrong:
 *
 *   1. the start library refused a paper whose only questions were
 *      multiple-choice as `not_open` — "nothing to sit";
 *   2. the sitting's marking marked out of the coding points alone;
 *   3. the admin page's count;
 *   4. the readiness page told a candidate the wrong number of questions
 *      before they started;
 *   5. and the sitting itself replaced the whole screen with "This paper
 *      has no questions. Tell your invigilator." the moment a candidate
 *      clicked a multiple-choice question — no palette, no clock, no
 *      editor, mid-exam. That one was found by `e2e/exam-journey.spec.ts`
 *      on its first run, because nothing had ever sat a mixed paper in a
 *      browser.
 *
 * So the rule is written down here rather than remembered: anything that
 * asks "how many questions does this paper have" goes through
 * `paperQuestionCount`, and the sitting's empty-paper guard asks about the
 * MERGED palette rather than about the coding questions.
 *
 * A source fence, deliberately: the fifth one was a single `!question` in a
 * component whose rendering a unit test cannot reach, and the sixth will be
 * too.
 */

/** Every place that states a paper's size, and must not count one kind. */
const COUNTS_BOTH_KINDS: ReadonlyArray<readonly [string, string]> = [
  ["apps/web/src/lib/exam/start.ts", "paperQuestionCount(assessment)"],
  ["apps/web/src/app/(exam)/assessments/[slug]/readiness/page.tsx", "paperQuestionCount({"],
  // The publish gate: a paper with nothing on it cannot be opened, and a
  // paper of multiple-choice questions is not nothing.
  ["apps/web/src/server/actions/admin-assessments.ts", "paperQuestionCount({"],
];

describe("a paper of two kinds", () => {
  it("counts both kinds wherever it states its size", () => {
    for (const [file, call] of COUNTS_BOTH_KINDS) {
      expect(readRepoFile(file), `${file} should ask paperQuestionCount`).toContain(call);
    }
  });

  it("does not count the coding questions alone on the readiness page", () => {
    // The exact shape of the fourth instance: `_count.problems` on its own,
    // handed to the candidate as "N questions".
    const page = readRepoFile("apps/web/src/app/(exam)/assessments/[slug]/readiness/page.tsx");
    expect(page).not.toMatch(/questionCount=\{assessment\._count\.problems\}/);
    // And it still selects both, since paperQuestionCount can only add up
    // what the query asked for.
    expect(page).toContain("problems: true, mcqs: true");
  });

  it("decides a sitting is empty from the merged palette, not from the programs", () => {
    /**
     * The fifth instance, and the fence that would have caught it. `items`
     * is the merged list; `question` is only set when the CURRENT item is a
     * coding question, so a guard on `question` means "the candidate is
     * looking at a multiple-choice question" and not "this paper is empty".
     */
    const session = readRepoFile("apps/web/src/components/exam/exam-session.tsx");
    expect(session, "the empty-paper guard must ask the merged palette").toContain("if (items.length === 0) {");
    expect(session, "a guard on the current coding question hides every MCQ").not.toMatch(
      /if \(!question\) \{/,
    );
  });
});
