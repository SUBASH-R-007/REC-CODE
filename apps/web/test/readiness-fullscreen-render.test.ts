import { describe, expect, it } from "vitest";

/**
 * The fullscreen step, inside REC Exam Browser and outside it (Phase 15e).
 *
 * This was a blocking defect rather than an untidy one. The browser
 * refuses every permission to the page (`policy.ts`, `REFUSED_PERMISSIONS`
 * — `docs/PROCTORING.md` §5 is why), and Chromium answers a refused
 * fullscreen request by leaving the promise PENDING rather than rejecting
 * it. Measured against a real Electron:
 *
 *     CASE refuses permissions    NEVER SETTLED (pending after 8s)
 *     CASE allows permissions     RESOLVED fullscreenElement=true
 *
 * So `await requestFullscreen()` never returned, `pass("fullscreen")`
 * never ran, the `catch` never ran either, and the button did nothing and
 * said nothing. `ready` is every check AND the consent box, so the Start
 * button stayed disabled for ever — on `KIOSK_RECX`, the one mode that
 * can only be sat in that browser.
 *
 * What is tested here is both halves: that the step is gone where it
 * cannot work, and that it is still a real exercise everywhere else.
 */

const React = await import("react");
// apps/web/vitest.config.ts compiles .tsx with the classic JSX runtime.
(globalThis as { React?: unknown }).React = React;
const { createElement } = React;
const { renderToStaticMarkup } = await import("react-dom/server");
const { ReadinessCheck } = await import("@/components/exam/readiness-check");

const render = (fullscreenHeld: boolean) =>
  renderToStaticMarkup(
    createElement(ReadinessCheck, {
      slug: "probe",
      durationMinutes: 60,
      questionCount: 3,
      proctorNote: null,
      needsDevice: false,
      fullscreenHeld,
    }),
  );

describe("in an ordinary browser", () => {
  const html = render(false);

  it("still offers the test, because there it proves something", () => {
    expect(html).toContain("Test full screen");
    expect(html).toContain("Full screen works on this machine");
  });

  it("does not claim the step is already done", () => {
    expect(html).not.toContain("Full screen is held by REC Exam Browser");
    // The other half of the assertion next door: an undone row renders the
    // other mark, so finding the tick there would mean nothing.
    const row = html.slice(0, html.indexOf("Pasting works"));
    expect(row).not.toContain("lucide-check");
  });
});

describe("inside REC Exam Browser", () => {
  const html = render(true);

  it("offers no button to press, because pressing it did nothing for ever", () => {
    expect(html).not.toContain("Test full screen");
  });

  it("says who is holding the screen, and that the page cannot change it", () => {
    expect(html).toContain("Full screen is held by REC Exam Browser");
    expect(html).toContain("nothing to test");
    expect(html).toContain("cannot turn that off");
  });

  it("counts the step as met, so it cannot hold the Start button", () => {
    /**
     * `ready` is `Object.values(passed).every(Boolean) && consented`, so a
     * step that can never pass is a paper that can never start. The tick
     * beside the row is how that shows on screen; the row for a step not
     * yet done renders the other mark.
     */
    const row = html.slice(0, html.indexOf("Pasting works"));
    expect(row, "the fullscreen row is rendered done").toContain("lucide-check");
  });

  it("leaves every other step a real check", () => {
    // The paper still cannot be started without them: only the one that
    // was impossible is gone.
    expect(html).toContain("Pasting works, and is recorded rather than blocked");
    expect(html).toContain("This machine can reach the exam server");
    expect(html).toContain("You can type an answer and read a question");
  });
});
