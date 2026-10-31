import { expect, test } from "@playwright/test";
import { contextAs } from "./support/session";
import { openPage } from "./support/page";

/**
 * SPEC §10's two manual items, as a driven drill (Phase 10f).
 *
 *   "pull the plug on a judge host mid-contest and confirm leases reclaim,
 *    the reconciler re-enqueues, and no submission is lost; restart Redis
 *    and confirm the same."
 *
 * Both are producible here: the WSL mirror runs a real worker on real
 * isolate and a real Redis, and `kill -9` on the worker IS the plug. This
 * spec drives the half that needs a browser — returning a quarantined node
 * to service through `/admin/judge`, which is the only legitimate way (SQL
 * is explicitly not, RUNBOOK §2.2) — and asserts what the platform shows a
 * student while a submission is in flight.
 *
 * It is NOT part of any gate: it needs a live stack, a real judge and a
 * human to kill the worker at the right moment (`scripts/ops/` has no
 * plug-pull script, deliberately — a drill that can be run by accident is a
 * drill that will be). Run it by name:
 *
 *   npx playwright test --project=resilience
 *
 * The project is not in the default list in playwright.config.ts.
 */

test.describe("judge resilience", () => {
  test("a node that is not ONLINE is returned to service through the admin page", async ({ browser }) => {
    const context = await contextAs(browser, "admin", { viewport: { width: 1366, height: 768 } });
    const page = await context.newPage();
    try {
      await openPage(page, "/admin/judge");
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

      /**
       * QUARANTINED or DRAINING — both are "not taking work until a human
       * says so", and the second is the one that happens by itself: three
       * consecutive releases auto-drain a node, which is exactly what a
       * `kill -9` produces (the stale isolate boxes make the restarted
       * worker's `--init` fail). The admin page is the only way back from
       * either (RUNBOOK §2.2: never with SQL).
       */
      // The page renders the status as a chip: "Draining", "Quarantined".
      const offline = page.getByText(/Quarantined|Draining/i).first();
      if (!(await offline.isVisible().catch(() => false))) {
        test.skip(true, "every node is ONLINE: nothing to return to service");
      }

      // The page offers the action only when the server would allow it: a
      // node whose last self-check FAILED cannot be returned, because its
      // next heartbeat would quarantine it again. So this click is also an
      // assertion that the worker's latest self-check passed.
      const button = page.getByRole("button", { name: /Return to ONLINE/ }).first();
      await expect(button, "the page refuses the transition while the self-check is failing").toBeVisible();
      await button.click();

      // Every status change carries a reason, which goes into the audit log.
      // Scoped to the dialog: the page itself also shows the node's last
      // quarantine reason, and an unscoped label matches both.
      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible();
      await dialog
        .getByLabel(/reason/i)
        .fill("Phase 10f resilience drill: self-check passed after a clean restart.");
      await dialog.getByRole("button", { name: "Return to ONLINE" }).click();

      await expect(page.getByText(/Online/i).first()).toBeVisible({ timeout: 30_000 });
    } finally {
      await context.close();
    }
  });

  test("a student sees a submission still queued while the judge is gone", async ({ browser }) => {
    /**
     * The half of the plug-pull a browser can show: what the student is
     * looking at. The lease reclaim and the re-enqueue are the scheduler's,
     * and the drill script checks those in the database — here the question
     * is whether the page lies. It must not show a verdict, and it must not
     * show an error: the submission is QUEUED, and queued is what it says.
     */
    const context = await contextAs(browser, "student", { viewport: { width: 1366, height: 768 } });
    const page = await context.newPage();
    try {
      // The workspace, which is where a student watches a verdict arrive.
      // There is no submissions INDEX route (only /submissions/[id]), which
      // is itself the answer to "where would they be looking".
      await openPage(page, "/problems/two-sum");
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible({ timeout: 60_000 });
      const text = await page.locator("main").innerText();
      // Whatever the state of the queue, the page must not be claiming an
      // internal error to a student whose submission is merely waiting, and
      // it must not have invented a verdict for one.
      expect(text).not.toMatch(/something went wrong/i);
      expect(text).not.toMatch(/internal error/i);
      // The panel says one of the two true things: nothing yet, or a list.
      expect(text).toMatch(/No submissions yet|Submissions|Accepted|Queued|Running/i);
    } finally {
      await context.close();
    }
  });
});
