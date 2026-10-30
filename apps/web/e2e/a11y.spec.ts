import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { ACCOUNTS, type AccountKey } from "./support/accounts";
import { appliedTheme, openPage, presetTheme, settle, type Theme, waitForEditor } from "./support/page";

/**
 * The axe gate (docs/ACCESSIBILITY.md §6): ZERO serious or critical
 * violations of WCAG 2.0 / 2.1 / 2.2 A and AA rules on the gated pages, in the
 * light and the dark theme, at 1366 × 768 and at a 375 × 812 phone viewport.
 * A second set of pages is scanned the same way and REPORTED (annotation,
 * attachment, console line) without gating. The coding workspace is also
 * scanned with its console open (wide) and on its Code and Result tabs
 * (narrow), so the editor and the results region are covered too.
 *
 * No axe rule is disabled.
 *
 * One region is excluded from every scan, with this justification:
 *   `nextjs-portal` — the Next.js development overlay / dev-tools indicator.
 *   `next dev` injects it into every page; it is not part of REC Code and is
 *   never shipped (a production build has no such element). Scanning it
 *   would gate the product on Next.js's own development UI.
 */

const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
const EXCLUDE = ["nextjs-portal"];
const GATING_IMPACTS = new Set(["serious", "critical"]);

interface Viewport {
  name: "desktop" | "mobile";
  width: number;
  height: number;
  mobile: boolean;
}

const VIEWPORTS: readonly Viewport[] = [
  { name: "desktop", width: 1366, height: 768, mobile: false },
  { name: "mobile", width: 375, height: 812, mobile: true },
];
const THEMES: readonly Theme[] = ["light", "dark"];

interface Target {
  path: string;
  /** null = signed out. */
  as: AccountKey | null;
  gating: boolean;
  /** Extra readiness wait beyond `settle`. */
  ready?: (page: Page, viewport: Viewport) => Promise<void>;
  /**
   * Further states of the same page to scan after the initial one (each is
   * entered from the previous state). Every state is gated like the first.
   */
  states?: (viewport: Viewport) => readonly State[];
}

interface State {
  name: string;
  enter: (page: Page) => Promise<void>;
}

/** The coding workspace: the console drawer (wide) and the Code / Result tabs (narrow). */
function workspaceStates(viewport: Viewport): readonly State[] {
  if (!viewport.mobile) {
    return [
      {
        name: "console open",
        enter: async (page) => {
          await page.getByRole("button", { name: "Console", exact: true }).click();
          await expect(page.getByRole("heading", { name: "Console", exact: true })).toBeVisible();
        },
      },
    ];
  }
  const tab = (name: "Code" | "Result"): State => ({
    name: `${name} tab`,
    enter: async (page) => {
      // The workspace's own tabs (the console has a "Result" tab too).
      const workspaceTab = page.getByRole("tablist", { name: "Workspace" }).getByRole("tab", { name, exact: true });
      await workspaceTab.click();
      await expect(workspaceTab).toHaveAttribute("aria-selected", "true");
      if (name === "Code") await expect(page.locator('[data-editor-root][data-editor="codemirror"]')).toBeVisible();
    },
  });
  return [tab("Code"), tab("Result")];
}

const TARGETS: readonly Target[] = [
  { path: "/login", as: null, gating: true },
  // Phase 11a: the two pages a student reaches when they cannot sign in —
  // which is exactly when an accessibility failure is unrecoverable, since
  // there is no other way in.
  { path: "/forgot-password", as: null, gating: true },
  { path: "/reset-password?token=not-a-real-token", as: null, gating: true },
  { path: "/dashboard", as: "student", gating: true },
  { path: "/problems", as: "student", gating: true },
  {
    path: "/problems/two-sum",
    as: "student",
    gating: true,
    // Scan the real editor (Monaco >= 768 px, CodeMirror below), not the
    // plain textarea it replaces. On a phone it sits in the (initially
    // hidden) Code tab, so it is waited for in the DOM, then shown.
    ready: (page, viewport) => waitForEditor(page, viewport.mobile ? "codemirror" : "monaco"),
    states: workspaceStates,
  },
  { path: "/leaderboard", as: "student", gating: true },
  /**
   * Phase 7, GATING. The aptitude surface is the one the largest number of
   * students will ever use — SPEC §5 opens the phase by saying so — and a
   * sizeable number of them use it on a phone, which is why the hub and
   * topic practice are scanned at 375px as well as at 1366px.
   *
   * The timed mock SITTING is not in this list, and deliberately: it is
   * hard-blocked below 768px (SPEC §7's "do not build a serious phone-based
   * solving experience"), so a 375px scan would be scanning the block, and
   * its desktop states need a live sitting that the e2e fixture does not
   * seed. It is covered by the manual pass instead, which is recorded as a
   * Phase 7 gate item in docs/RUNBOOK.md §3.
   */
  { path: "/aptitude", as: "student", gating: true },
  { path: "/account/leave", as: "student", gating: true },
  { path: "/account/reactivate", as: "student", gating: true },
  /**
   * Phase 11f. A student whose password is already their own is redirected
   * home from here, so what axe scans is that landing — which is the right
   * thing to keep clean anyway, and the page itself is covered by the
   * exposure sweep and the database tests.
   */
  { path: "/account/new-password", as: "student", gating: true },
  /**
   * Phase 9c, GATING. The page is a grid of three cards with a progress bar
   * per component, which is exactly the shape that goes wrong for a screen
   * reader: every bar carries its own label with the denominator in it, and
   * the scan is what keeps that true.
   */
  { path: "/placement", as: "student", gating: true },
  // Reported, not gating.
  // Phase 12c. The revision queue: a list of links and a stats block, and
  // the one page whose whole job is to be opened every morning.
  { path: "/revision", as: "student", gating: false },
  { path: "/sheets", as: "student", gating: false },
  { path: "/learn", as: "student", gating: false },
  { path: "/profile", as: "student", gating: false },
  { path: "/notes", as: "student", gating: false },
  { path: "/bookmarks", as: "student", gating: false },
  { path: "/help", as: "student", gating: false },
  // Phase 9d, reported. The two staff trees the phase adds. Scanned as the
  // SUPER_ADMIN, who holds both roles: a PLACEMENT_OFFICER and a TA_MENTOR
  // account are not in the e2e fixture, and the markup does not depend on
  // which of the admitted roles is looking.
  { path: "/placement-cell", as: "admin", gating: false },
  /**
   * Phase 9e, GATING. The heatmap is the one surface in the whole product
   * whose readability depends on markup rather than on copy: fourteen
   * columns by N sections, with a count in every cell and colour as a
   * redundant encoding. A grid that lost its scope="row" headers would be
   * unreadable to a screen reader and would look identical to a sighted
   * reviewer, which is exactly the failure a scan catches and a review does
   * not.
   */
  { path: "/placement-cell/heatmap", as: "admin", gating: true },
  { path: "/placement-cell/at-risk", as: "admin", gating: false },
  { path: "/placement-cell/aptitude", as: "admin", gating: false },
  { path: "/placement-cell/drives", as: "admin", gating: false },
  { path: "/placement-cell/drives/new", as: "admin", gating: false },
  { path: "/placement-cell/export", as: "admin", gating: false },
  /**
   * `/placement-cell/students/[id]` is deliberately NOT scanned. Every view
   * of it writes an AuditLog row, so an automated scan on every run would
   * manufacture a record of somebody looking at a student that nobody looked
   * at — and the value of that log is that every row in it is real. It is
   * covered by the capability matrix (rendered as every role, guard
   * asserted) and by the manual pass recorded in docs/RUNBOOK.md §3.
   */
  { path: "/mentor", as: "admin", gating: false },
  { path: "/admin/judge", as: "admin", gating: false },
  // Public (signed out): the judge transparency page (Phase 4).
  { path: "/judge", as: null, gating: false },
  /**
   * Phase 9f, GATING, and signed out because that is how it is read. This is
   * the only page in the product whose audience has never seen the product:
   * a recruiter opens it once, on whatever device is to hand, and forms their
   * whole impression from it. An unknown code is used so the scan needs no
   * seeded export — the frame, the status block and the footer are the same
   * markup on every outcome, which is why Shell() renders all five.
   */
  { path: "/verify/aaaaaaaaaaaaaaaaaaaaaaaa", as: null, gating: true },
  // Phase 4, GATING. /admin as the scoped ADMIN RECADMIN02 (what an admin
  // really sees); /super as the SUPER_ADMIN RECADMIN01; /judge signed out.
  { path: "/admin", as: "staffAdmin", gating: true },
  { path: "/admin/students", as: "staffAdmin", gating: true },
  { path: "/admin/students/import", as: "staffAdmin", gating: true },
  { path: "/admin/cohorts", as: "staffAdmin", gating: true },
  { path: "/admin/reports", as: "staffAdmin", gating: true },
  { path: "/admin/announcements/new", as: "staffAdmin", gating: true },
  { path: "/admin/accommodations", as: "staffAdmin", gating: true },
  { path: "/admin/problems", as: "staffAdmin", gating: true },
  { path: "/admin/problems/new", as: "staffAdmin", gating: true },
  // Phase 12a. The list and the create form: the form is the one with a
  // radio group and a conditionally disabled checkbox, which is where an
  // accessibility mistake would actually land.
  { path: "/admin/assessments", as: "staffAdmin", gating: true },
  { path: "/admin/assessments/new", as: "staffAdmin", gating: true },
  { path: "/admin/judge", as: "staffAdmin", gating: true },
  { path: "/super", as: "admin", gating: true },
  { path: "/super/users", as: "admin", gating: true },
  { path: "/super/roles", as: "admin", gating: true },
  { path: "/super/settings/branding", as: "admin", gating: true },
  { path: "/super/settings/policy", as: "admin", gating: true },
  { path: "/super/settings/judge", as: "admin", gating: true },
  // Phase 12b. The AI helper's switch: a select, two numbers and a reason
  // dialog, and the one page where a wrong label would hide what turning it
  // on actually does.
  { path: "/super/settings/ai", as: "admin", gating: true },
  { path: "/super/audit", as: "admin", gating: true },
  { path: "/super/impersonate", as: "admin", gating: true },
  { path: "/super/flags", as: "admin", gating: true },
  { path: "/super/jobs", as: "admin", gating: true },
  { path: "/super/data", as: "admin", gating: true },
  { path: "/judge", as: null, gating: true },
];

interface Finding {
  state: string;
  id: string;
  impact: string;
  help: string;
  nodes: number;
  targets: string[];
  /** The first few nodes: markup and axe's explanation (for fixing). */
  details: { html: string; summary: string }[];
}

type Violations = Awaited<ReturnType<AxeBuilder["analyze"]>>["violations"];

function summarise(state: string, violations: Violations): Finding[] {
  return violations.map((v) => ({
    state,
    id: v.id,
    impact: v.impact ?? "unknown",
    help: v.help,
    nodes: v.nodes.length,
    targets: v.nodes.slice(0, 6).map((n) => n.target.map(String).join(" ")),
    details: v.nodes.slice(0, 3).map((n) => ({
      html: n.html.slice(0, 240),
      summary: (n.failureSummary ?? "").replace(/\s+/g, " ").slice(0, 400),
    })),
  }));
}

function describeFindings(findings: readonly Finding[]): string {
  if (findings.length === 0) return "none";
  return findings.map((f) => `${f.impact}:${f.id}x${f.nodes}${f.state === "initial" ? "" : ` (${f.state})`}`).join(", ");
}

async function record(testInfo: TestInfo, label: string, findings: Finding[], url: string) {
  const body = JSON.stringify({ label, url, violations: findings }, null, 2);
  await testInfo.attach("axe-violations.json", { body, contentType: "application/json" });
  testInfo.annotations.push({ type: "axe", description: `${label}: ${describeFindings(findings)}` });
  console.log(`[axe] ${label} -> ${describeFindings(findings)}`);
  if (findings.length > 0 && process.env.E2E_AXE_DETAILS === "1") console.log(body);
}

async function scan(page: Page, state: string): Promise<Finding[]> {
  const results = await new AxeBuilder({ page }).withTags(TAGS).exclude(EXCLUDE).analyze();
  return summarise(state, results.violations);
}

for (const target of TARGETS) {
  test.describe(`${target.gating ? "gate" : "report"} ${target.path}`, () => {
    for (const viewport of VIEWPORTS) {
      for (const theme of THEMES) {
        test.describe(`${viewport.name} ${theme}`, () => {
          test.use({
            viewport: { width: viewport.width, height: viewport.height },
            isMobile: viewport.mobile,
            hasTouch: viewport.mobile,
            colorScheme: theme,
            storageState: target.as ? ACCOUNTS[target.as].storageState : { cookies: [], origins: [] },
          });

          test(`axe ${target.path} [${viewport.name}, ${theme}]`, async ({ page }, testInfo) => {
            const label = `${target.path} [${viewport.name} ${viewport.width}x${viewport.height}, ${theme}]`;
            await presetTheme(page, theme);
            const response = await openPage(page, target.path);
            expect(response?.status(), `${target.path} should load`).toBeLessThan(400);
            // A guarded page that bounced to /login would scan the wrong page.
            if (target.as) expect(new URL(page.url()).pathname).not.toBe("/login");
            await settle(page);
            if (target.ready) await target.ready(page, viewport);
            expect(await appliedTheme(page), "the stored theme is applied").toBe(theme);

            const findings = await scan(page, "initial");
            for (const state of target.states?.(viewport) ?? []) {
              await state.enter(page);
              await settle(page);
              findings.push(...(await scan(page, state.name)));
            }
            await record(testInfo, label, findings, page.url());

            if (target.gating) {
              const blocking = findings.filter((f) => GATING_IMPACTS.has(f.impact));
              expect(blocking, `serious/critical axe violations on ${label}:
${JSON.stringify(blocking, null, 2)}`).toEqual(
                [],
              );
            }
          });
        });
      }
    }
  });
}
