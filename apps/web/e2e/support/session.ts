import type { Browser, BrowserContext, Page } from "@playwright/test";
import { ACCOUNTS, passwordFor, type Account, type AccountKey } from "./accounts";
import { openPage } from "./page";

/**
 * How long to wait for the sign-in POST to answer. A two-core CI runner
 * compiles `/api/auth/login` on its first request, and the suite's first
 * action is a sign-in, so the budget matches `navigationTimeout` in
 * playwright.config.ts rather than being a second, smaller number that
 * expires first. `scripts/dev/warm-routes.sh` POSTs the route before the
 * suite starts, so this budget is the backstop and not the plan.
 */
const SIGN_IN_TIMEOUT_MS = process.env.CI ? 180_000 : 120_000;

/**
 * Sign in through the real sign-in page: a server-rendered form with no
 * JavaScript that POSTs to /api/auth/login. Each call mints a NEW session
 * (use it when a test must not share the stored session, e.g. an
 * impersonation, which belongs to one session). The password is typed,
 * never printed, and a failure quotes the page's own alert — or says that
 * no alert appeared, which means something other than the credentials.
 */
export async function signInWithForm(page: Page, acct: Account): Promise<void> {
  await openPage(page, "/login");
  await page.getByLabel("Roll number or college email").fill(acct.identifier);
  await page.getByLabel("Password", { exact: true }).fill(passwordFor(acct));
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: SIGN_IN_TIMEOUT_MS }).catch(async () => {
    const alert = await page
      .getByRole("alert")
      .first()
      .textContent()
      .catch(() => null);
    // An alert means the server refused and said why. No alert means the
    // request never came back, which is a different problem and used to be
    // reported as if the credentials were wrong.
    const why = alert
      ? `: ${alert.trim()}`
      : ` — still on ${page.url()} after ${SIGN_IN_TIMEOUT_MS / 1000}s with no alert, so the POST never answered`;
    throw new Error(`Sign-in failed for ${acct.identifier}${why}`);
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
