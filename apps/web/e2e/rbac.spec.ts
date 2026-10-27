import { expect, test, type Browser, type Page } from "@playwright/test";
import { ACCOUNTS, type AccountKey } from "./support/accounts";
import { contextAs, expectLandedOn, signInWithForm, signedOutContext } from "./support/session";
import { openPage, settle } from "./support/page";

/**
 * Phase 4 RBAC, end to end against the running stack (no judge needed):
 *
 *   - a student who opens any /admin/** or /super/** URL ends on /dashboard;
 *   - RECADMIN02 (ADMIN, scoped to CSE) who opens any /super/** URL ends on /admin;
 *   - RECADMIN02's /admin/students lists CSE roll numbers and no ECE roll
 *     number, and an ECE student's /admin/students/<id> is a 404;
 *   - every /super page carries the strip "Super-admin — all actions are audited";
 *   - read-only impersonation: RECADMIN01 starts one (20+ character reason)
 *     on a fresh session, the banner shows, a draft save is refused with
 *     the read-only message, it is ended, and both audit rows exist;
 *   - POST /api/admin/problems/import refuses a signed-out caller, a
 *     cross-site request and a student, before reading the body.
 *
 * RBAC is enforced server-side; this proves it at the HTTP surface. The
 * role × capability matrix (apps/web/test/capability-matrix.test.ts)
 * proves it action by action.
 */

/** Every /admin page (dynamic segments with an id that does not exist). */
const ADMIN_PATHS = [
  "/admin",
  "/admin/students",
  "/admin/students/import",
  "/admin/students/import/e2e-missing",
  "/admin/students/e2e-missing",
  "/admin/cohorts",
  "/admin/sheets",
  "/admin/sheets/new",
  "/admin/sheets/e2e-missing",
  "/admin/tracks",
  "/admin/tracks/new",
  "/admin/tracks/e2e-missing",
  "/admin/reports",
  "/admin/announcements",
  "/admin/announcements/new",
  "/admin/announcements/e2e-missing",
  "/admin/accommodations",
  "/admin/accommodations/new",
  "/admin/accommodations/e2e-missing",
  "/admin/problems",
  "/admin/problems/new",
  "/admin/problems/import",
  "/admin/problems/import/e2e-missing",
  "/admin/problems/e2e-missing",
  "/admin/problems/e2e-missing/testcases",
  "/admin/problems/e2e-missing/validate",
  "/admin/judge",
] as const;

/**
 * Every /super page. (/super/data/exports/<id> is a download route, not a
 * page: it answers 403 / 404 instead of redirecting, and is covered by
 * apps/web/test/pii-export-route.test.ts.)
 */
const SUPER_PATHS = [
  "/super",
  "/super/users",
  "/super/roles",
  "/super/settings/branding",
  "/super/settings/policy",
  "/super/settings/judge",
  "/super/settings/integrations",
  "/super/audit",
  "/super/impersonate",
  "/super/flags",
  "/super/jobs",
  "/super/data",
] as const;

const SUPER_STRIP = "Super-admin — all actions are audited";
/** apps/web/src/lib/errors.ts IMPERSONATION_READ_ONLY_MESSAGE (the UI contract). */
const READ_ONLY_MESSAGE = "You are viewing as another user (read-only). End the impersonation to make changes.";

const CSE_STUDENTS = [ACCOUNTS.student.identifier, ACCOUNTS.authoring.identifier];
const ECE_STUDENT = ACCOUNTS.ece.identifier;
/** The second seeded ECE student (apps/web/scripts/seed.ts). */
const ECE_STUDENT_2 = process.env.E2E_ECE_STUDENT_2_ID ?? "2116226002002";

/** Open each path as `key`; return the paths that did NOT end on `home`. */
async function bounces(browser: Browser, key: AccountKey, paths: readonly string[], home: string): Promise<string[]> {
  const context = await contextAs(browser, key);
  const page = await context.newPage();
  const wrong: string[] = [];
  try {
    for (const path of paths) {
      await test.step(`${ACCOUNTS[key].identifier} → ${path}`, async () => {
        await openPage(page, path, { waitUntil: "commit" });
        try {
          await expectLandedOn(page, home, 60_000);
        } catch {
          wrong.push(`${path} → ${new URL(page.url()).pathname}`);
        }
      });
    }
  } finally {
    await context.close();
  }
  return wrong;
}

/** The /admin/students/<id> link of the row showing this roll number, as a super-admin sees it. */
async function studentIdOf(page: Page, roll: string): Promise<string> {
  await openPage(page, `/admin/students?q=${encodeURIComponent(roll)}`);
  const row = page.locator("table tbody tr").filter({ hasText: roll });
  await expect(row, `the student list finds ${roll}`).toHaveCount(1);
  const href = await row.locator('a[href^="/admin/students/"]').first().getAttribute("href");
  const id = href?.split("/").pop() ?? "";
  expect(id, `the row links to the student page of ${roll}`).toMatch(/^[A-Za-z0-9_-]+$/);
  return id;
}

test.describe("a student", () => {
  test("ends on /dashboard from every /admin and /super URL", async ({ browser }) => {
    test.setTimeout(15 * 60_000);
    const wrong = [
      ...(await bounces(browser, "student", [...ADMIN_PATHS, ...SUPER_PATHS], "/dashboard")),
      // An ECE student too (another cohort, same role).
      ...(await bounces(browser, "ece", ["/admin", "/admin/students", "/admin/problems", "/super", "/super/audit"], "/dashboard")),
    ];
    expect(wrong, "pages that did not send the student to /dashboard").toEqual([]);
  });
});

test.describe("a scoped ADMIN (RECADMIN02)", () => {
  test("ends on /admin from every /super URL", async ({ browser }) => {
    test.setTimeout(10 * 60_000);
    const wrong = await bounces(browser, "staffAdmin", SUPER_PATHS, "/admin");
    expect(wrong, "/super pages that did not send RECADMIN02 to /admin").toEqual([]);
  });

  test("sees CSE students and no ECE student; an ECE student's page is a 404", async ({ browser }) => {
    test.setTimeout(5 * 60_000);
    // The ECE student exists: the super-admin (whole college) finds it.
    const superCtx = await contextAs(browser, "admin");
    const superPage = await superCtx.newPage();
    const eceId = await studentIdOf(superPage, ECE_STUDENT);
    await superCtx.close();

    const context = await contextAs(browser, "staffAdmin");
    const page = await context.newPage();
    try {
      // Unfiltered list: CSE rows only.
      const list = await openPage(page, "/admin/students");
      expect(list?.status()).toBe(200);
      expect(new URL(page.url()).pathname).toBe("/admin/students");
      await settle(page);
      const rows = page.locator("table tbody tr");
      await expect(rows.first(), "RECADMIN02 sees students").toBeVisible();
      const listed = (await rows.allInnerTexts()).join("\n");
      for (const roll of [ECE_STUDENT, ECE_STUDENT_2]) {
        expect(listed, `the scoped list must not show ECE ${roll}`).not.toContain(roll);
      }

      // Exact searches: CSE found, ECE not.
      for (const roll of CSE_STUDENTS) {
        await openPage(page, `/admin/students?q=${encodeURIComponent(roll)}`);
        await expect(page.locator("table tbody tr").filter({ hasText: roll }), `CSE ${roll} is in scope`).toHaveCount(1);
      }
      for (const query of [`q=${ECE_STUDENT}`, `q=${ECE_STUDENT_2}`, "dept=ECE"]) {
        await openPage(page, `/admin/students?${query}`);
        await settle(page);
        const text = (await page.locator("table tbody").allInnerTexts()).join("\n");
        expect(text, `/admin/students?${query} lists no ECE student`).not.toMatch(new RegExp(`${ECE_STUDENT}|${ECE_STUDENT_2}`));
      }

      // In scope: a CSE student's page renders. Out of scope: 404, exactly like a missing id.
      const cseId = await (async () => {
        await openPage(page, `/admin/students?q=${encodeURIComponent(CSE_STUDENTS[0]!)}`);
        const href = await page
          .locator("table tbody tr")
          .filter({ hasText: CSE_STUDENTS[0]! })
          .locator('a[href^="/admin/students/"]')
          .first()
          .getAttribute("href");
        return href?.split("/").pop() ?? "";
      })();
      expect(cseId, "RECADMIN02's row links to the CSE student's page").toMatch(/^[A-Za-z0-9_-]+$/);
      const inScope = await openPage(page, `/admin/students/${cseId}`);
      expect(inScope?.status(), "a CSE student's page answers 200").toBe(200);

      const outOfScope = await openPage(page, `/admin/students/${eceId}`);
      expect(outOfScope?.status(), "an ECE student's page answers 404 for RECADMIN02").toBe(404);
      await expect(page.getByText("That student was not found")).toBeVisible();
      await expect(page.getByText(ECE_STUDENT)).toHaveCount(0);
    } finally {
      await context.close();
    }
  });
});

test.describe("a super-admin", () => {
  test('sees "Super-admin — all actions are audited" on every /super page', async ({ browser }) => {
    test.setTimeout(10 * 60_000);
    for (const key of ["admin", "super2"] as const) {
      const context = await contextAs(browser, key);
      const page = await context.newPage();
      try {
        for (const path of key === "admin" ? SUPER_PATHS : (["/super"] as const)) {
          await test.step(`${ACCOUNTS[key].identifier} ${path}`, async () => {
            const response = await openPage(page, path);
            expect(response?.status(), `${path} loads`).toBe(200);
            expect(new URL(page.url()).pathname).toBe(path);
            await expect(page.getByRole("note").filter({ hasText: SUPER_STRIP })).toBeVisible();
          });
        }
      } finally {
        await context.close();
      }
    }
  });

  test("impersonation is read-only, bannered, ended and audited", async ({ browser }) => {
    test.setTimeout(5 * 60_000);
    const runId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const reason = `E2E rbac check ${runId}: confirm the read-only view and its audit rows`;
    // A NEW session for RECADMIN01: an impersonation belongs to the session
    // that started it, so the stored session other specs use is untouched.
    const context = await signedOutContext(browser);
    const page = await context.newPage();
    const banner = page.getByRole("region", { name: "Impersonation", exact: true });
    try {
      await signInWithForm(page, ACCOUNTS.admin);

      await test.step("start a read-only view of the ECE student", async () => {
        await openPage(page, `/super/impersonate?q=${encodeURIComponent(ECE_STUDENT)}`);
        await expect(page.getByRole("note").filter({ hasText: SUPER_STRIP })).toBeVisible();
        await page.getByLabel(/^Why do you need to view as /).fill(reason);
        await page.getByRole("button", { name: "Start read-only view (15 minutes)" }).click();
        await expectLandedOn(page, "/dashboard");
        await expect(banner).toBeVisible();
        await expect(banner).toContainText("read-only");
        await expect(banner).toContainText(ECE_STUDENT);
        await expect(banner.getByRole("button", { name: "End impersonation" })).toBeVisible();
      });

      await test.step("a draft save is refused with the read-only message", async () => {
        const response = await page.request.post("/api/drafts", {
          headers: { "content-type": "text/plain;charset=UTF-8" },
          data: JSON.stringify({ slug: "two-sum", language: "py312", source: "print(1)", updatedAt: Date.now() }),
          maxRedirects: 0,
        });
        expect(response.status(), "POST /api/drafts while impersonating").toBe(403);
        expect(((await response.json()) as { error?: string }).error).toBe(READ_ONLY_MESSAGE);
        // Every page still shows the banner.
        await openPage(page, "/problems");
        await expect(banner).toBeVisible();
      });

      await test.step("end it", async () => {
        await banner.getByRole("button", { name: "End impersonation" }).click();
        await expectLandedOn(page, "/super/impersonate");
        await expect(banner).toHaveCount(0);
      });

      await test.step("the start and the end are in the audit log", async () => {
        await openPage(page, `/super/audit?target=${encodeURIComponent(ECE_STUDENT)}&sensitivity=SECURITY`);
        const rows = page.locator("table tbody tr");
        const started = rows.filter({ hasText: "impersonation.started" }).filter({ hasText: runId });
        await expect(started, "one impersonation.started row carries this run's reason").toHaveCount(1);
        const sessionId = ((await started.locator("td").nth(6).locator("span").textContent()) ?? "").trim();
        expect(sessionId, "the started row names its ImpersonationSession").toMatch(/^[A-Za-z0-9_-]+$/);
        await expect(
          rows.filter({ hasText: "impersonation.ended" }).filter({ hasText: sessionId }),
          "one impersonation.ended row for the same session",
        ).toHaveCount(1);
      });
    } finally {
      // Never leave this session impersonating, even when a step failed.
      if ((await banner.count().catch(() => 0)) > 0) {
        await banner
          .getByRole("button", { name: "End impersonation" })
          .click()
          .catch(() => undefined);
        await page.waitForURL((url) => url.pathname === "/super/impersonate", { timeout: 30_000 }).catch(() => undefined);
      }
      await context.close();
    }
  });
});

test.describe("POST /api/admin/problems/import", () => {
  test("refuses a signed-out caller, a cross-site request and a student", async ({ playwright, baseURL, browser }) => {
    const zip = Buffer.from("PK\u0003\u0004 not a real archive");
    const anon = await playwright.request.newContext({ baseURL, storageState: { cookies: [], origins: [] } });
    try {
      // Cross-site (a browser would send Fetch-Metadata): refused before anything else.
      const crossSite = await anon.post("/api/admin/problems/import", {
        headers: { "content-type": "application/zip", "sec-fetch-site": "cross-site", origin: "https://elsewhere.example" },
        data: zip,
        maxRedirects: 0,
      });
      expect(crossSite.status(), "signed out + cross-site").toBe(403);
      expect(await crossSite.text()).not.toContain("importId");

      // Same origin but no session: the staff guard refuses (401 = "sign in first").
      const signedOut = await anon.post("/api/admin/problems/import", {
        headers: { "content-type": "application/zip" },
        data: zip,
        maxRedirects: 0,
      });
      expect(signedOut.status(), "signed out, same origin").toBe(401);
      expect(await signedOut.text()).not.toContain("importId");
    } finally {
      await anon.dispose();
    }

    // A signed-in student: forbidden.
    const context = await contextAs(browser, "student");
    try {
      const asStudent = await context.request.post("/api/admin/problems/import", {
        headers: { "content-type": "application/zip" },
        data: zip,
        maxRedirects: 0,
      });
      expect(asStudent.status(), "a student").toBe(403);
      expect(await asStudent.text()).not.toContain("importId");
    } finally {
      await context.close();
    }
  });
});
