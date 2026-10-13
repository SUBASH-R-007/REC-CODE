import type { Browser, BrowserContext, Page } from "@playwright/test";
import { ACCOUNTS, passwordFor, type Account, type AccountKey } from "./accounts";

/**
 * Sign in through the real sign-in page: a server-rendered form with no
 * JavaScript that POSTs to /api/auth/login. Each call mints a NEW session
 * (use it when a test must not share the stored session, e.g. an
 * impersonation, which belongs to one session). The password is typed,
 * never printed; a failure reports only the page's own alert text.
 */
export async function signInWithForm(page: Page, acct: Account): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Roll number or college email").fill(acct.identifier);
  await page.getByLabel("Password", { exact: true }).fill(passwordFor(acct));
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 120_000 }).catch(async () => {
    const alert = await page.getByRole("alert").first().textContent().catch(() => null);
    throw new Error(`Sign-in failed for ${acct.identifier}${alert ? `: ${alert.trim()}` : ""}`);
  });
}

/** A browser context carrying the session global setup stored for this account. */
export async function contextAs(
  browser: Browser,
  key: AccountKey,
  options: Parameters<Browser["newContext"]>[0] = {},
): Promise<BrowserContext> {
  return browser.newContext({ ...options, storageState: ACCOUNTS[key].storageState });
}

/** A signed-out browser context. */
export async function signedOutContext(browser: Browser, options: Parameters<Browser["newContext"]>[0] = {}) {
  return browser.newContext({ ...options, storageState: { cookies: [], origins: [] } });
}

/** Wait until the page has landed on `pathname` (server redirect, streamed redirect or client navigation). */
export async function expectLandedOn(page: Page, pathname: string, timeout = 60_000): Promise<void> {
  await page.waitForURL((url) => url.pathname === pathname, { timeout, waitUntil: "commit" });
}
