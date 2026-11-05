import { describe, expect, it, vi } from "vitest";

/**
 * The version floor's form, rendered (Phase 14f).
 *
 * This control is the emergency lever AND the lever that locks a hall out
 * of its exam, so the things worth pinning are not cosmetic: that it shows
 * the floor currently in force, that it says what raising it does before
 * somebody raises it, and that clearing it is one obvious action rather
 * than a field a person has to remember to blank while a hall waits.
 *
 * Rendered rather than driven: the server action behind it is covered by
 * the capability matrix, and what is being checked here is what a
 * super-admin reads on the screen.
 */

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => undefined }) }));
vi.mock("@/server/actions/super-settings", () => ({ setExamBrowserVersionFloor: vi.fn() }));

const React = await import("react");
// apps/web/vitest.config.ts compiles .tsx with the classic JSX runtime
// (React.createElement), which expects a `React` in scope.
(globalThis as { React?: unknown }).React = React;
const { createElement } = React;
const { renderToStaticMarkup } = await import("react-dom/server");
const { ExamBrowserFloorForm } = await import("@/components/super/exam-browser-floor-form");

const render = (current: string | null) =>
  renderToStaticMarkup(createElement(ExamBrowserFloorForm, { current }));

describe("with no floor set", () => {
  const html = () => render(null);

  it("says every version is accepted, rather than leaving it blank", () => {
    expect(html()).toContain("No floor: any version is accepted");
  });

  it("offers no Clear button, because there is nothing to clear", () => {
    expect(html()).not.toContain("Clear the floor");
  });

  it("starts with an empty field", () => {
    expect(html()).toMatch(/id="exam-browser-floor"[^>]*value=""/);
  });
});

describe("with a floor in force", () => {
  const html = () => render("1.4.2");

  it("shows the floor that is actually being applied", () => {
    expect(html()).toContain("Floor 1.4.2");
  });

  it("fills the field with it, so a person edits rather than retypes", () => {
    /**
     * The opposite of the SEB keys beside it, which start empty because
     * they are secrets and printing one back invites a half-edit. A version
     * number is not a secret -- it is on the public page -- and a floor
     * somebody has to retype from memory is a floor that gets mistyped.
     */
    expect(html()).toMatch(/id="exam-browser-floor"[^>]*value="1\.4\.2"/);
  });

  it("offers one obvious way to clear it", () => {
    expect(html()).toContain("Clear the floor");
  });
});

describe("what it says before anybody presses the button", () => {
  it("states the consequence, in the second person, next to the control", () => {
    const html = render("1.4.2");
    expect(html).toContain("refuses every candidate whose installed copy is older");
    // The part that is easy to leave out and expensive to discover.
    expect(html).toContain("including candidates part-way through a paper");
    expect(html).toContain("cannot sit");
  });

  it("says what a version looks like, so nobody guesses", () => {
    expect(render(null)).toContain("Three numbers, like 1.2.0");
  });

  /**
   * There was a test here asserting the rendered markup contains none of
   * the five phrases `tests/repo/forbidden-words.test.ts` bans. Writing it
   * required writing the five phrases, and that scan reads every text file
   * in the repository — so the test failed the gate on its own source.
   *
   * It is left out rather than exempted, because it was not buying
   * anything: this component builds its text from literals in its own
   * file, and that file is already inside the scan. A phrase assembled at
   * render time was a case I invented and none exists.
   */
});
