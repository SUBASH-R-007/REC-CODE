import type { CreateEditor, EditorController, LoadEditor } from "@/components/editor/editor-types";
import { loadMonaco } from "@/components/editor/monaco-loader";
import { MONACO_THEME, applyTheme, watchTheme } from "@/components/editor/monaco-theme";
import type { MonacoApi } from "@/components/editor/monaco-types";

export { preloadMonaco } from "@/components/editor/monaco-loader";

/** Line height and vertical padding, in CSS px (the plain textarea uses the same). */
const LINE_HEIGHT = 21;
const PADDING = 12;

/**
 * Monaco behind the EditorController interface. Loaded from the self-hosted
 * AMD build (/monaco/vs) — nothing from the monaco-editor package is
 * bundled. Only the generic editor worker runs (no TypeScript/JSON/CSS/HTML
 * services), ligatures and the minimap are off, and the theme is rebuilt
 * from the CSS design tokens whenever <html> changes (MutationObserver).
 * Tab-mode: Monaco's own Ctrl+M (Ctrl+Shift+M on macOS) toggles "Tab moves
 * focus"; Esc then Tab is handled by CodeEditor around this editor.
 *
 * The console drawer overlays the bottom of the editor (never a squeeze):
 * setOccludedBottom() gives Monaco that much extra bottom padding, so the
 * last lines can scroll above the drawer, and keeps the caret line (and the
 * line after it) clear of it on every caret move — Monaco's own reveal only
 * knows the full viewport, which the drawer partly covers. And when the
 * editor's own box shrinks, a caret line that was in view stays in view.
 */
function monacoFactory(monaco: MonacoApi): CreateEditor {
  return (host, options) => {
    applyTheme(monaco);
    const fontFamily = getComputedStyle(document.documentElement).getPropertyValue("--font-mono").trim();
    const editor = monaco.editor.create(host, {
      value: options.value,
      language: options.language,
      theme: MONACO_THEME,
      ariaLabel: options.label,
      minimap: { enabled: false },
      fontLigatures: false,
      automaticLayout: true,
      fontSize: 14,
      lineHeight: LINE_HEIGHT,
      ...(fontFamily ? { fontFamily } : {}),
      tabSize: 4,
      insertSpaces: true,
      detectIndentation: false,
      scrollBeyondLastLine: false,
      renderLineHighlight: "line",
      smoothScrolling: true,
      padding: { top: PADDING, bottom: PADDING },
      // The results console overlays the bottom of the pane.
      fixedOverflowWidgets: true,
      accessibilitySupport: "auto",
    });

    let applying = false;
    const subscription = editor.onDidChangeModelContent(() => {
      if (!applying) options.onChange(editor.getValue());
    });
    const stopWatching = watchTheme(monaco);

    /** CSS px at the bottom of the editor covered by the console drawer. */
    let occluded = 0;
    /**
     * Scroll down just enough that the caret line (plus `below` px of the
     * next) ends above the drawer — never up: Monaco reveals upwards itself.
     */
    const revealCaretAbove = (height: number, below: number) => {
      const position = editor.getPosition();
      if (!position) return;
      const visible = height - occluded;
      if (visible < LINE_HEIGHT + below) return;
      const wanted = editor.getTopForLineNumber(position.lineNumber) + LINE_HEIGHT + below - visible;
      if (wanted > editor.getScrollTop()) editor.setScrollTop(wanted);
    };
    const keepCaretClear = () => {
      if (occluded > 0) revealCaretAbove(editor.getLayoutInfo().height, LINE_HEIGHT);
    };
    const caretSubscription = editor.onDidChangeCursorPosition(keepCaretClear);

    // Monaco re-lays out when its box changes size (automaticLayout) but does
    // not re-reveal the caret, so a caret line at the bottom of a box that
    // then shrinks (a toolbar or status row wrapping onto a second line) ends
    // up clipped. A caret that was in view before the change stays in view.
    let layoutHeight = editor.getLayoutInfo().height;
    const layoutSubscription = editor.onDidLayoutChange(() => {
      const before = layoutHeight;
      layoutHeight = editor.getLayoutInfo().height;
      const position = editor.getPosition();
      if (layoutHeight >= before || !position) return;
      const top = editor.getTopForLineNumber(position.lineNumber) - editor.getScrollTop();
      const wasInView = top >= 0 && top + LINE_HEIGHT <= before - occluded;
      if (wasInView) revealCaretAbove(layoutHeight, occluded > 0 ? LINE_HEIGHT : 0);
    });

    const controller: EditorController = {
      getValue: () => editor.getValue(),
      setValue(value) {
        if (editor.getValue() === value) return;
        applying = true;
        try {
          editor.setValue(value);
        } finally {
          applying = false;
        }
      },
      setLanguage(language) {
        const model = editor.getModel();
        if (model) monaco.editor.setModelLanguage(model, language);
      },
      setLabel(label) {
        editor.updateOptions({ ariaLabel: label });
      },
      focus(caret) {
        if (caret !== undefined) {
          const position = editor.getModel()?.getPositionAt(caret);
          if (position) {
            editor.setPosition(position);
            editor.revealPositionInCenterIfOutsideViewport(position);
            keepCaretClear();
          }
        }
        editor.focus();
      },
      setOccludedBottom(px) {
        const next = Math.max(0, Math.round(px));
        if (next === occluded) return;
        occluded = next;
        editor.updateOptions({ padding: { top: PADDING, bottom: PADDING + occluded } });
        keepCaretClear();
      },
      dispose() {
        subscription.dispose();
        caretSubscription.dispose();
        layoutSubscription.dispose();
        stopWatching();
        editor.dispose();
      },
    };
    return controller;
  };
}

export const loadMonacoEditor: LoadEditor = async () => monacoFactory(await loadMonaco());
