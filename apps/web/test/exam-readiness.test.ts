import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { ATTEMPT_REVOKE_MESSAGES, DEVICE_BOUND_PROCTOR_MODES } from "@recx/shared";

/**
 * The minute before a paper, and the minute after it (Phase 12t).
 *
 * Three of the five defects the exam journey found are in these two
 * moments, and none of them is a crash: each is a screen that told a
 * candidate something untrue, or made them do something pointless, at the
 * two times in the product where a person is least able to absorb it.
 *
 * They are asserted against the source because all three live in
 * rendering a unit test cannot reach, and because each is a decision
 * somebody could undo without noticing what it cost. `e2e/exam-journey`
 * drives the behaviour; this is the line that notices if it is quietly
 * reverted between live runs.
 */

const WEB = path.resolve(__dirname, "..");
const read = (rel: string) => readFileSync(path.join(WEB, rel), "utf8");
const READINESS_PAGE = () => read("src/app/(exam)/assessments/[slug]/readiness/page.tsx");

describe("the readiness page", () => {
  it("asks the device step for a device only on a paper that is bound to one", () => {
    /**
     * It used to find that out when the candidate pressed "Check my
     * device" — so on a paper needing no device, every candidate read that
     * their assessment was bound to a machine their department had
     * enrolled (it was not) and Start stayed disabled until they pressed a
     * button about it. The journey could not get past it.
     */
    expect(READINESS_PAGE()).toContain("needsDevice={requiresDeviceAssertion(assessment.proctorMode)}");
    const check = read("src/components/exam/device-check.tsx");
    // Not required: it says so from the first render, with no round trip
    // and no WebAuthn prompt.
    expect(check).toContain('useState<"idle" | "busy" | "verified" | "not_required">(');
    expect(check).toContain('required ? "idle" : "not_required"');
    // And it reports it ONCE. The parent passes an inline arrow whose state
    // update makes a new object every time, so an unguarded effect would
    // call it again on the render it caused, for ever.
    expect(check).toContain("reported.current");
    // The modes that genuinely need one are still the spec's two.
    expect([...DEVICE_BOUND_PROCTOR_MODES].sort()).toEqual(["LAB_SUPERVISED", "REMOTE_MONITORED"]);
  });

  it("answers a candidate who has already finished, instead of offering them the form", () => {
    const page = READINESS_PAGE();
    // The question is asked on the page rather than only by the start
    // route, so the answer arrives before four checks and a consent box.
    expect(page).toContain("isFinished(latest.status as AttemptStatus)");
    expect(page).toContain("spent >= assessment.maxAttempts");
    /**
     * And the form is not rendered at all in that case. Matched as "the
     * `over` branch comes before `<ReadinessCheck`" rather than as the
     * exact opening of the expression: Phase 12y.8 put the Safe Exam
     * Browser panel in front of both, so `{over ?` became `: over ?`, and
     * a test that pinned the punctuation failed on a change that moved
     * nothing it was about.
     */
    expect(page).toContain("over ?");
    expect(page.indexOf("over ?")).toBeLessThan(page.indexOf("<ReadinessCheck"));
    expect(page).toContain("<ReadinessCheck");
  });
});

describe("the sentence at the end of a sitting", () => {
  it("confirms a hand-in rather than reporting it as already done", () => {
    /**
     * `ATTEMPT_REVOKE_MESSAGES.submitted` is the right answer to a REQUEST
     * arriving against a finished sitting. It was also what the candidate
     * who had just pressed Submit read — and "already" reads as though
     * something had gone wrong, at the one moment they most need to be
     * told plainly that they are done.
     */
    expect(ATTEMPT_REVOKE_MESSAGES.submitted).toMatch(/already been submitted/);
    const bar = read("src/components/exam/exam-bottom-bar.tsx");
    expect(bar).toContain("const message = handedIn");
    expect(bar).toContain("Handed in. Your answers are saved");
    // Set only on the success path, so a 409 — this sitting was finished
    // somewhere else — still reads as the refusal it is.
    const session = read("src/components/exam/exam-session.tsx");
    expect(session).toContain("setHandedIn(true);");
    const before409 = session.slice(0, session.indexOf("setHandedIn(true);"));
    expect(before409).toContain("if (response.status === 409)");
    expect(before409.slice(before409.indexOf("if (response.status === 409)"))).not.toContain("setHandedIn");
  });
});
/**
 * The fullscreen step and REC Exam Browser (Phase 15e).
 *
 * The rendering is tested next door. These are the two lines that carry
 * the decision, asserted against the source because each could be undone
 * by somebody who did not know what it cost: a `KIOSK_RECX` paper that
 * could not be started from the browser it must be sat in.
 */
describe("the fullscreen step inside REC Exam Browser", () => {
  it("is told, by the page that already knows", () => {
    // The page computes `inRecxBrowser` from the sitting header for its
    // own refusal screen; this is the same fact, passed down rather than
    // guessed at in the client.
    expect(READINESS_PAGE()).toContain("fullscreenHeld={inRecxBrowser}");
  });

  it("starts the step met rather than leaving it unreachable", () => {
    const check = read("src/components/exam/readiness-check.tsx");
    expect(check).toContain("fullscreen: fullscreenHeld,");
    // And the button is not rendered at all in that case, rather than
    // rendered and inert.
    expect(check).toContain("{fullscreenHeld ? (");
  });

  it("never lets the test hang silently where it IS offered", () => {
    /**
     * A refused fullscreen request does not always reject: where the
     * embedder denies the permission, Chromium leaves the promise
     * pending. Without the race, the button did nothing and said nothing
     * — the worst of the three possible outcomes, because the candidate
     * cannot tell waiting from broken.
     */
    const check = read("src/components/exam/readiness-check.tsx");
    expect(check).toContain("FULLSCREEN_TIMEOUT_MS");
    expect(check).toContain("Promise.race");
  });
});
