import type { Locator, Page } from "@playwright/test";

/**
 * Server-action forms on the admin pages report a failure as an inline
 * `<p role="alert">` (and a toast) and a success as a toast
 * (`role="status"`) and/or a re-rendered page. Wait for whichever comes
 * first, and fail with the page's own error text instead of a bare timeout.
 */
export async function expectActionSuccess(page: Page, success: Locator, step: string, timeout = 60_000): Promise<void> {
  const failure = page.locator('p[role="alert"]').filter({ hasText: /\S/ }).first();
  const outcome = await Promise.race([
    success
      .first()
      .waitFor({ state: "visible", timeout })
      .then(() => "ok" as const),
    failure.waitFor({ state: "visible", timeout }).then(() => "failed" as const),
  ]).catch(() => "timeout" as const);
  if (outcome === "failed") {
    const text = ((await failure.textContent().catch(() => "")) ?? "").trim();
    throw new Error(`[${step}] the action failed: ${text}`);
  }
  if (outcome === "timeout") throw new Error(`[${step}] no success signal within ${Math.round(timeout / 1000)} s`);
}

/** A toast (role="status") with exactly this message. */
export function toast(page: Page, message: string | RegExp): Locator {
  return page.getByRole("status").filter({ hasText: message });
}
