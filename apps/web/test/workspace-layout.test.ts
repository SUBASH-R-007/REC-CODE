import { describe, expect, it } from "vitest";
import {
  CONTROL_PX,
  EDITOR_DEFAULT_PERCENT,
  EDITOR_MIN_PX,
  MEDIA,
  MIN_CONTROL_PX,
  STATEMENT_DEFAULT_PERCENT,
  controlPx,
  densityFor,
  editorFor,
  editorKeyHint,
  editorMinPercent,
  isFocusShortcut,
  layoutFor,
  statementMinPercent,
} from "@/components/workspace/layout";

describe("workspace breakpoints", () => {
  it("uses two panes from 1024 px and three tabs below", () => {
    expect(layoutFor(1024)).toBe("panels");
    expect(layoutFor(1366)).toBe("panels");
    expect(layoutFor(1023)).toBe("tabs");
    expect(layoutFor(768)).toBe("tabs");
    expect(layoutFor(320)).toBe("tabs");
  });

  it("uses Monaco from 768 px and CodeMirror below", () => {
    expect(editorFor(768)).toBe("monaco");
    expect(editorFor(1366)).toBe("monaco");
    expect(editorFor(767)).toBe("codemirror");
    expect(editorFor(375)).toBe("codemirror");
  });

  it("goes compact below 700 px of height — 1366 × 768 laptops land here once browser chrome is counted", () => {
    expect(densityFor(699)).toBe("compact");
    expect(densityFor(657)).toBe("compact");
    expect(densityFor(700)).toBe("comfortable");
    expect(densityFor(900)).toBe("comfortable");
  });

  it("treats unknown sizes as the roomy default (SSR)", () => {
    for (const odd of [Number.NaN, 0, -1]) {
      expect(densityFor(odd)).toBe("comfortable");
      expect(layoutFor(odd)).toBe("panels");
      expect(editorFor(odd)).toBe("monaco");
    }
  });

  it("matches the media queries the client and CSS use", () => {
    expect(MEDIA.wide).toBe("(min-width: 1024px)");
    expect(MEDIA.monaco).toBe("(min-width: 768px)");
    // max-height is inclusive: 699 px is compact, 700 px is not.
    expect(MEDIA.compact).toBe("(max-height: 699px)");
  });
});

describe("control sizes (WCAG 2.2 target size)", () => {
  it("shrinks controls 36 → 30 px in compact density and never below 30 px", () => {
    expect(CONTROL_PX).toEqual({ comfortable: 36, compact: 30 });
    expect(controlPx("comfortable")).toBe(36);
    expect(controlPx("compact")).toBe(30);
    expect(MIN_CONTROL_PX).toBe(30);
    for (const d of ["comfortable", "compact"] as const) expect(controlPx(d)).toBeGreaterThanOrEqual(24);
  });
});

describe("pane sizes", () => {
  it("defaults to statement 38 % / editor 62 %", () => {
    expect(STATEMENT_DEFAULT_PERCENT + EDITOR_DEFAULT_PERCENT).toBe(100);
    expect(STATEMENT_DEFAULT_PERCENT).toBe(38);
  });

  it("keeps the editor at least 380 px wide", () => {
    for (const width of [1024, 1280, 1366, 1920]) {
      expect((editorMinPercent(width) / 100) * width).toBeGreaterThanOrEqual(EDITOR_MIN_PX - 0.001);
    }
    expect(editorMinPercent(1366)).toBeCloseTo((380 / 1366) * 100, 5);
  });

  it("clamps the minimums to sane bounds", () => {
    expect(editorMinPercent(4000)).toBe(20);
    expect(editorMinPercent(500)).toBe(EDITOR_DEFAULT_PERCENT);
    expect(editorMinPercent(Number.NaN)).toBeCloseTo((380 / 1280) * 100, 5);
    expect(statementMinPercent(4000)).toBe(15);
    expect(statementMinPercent(600)).toBe(STATEMENT_DEFAULT_PERCENT);
  });
});

describe("keyboard", () => {
  it("states the editor's way out (WCAG 2.1.2)", () => {
    expect(editorKeyHint("monaco", false)).toBe("Esc then Tab leaves the editor · Ctrl+M toggles Tab key");
    expect(editorKeyHint("codemirror", false)).toBe("Esc then Tab leaves the editor · Ctrl+M toggles Tab key");
    expect(editorKeyHint("monaco", true)).toBe("Esc then Tab leaves the editor · Ctrl+Shift+M toggles Tab key");
    expect(editorKeyHint("codemirror", true)).toBe("Esc then Tab leaves the editor · Alt+Shift+M toggles Tab key");
    expect(editorKeyHint("plain", false)).toBeNull();
  });

  it("recognises Ctrl+Shift+F (and only that) as the focus-mode shortcut", () => {
    const base = { key: "F", code: "KeyF", ctrlKey: true, shiftKey: true, altKey: false, metaKey: false };
    expect(isFocusShortcut(base)).toBe(true);
    expect(isFocusShortcut({ ...base, key: "f" })).toBe(true);
    expect(isFocusShortcut({ ...base, key: "Ф", code: "KeyF" })).toBe(true); // other keyboard layouts
    expect(isFocusShortcut({ ...base, shiftKey: false })).toBe(false);
    expect(isFocusShortcut({ ...base, ctrlKey: false, metaKey: true })).toBe(false);
    expect(isFocusShortcut({ ...base, altKey: true })).toBe(false);
    expect(isFocusShortcut({ ...base, key: "G", code: "KeyG" })).toBe(false);
  });
});
