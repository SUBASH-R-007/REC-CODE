import { describe, expect, it } from "vitest";
import { findFiles, readRepoFile } from "./support/repo";

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

/**
 * Every file that asks the database for a paper's `problems` count.
 *
 * Hand-listing the call sites is what let this happen a sixth and seventh
 * time: the list held the three places somebody had already fixed, so it
 * said nothing about the student's own assessment list or the staff
 * Questions column, which both counted `problems` alone. This asks the
 * question the other way round — WHO COUNTS A PAPER — and makes every
 * answer declare both kinds.
 */
/**
 * Built per call, not held in a module constant.
 *
 * A `/g` regex carries `lastIndex`, and reusing one across `matchAll` over
 * 700 files found NOTHING while the same pattern written inline found every
 * site — a fence that passes because it matched nothing is the worst kind
 * of green, so it is constructed fresh and the test below counts the sites
 * it finds to prove it is still looking at something.
 */
const countSelect = () => /_count:\s*\{\s*select:\s*\{([^}]*)\}/g;

/** Files that count an Assessment's questions, by what they select. */
const assessmentCountSites = (): Array<{ rel: string; fields: string }> => {
  const sites: Array<{ rel: string; fields: string }> = [];
  for (const rel of findFiles({ extensions: [".ts", ".tsx"] })) {
    if (!rel.startsWith("apps/web/src/")) continue;
    const source = readRepoFile(rel);
    // Only the queries that are ABOUT an assessment: a contest also has
    // `problems`, and a contest has no multiple-choice questions.
    if (!source.includes("db.assessment")) continue;
    for (const match of source.matchAll(countSelect())) {
      const fields = match[1] ?? "";
      if (fields.includes("problems")) sites.push({ rel, fields });
    }
  }
  return sites;
};

describe("a paper of two kinds", () => {
  it("is counted by somebody, or this fence is asserting nothing", () => {
    // Four is the number of places that count an assessment's questions
    // today. If this drops, the fence has stopped looking rather than the
    // product having stopped counting.
    expect(assessmentCountSites().length).toBeGreaterThanOrEqual(4);
  });

  it("counts BOTH kinds everywhere an assessment's questions are counted", () => {
    /**
     * Seven instances, found one at a time over four phases: the start
     * library's "nothing to sit", the sitting's marking, the admin page,
     * the readiness page, the sitting's own empty-paper guard, the
     * student's assessment list and the staff Questions column. Every one
     * read correctly and was wrong.
     */
    const offenders = assessmentCountSites().filter((site) => !site.fields.includes("mcqs"));
    expect(
      offenders.map((o) => `${o.rel}: _count {${o.fields.trim()}}`),
      "an assessment's question count must include mcqs: a paper may be all code, all questions, or a mix",
    ).toEqual([]);
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
