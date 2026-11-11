import { expect, test } from "@playwright/test";
import { ACCOUNTS } from "./support/accounts";
import { openPage, settle } from "./support/page";

/**
 * The public /judge transparency page (Phase 4) and the workspace footer
 * link into it:
 *   - signed out, /judge answers 200 without a redirect to /login and lists
 *     the seeded enabled languages, each under its own anchor;
 *   - signed in as a student, the workspace footer names the active
 *     language and links (in a new tab) to that language's /judge section,
 *     whose heading carries the same label.
 */

const SEEDED_ENABLED = ["cpp20", "py312"] as const;

test.describe("signed out", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("/judge is public and lists the enabled languages", async ({ page }) => {
    const response = await openPage(page, "/judge");
    expect(response?.status(), "/judge should answer 200 signed out").toBe(200);
    expect(new URL(page.url()).pathname).toBe("/judge");
    await settle(page);
    await expect(page.getByRole("heading", { level: 1, name: "Judge specifications" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Sign in" })).toBeVisible();
    for (const key of SEEDED_ENABLED) {
      await expect(page.locator(`h3#lang-${key}`), `the ${key} card`).toBeVisible();
    }
    await expect(page.locator("#verdict-precedence li")).not.toHaveCount(0);
    await expect(page.locator("#run-outcome-rules li")).not.toHaveCount(0);
  });
});

test.describe("workspace footer", () => {
  test.use({ storageState: ACCOUNTS.student.storageState });

  test("links the active language to its /judge section", async ({ page, context }) => {
    await openPage(page, process.env.E2E_PROBLEM ? `/problems/${process.env.E2E_PROBLEM}` : "/problems/two-sum");
    expect(new URL(page.url()).pathname).not.toBe("/login");
    await settle(page);

    const link = page.locator('a[href^="/judge#lang-"]');
    await expect(link).toHaveCount(1);
    await expect(link).toHaveAttribute("target", "_blank");
    await expect(link).toHaveAccessibleName(/opens in a new tab/);
    const href = (await link.getAttribute("href")) ?? "";
    const anchor = href.split("#")[1] ?? "";
    expect(anchor).toMatch(/^lang-[a-z0-9]+$/);
    const shown = ((await link.locator("span").first().textContent()) ?? "").trim();
    expect(shown.length).toBeGreaterThan(0);

    const judge = await context.newPage();
    const response = await openPage(judge, href);
    expect(response?.status()).toBe(200);
    const heading = judge.locator(`h3#${anchor}`);
    await expect(heading).toBeVisible();
    // The footer shows the label (plus the version when the label lacks it).
    expect(shown.startsWith(((await heading.textContent()) ?? "").trim())).toBe(true);
    await judge.close();
  });
});
