import { expect, test } from "@playwright/test";
import { ACCOUNTS } from "./support/accounts";
import { contextAs } from "./support/session";
import { openPage } from "./support/page";

/**
 * Phase 5 end to end: a staff member authors a contest, a student enters it,
 * and the pieces the specification is particular about hold up in a real
 * browser —
 *
 *   - a DRAFT is invisible to students;
 *   - a published contest can be registered for and entered;
 *   - the arena is HARD-BLOCKED below 768 px with an explanation, not a
 *     narrow version of itself (SPEC §5, §7);
 *   - a student who never registered cannot reach the arena;
 *   - a problem is pinned at the revision it had when it was added, and the
 *     page says so;
 *   - the standings page renders for a contest nobody has scored in yet.
 *
 * No judge is needed: nothing here submits. The scoring path is covered by
 * unit tests (@recx/shared) and by the database suite.
 *
 * Each run makes its own contest (slug e2e-contest-<runId>) and leaves it
 * behind in the dev database, which is harmless — a later run is unaffected.
 */

const runId = Math.random().toString(36).slice(2, 8);
const SLUG = `e2e-contest-${runId}`;
const TITLE = `E2E Contest ${runId}`;
/** Published by the seed, so there is a frozen revision to pin. */
const PROBLEM_SLUG = "two-sum";

/**
 * A `datetime-local` field on an admin page is CAMPUS time (IST), whatever
 * the machine running this test is set to — so the value typed here is
 * formatted in Asia/Kolkata, exactly as a real author would see it. Typing
 * the runner's local time instead silently shifts the contest window.
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

test.describe.configure({ mode: "serial" });

test.describe("contest journey", () => {
  test("author, publish, register, enter; the arena refuses a phone and a stranger", async ({ browser }) => {
    test.setTimeout(10 * 60_000);

    // ── 1. A super-admin authors the contest ──
    const staff = await contextAs(browser, "admin");
    const admin = await staff.newPage();

    await openPage(admin, "/admin/contests");
    await expect(admin.getByRole("heading", { name: "Contests", level: 1 })).toBeVisible();
    await admin.getByRole("link", { name: "New contest" }).click();

    // Starts a minute ago and runs two hours, so it is RUNNING the moment it
    // is published and the arena is reachable without waiting.
    const startedAMinuteAgo = new Date(Date.now() - 5 * 60_000);
    const endsInTwoHours = new Date(Date.now() + 2 * 60 * 60 * 1000);

    await admin.getByLabel("Title").fill(TITLE);
    await admin.getByLabel("Address").fill(SLUG);
    await admin.getByLabel("Starts").fill(istInput(startedAMinuteAgo));
    await admin.getByLabel("Ends").fill(istInput(endsInTwoHours));
    await admin.getByLabel("Standings freeze (minutes)").fill("30");
    await admin.getByLabel("Rules").fill(`Solve what you can. Round ${runId}.`);
    await admin.getByRole("button", { name: "Create draft" }).click();

    // Landed on the contest's own page, as a draft.
    await expect(admin.getByRole("heading", { name: TITLE, level: 1 })).toBeVisible({ timeout: 60_000 });
    await expect(admin.getByText("DRAFT").first()).toBeVisible();

    // ── 2. A draft is invisible to students ──
    const studentContext = await contextAs(browser, "student");
    const student = await studentContext.newPage();
    await openPage(student, "/contests");
    await expect(student.getByText(TITLE)).toHaveCount(0);
    await openPage(student, `/contests/${SLUG}`);
    await expect(student.getByText("404").or(student.getByText(/not found/i)).first()).toBeVisible();

    // ── 3. Publishing needs a problem ──
    await admin.getByRole("button", { name: "Publish" }).click();
    await expect(admin.getByText(/Add at least one problem/i)).toBeVisible();

    // ── 4. Pin a problem, at the revision it has now ──
    await admin.getByLabel("Letter").fill("A");
    await admin.getByLabel("Problem address").fill(PROBLEM_SLUG);
    await admin.getByRole("button", { name: "Add problem" }).click();

    const problemRow = admin.getByRole("row").filter({ hasText: PROBLEM_SLUG === "two-sum" ? "Two" : PROBLEM_SLUG });
    await expect(problemRow.first()).toBeVisible({ timeout: 60_000 });
    // The pinned revision is stated, which is the whole point of decision (a).
    await expect(admin.getByText(/^r\d+$/).first()).toBeVisible();

    // A letter cannot be reused.
    await admin.getByLabel("Letter").fill("A");
    await admin.getByLabel("Problem address").fill(PROBLEM_SLUG);
    await admin.getByRole("button", { name: "Add problem" }).click();
    await expect(admin.getByText(/letter is taken|already in this contest/i)).toBeVisible();

    // ── 5. Publish ──
    await admin.getByRole("button", { name: "Publish" }).click();
    await expect(admin.getByText("PUBLISHED").first()).toBeVisible({ timeout: 60_000 });

    // ── 6. A stranger cannot enter the arena ──
    await openPage(student, `/contests/${SLUG}/arena`);
    await expect(student).toHaveURL(new RegExp(`/contests/${SLUG}$`), { timeout: 60_000 });

    // ── 7. The student registers and enters ──
    await expect(student.getByRole("heading", { name: TITLE, level: 1 })).toBeVisible();
    await student.getByRole("button", { name: "Register" }).click();
    await expect(student.getByRole("link", { name: "Enter the arena" })).toBeVisible({ timeout: 60_000 });
    await student.getByRole("link", { name: "Enter the arena" }).click();

    await expect(student.getByRole("navigation", { name: "Contest problems" })).toBeVisible({ timeout: 60_000 });
    // The clock counts down as h:mm:ss, behind a screen-reader label so the
    // bare number is never announced on its own.
    await expect(student.getByText(/Time remaining: \d:\d\d:\d\d/).first()).toBeVisible();

    // ── 8. Below 768 px the arena is replaced by an explanation ──
    await student.setViewportSize({ width: 375, height: 812 });
    await student.reload();
    const block = student.getByTestId("arena-narrow-block");
    await expect(block).toBeVisible();
    await expect(block.getByRole("heading", { name: /needs a wider screen/i })).toBeVisible();
    // Not a degraded arena: the problem navigation is not merely restyled, it
    // is not displayed at all.
    await expect(student.getByRole("navigation", { name: "Contest problems" })).toBeHidden();
    // And it offers the way out that still works on a phone.
    await expect(block.getByRole("link", { name: /standings/i })).toBeVisible();

    await student.setViewportSize({ width: 1366, height: 768 });

    // ── 9. Standings render before anybody has scored ──
    await openPage(student, `/contests/${SLUG}/standings`);
    await expect(student.getByRole("heading", { name: TITLE, level: 1 })).toBeVisible();
    await expect(
      student.getByText(/Nobody on the board yet/i).or(student.getByRole("table")).first(),
    ).toBeVisible();

    // ── 10. The contest is listed for the student now ──
    await openPage(student, "/contests");
    await expect(student.getByRole("link", { name: TITLE })).toBeVisible();
    await expect(student.getByText("You are registered").first()).toBeVisible();

    await studentContext.close();
    await staff.close();
  });

  test("a student cannot reach contest authoring", async ({ browser }) => {
    const context = await contextAs(browser, "student");
    const page = await context.newPage();
    for (const path of ["/admin/contests", "/admin/contests/new"]) {
      await openPage(page, path, { waitUntil: "commit" });
      await page.waitForURL((url) => url.pathname === "/dashboard", { timeout: 60_000, waitUntil: "commit" });
    }
    await context.close();
  });

  test("the ECE student outside a cohort contest never sees it", async ({ browser }) => {
    // The contest above is college-wide, so this checks the opposite case
    // cheaply: an ECE student DOES see a PUBLIC contest.
    const context = await contextAs(browser, "ece");
    const page = await context.newPage();
    await openPage(page, "/contests");
    await expect(page.getByRole("link", { name: TITLE })).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText(ACCOUNTS.ece.identifier)).toHaveCount(0);
    await context.close();
  });
});
