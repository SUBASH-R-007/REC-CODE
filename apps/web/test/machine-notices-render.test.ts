import { describe, expect, it } from "vitest";

/**
 * The machine notices, rendered (Phase 15b).
 *
 * The arithmetic is tested next door. What is tested here is the part a
 * candidate actually meets: that a broken clock says what will happen
 * rather than naming a constant, that a warning appears before the thing
 * it warns about rather than at it, and above all that the component is
 * SILENT when there is nothing to say — because a readiness check that
 * announces something every time is one candidates learn to click past,
 * and the checks beside this one are the ones they must not.
 */

const React = await import("react");
// apps/web/vitest.config.ts compiles .tsx with the classic JSX runtime
// (React.createElement), which expects a `React` in scope.
(globalThis as { React?: unknown }).React = React;
const { createElement } = React;
const { renderToStaticMarkup } = await import("react-dom/server");
const { MachineNotices } = await import("@/components/exam/machine-notices");

type Props = Parameters<typeof MachineNotices>[0];
const render = (skew: Props["skew"], power: Props["power"] = { kind: "unknown" }) =>
  renderToStaticMarkup(createElement(MachineNotices, { skew, power }));

describe("silence", () => {
  it("renders nothing at all when the machine is fine", () => {
    expect(render({ kind: "fine", offsetMs: 300 }, { kind: "plugged_in" })).toBe("");
  });

  it("renders nothing when neither can be measured", () => {
    expect(render({ kind: "unknown" }, { kind: "unknown" })).toBe("");
  });

  it("says nothing about a healthy battery, on battery or not", () => {
    expect(render({ kind: "fine", offsetMs: 0 }, { kind: "on_battery", percent: 85 })).toBe("");
  });
});

describe("a clock that will stop the sitting", () => {
  it("says how wrong it is, in words, and what will happen", () => {
    const html = render({ kind: "broken", offsetMs: 240_000 });
    expect(html).toContain("4 minutes fast");
    expect(html, "the consequence, not the constant").toContain("will refuse to sit a paper");
    expect(html).toContain("Set the time automatically");
  });

  it("offers the invigilator as the other way out", () => {
    // A candidate on a locked-down lab image cannot change the clock.
    expect(render({ kind: "broken", offsetMs: -600_000 })).toContain("invigilator");
  });

  it("warns more gently before the limit, and says why it matters anyway", () => {
    const html = render({ kind: "drifting", offsetMs: 45_000 });
    expect(html).toContain("45 seconds fast");
    expect(html).toContain("still works");
    expect(html).toContain("partway through");
  });
});

describe("a battery that will not last the paper", () => {
  it("gives the number and the reason", () => {
    const html = render({ kind: "fine", offsetMs: 0 }, { kind: "low_battery", percent: 17 });
    expect(html).toContain("17%");
    expect(html).toContain("Plug it in");
    expect(html, "the reason it matters, said plainly").toContain("your clock keeps running");
  });
});

describe("both at once", () => {
  it("shows both, rather than hiding one behind the other", () => {
    const html = render({ kind: "broken", offsetMs: 300_000 }, { kind: "low_battery", percent: 9 });
    expect(html).toContain("5 minutes fast");
    expect(html).toContain("9%");
  });
});
