import { defineConfig } from "@playwright/test";

/**
 * End-to-end suite (apps/web/e2e): the axe accessibility gate, the
 * keyboard-only solving journey, the workspace timings, and the Phase 4
 * RBAC, authoring-journey and /judge specs. See e2e/README.md.
 *
 * The stack is EXTERNAL — there is no `webServer` block. Point the suite at a
 * running REC Code with E2E_BASE_URL (default http://localhost:3000); the
 * seeded accounts must exist (apps/web/scripts/seed.ts) and their passwords
 * come from SEED_STUDENT_PASSWORD / SEED_ADMIN_PASSWORD (environment, or
 * apps/web/.env.local).
 *
 * Browsers: Windows uses the installed Google Chrome (channel "chrome"), so
 * no Playwright browser download is needed there. Linux (CI) uses the
 * bundled Chromium, installed once with:
 *
 *     npx playwright install --with-deps chromium
 *
 * Judge-dependent steps (Run / Submit verdicts) run only with E2E_JUDGE=1 —
 * they need a real judge worker attached to the stack.
 */

const baseURL = process.env.E2E_BASE_URL ?? "http://localhost:3000";
const channel = process.platform === "win32" ? "chrome" : undefined;

export default defineConfig({
  testDir: "./e2e",
  outputDir: "./test-results",
  // A dev server compiles each route on its first request: generous budgets.
  timeout: 120_000,
  expect: { timeout: 20_000 },
  retries: 0,
  fullyParallel: false,
  workers: process.env.E2E_WORKERS ? Number(process.env.E2E_WORKERS) : 2,
  forbidOnly: Boolean(process.env.CI),
  reporter: process.env.CI
    ? [["list"], ["html", { open: "never", outputFolder: "playwright-report" }], ["github"]]
    : [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]],
  globalSetup: "./e2e/global-setup.ts",
  use: {
    baseURL,
    ...(channel ? { channel } : {}),
    navigationTimeout: 90_000,
    actionTimeout: 20_000,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    // Animations are collapsed so axe measures settled colours, not frames
    // of a fade-in (the product honours prefers-reduced-motion everywhere).
    reducedMotion: "reduce",
    locale: "en-IN",
    timezoneId: "Asia/Kolkata",
  },
  // One output directory per project: a run cleans only the directories of
  // the projects it runs, so `--project=perf` and `--project=a11y` can run
  // side by side without deleting each other's traces.
  projects: [
    { name: "a11y", testMatch: /(^|[\\/])a11y\.spec\.ts$/, outputDir: "./test-results/a11y" },
    { name: "keyboard", testMatch: /keyboard-journey\.spec\.ts$/, outputDir: "./test-results/keyboard" },
    // Throttled workspace timings (CPU 4×, 3 Mbps / 150 ms). Budgets are
    // enforced against a production build: see the spec's header.
    { name: "perf", testMatch: /perf-workspace\.spec\.ts$/, outputDir: "./test-results/perf" },
    // Phase 4: RBAC redirects, AdminScope, the /super strip, read-only
    // impersonation and the import route's refusals. No judge needed.
    { name: "rbac", testMatch: /(^|[\\/])rbac\.spec\.ts$/, outputDir: "./test-results/rbac" },
    // Phase 4: the authoring journey (the Phase 4 manual check). Needs a live judge
    // (E2E_JUDGE=1; skipped otherwise). One serial test of up to 20 minutes.
    {
      name: "authoring",
      testMatch: /authoring-journey\.spec\.ts$/,
      outputDir: "./test-results/authoring",
      fullyParallel: false,
      timeout: 20 * 60_000,
    },
    // Phase 4: the public /judge page and the workspace footer link into it.
    { name: "judge", testMatch: /judge-page\.spec\.ts$/, outputDir: "./test-results/judge" },
    // Phase 5: authoring a contest, entering it, and the arena's hard block
    // below 768 px. No judge needed — nothing here submits.
    {
      name: "contest",
      testMatch: /contest-journey\.spec\.ts$/,
      outputDir: "./test-results/contest",
      fullyParallel: false,
    },
  ],
});
