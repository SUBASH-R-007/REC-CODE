import { expect, test, type Page } from "@playwright/test";
import { contextAs } from "./support/session";
import { openPage, settle } from "./support/page";

/**
 * A student says a problem is wrong, and a staff member answers it
 * (Phase 16a), watched end to end in a browser.
 *
 * The rules are covered by 13 database tests and 12 unit tests. What those
 * cannot see is the WIRING: whether the panel renders where a student would
 * look, whether the dialog's submit reaches the action, whether the staff
 * queue shows the row, and whether the hold banner appears on the problem
 * the hold was set on. Every one of those has been a real defect in this
 * repository at least once (`docs/RUNBOOK.md`, Phase 15p: a journey that had
 * silently stopped covering anything).
 *
 * Serial, one worker, and it cleans up after itself by deciding the report
 * it files and releasing the hold it sets — so a second run starts from the
 * same place as the first.
 *
 * NOT in any gate: it needs a live stack and a seeded database. Run it by
 * name, `--project=defect`.
 */

test.describe.configure({ mode: "serial" });

const SLUG = "two-sum";
/**
 * Unique per run. The spec answers and releases what it files, so a second
 * run starts from a clean state — but the DECIDED rows stay on the staff
 * queue, by design, and two rows with identical text would make every
 * locator here ambiguous. A run marker is cheaper than deleting history.
 */
const RUN = `${Date.now().toString(36)}`;
const DETAIL = `Case 3 expects 7, but 1 + 2 + 3 is 6. Checked twice on paper. [run ${RUN}]`;
const ANSWER = `You are right. Revision 2 will fix case 3. [run ${RUN}]`;

async function openWorkspace(page: Page): Promise<void> {
  await openPage(page, `/problems/${SLUG}`);
  await settle(page);
}

test.describe("a reported defect", () => {
  test("is filed by a student, answered by staff, and withholds the problem", async ({ browser }) => {
    const studentContext = await contextAs(browser, "student");
    const staffContext = await contextAs(browser, "admin");
    const student = await studentContext.newPage();
    const staff = await staffContext.newPage();

    try {
      await test.step("clear anything a previous run left open", async () => {
        /**
         * A student may hold only ONE open report per revision, so a run
         * that died between filing and answering would leave this spec
         * unable to start. Staff answering an outstanding report is also
         * the ordinary thing to do, so the clean-up is the product's own
         * flow rather than a database reach-around.
         */
        await openPage(staff, "/admin/problems");
        await staff.getByRole("link", { name: /Two Sum/i }).first().click();
        await settle(staff);
        for (let guard = 0; guard < 5; guard += 1) {
          const answer = staff.getByRole("button", { name: "Answer" }).first();
          if ((await answer.count()) === 0) break;
          await answer.click();
          const form = staff.getByRole("form", { name: "Answer a defect report" });
          await form.getByLabel("What did you decide?").selectOption("DISMISSED");
          await form.getByLabel("What the student is shown").fill("Closing a report left open by an earlier test run.");
          await form.getByRole("button", { name: "Save the answer" }).click();
          await expect(form).toHaveCount(0, { timeout: 30_000 });
          await settle(staff);
        }
        const release = staff.getByRole("button", { name: "Release it for new papers" });
        if ((await release.count()) > 0) {
          await release.click();
          const form = staff.getByRole("form", { name: "Release a withheld problem" });
          await form.getByLabel("What changed?").fill("clearing a hold left by an earlier test run");
          await form.getByRole("button", { name: "Release", exact: true }).click();
          await expect(staff.getByText("Withheld from new papers", { exact: true })).toHaveCount(0, { timeout: 30_000 });
        }
      });

      await test.step("the student finds the control under the samples", async () => {
        await openWorkspace(student);
        // Inside the description's own landmark, which is the reason it is
        // placed there: a contradiction is noticed while reading the samples.
        const description = student.getByRole("article", { name: "Problem description" });
        await expect(description.getByRole("heading", { name: "Something here looks wrong?" })).toBeVisible();
        await expect(description.getByRole("button", { name: /Report a problem with this question/ })).toBeVisible();
      });

      await test.step("and files one", async () => {
        await student.getByRole("button", { name: /Report a problem with this question/ }).click();
        const form = student.getByRole("form", { name: "Report a problem defect" });
        await expect(form).toBeVisible();
        await form.getByLabel("What looks wrong?").selectOption("WRONG_EXPECTED_OUTPUT");
        await form.getByLabel("Tell them what you saw").fill(DETAIL);
        await form.getByRole("button", { name: "Report", exact: true }).click();
        // The panel swaps to the open-report sentence, which is the only
        // thing that tells them it worked.
        await expect(student.getByText(/A staff member reads these/)).toBeVisible({ timeout: 30_000 });
      });

      let problemUrl = "";

      await test.step("staff see it on the problem, above the content", async () => {
        await openPage(staff, "/admin/problems");
        await staff.getByRole("link", { name: /Two Sum/i }).first().click();
        await settle(staff);
        problemUrl = staff.url();
        const reports = staff.getByRole("region", { name: "Reported defects" });
        await expect(reports).toBeVisible();
        await expect(reports.getByText(DETAIL)).toBeVisible();
        // Exact, because the table caption also says "1 open of 1" and the
        // badge is what tells a staff member the row is theirs to answer.
        await expect(reports.getByText("Open", { exact: true })).toBeVisible();
      });

      await test.step("a staff member upholds it and withholds the problem", async () => {
        // The newest open report is the one this run filed; decided rows
        // keep their place in the table and have no Answer button.
        await staff.getByRole("button", { name: "Answer" }).first().click();
        const form = staff.getByRole("form", { name: "Answer a defect report" });
        await form.getByLabel("What did you decide?").selectOption("UPHELD");
        await form.getByLabel("What the student is shown").fill(ANSWER);
        await form.getByRole("checkbox").check();
        await form.getByLabel("Why it is withheld").fill("case 3 expects the wrong sum");
        await form.getByRole("button", { name: "Save the answer" }).click();
        await expect(staff.getByText("Withheld from new papers", { exact: true })).toBeVisible({ timeout: 30_000 });
      });

      await test.step("the student reads the answer", async () => {
        await openWorkspace(student);
        await expect(student.getByText(ANSWER)).toBeVisible();
        await expect(student.getByText("Upheld").first()).toBeVisible();
      });

      await test.step("and the problem is released again, which is a separate decision", async () => {
        await openPage(staff, problemUrl);
        await staff.getByRole("button", { name: "Release it for new papers" }).click();
        const form = staff.getByRole("form", { name: "Release a withheld problem" });
        await form.getByLabel("What changed?").fill("revision 2 published with the corrected case");
        await form.getByRole("button", { name: "Release", exact: true }).click();
        await expect(staff.getByText("Withheld from new papers", { exact: true })).toHaveCount(0, { timeout: 30_000 });
      });
    } finally {
      await studentContext.close();
      await staffContext.close();
    }
  });
});
