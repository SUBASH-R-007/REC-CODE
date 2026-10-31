import { expect, test } from "@playwright/test";
import { contextAs } from "./support/session";
import { openPage, presetTheme, settle, type Theme } from "./support/page";
import { expectNoGatingViolations, record, scan, type Finding } from "./support/axe";
import { authorPaper, goToQuestion, RIGHT_OPTION, walkReadinessChecks } from "./support/exam-paper";

/**
 * The axe gate, over the screen a candidate cannot leave (Phase 12u).
 *
 * `a11y.spec.ts` scans 64 pages — the dashboard, the problem workspace with
 * its console open, every admin and placement-cell page, the account pages
 * — in both themes and at both viewports, and gates on zero serious or
 * critical violations. Not one of them is the exam surface. The readiness
 * page, the sitting, the question palette, the multiple-choice radio group
 * and the run console had never been scanned.
 *
 * That is the wrong way round. A student on any other page can leave,
 * reload, switch device or come back tomorrow. A candidate in a sitting has
 * a clock running, cannot open another tab without it being recorded, and
 * cannot ask anyone for help. If one screen in the product has to be
 * reachable by keyboard and legible to a screen reader, it is this one.
 *
 * It cannot be scanned from a list of paths, which is why it was missed: a
 * sitting has to be authored, opened, started and navigated before there is
 * anything to look at. So this spec does that, then scans four states — the
 * readiness page, the sitting on a coding question, the sitting on a
 * multiple-choice question, and the sitting with the run console open — in
 * one theme and viewport per run, parameterised so a full pass is four runs
 * and a smoke test is one.
 *
 * Rules, tag set and the one exclusion come from `support/axe.ts`: the same
 * ones `a11y.spec.ts` gates on, because a second definition of "accessible"
 * would be worse than none.
 *
 * NOT in any gate: it needs a live stack. `--project=exam-a11y`, and
 * `E2E_AXE_DETAILS=1` to print the offending markup.
 */

const VIEWPORTS = [
  { name: "desktop", width: 1366, height: 768, mobile: false },
  { name: "mobile", width: 375, height: 812, mobile: true },
] as const;
const THEMES: readonly Theme[] = ["light", "dark"];

for (const viewport of VIEWPORTS) {
  for (const theme of THEMES) {
    test.describe(`exam surface axe [${viewport.name}, ${theme}]`, () => {
      test.use({
        viewport: { width: viewport.width, height: viewport.height },
        isMobile: viewport.mobile,
        hasTouch: viewport.mobile,
        colorScheme: theme,
      });

      test(`readiness and a sitting, both kinds [${viewport.name}, ${theme}]`, async ({
        browser,
      }, testInfo) => {
        test.setTimeout(12 * 60_000);
        const runId = `${viewport.name[0]}${theme[0]}${Math.random().toString(36).slice(2, 7)}`;
        const label = `exam surface [${viewport.name} ${viewport.width}x${viewport.height}, ${theme}]`;

        const staffContext = await contextAs(browser, "admin");
        const admin = await staffContext.newPage();
        const paper = await authorPaper(admin, { runId });

        const candidateContext = await contextAs(browser, "journey", {
          viewport: { width: viewport.width, height: viewport.height },
          isMobile: viewport.mobile,
          hasTouch: viewport.mobile,
          colorScheme: theme,
          permissions: ["clipboard-read", "clipboard-write"],
        });
        const candidate = await candidateContext.newPage();
        await presetTheme(candidate, theme);

        const findings: Finding[] = [];

        // ── The readiness page ──
        await openPage(candidate, `/assessments/${paper.slug}/readiness`);
        await expect(
          candidate.getByRole("heading", { name: "Before you start", level: 1 }),
        ).toBeVisible({ timeout: 60_000 });
        await settle(candidate);
        findings.push(...(await scan(candidate, "readiness")));

        // Again with every check done, because that state renders four
        // "passed" rows and enables a button that was disabled.
        await walkReadinessChecks(candidate);
        await settle(candidate);
        findings.push(...(await scan(candidate, "readiness-checked")));

        // ── The sitting ──
        await candidate.getByRole("button", { name: "Start the assessment" }).click();
        await expect(candidate).toHaveURL(new RegExp(`/assessments/${paper.slug}/attempt$`), {
          timeout: 120_000,
        });
        await expect(candidate.getByText(/Question 1 of 2/).first()).toBeVisible({ timeout: 60_000 });
        await settle(candidate);
        findings.push(...(await scan(candidate, "sitting-code")));

        // The editor's own region, with text in it: an empty editor and a
        // full one are different trees.
        await candidate.locator("[data-editor-root]").first().click();
        await candidate.keyboard.insertText("// a line of the candidate's own\n");
        await settle(candidate);
        findings.push(...(await scan(candidate, "sitting-code-typed")));

        // ── The multiple-choice question ──
        await goToQuestion(candidate, 2, 2);
        await expect(candidate.getByRole("radio", { name: RIGHT_OPTION })).toBeVisible({
          timeout: 60_000,
        });
        await settle(candidate);
        findings.push(...(await scan(candidate, "sitting-mcq")));

        await candidate.getByRole("radio", { name: RIGHT_OPTION }).check();
        await settle(candidate);
        findings.push(...(await scan(candidate, "sitting-mcq-answered")));

        // ── The run console ──
        // Opened by its own header button, so the drawer is scanned
        // whether or not a judge is attached to this stack.
        await goToQuestion(candidate, 1, 2);
        const consoleToggle = candidate.getByRole("button", { name: /^Run results/ });
        if (await consoleToggle.count()) {
          await consoleToggle.first().click();
          await settle(candidate);
          findings.push(...(await scan(candidate, "sitting-console-open")));
        }

        // ── The confirmation, and the ended state ──
        await candidate.getByRole("button", { name: "Submit test" }).click();
        await expect(candidate.getByRole("button", { name: "Yes, submit" })).toBeVisible();
        await settle(candidate);
        findings.push(...(await scan(candidate, "submit-confirming")));

        await candidate.getByRole("button", { name: "Yes, submit" }).click();
        await expect(candidate.getByText(/Handed in\. Your answers are saved/)).toBeVisible({
          timeout: 120_000,
        });
        await settle(candidate);
        findings.push(...(await scan(candidate, "handed-in")));

        await record(testInfo, label, findings, candidate.url());
        expectNoGatingViolations(findings, label);
      });
    });
  }
}
