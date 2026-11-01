import { expect, type Page } from "@playwright/test";
import { openPage } from "./page";

/**
 * Authoring a paper and getting into it, shared by the specs that need a
 * sitting (Phase 12u).
 *
 * `exam-journey` built this inline, which was right while one spec sat a
 * paper. The axe scan of the exam surface needs the same thing — a sitting
 * cannot be reached from a list of paths, it has to be authored, opened,
 * started and navigated — and the setup is long enough that two copies
 * would drift.
 */

/**
 * A `datetime-local` field on an admin page is CAMPUS time (IST), whatever
 * the machine running the test is set to; typing the runner's local time
 * silently shifts the window.
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

export function istInput(date: Date): string {
  const parts = IST.formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}`;
}

/** Published by the seed, so there is a frozen revision to pin. */
export const SEEDED_PROBLEM_SLUG = "two-sum";
export const RIGHT_OPTION = "Merge sort";

export interface PaperOptions {
  /** Distinguishes this run's paper from every other run's. */
  readonly runId: string;
  /** Phase 12s: accept only text copied inside the sitting. */
  readonly refuseOutsidePaste?: boolean;
  /** Leave out the coding question, which is the all-multiple-choice case. */
  readonly codingQuestion?: boolean;
  readonly durationMinutes?: number;
  /**
   * Phase 13a: the languages the paper accepts, by their short labels as
   * the checkbox list writes them ("C++20", "Python 3.12"). Left out, the
   * paper restricts nothing and the candidate is offered every enabled
   * language -- which is what every paper written before 13a holds.
   */
  readonly languages?: readonly string[];
}

export interface AuthoredPaper {
  readonly slug: string;
  readonly title: string;
  readonly stem: string;
  readonly questionCount: number;
}

/**
 * Author a paper as staff and open it for candidates.
 *
 * ADVISORY, so no hall, no registered device and no kiosk key stand between
 * a test and the sitting; those refusals are driven directly by
 * `exam-start-hall.db.test.ts`, which is the right place for them.
 */
export async function authorPaper(admin: Page, options: PaperOptions): Promise<AuthoredPaper> {
  const { runId } = options;
  const coding = options.codingQuestion ?? true;
  const slug = `e2e-exam-${runId}`;
  const title = `E2E Exam ${runId}`;
  const stem = `Which of these is a stable sort? (${runId})`;
  const minutes = options.durationMinutes ?? 90;

  await openPage(admin, "/admin/assessments");
  await expect(admin.getByRole("heading", { name: "Assessments", level: 1 })).toBeVisible();
  await admin.getByRole("link", { name: /New assessment/i }).first().click();

  await admin.getByRole("textbox", { name: "Title" }).fill(title);
  // "Address" also appears in the popup option's description ("no address
  // bar"), so every field here is asked for by role as well as by name.
  await admin.getByRole("textbox", { name: "Address" }).fill(slug);
  await admin.getByRole("textbox", { name: "Instructions" }).fill(`Answer everything. Round ${runId}.`);
  await admin.getByRole("radio", { name: /^Advisory/ }).check();
  await admin.getByRole("textbox", { name: "Opens" }).fill(istInput(new Date(Date.now() - 5 * 60_000)));
  await admin
    .getByRole("textbox", { name: "Closes" })
    .fill(istInput(new Date(Date.now() + 4 * 60 * 60_000)));
  await admin.getByRole("textbox", { name: "Duration (minutes)" }).fill(String(minutes));
  await admin.getByRole("textbox", { name: "Attempts allowed" }).fill("1");
  if (options.refuseOutsidePaste) {
    await admin.getByRole("checkbox", { name: /Accept only text copied inside the sitting/i }).check();
  }
  await admin.getByRole("button", { name: "Create the draft" }).click();

  await expect(admin.getByRole("heading", { name: title, level: 1 })).toBeVisible({ timeout: 60_000 });
  await expect(admin.getByText("DRAFT").first()).toBeVisible();

  if (coding) {
    await admin.getByRole("textbox", { name: "Problem address" }).fill(SEEDED_PROBLEM_SLUG);
    await admin.getByRole("textbox", { name: "Position", exact: true }).first().fill("1");
    await admin.getByRole("textbox", { name: "Points" }).fill("3");
    await admin.getByRole("button", { name: "Add", exact: true }).click();
    // The pinned revision is stated, as on a contest.
    await expect(admin.getByText(/^r\d+$/).first()).toBeVisible({ timeout: 60_000 });
  }

  await admin.getByRole("textbox", { name: "Question", exact: true }).fill(stem);
  await admin
    .getByRole("textbox", { name: "Options, one per line" })
    .fill(["Quicksort", RIGHT_OPTION, "Heapsort"].join("\n"));
  await admin.getByRole("textbox", { name: "Position", exact: true }).last().fill(coding ? "2" : "1");
  // 1-based in the form, 0-based in the row: the author counts off the list
  // they just typed and the boundary converts it once (12r.3).
  await admin.getByRole("textbox", { name: "Answer (line number)" }).fill("2");
  await admin.getByRole("textbox", { name: "Marks" }).fill("2");
  await admin.getByRole("button", { name: "Add question" }).click();
  await expect(admin.getByText(stem).first()).toBeVisible({ timeout: 60_000 });

  /**
   * The accepted languages, ticked through the real form (Phase 13a).
   *
   * On the draft page rather than the create form, because that is where
   * the choice lives: it stays editable after publication, since a
   * candidate's set is frozen into their own attempt at start.
   */
  if (options.languages && options.languages.length > 0) {
    /**
     * Scoped to the PAPER's own form (Phase 13c).
     *
     * The page now has two kinds of language checkbox: the paper's
     * accepted set, and the per-question narrowing in the questions
     * table. A page-wide `getByRole("checkbox", { name: "C++20" })`
     * matches both and Playwright refuses it in strict mode -- which is
     * the suite catching an ambiguity the moment the second control
     * appeared, rather than a test quietly ticking the wrong box.
     *
     * By substring, not by a built regular expression: the labels hold
     * "C++20", whose plus signs are a regex that matches nothing.
     */
    const card = admin.locator("form").filter({ hasText: "Save the languages" }).first();
    for (const label of options.languages) {
      await card.getByRole("checkbox", { name: label }).check();
    }
    await card.getByRole("button", { name: "Save the languages" }).click();
    await expect(admin.getByText(/Saved\. Candidates may answer in/)).toBeVisible({ timeout: 60_000 });
  }

  await admin.getByRole("button", { name: /^Publish/ }).click();
  await expect(admin.getByText("PUBLISHED").first()).toBeVisible({ timeout: 60_000 });
  await admin.getByRole("button", { name: /Open it for candidates/ }).click();
  await expect(admin.getByText("OPEN").first()).toBeVisible({ timeout: 60_000 });

  return { slug, title, stem, questionCount: coding ? 2 : 1 };
}

/**
 * The four readiness checks and the consent box, each asserted as it is
 * done so a failure names the capability that was missing rather than only
 * saying the button stayed disabled.
 *
 * Walked rather than worked around: each check is a real browser capability
 * a sitting depends on, and a machine that cannot do one of them should
 * find out here rather than halfway through a paper.
 */
export async function walkReadinessChecks(candidate: Page): Promise<void> {
  const row = (label: RegExp) => candidate.getByText(label).first();
  const start = candidate.getByRole("button", { name: "Start the assessment" });
  await expect(start).toBeDisabled();

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
}

/** The palette button for a position, by the aria-label `paletteLabel` builds. */
export const paletteButton = (page: Page, position: number) =>
  page.getByRole("button", { name: new RegExp(`^Question ${position},`) });

/**
 * Move to a question and wait until it is the one on screen.
 *
 * The click RETRIES, which is not belt-and-braces: the sitting is server
 * rendered and the palette only navigates once React has attached, so a
 * click that lands in that window does nothing at all and is not retried by
 * anything — the page simply stays on question 1. That is what happened the
 * first time this ran against a dev server rather than a production build,
 * and a test that passes only when the bundle is warm is worse than no
 * test. The header is the assertion because it is the one thing that always
 * states which question a candidate is looking at.
 */
export async function goToQuestion(page: Page, position: number, total: number): Promise<void> {
  await expect(async () => {
    await paletteButton(page, position).click();
    await expect(page.getByText(`Question ${position} of ${total}`).first()).toBeVisible({
      timeout: 2_000,
    });
  }).toPass({ timeout: 60_000 });
}
