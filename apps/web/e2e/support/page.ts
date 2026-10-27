import { expect, type Page } from "@playwright/test";

export type Theme = "light" | "dark";

/** The key the inline theme script reads before first paint (src/lib/theme-script.ts). */
export const THEME_STORAGE_KEY = "recx-theme";

/**
 * Store the theme before any page script runs, on every navigation of this
 * page. Pair it with the context's `colorScheme` so "system" and the stored
 * choice agree.
 */
export async function presetTheme(page: Page, theme: Theme): Promise<void> {
  await page.addInitScript(
    ([key, value]) => {
      try {
        window.localStorage.setItem(key, value);
      } catch {
        // Storage blocked: the colorScheme emulation still selects the theme.
      }
    },
    [THEME_STORAGE_KEY, theme] as const,
  );
}

/** The theme actually applied to <html> (the `dark` class). */
export async function appliedTheme(page: Page): Promise<Theme> {
  const dark = await page.evaluate(() => document.documentElement.classList.contains("dark"));
  return dark ? "dark" : "light";
}

/**
 * Wait until a page has settled: loaded, the RSC stream finished (network
 * idle, best effort — the dev server keeps an HMR socket open), Suspense
 * skeletons replaced and fonts ready.
 */
export async function settle(page: Page): Promise<void> {
  await page.waitForLoadState("load");
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => undefined);
  await page
    .waitForFunction(() => document.querySelectorAll(".skeleton, [aria-busy='true']").length === 0, undefined, {
      timeout: 20_000,
    })
    .catch(() => undefined);
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
}

/**
 * The coding workspace has handed its plain textarea over to the real
 * editor. Attached, not visible: below 1024 px the editor lives in the Code
 * tab, which is not the initial one.
 */
export async function waitForEditor(page: Page, kind: "monaco" | "codemirror"): Promise<void> {
  await expect(page.locator(`[data-editor-root][data-editor="${kind}"]`)).toBeAttached({ timeout: 60_000 });
}

/**
 * Patterns in a navigation error that mean the dev server went away, not
 * that the page is wrong. `next dev` restarts ITSELF when it approaches its
 * memory threshold — it says so: "⚠ Server is approaching the used memory
 * threshold, restarting..." — and a request in flight at that moment is
 * answered with nothing at all.
 */
const SERVER_WENT_AWAY =
  /ERR_EMPTY_RESPONSE|ERR_CONNECTION_REFUSED|ERR_CONNECTION_RESET|ERR_CONNECTION_CLOSED|ERR_SOCKET_NOT_CONNECTED|socket hang up|ECONNREFUSED|ECONNRESET/;

/** How long to keep waiting for a restarting dev server before giving up. */
const RESTART_BUDGET_MS = process.env.CI ? 180_000 : 60_000;

/**
 * `page.goto`, but tolerant of the development server restarting under it.
 *
 * Every navigation in this suite goes through here. The reason is a real CI
 * failure: the suite warms about sixty routes, which is most of the app's
 * module graph, and shortly afterwards Next decided it was near its memory
 * ceiling and restarted — so the global setup's very first `page.goto`
 * returned `net::ERR_EMPTY_RESPONSE` and the whole job failed before a
 * single assertion had run.
 *
 * Only connection-level failures are retried, and only while the budget
 * lasts. A navigation TIMEOUT is not retried: a page that takes too long is
 * a finding, and this must never turn one into a pass. Anything else —
 * including an assertion later in the test — is rethrown untouched.
 */
export async function openPage(
  page: Page,
  path: string,
  options: Parameters<Page["goto"]>[1] = {},
): Promise<Awaited<ReturnType<Page["goto"]>>> {
  const deadline = Date.now() + RESTART_BUDGET_MS;
  for (let attempt = 1; ; attempt++) {
    try {
      return await page.goto(path, options);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!SERVER_WENT_AWAY.test(message) || Date.now() >= deadline) throw error;
      console.log(`[e2e] ${path}: the server went away (${message.split("\n")[0]}); retry ${attempt}`);
      await page.waitForTimeout(2_000);
    }
  }
}
