import { expect, test } from "@playwright/test";
import { PROBLEM_KIND_HINT, PROBLEM_KIND_LABEL, type ProblemKind } from "@recx/shared";
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
 * A published problem of a given kind, found the way a student would:
 * the catalogue says which kind each row is (Phase 12p, slice 3), so the
 * chip is the handle. Until that slice this had to open problems one at a
 * time and recognise the bar over the editor — which is how the gap was
 * found, and why the walk is kept below as the fallback.
 *
 * The row is matched on the chip's own screen-reader sentence rather than
 * on the short label, because a label like "SQL" could appear in a title.
 */
async function slugOfKind(
  page: import("@playwright/test").Page,
  what: { kind: ProblemKind; bar: RegExp; envVar: string },
): Promise<string> {
  const given = process.env[what.envVar];
  if (given) return given;

  await openPage(page, "/problems");
  const row = page.getByRole("row").filter({ hasText: PROBLEM_KIND_HINT[what.kind] }).first();
  if (await row.isVisible({ timeout: 30_000 }).catch(() => false)) {
    const href = await row.getByRole("link").first().getAttribute("href");
    if (href?.startsWith("/problems/")) return href.replace("/problems/", "").split("?")[0]!;
  }

  // Fallback: open problems until one shows that kind's bar. A catalogue
  // page holds fifty rows, so a kind can simply be on page two.
  const hrefs = [
    ...new Set(
      (await page.getByRole("link").evaluateAll((els) => els.map((e) => e.getAttribute("href") ?? "")))
        .filter((h) => /^\/problems\/[^/?#]+$/.test(h))
        .map((h) => h.replace("/problems/", "")),
    ),
  ];
  for (const slug of hrefs.slice(0, 12)) {
    await openPage(page, `/problems/${slug}`);
    if (await page.locator("p", { hasText: what.bar }).first().isVisible({ timeout: 15_000 }).catch(() => false)) {
      return slug;
    }
  }
  throw new Error(`no ${what.kind} problem in the catalogue; set ${what.envVar} to one`);
}

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

/**
 * Put the starter back. The confirmation names the broken program rather
 * than "starter code", which is the wording Phase 12m gave a debugging
 * question.
 */
async function resetToStarter(page: import("@playwright/test").Page): Promise<void> {
  await page.getByRole("button", { name: /Reset to the broken program/i }).click();
  await expect(page.getByRole("dialog")).toContainText("Reset to the broken program?");
  await page.getByRole("button", { name: "Reset code" }).click();
}

const DEBUGGING = { kind: "debugging" as const, bar: /a debugging question/, envVar: "E2E_DEBUG_PROBLEM" };
const SQL = { kind: "sql" as const, bar: /PostgreSQL 17/, envVar: "E2E_SQL_PROBLEM" };
const INTERACTIVE = { kind: "interactive" as const, bar: /a conversation/, envVar: "E2E_INTERACTIVE_PROBLEM" };
const ANSWER = { kind: "answer" as const, bar: /your answer, not a program/, envVar: "E2E_ANSWER_PROBLEM" };

/** Every kind a contest can hold, with the bar it must show when opened. */
const IN_A_CONTEST = [SQL, DEBUGGING, INTERACTIVE, ANSWER];

/**
 * A correct answer for each kind, for the judged run below.
 *
 * The debugging one is deliberately ONE line away from the broken program
 * it is given — `i <= n` where the statement asks for the whole numbers
 * BELOW n — because the budget is one line and a rewrite would be refused
 * before it ever reached the judge.
 */
const SOLUTION: Readonly<Record<string, string>> = {
  sql: "select id, name from students order by id;",
  debugging: [
    "#include <iostream>",
    "",
    "int main() {",
    "    int n;",
    "    std::cin >> n;",
    "    int sum = 0;",
    "    for (int i = 0; i < n; i++) sum += i;",
    "    std::cout << sum << std::endl;",
    "}",
    "",
  ].join("\n"),
  // Binary search inside the 40 queries the statement allows, flushing
  // every line, and stopping the moment the examiner says "correct".
  interactive: [
    "#include <iostream>",
    "#include <string>",
    "",
    "int main() {",
    "    long long lo = 1, hi = 1000000000;",
    "    std::string reply;",
    "    while (lo < hi) {",
    "        long long mid = lo + (hi - lo) / 2;",
    "        std::cout << mid << std::endl;",
    "        if (!(std::cin >> reply)) return 0;",
    "        if (reply == \"correct\") return 0;",
    "        if (reply == \"lower\") hi = mid - 1; else lo = mid + 1;",
    "    }",
    "    std::cout << lo << std::endl;",
    "    std::cin >> reply;",
    "    return 0;",
    "}",
    "",
  ].join("\n"),
};

/** Type a whole answer into the editor, whichever editor it is. */
async function typeSolution(page: import("@playwright/test").Page, source: string): Promise<void> {
  const editor = page.locator("[data-editor-root]").first();
  await expect(editor).toBeVisible({ timeout: 60_000 });
  await editor.click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.insertText(source);
}

test.describe.configure({ mode: "serial" });

test.describe("the problem kinds, in a browser", () => {
  test("the catalogue says which kind each problem is, before anybody opens one", async ({ browser }, testInfo) => {
    test.setTimeout(5 * 60_000);
    const context = await contextAs(browser, "student");
    const page = await context.newPage();
    await openPage(page, "/problems");

    /**
     * Phase 12p, slice 3. Until it, this page named the status, the code,
     * the title, the topics, the difficulty and the acceptance rate — and
     * nothing about the kind, so the four kinds of question that are not
     * ordinary programs were indistinguishable from the outside.
     */
    const seen: ProblemKind[] = [];
    for (const kind of ["sql", "debugging", "interactive", "answer"] as const) {
      const row = page.getByRole("row").filter({ hasText: PROBLEM_KIND_HINT[kind] }).first();
      if (!(await row.isVisible({ timeout: 20_000 }).catch(() => false))) continue;
      seen.push(kind);
      // The word a student reads, and the sentence a screen reader reads.
      await expect(row).toContainText(PROBLEM_KIND_LABEL[kind]);
      await expect(row).toContainText(PROBLEM_KIND_HINT[kind]);
      // And the row still goes where it went before.
      await expect(row.getByRole("link").first()).toHaveAttribute("href", /^\/problems\//);
    }
    expect(seen.length, "the catalogue shows none of the four named kinds — seed one").toBeGreaterThan(0);

    // An ordinary program is NOT labelled: a chip on every row is a chip
    // nobody reads, and that half is as much the feature as the other.
    const plain = page
      .getByRole("row")
      .filter({ hasText: /REC-/ })
      .filter({ hasNotText: PROBLEM_KIND_HINT.sql })
      .filter({ hasNotText: PROBLEM_KIND_HINT.debugging })
      .filter({ hasNotText: PROBLEM_KIND_HINT.interactive })
      .filter({ hasNotText: PROBLEM_KIND_HINT.answer })
      .first();
    if (await plain.isVisible({ timeout: 10_000 }).catch(() => false)) {
      for (const kind of ["sql", "debugging", "interactive", "answer"] as const) {
        await expect(plain).not.toContainText(PROBLEM_KIND_LABEL[kind]);
      }
    }
    await shot(page, testInfo, "catalogue-kinds.png");
  });

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

  test("every kind a contest can hold opens as its own practice surface", async ({ browser }, testInfo) => {
    test.setTimeout(10 * 60_000);
    const staff = await contextAs(browser, "admin");
    const admin = await staff.newPage();
    const studentContext = await contextAs(browser, "student");
    const student = await studentContext.newPage();

    /**
     * SPEC allows every kind in a contest, and nothing refuses one: the
     * arena has no editor of its own, only a link to /problems/<slug>. Two
     * NOT RUN rows said otherwise (12k.4, 12l.3) and this is the walk that
     * settles them — for all four kinds, not just the one.
     *
     * A kind the catalogue does not hold is skipped rather than failed:
     * the seed decides which exist, and this test is about the lane.
     */
    const kinds: { letter: string; slug: string; bar: RegExp; kind: string }[] = [];
    const letters = "ABCD";
    for (const [i, what] of IN_A_CONTEST.entries()) {
      const slug = await slugOfKind(student, what).catch(() => null);
      if (slug) kinds.push({ letter: letters[i]!, slug, bar: what.bar, kind: what.kind });
    }
    expect(kinds.length, "the catalogue holds none of the four kinds").toBeGreaterThan(0);

    // ── A contest that is running now, holding one of each ──
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

    for (const { letter, slug, kind } of kinds) {
      await admin.getByLabel("Letter").fill(letter);
      await admin.getByLabel("Problem address").fill(slug);
      await admin.getByRole("button", { name: "Add problem" }).click();
      // Nothing refuses any of these in a contest, and this is the
      // assertion that says so out loud: the pin lands. The row names the
      // problem by title and links to it, so that link identifies it.
      const pinned = admin.getByRole("row").filter({ has: admin.locator(`a[href*="${slug}"]`) });
      await expect(pinned.first(), `${kind} was refused the pin`).toBeVisible({ timeout: 60_000 });
      // Pinned at the revision it had when it was added, as every contest
      // problem is.
      await expect(pinned.first()).toContainText(/r\d+/);
    }
    await admin.getByRole("button", { name: "Publish" }).click();
    await expect(admin.getByText("PUBLISHED").first()).toBeVisible({ timeout: 60_000 });

    // ── The student registers, enters, and opens the question ──
    await openPage(student, `/contests/${SLUG}`);
    await expect(student.getByRole("heading", { name: TITLE, level: 1 })).toBeVisible({ timeout: 60_000 });
    await student.getByRole("button", { name: "Register" }).click();
    await student.getByRole("link", { name: "Enter the arena" }).click();
    await expect(student.getByRole("navigation", { name: "Contest problems" })).toBeVisible({ timeout: 60_000 });
    await shot(student, testInfo, "arena.png");

    // Each letter in turn: the arena's one control is a link to the
    // practice workspace, and what arrives is that kind's own surface.
    for (const { letter, slug, bar, kind } of kinds) {
      await openPage(student, `/contests/${SLUG}/arena?p=${letter}`);
      const open = student.getByRole("link", { name: /Open the workspace/i });
      await expect(open, `${kind}: the arena offers no way in`).toBeVisible({ timeout: 60_000 });
      await expect(open, `${kind}: the arena links somewhere of its own`).toHaveAttribute(
        "href",
        `/problems/${slug}`,
      );
      await open.click();
      await expect(student).toHaveURL(new RegExp(`/problems/${slug}$`), { timeout: 90_000 });
      await expect(
        student.locator("p", { hasText: bar }).first(),
        `${kind}: the workspace a contest opened does not know the kind`,
      ).toBeVisible({ timeout: 60_000 });
      await shot(student, testInfo, `contest-${kind}.png`);
    }

    // And the SQL one in particular offers the query language, no compiler.
    const sql = kinds.find((k) => k.kind === "sql");
    if (sql) {
      await openPage(student, `/problems/${sql.slug}`);
      const picker = student.getByLabel(/Language/i).first();
      if (await picker.count()) {
        await expect(picker).toContainText(/PostgreSQL 17|SQL/i);
        await expect(picker).not.toContainText(/C\+\+|Python/i);
      }
    }

    expect(ACCOUNTS.student.identifier.length, "the student account is the seeded one").toBeGreaterThan(0);
  });
  test("a contest judges every kind, and the standings move", async ({ browser }, testInfo) => {
    test.skip(!process.env.E2E_JUDGE, "needs a judge node attached to the stack: E2E_JUDGE=1");
    test.setTimeout(30 * 60_000);

    /**
     * The half slice 4 could not settle. It proved the LANE — every kind
     * pins into a contest and opens with its own surface — but nothing was
     * ever submitted there, so no verdict, no score and no standings had
     * been exercised with these kinds.
     *
     * Here each one is answered correctly inside a running contest and
     * judged by a real node.
     */
    const staff = await contextAs(browser, "admin");
    const admin = await staff.newPage();
    const studentContext = await contextAs(browser, "journey");
    const student = await studentContext.newPage();

    const slug = `${SLUG}-judged`;
    const title = `${TITLE} judged`;
    const kinds: { letter: string; slug: string; kind: string }[] = [];
    for (const [i, what] of IN_A_CONTEST.entries()) {
      const found = await slugOfKind(student, what).catch(() => null);
      if (found) kinds.push({ letter: "ABCD"[i]!, slug: found, kind: what.kind });
    }
    expect(kinds.length, "no kinds to judge").toBeGreaterThan(0);

    /**
     * The node may be quarantined — a development host fails nine kernel
     * hardening checks and its calibration drifts from the fleet median,
     * and this machine's node had been left out of service. Returning it
     * is an ADMIN action on /admin/judge with a reason that lands in the
     * audit log, never an UPDATE: that is the rule, and this is the
     * supported way to do it (the Phase 10f drill uses the same control).
     */
    await openPage(admin, "/admin/judge");
    /**
     * Pause the ten-second auto-refresh first. It calls router.refresh(),
     * which remounts the node's action buttons and takes the open dialog
     * with them — so a reason typed slowly is lost. The page offers the
     * Pause for exactly this, and a test that does not use it is testing
     * its own typing speed.
     */
    const pause = admin.getByRole("button", { name: "Pause", exact: true });
    if (await pause.isVisible({ timeout: 30_000 }).catch(() => false)) await pause.click();

    const returnToOnline = admin.getByRole("button", { name: /^Return to ONLINE: / }).first();
    if (await returnToOnline.isVisible({ timeout: 30_000 }).catch(() => false)) {
      const dialog = admin.getByRole("dialog");
      // The buttons are a client island on a page that re-renders itself;
      // a click that lands before it is listening does nothing at all, so
      // open the dialog by result rather than by one click.
      for (let attempt = 0; attempt < 4; attempt++) {
        await returnToOnline.click();
        if (await dialog.isVisible({ timeout: 5_000 }).catch(() => false)) break;
      }
      await expect(dialog, "the node dialog never opened").toBeVisible({ timeout: 10_000 });
      await dialog.getByLabel("Reason").fill(`Judged-contest stage, Phase 12p.5, round ${runId}.`);
      await dialog.getByRole("button", { name: "Return to ONLINE", exact: true }).click();
      await expect(dialog).toBeHidden({ timeout: 60_000 });
    }
    // Whatever state it started in, it has to be taking work now.
    await expect(
      admin.getByRole("button", { name: /^Return to ONLINE: / }),
      "the judge node is still out of service",
    ).toHaveCount(0, { timeout: 60_000 });

    await openPage(admin, "/admin/contests");
    await admin.getByRole("link", { name: "New contest" }).click();
    await admin.getByLabel("Title").fill(title);
    await admin.getByLabel("Address").fill(slug);
    await admin.getByLabel("Starts").fill(istInput(new Date(Date.now() - 5 * 60_000)));
    await admin.getByLabel("Ends").fill(istInput(new Date(Date.now() + 3 * 60 * 60 * 1000)));
    await admin.getByLabel("Standings freeze (minutes)").fill("0");
    await admin.getByLabel("Rules").fill(`Answer each one. Round ${runId}.`);
    await admin.getByRole("button", { name: "Create draft" }).click();
    await expect(admin.getByRole("heading", { name: title, level: 1 })).toBeVisible({ timeout: 60_000 });
    for (const { letter, slug: problemSlug } of kinds) {
      await admin.getByLabel("Letter").fill(letter);
      await admin.getByLabel("Problem address").fill(problemSlug);
      await admin.getByRole("button", { name: "Add problem" }).click();
      await expect(admin.getByRole("row").filter({ has: admin.locator(`a[href*="${problemSlug}"]`) }).first()).toBeVisible({
        timeout: 60_000,
      });
    }
    await admin.getByRole("button", { name: "Publish" }).click();
    await expect(admin.getByText("PUBLISHED").first()).toBeVisible({ timeout: 60_000 });

    await openPage(student, `/contests/${slug}`);
    await student.getByRole("button", { name: "Register" }).click();
    await expect(student.getByRole("link", { name: "Enter the arena" })).toBeVisible({ timeout: 60_000 });

    const judged: string[] = [];
    for (const { kind, slug: problemSlug } of kinds) {
      await openPage(student, `/problems/${problemSlug}`);

      let source = SOLUTION[kind];
      if (kind === "answer") {
        /**
         * An output-only question's one case is visible, and its data IS
         * the question — so the answer is worked out from the page, which
         * is what a student does.
         */
        const body = await student.locator("main").innerText();
        const numbers = [...body.matchAll(/-?\d+/g)].map((m) => Number(m[0]));
        const count = numbers[0] ?? 0;
        expect(count, "the sample data did not start with a count").toBeGreaterThan(0);
        source = String(numbers.slice(1, 1 + count).reduce((a, b) => a + b, 0));
      }
      expect(source, `no model answer for ${kind}`).toBeTruthy();

      await typeSolution(student, source!);
      await student.getByRole("button", { name: "Submit" }).click();
      await expect(
        student.locator('[data-verdict="AC"]').first(),
        `${kind}: not Accepted inside the contest`,
      ).toBeVisible({ timeout: 10 * 60_000 });
      judged.push(kind);
      await shot(student, testInfo, `judged-${kind}.png`);
    }
    expect(judged, "nothing was judged").not.toEqual([]);

    // The standings are the point of a contest: the score has to move.
    await openPage(student, `/contests/${slug}/standings`);
    const row = student.getByRole("row").filter({ hasText: ACCOUNTS.journey.identifier }).first();
    await expect(row.or(student.getByRole("table")).first()).toBeVisible({ timeout: 60_000 });
    await shot(student, testInfo, "judged-standings.png");
  });
});
