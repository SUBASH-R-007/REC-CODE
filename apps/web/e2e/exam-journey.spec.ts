import { expect, test, type Page } from "@playwright/test";
import { contextAs } from "./support/session";
import { openPage } from "./support/page";
import {
  authorPaper,
  goToQuestion,
  paletteButton,
  RIGHT_OPTION,
  walkReadinessChecks,
  type AuthoredPaper,
} from "./support/exam-paper";

/**
 * Phase 12t: somebody actually sits an assessment, in a browser.
 *
 * Nothing did, until now. `contest-journey` enters an arena,
 * `keyboard-journey` solves a practice problem, `problem-kinds` reads the
 * kinds — and the exam surface, the highest-stakes screen in the product,
 * had no end-to-end test at all. Every defect of the last three phases
 * lived there, and every one was reported by a person sitting a paper
 * rather than caught by anything:
 *
 *   - 12r.2: the paper handed the client the editor's highlighting mode in
 *     a field every route validates as a toolchain KEY, so a candidate
 *     could not save, could not run and COULD NOT HAND IN. Nothing looked
 *     wrong until a request was made.
 *   - 12r.1, 12r.3, 12s.1: four separate places counted a paper's questions
 *     from the coding questions alone, so a paper with multiple-choice
 *     questions on it announced the wrong number, built the wrong palette
 *     and marked out of the wrong total.
 *   - 12q.5: there was no Run in a sitting at all, and the save pill said
 *     "Not saved — check your connection" while the connection was fine.
 *
 * Each of those is one browser journey away from being obvious. So this is
 * that journey, across BOTH question kinds in one paper, from authoring to
 * handed in: a staff member authors a mixed paper and opens it, a candidate
 * reads the readiness page and the question count on it, starts, answers
 * the multiple-choice question and watches the pill say Saved, moves to the
 * coding question, types a solution, pastes something from outside and is
 * refused, runs the samples, hands the paper in, and cannot get back in.
 *
 * NOT in any gate: it needs a live stack, and Run needs a judge. Run it by
 * name — `--project=exam` — with `E2E_JUDGE=1` for the Run step; without
 * that the Run assertions are skipped and everything else still runs.
 *
 * Each run authors its own paper (address `e2e-exam-<runId>`) and leaves it
 * behind in the dev database, which is harmless: a later run is unaffected.
 */

const runId = Math.random().toString(36).slice(2, 8);

const JUDGE = process.env.E2E_JUDGE === "1";

/** The save pill, which is a live region. */
const savePill = (page: Page) => page.getByRole("status").filter({ hasText: /Saved|Saving|Not saved/ }).first();

/**
 * Two-sum in C++20, the paper's frozen language, in the shape the paper
 * asks for.
 *
 * A FUNCTION problem: the judge supplies `main`, includes the headers and
 * calls `Solution::twoSum`. The first draft of this spec wrote a whole
 * program with its own `main`, and the Run console said so — "error:
 * redefinition of 'int main()'", with the hint "do not write main() — in a
 * function problem the judge supplies it and calls your method". Which is
 * the console doing its job, and the reason this step is in the journey at
 * all: the verdict and its explanation are what a candidate reads.
 *
 * Quadratic on purpose: the samples are three elements long, and this needs
 * no header the starter's own signature does not already require.
 */
const SOLUTION = [
  "class Solution {",
  "public:",
  "    std::vector<int> twoSum(std::vector<int>& nums, long long target) {",
  "        for (int i = 0; i < (int)nums.size(); i++)",
  "            for (int j = i + 1; j < (int)nums.size(); j++)",
  "                if ((long long)nums[i] + nums[j] == target) return {i, j};",
  "        return {};",
  "    }",
  "};",
].join("\n");

test.describe.configure({ mode: "serial" });

test.describe("exam journey", () => {
  test("author a mixed paper, sit it, answer both kinds, hand it in", async ({ browser }) => {
    test.setTimeout(12 * 60_000);

    // ── 1. A staff member authors a mixed paper and opens it ──
    const staffContext = await contextAs(browser, "admin");
    const admin = await staffContext.newPage();
    const paper: AuthoredPaper = await authorPaper(admin, {
      runId,
      // The reason this paper is the one that tests it: the refusal happens
      // inside a browser paste event and nowhere else (Phase 12s).
      refuseOutsidePaste: true,
      /**
       * Two accepted languages (Phase 13a), ticked through the real admin
       * form. The picker, the starter swap and the rule about keeping work
       * are all browser behaviour, so this is where they are proved.
       */
      languages: ["C++20", "Python 3.12"],
    });

    // ── 4. The candidate reads the readiness page ──
    const candidateContext = await contextAs(browser, "journey", {
      // For the paste step: a real Ctrl+V needs a real clipboard.
      permissions: ["clipboard-read", "clipboard-write"],
    });
    const candidate = await candidateContext.newPage();

    await openPage(candidate, `/assessments/${paper.slug}/readiness`);
    // The page's own heading is "Before you start"; the paper's title is the
    // heading under it.
    await expect(candidate.getByRole("heading", { name: "Before you start", level: 1 })).toBeVisible({
      timeout: 60_000,
    });
    await expect(candidate.getByRole("heading", { name: paper.title, level: 2 })).toBeVisible();
    /**
     * BOTH kinds, which is the fence for the blind spot found in four
     * separate places: this page counted `_count.problems` alone, so a
     * paper with multiple-choice questions on it told a candidate the wrong
     * number before they started (12s.1).
     */
    await expect(candidate.getByText(/2 questions/).first()).toBeVisible();
    await expect(candidate.getByText(/90 minutes/).first()).toBeVisible();

    // ── 5. The four checks, then Start ──
    await walkReadinessChecks(candidate);
    const start = candidate.getByRole("button", { name: "Start the assessment" });
    await start.click();
    await expect(candidate).toHaveURL(new RegExp(`/assessments/${paper.slug}/attempt$`), { timeout: 120_000 });
    // Two questions in the palette, not one: `items`, not `questions`.
    await expect(candidate.getByText(/Question 1 of 2/).first()).toBeVisible({ timeout: 60_000 });
    await expect(paletteButton(candidate, 2)).toBeVisible();

    // ── 6. The multiple-choice question: pick an option, watch it save ──
    await goToQuestion(candidate, 2, 2);
    await expect(candidate.getByText(paper.stem.slice(0, 30), { exact: false }).first()).toBeVisible({ timeout: 30_000 });
    // A real radio group, so an option is reachable by its own text.
    await candidate.getByRole("radio", { name: RIGHT_OPTION }).check();
    /**
     * The pill, asserted rather than trusted: for a whole phase it said
     * "Not saved — check your connection" while the connection was fine,
     * because the language the client sent was the one value no route would
     * accept (12r.2).
     */
    await expect(savePill(candidate)).toContainText(/Saved/, { timeout: 60_000 });
    // And the answer survives a reload, which is what "saved" has to mean.
    await candidate.reload();
    await expect(paletteButton(candidate, 2)).toBeVisible({ timeout: 60_000 });
    await goToQuestion(candidate, 2, 2);
    await expect(candidate.getByRole("radio", { name: RIGHT_OPTION })).toBeChecked({ timeout: 60_000 });

    // ── 7. The coding question: type, and watch THAT save ──
    await goToQuestion(candidate, 1, 2);
    const editorRoot = candidate.locator("[data-editor-root]").first();
    await expect(editorRoot).toBeVisible({ timeout: 60_000 });

    /**
     * ── 7a. The language picker (Phase 13a) ──
     *
     * Before this phase a sitting had ONE language that nobody chose --
     * `cpp20`, because its key sorts first among the enabled toolchains --
     * so a candidate who writes Python sat down in front of a C++ editor
     * with nothing on screen to change it. The paper above accepts two.
     */
    const language = candidate.getByRole("combobox", { name: "Language" });
    await expect(language).toBeVisible({ timeout: 60_000 });
    await expect(language).toHaveValue("cpp20");
    // The full label with its compiler, because under exam conditions
    // there is no /judge page to go and read.
    await expect(candidate.getByText(/C\+\+20 \(GCC/).first()).toBeVisible();

    /**
     * An UNTOUCHED editor follows the picker: a Python candidate should not
     * have to clear `class Solution {` by hand, and the starter is the one
     * thing that is safe to replace.
     */
    await language.selectOption({ label: "Python 3.12" });
    await expect(editorRoot).toContainText("def twoSum", { timeout: 30_000 });
    await language.selectOption({ label: "C++20" });
    await expect(editorRoot).toContainText("vector<int> twoSum", { timeout: 30_000 });

    await editorRoot.click();
    // Replace the starter rather than appending to it: the starter already
    // declares the method, so a second one is a redefinition — which is what
    // the Run console said, in those words, the first time this ran.
    await candidate.keyboard.press("ControlOrMeta+a");
    await candidate.keyboard.insertText(SOLUTION);
    await expect(savePill(candidate)).toContainText(/Saved/, { timeout: 60_000 });

    /**
     * ── 7b. Changing the language KEEPS the work (Phase 13a) ──
     *
     * The rule that matters most about the picker, and the one only a
     * browser can prove: a candidate twenty minutes into an answer who
     * opens the dropdown to see what else is offered, and picks something
     * by accident, must not lose twenty minutes of work. Their text stays
     * exactly as it is and the picker moves; only an editor still holding
     * the starter is swapped (asserted above, before anything was typed).
     */
    await language.selectOption({ label: "Python 3.12" });
    await expect(editorRoot).toContainText("twoSum(std::vector<int>& nums", { timeout: 30_000 });
    await expect(savePill(candidate)).toContainText(/Saved/, { timeout: 60_000 });
    // Back to the language the answer is written in, with the answer intact.
    await language.selectOption({ label: "C++20" });
    await expect(editorRoot).toContainText("twoSum(std::vector<int>& nums", { timeout: 30_000 });
    await expect(savePill(candidate)).toContainText(/Saved/, { timeout: 60_000 });

    // ── 8. A paste the candidate did not copy inside is refused (12s.1) ──
    await candidate.evaluate(() => navigator.clipboard.writeText("// not from this sitting\nint x = 1;\n"));
    await editorRoot.click();
    await candidate.keyboard.press("ControlOrMeta+v");
    // The notice names the rule and the exception to it, because a refusal
    // with no explanation is a bug report.
    await expect(candidate.getByText(/not copied inside this sitting/i)).toBeVisible({ timeout: 30_000 });
    await expect(candidate.getByText(/own earlier work still pastes/i)).toBeVisible();
    // The text did not land in the editor.
    await expect(editorRoot).not.toContainText("not from this sitting");

    // ── 9. Run the samples (judge required) ──
    if (JUDGE) {
      await candidate.getByRole("button", { name: /Run samples/ }).click();
      // The drawer names itself "Run results" (exam-console.tsx).
      const drawer = candidate.getByRole("region", { name: "Run results" });
      await expect(drawer).toBeVisible({ timeout: 60_000 });
      /**
       * A verdict, not a spinner that never resolves. This is the whole of
       * what 12q.5 added, and "Malformed run" is what it said before the
       * language field was named for what it is.
       */
      /**
       * The verdict itself, not merely that the console opened. The header
       * carries the code and the panel the sentence, so this asserts the
       * one a correct answer earns — and that neither of the two things the
       * exam surface used to say instead is on screen: "Malformed run",
       * which is what every run said while the language field was wrong
       * (12r.2), and a compile error, which is what this spec's own first
       * solution earned by writing `main()` in a function problem.
       */
      await expect(drawer.getByText(/Accepted/i).first()).toBeVisible({ timeout: 240_000 });
      await expect(drawer.getByText(/Malformed/i)).toHaveCount(0);
      await expect(drawer.getByText(/Compile Error/i)).toHaveCount(0);
      // Both samples, each one already printed on the question.
      await expect(drawer.getByText(/Sample 1/i).first()).toBeVisible();
      await expect(drawer.getByText(/Sample 2/i).first()).toBeVisible();
    }

    // ── 10. Hand it in ──
    await candidate.getByRole("button", { name: "Submit test" }).click();
    await candidate.getByRole("button", { name: "Yes, submit" }).click();
    /**
     * The sentence a candidate reads at the one moment that matters most.
     * It used to be `ATTEMPT_REVOKE_MESSAGES.submitted` — "This attempt has
     * already been submitted." — which is the right answer to a request
     * arriving against a finished sitting and the wrong one for the person
     * who just pressed the button (12t).
     */
    await expect(candidate.getByText(/Handed in\. Your answers are saved/)).toBeVisible({ timeout: 120_000 });
    await expect(candidate.getByText(/already been submitted/)).toHaveCount(0);
    // And the buttons are gone.
    await expect(candidate.getByRole("button", { name: "Submit test" })).toHaveCount(0);
    await expect(candidate.getByRole("button", { name: /Run samples/ })).toHaveCount(0);

    // ── 11. One attempt means one attempt ──
    /**
     * And the paper says so on arrival rather than after four checks: the
     * readiness page used to render the whole form to a candidate who had
     * already handed in, and only pressing Start told them (12t). This step
     * could not press it, because the checks had not enabled it — which is
     * how that was found.
     */
    await openPage(candidate, `/assessments/${paper.slug}/readiness`);
    await expect(candidate.getByText(/already finished this assessment/i).first()).toBeVisible({
      timeout: 60_000,
    });
    await expect(candidate.getByRole("button", { name: /Start the assessment/i })).toHaveCount(0);
    await expect(candidate.getByRole("button", { name: "Test full screen" })).toHaveCount(0);
  });

  test("a paper that is only multiple-choice can be sat and handed in", async ({ browser }) => {
    /**
     * The case that fired 12t's empty-paper guard on the FIRST render, and
     * the case every count in the product got wrong at least once: a paper
     * with no coding question at all. The mixed journey above would not
     * have caught it — it opens on a coding question, so `question` was
     * defined and the guard stayed quiet until the candidate clicked the
     * second item.
     *
     * Short on purpose: everything the long journey asserts about saving,
     * running and handing in holds whatever the paper is made of. What is
     * particular here is that one question is a whole paper.
     */
    test.setTimeout(8 * 60_000);
    const staffContext = await contextAs(browser, "admin");
    const admin = await staffContext.newPage();
    const paper = await authorPaper(admin, { runId: `${runId}q`, codingQuestion: false });

    const candidateContext = await contextAs(browser, "journey", {
      permissions: ["clipboard-read", "clipboard-write"],
    });
    const candidate = await candidateContext.newPage();
    await openPage(candidate, `/assessments/${paper.slug}/readiness`);
    // One question, not none, and the singular rather than "1 questions".
    await expect(candidate.getByText(/1 question(?!s)/).first()).toBeVisible({ timeout: 60_000 });

    await walkReadinessChecks(candidate);
    await candidate.getByRole("button", { name: "Start the assessment" }).click();
    await expect(candidate).toHaveURL(new RegExp(`/assessments/${paper.slug}/attempt$`), {
      timeout: 120_000,
    });

    // The sitting itself, which used to be replaced by "This paper has no
    // questions. Tell your invigilator." the moment it rendered.
    await expect(candidate.getByText(/Question 1 of 1/).first()).toBeVisible({ timeout: 60_000 });
    await expect(candidate.getByText(/no questions/i)).toHaveCount(0);
    await expect(candidate.getByRole("radio", { name: RIGHT_OPTION })).toBeVisible();
    // No editor and no Run on a paper with nothing to run.
    await expect(candidate.locator("[data-editor-root]")).toHaveCount(0);
    await expect(candidate.getByRole("button", { name: /Run samples/ })).toHaveCount(0);

    /**
     * The pick RETRIES, for the reason `goToQuestion` does.
     *
     * The sitting is server rendered and an option only records anything
     * once React has attached: a click that lands in that window checks
     * the radio in the DOM, the controlled input reverts it, and no
     * request is ever made. Nothing retries it, so the paper simply stays
     * unanswered -- which is what happened on a dev server that was still
     * compiling, and read as "the multiple-choice half is broken".
     *
     * The palette is the assertion, not the save pill: the pill says
     * "Saved" from the first render (there is nothing unsaved yet), so a
     * pill-only check passes without the answer ever having been recorded.
     */
    await expect(async () => {
      await candidate.getByRole("radio", { name: RIGHT_OPTION }).check();
      await expect(candidate.getByText(/1 of 1 answered/)).toBeVisible({ timeout: 10_000 });
    }).toPass({ timeout: 90_000 });
    await expect(savePill(candidate)).toContainText(/Saved/, { timeout: 60_000 });

    await candidate.getByRole("button", { name: "Submit test" }).click();
    await candidate.getByRole("button", { name: "Yes, submit" }).click();
    await expect(candidate.getByText(/Handed in\. Your answers are saved/)).toBeVisible({
      timeout: 120_000,
    });
  });
});
