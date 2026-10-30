import { editorKeyNote, type EditorKeymap } from "@recx/shared";

/**
 * Workspace layout rules, as pure functions (unit-tested in
 * test/workspace-layout.test.ts) plus the matching media queries.
 *
 *   width ≥ 1024 px   two resizable panes: statement 38 % / right 62 %, the
 *                     editor never narrower than 380 px; the results console
 *                     is an overlay drawer over the bottom of the editor —
 *                     never a squeeze (the 1366 × 768 decision).
 *   width < 1024 px   one column with three tabs: Problem / Code / Result.
 *   width < 768 px    CodeMirror 6 instead of Monaco (lazy, small).
 *   height < 700 px   data-density="compact": controls 36 → 30 px — never
 *                     below 30 px (WCAG 2.2 target size has a 24 px floor).
 */

export const WIDE_MIN_WIDTH = 1024;
export const MONACO_MIN_WIDTH = 768;
/** Compact below this viewport height. */
export const COMPACT_BELOW_HEIGHT = 700;

export const EDITOR_MIN_PX = 380;
export const STATEMENT_MIN_PX = 280;
export const STATEMENT_DEFAULT_PERCENT = 38;
export const EDITOR_DEFAULT_PERCENT = 62;

export type Density = "comfortable" | "compact";
export type WorkspaceLayout = "panels" | "tabs";
export type EditorKind = "monaco" | "codemirror";
export type MobileTab = "problem" | "code" | "result";

/** Control heights in CSS px. */
export const CONTROL_PX: Readonly<Record<Density, number>> = { comfortable: 36, compact: 30 };
/** The floor: no workspace control is ever smaller than this. */
export const MIN_CONTROL_PX = 30;

/** The same breakpoints as media queries (min-/max- pairs never overlap). */
export const MEDIA = {
  wide: `(min-width: ${WIDE_MIN_WIDTH}px)`,
  monaco: `(min-width: ${MONACO_MIN_WIDTH}px)`,
  compact: `(max-height: ${COMPACT_BELOW_HEIGHT - 1}px)`,
} as const;

const finite = (n: number, fallback: number) => (Number.isFinite(n) && n > 0 ? n : fallback);

export function densityFor(viewportHeight: number): Density {
  return finite(viewportHeight, Number.POSITIVE_INFINITY) < COMPACT_BELOW_HEIGHT ? "compact" : "comfortable";
}

export function layoutFor(viewportWidth: number): WorkspaceLayout {
  return finite(viewportWidth, WIDE_MIN_WIDTH) >= WIDE_MIN_WIDTH ? "panels" : "tabs";
}

export function editorFor(viewportWidth: number): EditorKind {
  return finite(viewportWidth, MONACO_MIN_WIDTH) >= MONACO_MIN_WIDTH ? "monaco" : "codemirror";
}

export function controlPx(density: Density): number {
  return Math.max(MIN_CONTROL_PX, CONTROL_PX[density]);
}

const clampPercent = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** The editor pane's minimum size (percent of the group) for a 380 px floor. */
export function editorMinPercent(groupWidth: number): number {
  const width = finite(groupWidth, 1280);
  return clampPercent((EDITOR_MIN_PX / width) * 100, 20, EDITOR_DEFAULT_PERCENT);
}

/** The statement pane's minimum size (percent of the group). */
export function statementMinPercent(groupWidth: number): number {
  const width = finite(groupWidth, 1280);
  return clampPercent((STATEMENT_MIN_PX / width) * 100, 15, STATEMENT_DEFAULT_PERCENT);
}

/**
 * The visible keyboard note next to the editor (WCAG 2.1.2: a non-standard
 * way out must be stated). Monaco and CodeMirror both leave on Esc then
 * Tab — handled by CodeEditor above both of them, so no keymap can bind it
 * away (Phase 12j) — and their Tab-mode toggles differ on Apple platforms.
 * The plain textarea never captures Tab.
 *
 * The wording itself lives in @recx/shared with the keymap copy, because
 * the setting page and this note have to agree about the way out.
 */
export function editorKeyHint(kind: EditorKind | "plain", apple: boolean, keymap: EditorKeymap = "DEFAULT"): string | null {
  return editorKeyNote({ kind, apple, keymap });
}

/** Focus mode's shortcut, as shown in labels. */
export const FOCUS_SHORTCUT = "Ctrl+Shift+F";

/** True for the focus-mode shortcut (Ctrl+Shift+F; Ctrl, not Cmd, on every platform). */
export function isFocusShortcut(e: { key: string; code?: string; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; metaKey: boolean }): boolean {
  return e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey && (e.code === "KeyF" || e.key.toLowerCase() === "f");
}
