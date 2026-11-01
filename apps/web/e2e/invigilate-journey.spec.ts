import { expect, test } from "@playwright/test";
import { contextAs } from "./support/session";
import { openPage } from "./support/page";
import { authorPaper, istInput, walkReadinessChecks } from "./support/exam-paper";

/**
 * Phase 12v: the other person in the room.
 *
 * The invigilator's desk has existed since Phase 6e — a hall roster with
 * presence and clocks, and four controls beside each candidate: message
 * them, grant extra time, record what you saw, and end the sitting with a
 * colleague's confirmation. Nothing had ever driven it, for a mechanical
 * reason that turned out to be a defect of its own: until Phase 12s.2
 * nothing wrote `AssessmentAttempt.examSessionId`, so the roster read
 * `where: { examSessionId }` and every hall page showed an empty room.
 * There was nobody to act on.
 *
 * Now there is, and this is the journey across BOTH sides at once — the
 * thing no unit test can be: a staff member acts at the desk and the
 * candidate's own page reacts, in another browser context, over the
 * heartbeat.
 *
 *   a hall is scheduled → a candidate starts a sitting and appears on the
 *   roster → the invigilator messages them and the message appears over
 *   their paper, which they must acknowledge → extra time is granted and
 *   their clock grows → an observation is recorded → termination is asked
 *   for, refused to the same person, confirmed by a second staff member,
 *   and the candidate's sitting ends with the invigilator's reason on
 *   screen.
 *
 * NOT in any gate: it needs a live stack. `--project=invigilate`.
 */

const runId = Math.random().toString(36).slice(2, 8);
const HALL = `Lab ${runId}`;
const ROOM = "Block C";
const MESSAGE = `Please raise your hand. (${runId})`;
const TIME_REASON = `Power cut in the hall for eight minutes, round ${runId}.`;
const OBSERVATION = `Candidate asked for a replacement keyboard, round ${runId}.`;
const TERMINATION = `Second device found on the desk, round ${runId}.`;

test.describe.configure({ mode: "serial" });

test.describe("invigilator journey", () => {
  test("seat a candidate, message them, grant time, record, and end it with two people", async ({
    browser,
  }) => {
    test.setTimeout(14 * 60_000);

    // ── 1. A paper, and a hall to sit it in ──
    const staffContext = await contextAs(browser, "admin");
    const admin = await staffContext.newPage();
    const paper = await authorPaper(admin, { runId, codingQuestion: false });

    // The hall is scheduled from the assessment's own page, which is where
    // the author already is.
    await admin.getByRole("textbox", { name: "Label" }).fill(HALL);
    await admin.getByRole("textbox", { name: "Room (optional)" }).fill(ROOM);
    await admin
      .getByRole("textbox", { name: "Opens", exact: true })
      .last()
      .fill(istInput(new Date(Date.now() - 5 * 60_000)));
    await admin
      .getByRole("textbox", { name: "Closes", exact: true })
      .last()
      .fill(istInput(new Date(Date.now() + 4 * 60 * 60_000)));
    await admin.getByRole("button", { name: "Schedule the hall" }).click();
    await expect(admin.getByText(HALL).first()).toBeVisible({ timeout: 60_000 });

    // ── 2. A candidate sits it ──
    const candidateContext = await contextAs(browser, "journey", {
      permissions: ["clipboard-read", "clipboard-write"],
    });
    const candidate = await candidateContext.newPage();
    await openPage(candidate, `/assessments/${paper.slug}/readiness`);
    await walkReadinessChecks(candidate);
    await candidate.getByRole("button", { name: "Start the assessment" }).click();
    await expect(candidate).toHaveURL(new RegExp(`/assessments/${paper.slug}/attempt$`), {
      timeout: 120_000,
    });
    await expect(candidate.getByText(/Question 1 of 1/).first()).toBeVisible({ timeout: 60_000 });

    // ── 3. They appear in the hall ──
    /**
     * The roster reads `where: { examSessionId }`, and nothing wrote that
     * column before 12s.2 — so this assertion is the one that would have
     * failed, silently, for every hall ever scheduled.
     */
    await openPage(admin, "/admin/invigilate");
    const hallRow = admin.locator("li").filter({ hasText: HALL });
    await expect(hallRow).toBeVisible({ timeout: 60_000 });
    await expect(hallRow.getByText("1 candidate")).toBeVisible();
    await hallRow.getByRole("link", { name: "Open" }).click();
    await expect(admin.getByRole("heading", { name: new RegExp(HALL) })).toBeVisible({ timeout: 60_000 });
    await expect(admin.getByText(/1\s*Sitting/).first()).toBeVisible();

    // ── 4. A message, which the candidate must acknowledge ──
    await admin.getByRole("button", { name: "Message" }).first().click();
    await admin.getByRole("textbox", { name: "What to say" }).fill(MESSAGE);
    await admin.getByRole("button", { name: "Send", exact: true }).click();
    await expect(admin.getByText("Message sent.")).toBeVisible({ timeout: 60_000 });

    /**
     * And it ARRIVES. For five phases the heartbeat answered with a
     * hard-coded empty list, so "Message sent." was a message nobody
     * received (12v). It comes over the beat, so the wait is the beat
     * interval and not a click.
     */
    const dialog = candidate.getByRole("alertdialog");
    await expect(dialog).toBeVisible({ timeout: 60_000 });
    await expect(dialog.getByText("A message from your invigilator")).toBeVisible();
    await expect(dialog.getByText(MESSAGE)).toBeVisible();
    await candidate.getByRole("button", { name: "I have read this" }).click();
    await expect(dialog).toBeHidden();
    // And it stays gone: the acknowledgement is recorded, so the next beat
    // does not ask again.
    await expect(candidate.getByRole("alertdialog")).toBeHidden({ timeout: 60_000 });

    // ── 5. Extra time, which the candidate's clock shows ──
    const clockBefore = await candidate.getByText(/Time remaining:/).first().textContent();
    await admin.getByRole("button", { name: "Grant time" }).first().click();
    await admin.getByRole("spinbutton", { name: "Minutes" }).fill("15");
    await admin.getByRole("textbox", { name: "Why" }).fill(TIME_REASON);
    await admin.getByRole("button", { name: "Grant", exact: true }).click();
    await expect(admin.getByText("15 minutes granted.")).toBeVisible({ timeout: 60_000 });
    // The clock is the server's, read on the next beat — so this is the
    // candidate learning about it the only way they can.
    await expect(async () => {
      const after = await candidate.getByText(/Time remaining:/).first().textContent();
      expect(after).not.toBe(clockBefore);
    }).toPass({ timeout: 90_000 });

    // ── 6. An observation, which the candidate never sees ──
    await admin.getByRole("button", { name: "Record what you saw" }).first().click();
    await admin.getByRole("textbox", { name: "Why" }).fill(OBSERVATION);
    await admin.getByRole("button", { name: "Record", exact: true }).click();
    await expect(admin.getByText("Observation recorded.")).toBeVisible({ timeout: 60_000 });
    // It is context for a reviewer, and the dialog says the candidate never
    // sees it. So they do not.
    await expect(candidate.getByText(OBSERVATION)).toHaveCount(0);

    // ── 7. Ending a sitting takes two people ──
    await admin.getByRole("button", { name: "Terminate" }).first().click();
    await admin.getByRole("textbox", { name: "Why" }).fill(TERMINATION);
    await admin.getByRole("button", { name: "Record", exact: true }).click();
    await expect(admin.getByText(/second staff member must confirm/i)).toBeVisible({ timeout: 60_000 });
    // Still sitting: asking is not ending.
    await expect(candidate.getByText(/invigilator has ended this sitting/i)).toHaveCount(0);

    // The same person cannot be the second person.
    await admin.reload();
    await admin.getByRole("button", { name: "Confirm termination" }).first().click();
    await admin.getByRole("textbox", { name: "Why" }).fill(`Confirming my own request, round ${runId}.`);
    await admin.getByRole("button", { name: "Record", exact: true }).click();
    await expect(admin.getByRole("alert")).toBeVisible({ timeout: 60_000 });
    await expect(candidate.getByText(/invigilator has ended this sitting/i)).toHaveCount(0);

    // A colleague confirms, and the sitting ends.
    const secondContext = await contextAs(browser, "staffAdmin");
    const second = await secondContext.newPage();
    await openPage(second, admin.url().replace(/^https?:\/\/[^/]+/, ""));
    await second.getByRole("button", { name: "Confirm termination" }).first().click();
    await second.getByRole("textbox", { name: "Why" }).fill(`Seen it too, round ${runId}.`);
    await second.getByRole("button", { name: "Record", exact: true }).click();
    await expect(second.getByText("Sitting ended.")).toBeVisible({ timeout: 60_000 });

    /**
     * The candidate's own screen, on the next beat: the sitting is over and
     * the message names who ended it. It does NOT say their result is void,
     * because it is not — the work stands and a human decides what it
     * means (SPEC §5, and the dialog the invigilator read says so too).
     */
    await expect(candidate.getByText(/An invigilator has ended this sitting/i)).toBeVisible({
      timeout: 90_000,
    });
    await expect(candidate.getByText(/void/i)).toHaveCount(0);
  });
});
