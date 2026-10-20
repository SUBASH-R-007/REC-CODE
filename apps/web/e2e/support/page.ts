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
