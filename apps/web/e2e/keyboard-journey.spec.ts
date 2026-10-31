import { expect, test, type Locator, type Page } from "@playwright/test";
import { ACCOUNTS } from "./support/accounts";
import {
  describeFocus,
  expectFocusInEditor,
  expectFocusVisible,
  isMain,
  isSkipLink,
  pressTab,
  tabTo,
  type FocusDesc,
} from "./support/keyboard";
import { openPage, settle, waitForEditor } from "./support/page";

/**
 * The keyboard-only solving journey (docs/ACCESSIBILITY.md §5–§6). After
 * sign-in (global setup) every interaction is a key press: no mouse, no
 * element.click(), no fill(). The page is only READ — to find where focus is
 * and that it is visible, which is asserted at every stop.
 *
 *   /problems → Difficulty: Easy → Apply → open a problem → skip link to the
 *   main region → read the statement → into the editor → type a solution →
 *   Esc, Tab out of the editor → Ctrl+M "Tab moves focus" → Run (verdict) →
 *   Submit a wrong solution (failing case) → Submit a correct one (Accepted)
 *   → back to the list → the next problem.
 *
 * Steps that need a real judge (Run / Submit verdicts) run only with
 * E2E_JUDGE=1; without it they are skipped and annotated (CI has no judge).
 */

const JUDGE = process.env.E2E_JUDGE === "1";
/** Judge round trip: queue + compile + tests on the live judge. */
const VERDICT_TIMEOUT = 75_000;

interface Solutions {
  /** Text the statement must contain (proves the statement panel is the one focused). */
  statementMarker: string;
  correct: string;
  wrong: string;
}

/**
 * One-line Python 3.12 solutions: a single line cannot be re-indented by the
 * editor, so what is typed is exactly what is judged.
 */
const SOLUTIONS: Readonly<Record<string, Solutions>> = {
  "handle-maker": {
    statementMarker: "makeHandle",
    correct:
      'class Solution: makeHandle = lambda self, name: "-".join(__import__("re").findall("[a-z0-9]+", name.lower()))',
    // Keeps the separators: fails Sample 1 ("  Priya  S. Kumar!! ").
    wrong: "class Solution: makeHandle = lambda self, name: name.lower()",
  },
  "two-sum": {
    statementMarker: "target",
    correct:
      "class Solution: twoSum = lambda self, nums, target: (lambda seen: next([seen[target - x], i] for i, x in enumerate(nums) if (target - x) in seen or seen.setdefault(x, i) is None))({})",
    // The pair in the wrong order: fails Sample 1.
    wrong:
      "class Solution: twoSum = lambda self, nums, target: (lambda seen: next([i, seen[target - x]] for i, x in enumerate(nums) if (target - x) in seen or seen.setdefault(x, i) is None))({})",
  },
};

const TAB_FOCUS_TOGGLE = process.platform === "darwin" ? "Control+Shift+M" : "Control+M";

test.use({
  storageState: ACCOUNTS.journey.storageState,
  viewport: { width: 1366, height: 768 },
  colorScheme: "light",
});

/** The workspace console (a region labelled by its "Console" heading). */
function consoleRegion(page: Page): Locator {
  return page.getByRole("region", { name: "Console", exact: true });
}

/** The single polite announcement of a final verdict (the workspace's live region). */
function verdictAnnouncement(page: Page, kind: "Run" | "Submission"): Locator {
  return page.locator('p[role="status"][aria-live="polite"]').filter({ hasText: new RegExp(`^${kind} (result|finished)`) });
}

async function editorValue(page: Page): Promise<string> {
  return page.evaluate(() => {
    const w = window as unknown as { monaco?: { editor: { getEditors(): { getValue(): string }[] } } };
    return w.monaco?.editor.getEditors()[0]?.getValue() ?? "";
  });
}

/** Replace the whole editor content from the keyboard (focus must be in the editor). */
async function typeSolution(page: Page, source: string, step: string): Promise<void> {
  await expectFocusInEditor(page, step, true);
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.insertText(source);
  await expect.poll(() => editorValue(page), { message: `[${step}] the editor holds the typed solution` }).toBe(source);
}

/**
 * Monaco speaks the Ctrl+M state ("Pressing Tab will now move focus…")
 * through its own live region. That message is for screen readers: assert it
 * was announced and that the region is not painted on the page (it is, if
 * Monaco's stylesheet fails to apply).
 */
async function expectEditorMessage(page: Page, message: RegExp, step: string): Promise<void> {
  const region = page.locator(".monaco-aria-container");
  await expect(region, `[${step}] Monaco announced the change`).toContainText(message);
  const box = await region.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { width: r.width, height: r.height };
  });
  expect(box.width <= 1 && box.height <= 1, `[${step}] the announcement is visually hidden (box ${JSON.stringify(box)})`).toBe(
    true,
  );
}

/** From the editor: Esc, Shift+Tab out, then back to the Submit / Run button. */
async function focusButton(page: Page, name: "Run" | "Submit", step: string): Promise<void> {
  await tabTo(page, (d) => d.tag === "button" && d.name === name, step, { backwards: true, max: 12 });
}

test("keyboard-only solving journey", async ({ page }, testInfo) => {
  test.setTimeout(8 * 60_000);
  const note = (type: string, description: string) => testInfo.annotations.push({ type, description });

  let slug = "";
  let solutions: Solutions | undefined;

  await test.step("filter the catalogue to Easy and apply, by keyboard", async () => {
    await openPage(page, "/problems");
    await settle(page);
    // Focus starts at the top of the document: the first Tab is the skip link.
    await pressTab(page);
    const first = await expectFocusVisible(page, "first Tab");
    expect(isSkipLink(first), `the first Tab reaches "Skip to content" (got ${first.tag} "${first.name}")`).toBe(true);

    const easy = await tabTo(page, (d) => d.tag === "input" && d.type === "checkbox" && d.value === "EASY", "Easy filter");
    if (!easy.checked) await page.keyboard.press("Space");
    expect((await describeFocus(page))?.checked, "Easy is checked").toBe(true);
    await expectFocusVisible(page, "Easy checked");

    await tabTo(page, (d) => d.tag === "button" && d.name === "Apply filters", "Apply filters");
    await page.keyboard.press("Enter");
    await page.waitForURL(/[?&]difficulty=EASY/);
    await settle(page);
    // next/form keeps focus on Apply; the result count is a status message.
    await expect(page.getByRole("status").filter({ hasText: /problem/i })).toBeVisible();
    await expectFocusVisible(page, "after Apply");
  });

  await test.step("open a problem by keyboard", async () => {
    const listed = await page
      .locator('table a[href^="/problems/"]')
      .evaluateAll((links) => links.map((a) => a.getAttribute("href")?.split("/").pop() ?? ""));
    const preferred = process.env.E2E_PROBLEM ?? "handle-maker";
    slug = [preferred, "handle-maker", "two-sum"].find((s) => listed.includes(s) && SOLUTIONS[s]) ?? "";
    expect(slug, `an Easy problem with a scripted solution is listed (listed: ${listed.join(", ")})`).not.toBe("");
    solutions = SOLUTIONS[slug];
    note("problem", slug);

    await tabTo(page, (d) => d.tag === "a" && d.href === `/problems/${slug}`, `link to ${slug}`);
    await page.keyboard.press("Enter");
    await page.waitForURL(new RegExp(`/problems/${slug}$`));
    await settle(page);
    await waitForEditor(page, "monaco");
  });

  await test.step("move to the main region and read the statement", async () => {
    const landed = await describeFocus(page);
    note("focus after opening the problem", landed ? `${landed.tag}#${landed.id} "${landed.name}"` : "<body>");
    if (!landed || !(isMain(landed) || landed.tag === "h1")) {
      // The skip link is the documented way to the content after a page change.
      await tabTo(page, isSkipLink, "skip link", { max: 120 });
      await page.keyboard.press("Enter");
    }
    const main = await expectFocusVisible(page, "main region");
    expect(isMain(main) || main.tag === "h1", `focus is on the main region or its heading (got ${main.tag}#${main.id})`).toBe(
      true,
    );

    const statement = await tabTo(
      page,
      (d) => d.role === "tabpanel" && d.text.includes(solutions!.statementMarker),
      "statement panel",
      { max: 15 },
    );
    expect(statement.name).toContain("Description");
    // A focusable panel scrolls from the keyboard.
    await page.keyboard.press("PageDown");
    await expectFocusVisible(page, "statement after PageDown");
  });

  await test.step("move into the editor and type a solution", async () => {
    const select = await tabTo(page, (d) => d.tag === "select" && d.name.includes("Language"), "language picker", {
      max: 15,
    });
    if (select.value !== "py312") {
      // Type-ahead on a closed native select changes the value.
      await page.keyboard.type("Python", { delay: 50 });
      for (let i = 0; i < 12 && (await describeFocus(page))?.value !== "py312"; i++) await page.keyboard.press("ArrowDown");
    }
    expect((await describeFocus(page))?.value, "Python 3.12 is selected").toBe("py312");

    await tabTo(page, (d) => d.inEditor, "editor", { max: 12 });
    await expectFocusVisible(page, "editor");
    await typeSolution(page, solutions!.correct, "type the solution");
  });

  await test.step("Esc then Tab leaves the editor", async () => {
    await page.keyboard.press("Escape");
    await page.keyboard.press("Tab");
    await expectFocusInEditor(page, "Esc, Tab", false);
    const out = await expectFocusVisible(page, "after Esc, Tab");
    note("focus after Esc, Tab", `${out.tag} "${out.name}"`);
  });

  await test.step("Ctrl+M toggles Tab-moves-focus in the editor", async () => {
    await page.keyboard.press("Shift+Tab");
    await expectFocusInEditor(page, "Shift+Tab back into the editor", true);
    await page.keyboard.press(TAB_FOCUS_TOGGLE);
    await expectEditorMessage(page, /Tab will now move focus/, "Ctrl+M on");
    await page.keyboard.press("Tab");
    await expectFocusInEditor(page, "Tab with Tab-moves-focus on", false);
    await expectFocusVisible(page, "after Tab with Tab-moves-focus on");

    // Back in, toggle it off again: Tab indents once more (the solution is
    // then typed afresh, so the indent does not matter).
    await page.keyboard.press("Shift+Tab");
    await expectFocusInEditor(page, "Shift+Tab back into the editor", true);
    await page.keyboard.press(TAB_FOCUS_TOGGLE);
    await expectEditorMessage(page, /Tab will now insert the tab character/, "Ctrl+M off");
    await page.keyboard.press("Tab");
    await expectFocusInEditor(page, "Tab with Tab-moves-focus off", true);
    await typeSolution(page, solutions!.correct, "retype the solution");
  });

  await test.step("Run from the keyboard and read the verdict", async (step) => {
    step.skip(!JUDGE, "needs a live judge (E2E_JUDGE=1)");
    await focusButton(page, "Run", "Run button");
    await page.keyboard.press("Enter");
    const announced = verdictAnnouncement(page, "Run");
    await expect(announced).toHaveText(/^Run result: Accepted\./, { timeout: VERDICT_TIMEOUT });
    const region = consoleRegion(page);
    await expect(region.locator("[data-verdict]").first()).toHaveAttribute("data-verdict", "AC");
    await expect(region).toContainText(/Passed \d+ of \d+ sample tests/);
    await expectFocusVisible(page, "after Run");
  });

  await test.step("Submit a wrong solution and read the failing case", async (step) => {
    step.skip(!JUDGE, "needs a live judge (E2E_JUDGE=1)");
    await tabTo(page, (d) => d.inEditor, "editor", { max: 12 });
    await typeSolution(page, solutions!.wrong, "type the wrong solution");
    await focusButton(page, "Submit", "Submit button");
    await page.keyboard.press("Enter");
    await expect(verdictAnnouncement(page, "Submission")).toHaveText(/^Submission result: Wrong Answer\./, {
      timeout: VERDICT_TIMEOUT,
    });
    await expectFocusVisible(page, "after Submit");

    const region = consoleRegion(page);
    await expect(region.locator("[data-verdict]").first()).toHaveAttribute("data-verdict", "WA");
    const failing = region.locator('ul[aria-label="Test results"] > li').filter({ has: page.locator('[data-verdict="WA"]') });
    await expect(failing).toHaveCount(1);
    const failingLabel = ((await failing.textContent()) ?? "").match(/Sample \d+|Hidden test \d+/)?.[0] ?? "";
    expect(failingLabel, "the failing test is named").not.toBe("");
    note("failing case", failingLabel);

    // Reach the failing case from the keyboard: a sample's details summary
    // (expanded on failure), or the result panel for a hidden test.
    const reached: FocusDesc = await tabTo(
      page,
      (d) =>
        (d.tag === "summary" && d.text.includes(failingLabel)) ||
        (failingLabel.startsWith("Hidden") && d.role === "tabpanel" && d.text.includes(failingLabel)),
      "failing case",
      { max: 20 },
    );
    expect(reached.text).toContain("Wrong Answer");
    if (failingLabel.startsWith("Sample")) {
      await expect(failing).toContainText("Expected output");
      await expect(failing).toContainText("Your output");
    }
  });

  await test.step("Submit a correct solution: Accepted", async (step) => {
    step.skip(!JUDGE, "needs a live judge (E2E_JUDGE=1)");
    await tabTo(page, (d) => d.inEditor, "back to the editor", { backwards: true, max: 25 });
    await typeSolution(page, solutions!.correct, "type the correct solution");
    await focusButton(page, "Submit", "Submit button");
    await page.keyboard.press("Enter");
    await expect(verdictAnnouncement(page, "Submission")).toHaveText(/^Submission result: Accepted\./, {
      timeout: VERDICT_TIMEOUT,
    });
    await expect(consoleRegion(page).locator("[data-verdict]").first()).toHaveAttribute("data-verdict", "AC");
    await expectFocusVisible(page, "after the accepted submission");
  });

  await test.step("go to the next problem by keyboard", async (step) => {
    await tabTo(page, (d) => d.tag === "a" && d.href === "/problems" && d.name === "Problems", "back to Problems", {
      backwards: true,
      max: 40,
    });
    await page.keyboard.press("Enter");
    await page.waitForURL(/\/problems$/);
    await settle(page);

    const order = await page
      .locator('table a[href^="/problems/"]')
      .evaluateAll((links) => links.map((a) => a.getAttribute("href") ?? ""));
    const next = order[order.indexOf(`/problems/${slug}`) + 1];
    step.skip(!next, `no problem is listed after ${slug}`);

    await tabTo(page, (d) => d.tag === "a" && d.href === `/problems/${slug}`, `link to ${slug}`, { max: 120 });
    const target = await tabTo(page, (d) => d.tag === "a" && (d.href ?? "").startsWith("/problems/"), "next problem link", {
      max: 6,
    });
    expect(target.href).toBe(next);
    await page.keyboard.press("Enter");
    await page.waitForURL((url) => url.pathname === next);
    await expect(page.getByRole("heading", { level: 1 })).toContainText(target.name);
    note("next problem", next!);
  });
});
