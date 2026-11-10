import { expect, test, type Page } from "@playwright/test";
import { AI_ASK_LABEL } from "@recx/shared";
import { ACCOUNTS } from "./support/accounts";
import { expectNoGatingViolations, record, scan } from "./support/axe";
import { openPage, settle, waitForEditor } from "./support/page";

/**
 * The student assistant panel, scanned (Phase 16m, `docs/ROADMAP.md` §3.6).
 *
 * The a11y sweep is 260 scans over 65 pages with `none` on every one, and
 * §3.6 names exactly one genuinely unscanned surface: the AI assistant
 * panel, which renders only where the helper is switched ON and a model and
 * key are configured on the server. This deployment's is off, so no sweep
 * has ever drawn it.
 *
 * Its own flag, like `E2E_JUDGE=1`, because it needs three things no other
 * spec needs: a super-admin to turn the helper on for the duration, a model
 * configured, and `AI_API_KEY` on the server. Without `E2E_AI=1` it skips
 * and annotates.
 *
 * **With the flag it FAILS rather than skips** when the tab is absent, which
 * §3.6 asks for in as many words: the panel not rendering is the thing most
 * likely to go wrong, and a spec that quietly passed because it could not
 * find its target would be worse than no spec.
 *
 * It switches the helper back off in a `finally`, including when the scan
 * fails. A run that left it on would change what every later spec sees, and
 * would leave a deployment setting altered by a test — which is the kind of
 * thing nobody looks for.
 *
 * The student is `journey`, which has already solved problems in this suite:
 * asking marks a FIRST solve assisted, and that account's first solve of
 * this problem is behind it. The `student` account reads only, by design
 * (`e2e/support/accounts.ts`), so it is not the one to ask with.
 */
const AI = process.env.E2E_AI === "1";

/** The problem the panel is opened on; the assistant answers on practice only. */
const SLUG = process.env.E2E_AI_SLUG ?? "two-sum";

/**
 * Set the helper on or off through the real form: a select that reads back
 * as a sentence, a Save, and an audited reason. Phase 15g made it a select
 * rather than a toggle precisely because turning it on is not a small act,
 * so a spec that called the server action directly would prove the panel
 * renders and nothing about whether a super-admin can get it there.
 */
async function setHelper(page: Page, to: "on" | "off"): Promise<void> {
  await openPage(page, "/super/settings/ai");
  await settle(page);

  const choice = page.getByLabel("The assistant");
  await expect(choice, "/super/settings/ai has no 'The assistant' control — the page changed shape").toBeVisible();
  await choice.selectOption(to);
  await page.getByRole("button", { name: "Save", exact: true }).first().click();

  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("Save the assistant's settings");
  // At least ten characters, and it is recorded in the audit log with a
  // name — so it says what actually happened.
  await dialog
    .getByRole("textbox")
    .fill(`Phase 16m: the accessibility sweep needs the assistant panel rendered; switching it ${to}`);
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await settle(page);

  // Read it back from the control, not from a toast: the next step depends
  // on the SAVED state, and a toast says only that a request was sent.
  await expect(page.getByLabel("The assistant")).toHaveValue(to);
}

test.describe("the student assistant panel, scanned", () => {
  test.skip(!AI, "needs the assistant switched on, a model, and a key on the server (E2E_AI=1)");
  test.describe.configure({ mode: "serial" });

  test("renders, and has no serious or critical axe violation", async ({ browser }, testInfo) => {
    // Two contexts: the student's session never carries super-admin rights.
    const staff = await browser.newContext({ storageState: ACCOUNTS.admin.storageState });
    const superPage = await staff.newPage();

    let turnedOn = false;
    try {
      await setHelper(superPage, "on");
      turnedOn = true;

      const studentContext = await browser.newContext({ storageState: ACCOUNTS.journey.storageState });
      const page = await studentContext.newPage();
      try {
        await openPage(page, `/problems/${SLUG}`);
        await waitForEditor(page, "monaco");
        await settle(page);

        const tab = page.getByRole("tab", { name: "Assistant" });
        await expect(
          tab,
          "the Assistant tab is absent with the helper switched on and E2E_AI=1 — this is the failure §3.6 asked for, not a skip",
        ).toBeVisible({ timeout: 30_000 });

        await tab.click();
        await settle(page);

        /**
         * Idle: the heading, the two sentences that say what a student is
         * agreeing to, the allowance line and the two ask buttons. This is
         * what a student meets first and the state a sweep would have drawn
         * if the helper had ever been on.
         */
        await expect(page.getByRole("button", { name: AI_ASK_LABEL.APPROACH })).toBeVisible();
        const idle = await scan(page, "assistant panel, idle");
        await record(testInfo, "assistant panel, idle", idle, page.url());
        expectNoGatingViolations(idle, "the assistant panel (idle)");

        /**
         * And with an answer on screen, which is the part with the longest
         * text and the live region. "How should I approach this?" needs no
         * draft in the editor to be answerable; what is scanned is the
         * markup, not the answer.
         */
        const ask = page.getByRole("button", { name: AI_ASK_LABEL.APPROACH });
        await ask.click();
        // Where this would be the student's FIRST solve, asking is confirmed
        // first. Where it would not, there is no dialog and nothing to do.
        const confirm = page.getByRole("dialog").filter({ hasText: "Ask the assistant?" });
        if (await confirm.isVisible().catch(() => false)) {
          await confirm.getByRole("button", { name: AI_ASK_LABEL.APPROACH }).click();
        }

        /**
         * The provider may be slow, may refuse, or may be rate-limited, and
         * every one of those renders a state. Waiting for the BUTTON to come
         * back from its loading state is what says "the panel has settled",
         * whichever state it settled into — and a scan of a spinner would
         * tell nobody anything.
         */
        await expect(ask).toBeEnabled({ timeout: 90_000 });
        await settle(page);
        const answered = await scan(page, "assistant panel, after asking");
        await record(testInfo, "assistant panel, after asking", answered, page.url());
        expectNoGatingViolations(answered, "the assistant panel (after asking)");
      } finally {
        await studentContext.close();
      }
    } finally {
      /**
       * Always, including after a failed scan. A run that left the helper on
       * would change what every later spec sees and would leave a
       * deployment setting altered by a test.
       */
      if (turnedOn) {
        try {
          await setHelper(superPage, "off");
        } catch (error) {
          // Reported rather than swallowed: the operator needs to know the
          // setting may still be on.
          testInfo.annotations.push({
            type: "warning",
            description: `could not switch the assistant back off — check /super/settings/ai (${
              error instanceof Error ? error.message.split("\n")[0] : String(error)
            })`,
          });
        }
      }
      await staff.close();
    }
  });
});
