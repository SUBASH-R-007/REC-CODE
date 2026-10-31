import { expect, test, type Page } from "@playwright/test";
import { contextAs } from "./support/session";
import { openPage } from "./support/page";

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
const SLUG = `e2e-exam-${runId}`;
const TITLE = `E2E Exam ${runId}`;
/** Published by the seed, so there is a frozen revision to pin. */
const PROBLEM_SLUG = "two-sum";
const STEM = `Which of these is a stable sort? (${runId})`;
const RIGHT_OPTION = "Merge sort";

const JUDGE = process.env.E2E_JUDGE === "1";

/**
 * A `datetime-local` field on an admin page is CAMPUS time (IST), whatever
 * the machine running this test is set to — typing the runner's local time
 * silently shifts the window. Same reasoning as `contest-journey`.
 */
const IST = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Kolkata",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

function istInput(date: Date): string {
  const parts = IST.formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}`;
}

/** The palette button for a position, by the aria-label `paletteLabel` builds. */
const paletteButton = (page: Page, position: number) =>
  page.getByRole("button", { name: new RegExp(`^Question ${position},`) });

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

    // ── 1. A staff member authors the paper ──
    const staffContext = await contextAs(browser, "admin");
    const admin = await staffContext.newPage();

    await openPage(admin, "/admin/assessments");
    await expect(admin.getByRole("heading", { name: "Assessments", level: 1 })).toBeVisible();
    await admin.getByRole("link", { name: /New assessment/i }).first().click();

    await admin.getByRole("textbox", { name: "Title" }).fill(TITLE);
    // "Address" also appears in the popup option's description ("no address
    // bar"), so the field is asked for by role as well as name.
    await admin.getByRole("textbox", { name: "Address" }).fill(SLUG);
    await admin.getByRole("textbox", { name: "Instructions" }).fill(`Answer both questions. Round ${runId}.`);
    /**
     * ADVISORY, so no hall, no registered device and no kiosk key stand
     * between this test and the sitting. Those refusals are driven directly
     * by `exam-start-hall.db.test.ts`, which is the right place for them —
     * what cannot be tested anywhere but a browser is everything after
     * Start.
     */
    await admin.getByRole("radio", { name: /^Advisory/ }).check();
    await admin.getByRole("textbox", { name: "Opens" }).fill(istInput(new Date(Date.now() - 5 * 60_000)));
    await admin.getByRole("textbox", { name: "Closes" }).fill(istInput(new Date(Date.now() + 4 * 60 * 60_000)));
    await admin.getByRole("textbox", { name: "Duration (minutes)" }).fill("90");
    await admin.getByRole("textbox", { name: "Attempts allowed" }).fill("1");
    // Phase 12s, and the reason this paper is the one that tests it: the
    // refusal happens inside a browser paste event and nowhere else.
    await admin.getByRole("checkbox", { name: /Accept only text copied inside the sitting/i }).check();
    await admin.getByRole("button", { name: "Create the draft" }).click();

    await expect(admin.getByRole("heading", { name: TITLE, level: 1 })).toBeVisible({ timeout: 60_000 });
    await expect(admin.getByText("DRAFT").first()).toBeVisible();

    // ── 2. One coding question and one multiple-choice question ──
    await admin.getByRole("textbox", { name: "Problem address" }).fill(PROBLEM_SLUG);
    await admin.getByRole("textbox", { name: "Position", exact: true }).first().fill("1");
    await admin.getByRole("textbox", { name: "Points" }).fill("3");
    await admin.getByRole("button", { name: "Add", exact: true }).click();
    // The pinned revision is stated, as on a contest.
    await expect(admin.getByText(/^r\d+$/).first()).toBeVisible({ timeout: 60_000 });

    await admin.getByRole("textbox", { name: "Question", exact: true }).fill(STEM);
    await admin.getByRole("textbox", { name: "Options, one per line" }).fill(["Quicksort", RIGHT_OPTION, "Heapsort"].join("\n"));
    await admin.getByRole("textbox", { name: "Position", exact: true }).last().fill("2");
    // 1-based in the form, 0-based in the row: the author counts off the
    // list they just typed and the boundary converts it once (12r.3).
    await admin.getByRole("textbox", { name: "Answer (line number)" }).fill("2");
    await admin.getByRole("textbox", { name: "Marks" }).fill("2");
    await admin.getByRole("button", { name: "Add question" }).click();
    await expect(admin.getByText(STEM).first()).toBeVisible({ timeout: 60_000 });

    // ── 3. Publish, then open it ──
    await admin.getByRole("button", { name: /^Publish/ }).click();
    await expect(admin.getByText("PUBLISHED").first()).toBeVisible({ timeout: 60_000 });
    await admin.getByRole("button", { name: /Open it for candidates/ }).click();
    await expect(admin.getByText("OPEN").first()).toBeVisible({ timeout: 60_000 });

    // ── 4. The candidate reads the readiness page ──
    const candidateContext = await contextAs(browser, "journey", {
      // For the paste step: a real Ctrl+V needs a real clipboard.
      permissions: ["clipboard-read", "clipboard-write"],
    });
    const candidate = await candidateContext.newPage();

    await openPage(candidate, `/assessments/${SLUG}/readiness`);
    // The page's own heading is "Before you start"; the paper's title is the
    // heading under it.
    await expect(candidate.getByRole("heading", { name: "Before you start", level: 1 })).toBeVisible({
      timeout: 60_000,
    });
    await expect(candidate.getByRole("heading", { name: TITLE, level: 2 })).toBeVisible();
    /**
     * BOTH kinds, which is the fence for the blind spot found in four
     * separate places: this page counted `_count.problems` alone, so a
     * paper with multiple-choice questions on it told a candidate the wrong
     * number before they started (12s.1).
     */
    await expect(candidate.getByText(/2 questions/).first()).toBeVisible();
    await expect(candidate.getByText(/90 minutes/).first()).toBeVisible();

    // ── 5. The four checks, then Start ──
    /**
     * The button is disabled until all four pass and the box is ticked, and
     * that gate is worth walking rather than working around: each check is
     * a real browser capability a sitting depends on, and a machine that
     * cannot do one of them should find out here rather than halfway
     * through a paper.
     */
    const start = candidate.getByRole("button", { name: "Start the assessment" });
    await expect(start).toBeDisabled();

    /**
     * Each check is asserted as it is done, so a failure names the
     * capability that was missing instead of only saying the button stayed
     * disabled. Each row states its own state in words for a screen
     * reader — "— passed" — which is what these read.
     */
    const row = (label: RegExp) => candidate.getByText(label).first();

    await candidate.getByRole("button", { name: "Test full screen" }).click();
    await expect(row(/Full screen works on this machine.*passed/)).toBeVisible({ timeout: 30_000 });

    await candidate.getByRole("button", { name: "Test the connection" }).click();
    await expect(row(/can reach the exam server.*passed/)).toBeVisible({ timeout: 30_000 });

    // A real paste into the scratch box, which is what the check is for.
    await candidate.evaluate(() => navigator.clipboard.writeText("readiness paste"));
    await candidate.getByRole("textbox", { name: /Scratch box/i }).click();
    await candidate.keyboard.press("ControlOrMeta+v");
    await expect(row(/Pasting works, and is recorded rather than blocked.*passed/)).toBeVisible({
      timeout: 30_000,
    });

    await candidate.getByRole("textbox", { name: /sample question/i }).fill("4");
    await expect(row(/type an answer and read a question.*passed/)).toBeVisible({ timeout: 30_000 });

    await candidate.getByRole("checkbox", { name: /I have read what is recorded/i }).check();

    await expect(start).toBeEnabled({ timeout: 30_000 });
    await start.click();
    await expect(candidate).toHaveURL(new RegExp(`/assessments/${SLUG}/attempt$`), { timeout: 120_000 });
    // Two questions in the palette, not one: `items`, not `questions`.
    await expect(candidate.getByText(/Question 1 of 2/).first()).toBeVisible({ timeout: 60_000 });
    await expect(paletteButton(candidate, 2)).toBeVisible();

    // ── 6. The multiple-choice question: pick an option, watch it save ──
    await paletteButton(candidate, 2).click();
    await expect(candidate.getByText(STEM.slice(0, 30), { exact: false }).first()).toBeVisible({ timeout: 30_000 });
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
    await paletteButton(candidate, 2).click();
    await expect(candidate.getByRole("radio", { name: RIGHT_OPTION })).toBeChecked({ timeout: 60_000 });

    // ── 7. The coding question: type, and watch THAT save ──
    await paletteButton(candidate, 1).click();
    const editorRoot = candidate.locator("[data-editor-root]").first();
    await expect(editorRoot).toBeVisible({ timeout: 60_000 });
    await editorRoot.click();
    // Replace the starter rather than appending to it: the starter already
    // declares the method, so a second one is a redefinition — which is what
    // the Run console said, in those words, the first time this ran.
    await candidate.keyboard.press("ControlOrMeta+a");
    await candidate.keyboard.insertText(SOLUTION);
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
    await openPage(candidate, `/assessments/${SLUG}/readiness`);
    await expect(candidate.getByText(/already finished this assessment/i).first()).toBeVisible({
      timeout: 60_000,
    });
    await expect(candidate.getByRole("button", { name: /Start the assessment/i })).toHaveCount(0);
    await expect(candidate.getByRole("button", { name: "Test full screen" })).toHaveCount(0);
  });
});
