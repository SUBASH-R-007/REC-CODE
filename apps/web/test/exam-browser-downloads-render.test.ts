import { describe, expect, it, vi } from "vitest";

/**
 * The download switch, rendered (Phase 14i).
 *
 * What matters on this screen is not the toggle but the two sentences
 * beside it: that turning it off takes the FILE away rather than the
 * button, and whether there is a build behind the switch at all. A
 * super-admin who turns this on over an empty directory should find out
 * here, not from a candidate the morning of a paper.
 */

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => undefined }) }));
vi.mock("@/server/actions/super-settings", () => ({ setExamBrowserDownloads: vi.fn() }));

const React = await import("react");
// apps/web/vitest.config.ts compiles .tsx with the classic JSX runtime
// (React.createElement), which expects a `React` in scope.
(globalThis as { React?: unknown }).React = React;
const { createElement } = React;
const { renderToStaticMarkup } = await import("react-dom/server");
const { ExamBrowserDownloadsForm } = await import("@/components/super/exam-browser-downloads-form");
type Status = Parameters<typeof ExamBrowserDownloadsForm>[0]["status"];

const render = (enabled: boolean, status: Status) =>
  renderToStaticMarkup(createElement(ExamBrowserDownloadsForm, { enabled, status }));

const READY: Status = { kind: "ready", version: "1.0.0", builds: 2 };

describe("the switch itself", () => {
  it("says which way it is set", () => {
    expect(render(false, READY)).toContain(">Off<");
    expect(render(true, READY)).toContain(">On<");
  });

  it("offers the action that is not the current state", () => {
    expect(render(false, READY)).toContain("Hand it out");
    expect(render(false, READY)).not.toContain("Stop handing it out");
    expect(render(true, READY)).toContain("Stop handing it out");
  });

  it("says the page and the download are public, because they are", () => {
    /**
     * A super-admin turning this on is publishing an executable from the
     * college's own hostname to anybody with the link. That should be on
     * the screen, not in a document.
     */
    const html = render(false, READY);
    expect(html).toContain("public");
    expect(html).toContain("signed in");
  });
});

describe("whether there is anything behind it", () => {
  it("says what is published when there is", () => {
    const html = render(true, READY);
    expect(html).toContain("Version 1.0.0");
    expect(html).toContain("2 platforms");
  });

  it("gets the plural right for one build", () => {
    expect(render(true, { kind: "ready", version: "1.0.0", builds: 1 })).toContain("1 platform");
  });

  it("warns when no directory is configured, and names the variable", () => {
    const html = render(false, { kind: "not_configured" });
    expect(html).toContain("EXAM_BROWSER_DOWNLOAD_DIR");
    expect(html).toContain("nothing would be offered even with this on");
  });

  it("warns when the directory holds no build", () => {
    const html = render(false, { kind: "no_build" });
    expect(html).toContain("holds no build");
    expect(html).toContain("nothing would be offered even with this on");
  });

  it("warns whichever way the switch is set", () => {
    // The warning is about the disk, not about the switch: a deployment
    // with the switch already on and nothing published is the worse case
    // of the two, and the one that looks fine at a glance.
    expect(render(true, { kind: "no_build" })).toContain("holds no build");
  });
});
