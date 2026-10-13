import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium, type FullConfig } from "@playwright/test";
import { ACCOUNTS, AUTH_DIR, STAFF_ACCOUNT_KEYS, type Account, type AccountKey } from "./support/accounts";
import { signInWithForm } from "./support/session";

/** rename() over a file another process has open can fail briefly on Windows. */
async function replaceFile(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(from, to);
      return;
    } catch (error) {
      if (attempt >= 20) throw error;
      await sleep(100);
    }
  }
}

/**
 * Global setup: sign each seeded account in ONCE through the real sign-in
 * form (a no-JS POST to /api/auth/login) and store its session
 * (storageState) for the specs. Also warms the dev server — `next dev`
 * compiles a route on its first request, which can take tens of seconds —
 * so the specs measure pages, not the compiler.
 */

const STUDENT_WARM = ["/dashboard", "/problems", "/problems/two-sum", "/leaderboard"];

/** Routes each account warms (only when E2E_WARM is not "0"). */
const WARM: Readonly<Record<AccountKey, readonly string[]>> = {
  student: STUDENT_WARM,
  journey: [],
  authoring: [],
  ece: [],
  // RECADMIN01 (SUPER_ADMIN): the judge console, authoring and the /super tree.
  admin: ["/admin/judge", "/admin/problems", "/admin/problems/new", "/super"],
  // RECADMIN02 (ADMIN, scoped): authoring and the scoped student list.
  staffAdmin: ["/admin", "/admin/problems", "/admin/problems/new", "/admin/students"],
  super2: ["/super"],
};

async function signIn(baseURL: string, channel: string | undefined, acct: Account, warm: readonly string[]) {
  const browser = await chromium.launch(channel ? { channel } : {});
  try {
    const context = await browser.newContext({ baseURL });
    const page = await context.newPage();
    page.setDefaultNavigationTimeout(120_000);
    page.setDefaultTimeout(60_000);

    await signInWithForm(page, acct);
    for (const path of warm) {
      await page.goto(path, { waitUntil: "load" });
    }

    // Written atomically: another run may be reading the previous file.
    const tmp = `${acct.storageState}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(await context.storageState()));
    await replaceFile(tmp, acct.storageState);
    await context.close();
  } finally {
    await browser.close();
  }
}

export default async function globalSetup(config: FullConfig) {
  const use = config.projects[0]?.use ?? {};
  const baseURL = use.baseURL ?? "http://localhost:3000";
  const channel = use.channel;
  mkdirSync(AUTH_DIR, { recursive: true });

  const warmFor = (key: AccountKey) => (process.env.E2E_WARM === "0" ? [] : WARM[key]);
  const staff = process.env.E2E_ADMIN !== "0";
  const keys: AccountKey[] = ["student", "journey", "authoring", "ece", ...(staff ? STAFF_ACCOUNT_KEYS : [])];
  // Sequential: the first sign-in also compiles /login and the server actions.
  for (const key of keys) {
    await signIn(baseURL, channel, ACCOUNTS[key], warmFor(key));
  }
}
