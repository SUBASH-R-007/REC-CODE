import { expect, test } from "@playwright/test";
import { ACCOUNTS } from "./support/accounts";
import { openPage } from "./support/page";
import { contextAs } from "./support/session";

/**
 * Phase 12p, slice 2: the problem kinds of Phase 12k–12n, read in a real
 * browser as a student. Each test here closes a `NOT RUN` row in
 * `docs/RUNBOOK.md` §3 that said the same thing — *proved apart, never
 * watched together*:
 *
 *   1. **The debugging counter between keystrokes** (12m.3). A component
 *      test renders the bar at, below and over the budget, and a repository
 *      fence asserts the bar and the submit action count the same way. What
 *      nobody had seen is the number moving as somebody types, in a real
 *      editor, against a real starter.
 *   2. **The SQL grammar under 768 px** (12k.4). Below that width the
 *      editor is CodeMirror 6, not Monaco, and its SQL grammar is a
 *      separate lazy chunk. The Phase 12k live run drove the wide layout
 *      only.
 *   3. **A SQL problem opened from a running contest's arena** (12k.4,
 *      12l.3). Two rows claimed the arena builds its own language list and
 *      its own result console; it does not — it links to
 *      `/problems/<slug>`. This walks that link with a SQL problem behind
 *      it, which is the lane both rows were about.
 *
 * No judge is needed: nothing here submits. Run it by name,
 * `--project=kinds`, against a running stack with the seeded accounts.
 *
 * The kinds come from the dev database rather than from a fixture, by
 * asking the catalogue for them — a hard-coded slug would rot the first
 * time somebody reseeds.
 */

const runId = Math.random().toString(36).slice(2, 8);
const SLUG = `e2e-kinds-${runId}`;
const TITLE = `E2E Kinds ${runId}`;

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

/**
 * A published problem of a given kind, found by OPENING problems until one
 * of them shows that kind's bar over the editor.
 *
 * It has to be done this way, and that is itself a finding of this slice:
 * the student catalogue names the code, the status, the title, the topics,
 * the difficulty and the acceptance rate, and nothing about the KIND. A
 * student cannot tell a SQL question, a debugging question with a one-line
 * budget, a conversation or an answer box from an ordinary program until
 * they have opened it. `E2E_DEBUG_PROBLEM` / `E2E_SQL_PROBLEM` skip the
 * walk when the slug is already known.
 */
async function slugOfKind(
  page: import("@playwright/test").Page,
  what: { bar: RegExp; envVar: string; name: string },
): Promise<string> {
  const given = process.env[what.envVar];
  if (given) return given;

  await openPage(page, "/problems");
  const hrefs = [
    ...new Set(
      (await page.getByRole("link").evaluateAll((els) => els.map((e) => e.getAttribute("href") ?? "")))
        .filter((h) => /^\/problems\/[^/?#]+$/.test(h))
        .map((h) => h.replace("/problems/", "")),
    ),
  ];
  expect(hrefs.length, "the catalogue lists no problems").toBeGreaterThan(0);

  for (const slug of hrefs.slice(0, 12)) {
    await openPage(page, `/problems/${slug}`);
    const bar = page.locator("p", { hasText: what.bar }).first();
    if (await bar.isVisible({ timeout: 15_000 }).catch(() => false)) return slug;
  }
  throw new Error(
    `no ${what.name} problem among the first ${Math.min(hrefs.length, 12)} in the catalogue; ` +
      `set ${what.envVar} to one`,
  );
}

/**
 * Put the starter back. The confirmation names the broken program rather
 * than "starter code", which is the wording Phase 12m gave a debugging
 * question.
 */
/**
 * A screenshot that survives the run: written under the project's
 * outputDir and attached from there, so the evidence for a RUNBOOK row is
 * a file somebody can open rather than a blob inside one HTML report.
 */
async function shot(
  page: import("@playwright/test").Page,
  testInfo: import("@playwright/test").TestInfo,
  name: string,
): Promise<void> {
  const file = testInfo.outputPath(name);
  await page.screenshot({ path: file });
  await testInfo.attach(name, { path: file, contentType: "image/png" });
}

async function resetToStarter(page: import("@playwright/test").Page): Promise<void> {
  await page.getByRole("button", { name: /Reset to the broken program/i }).click();
  await expect(page.getByRole("dialog")).toContainText("Reset to the broken program?");
  await page.getByRole("button", { name: "Reset code" }).click();
}

const DEBUGGING = { bar: /a debugging question/, envVar: "E2E_DEBUG_PROBLEM", name: "debugging" };
const SQL = { bar: /PostgreSQL 17/, envVar: "E2E_SQL_PROBLEM", name: "SQL" };

test.describe.configure({ mode: "serial" });

test.describe("the problem kinds, in a browser", () => {
  test("the debugging counter moves between keystrokes, and turns red over budget", async ({ browser }, testInfo) => {
    test.setTimeout(5 * 60_000);
    const context = await contextAs(browser, "student");
    const page = await context.newPage();

    // Straight to a debugging problem. The bar names the budget, so the
    // page itself says which number the counter is counting towards.
    const slug = await slugOfKind(page, DEBUGGING);
    await openPage(page, `/problems/${slug}`);

    const bar = page.locator("p", { hasText: /a debugging question/ }).first();
    await expect(bar).toBeVisible({ timeout: 60_000 });
    const budgetText = (await bar.innerText()).replace(/\s+/g, " ");
    const budget = Number(/at most (\d+) line/.exec(budgetText)?.[1] ?? "0");
    expect(budget, `the bar must name a budget: ${budgetText}`).toBeGreaterThan(0);

    const counter = bar.locator('[aria-live="polite"]');
    const zero = `0 of ${budget} line${budget === 1 ? "" : "s"} changed`;
    /**
     * This account may arrive with a draft from an earlier run — and the
     * counter counts it, on arrival, before anybody types. That is the right
     * behaviour and worth saying out loud, but this test needs a known
     * start, so put the broken program back first.
     */
    if ((await counter.innerText()) !== zero) {
      await resetToStarter(page);
      await expect(counter).toHaveText(zero, { timeout: 20_000 });
    }
    await expect(counter).toHaveText(zero);
    await expect(counter).not.toHaveClass(/text-danger/);
    await shot(page, testInfo, "debug-00-untouched.png");

    // Type INSIDE the editor, one key at a time, and watch the number. The
    // editor here is Monaco (this viewport is wide); the bar is React state
    // over the same source the submit action would refuse.
    const editor = page.locator("[data-editor-root]").first();
    await expect(editor).toBeVisible();
    await editor.click();
    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.type(" ", { delay: 60 });
    await page.keyboard.type("x", { delay: 60 });

    // One line touched: the count is 1 and still not red at a budget of 1.
    await expect(counter).toHaveText(`1 of ${budget} line${budget === 1 ? "" : "s"} changed`, { timeout: 20_000 });
    await shot(page, testInfo, "debug-01-one-line.png");

    // A second changed line takes it over a budget of 1, and the number
    // goes red where a student is looking.
    await page.keyboard.press("Enter");
    await page.keyboard.type("int recx_extra = 1;", { delay: 20 });
    await expect(counter).not.toHaveText(`1 of ${budget} line${budget === 1 ? "" : "s"} changed`, { timeout: 20_000 });
    const after = await counter.innerText();
    const changed = Number(/^(\d+) of/.exec(after)?.[1] ?? "0");
    expect(changed, `the counter moved to ${after}`).toBeGreaterThan(budget);
    await expect(counter).toHaveClass(/text-danger/);
    await shot(page, testInfo, "debug-02-over-budget.png");

    // Reset puts the broken program back, and the counter with it.
    await resetToStarter(page);
    await expect(counter).toHaveText(zero, { timeout: 20_000 });
    await expect(counter).not.toHaveClass(/text-danger/);
  });

  test("a SQL question under 768 px: CodeMirror, with SQL coloured", async ({ browser }, testInfo) => {
    test.setTimeout(5 * 60_000);
    const context = await contextAs(browser, "student");
    const page = await context.newPage();
    const slug = await slugOfKind(page, SQL);

    // A phone, the width the Phase 12k live run never drove.
    await page.setViewportSize({ width: 375, height: 812 });
    await openPage(page, `/problems/${slug}`);

    // Under 768 px the workspace is three tabs — Problem, Code, Result —
    // and the rules are in the Description, in full prose rather than as
    // chips, because there is room for them there.
    // `.first()` because each sentence is also in the chip bar's screen-reader
    // text, which is rendered at this width too.
    await expect(page.getByText(/judged on PostgreSQL 17/).first()).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText(/One statement per submission/).first()).toBeVisible();
    await expect(page.getByText(/read-only user/).first()).toBeVisible();

    // The editor is behind the Code tab at this width.
    await page.getByRole("tab", { name: "Code" }).click();
    const bar = page.locator("p", { hasText: /PostgreSQL 17/ }).first();
    await expect(bar).toBeVisible({ timeout: 60_000 });
    await expect(bar).toContainText("one statement");
    await expect(bar).toContainText("read-only");

    // Below 768 px the editor is CodeMirror, chosen once per mount.
    const editor = page.locator("[data-editor-root]").first();
    await expect(editor).toBeVisible();
    await expect(editor.locator(".cm-editor")).toBeVisible({ timeout: 60_000 });
    await expect(editor.locator(".monaco-editor")).toHaveCount(0);

    // And the SQL grammar is actually in it: a keyword is a span of its own
    // with a colour the surrounding text does not have. Typed rather than
    // assumed, so this fails if the lang chunk never loads.
    await editor.click();
    await page.keyboard.press("ControlOrMeta+A");
    await page.keyboard.insertText("select id, name from students order by id;");
    const coloured = await page.evaluate(() => {
      const content = document.querySelector(".cm-content") as HTMLElement | null;
      if (!content) return { ok: false, why: "no .cm-content" };
      const plain = getComputedStyle(content).color;
      const spans = [...content.querySelectorAll("span")] as HTMLElement[];
      const hit = spans.find((s) => /^(select|from|order|by)$/i.test(s.textContent ?? ""));
      if (!hit) return { ok: false, why: `no keyword span among ${spans.length}`, plain };
      const colour = getComputedStyle(hit).color;
      return { ok: colour !== plain, why: `${hit.textContent}: ${colour} vs ${plain}`, plain, colour };
    });
    expect(coloured.ok, `SQL keywords are not tokenised: ${coloured.why}`).toBe(true);

    await shot(page, testInfo, "sql-narrow.png");

    // No horizontal page scroll at phone width, which is what a hard-blocked
    // arena exists to avoid and a practice page must not need.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, "the page scrolls sideways at 375 px").toBeLessThanOrEqual(1);
  });

  test("a SQL problem reached from a running contest's arena is the practice surface", async ({
    browser,
  }, testInfo) => {
    test.setTimeout(10 * 60_000);
    const staff = await contextAs(browser, "admin");
    const admin = await staff.newPage();
    const studentContext = await contextAs(browser, "student");
    const student = await studentContext.newPage();

    const sqlSlug = await slugOfKind(student, SQL);

    // ── A contest that is running now, with a SQL problem in it ──
    await openPage(admin, "/admin/contests");
    await admin.getByRole("link", { name: "New contest" }).click();
    await admin.getByLabel("Title").fill(TITLE);
    await admin.getByLabel("Address").fill(SLUG);
    await admin.getByLabel("Starts").fill(istInput(new Date(Date.now() - 5 * 60_000)));
    await admin.getByLabel("Ends").fill(istInput(new Date(Date.now() + 2 * 60 * 60 * 1000)));
    await admin.getByLabel("Standings freeze (minutes)").fill("30");
    await admin.getByLabel("Rules").fill(`One query. Round ${runId}.`);
    await admin.getByRole("button", { name: "Create draft" }).click();
    await expect(admin.getByRole("heading", { name: TITLE, level: 1 })).toBeVisible({ timeout: 60_000 });

    await admin.getByLabel("Letter").fill("A");
    await admin.getByLabel("Problem address").fill(sqlSlug);
    await admin.getByRole("button", { name: "Add problem" }).click();
    // Nothing refuses a SQL problem in a contest, and this is the assertion
    // that says so out loud: the pin lands. The row names the problem by
    // title and links to it, so that link is what identifies it.
    const pinned = admin.getByRole("row").filter({ has: admin.locator(`a[href*="${sqlSlug}"]`) });
    await expect(pinned.first()).toBeVisible({ timeout: 60_000 });
    // Pinned at the revision it had when it was added, as every contest
    // problem is.
    await expect(pinned.first()).toContainText(/r\d+/);
    await admin.getByRole("button", { name: "Publish" }).click();
    await expect(admin.getByText("PUBLISHED").first()).toBeVisible({ timeout: 60_000 });

    // ── The student registers, enters, and opens the question ──
    await openPage(student, `/contests/${SLUG}`);
    await expect(student.getByRole("heading", { name: TITLE, level: 1 })).toBeVisible({ timeout: 60_000 });
    await student.getByRole("button", { name: "Register" }).click();
    await student.getByRole("link", { name: "Enter the arena" }).click();
    await expect(student.getByRole("navigation", { name: "Contest problems" })).toBeVisible({ timeout: 60_000 });
    await shot(student, testInfo, "arena.png");

    // The arena's one control. It is a link to the practice workspace, which
    // is the whole correction those two NOT RUN rows needed.
    const open = student.getByRole("link", { name: /Open the workspace/i });
    await expect(open).toBeVisible();
    await expect(open).toHaveAttribute("href", `/problems/${sqlSlug}`);
    await open.click();

    // And what arrives is the SQL surface, not a programming one.
    await expect(student).toHaveURL(new RegExp(`/problems/${sqlSlug}$`), { timeout: 90_000 });
    const bar = student.locator("p", { hasText: /PostgreSQL 17/ }).first();
    await expect(bar).toBeVisible({ timeout: 60_000 });
    await expect(bar).toContainText("one statement");
    await expect(bar).toContainText("read-only");
    // The language picker offers the query language and no compiler.
    const picker = student.getByLabel(/Language/i).first();
    if (await picker.count()) {
      await expect(picker).toContainText(/PostgreSQL 17|SQL/i);
      await expect(picker).not.toContainText(/C\+\+|Python/i);
    }
    await shot(student, testInfo, "contest-sql-workspace.png");

    expect(ACCOUNTS.student.identifier.length, "the student account is the seeded one").toBeGreaterThan(0);
  });
});
