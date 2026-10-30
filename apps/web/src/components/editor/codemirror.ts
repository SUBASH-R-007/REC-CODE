import { Annotation, Compartment, EditorState, Transaction, type Extension } from "@codemirror/state";
import {
  EditorView,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { HighlightStyle, bracketMatching, indentOnInput, indentUnit, syntaxHighlighting } from "@codemirror/language";
import { Prec } from "@codemirror/state";
import { tags } from "@lezer/highlight";
import type { EditorKeymap } from "@recx/shared";
import type { CreateEditor, EditorController, EditorPrefs, LoadEditor } from "@/components/editor/editor-types";
import { editorLineHeight } from "@/components/profile/settings-schema";

/**
 * CodeMirror 6 for narrow screens (< 768 px), where Monaco is too heavy and
 * fights the on-screen keyboard. This module is its own lazy chunk; each
 * language grammar is a further chunk loaded only when that language is in
 * use. Colours are the design tokens themselves (CSS variables), so the
 * admin brand and light/dark switching apply with no theme rebuild.
 *
 * Tab indents (indentWithTab). The keyboard way out is CodeMirror's own:
 * Esc then Tab moves focus on, and Ctrl+M (Alt+Shift+M on macOS) toggles
 * "Tab moves focus" — both stated next to the editor. CodeEditor handles
 * Esc then Tab ABOVE this editor in the capture phase as well, so no
 * keymap can take the way out (Phase 12j).
 *
 * Phase 12j: the viewer's font size, tab size and keymap are applied here.
 * Each keymap is its own lazy chunk, fetched the first time somebody turns
 * one on; the font size and the line height move together, because the
 * scroll margins below are measured in line heights.
 */

const External = Annotation.define<boolean>();

/** CSS px, as in the theme below (and Monaco / the plain textarea). */
const CONTENT_PADDING = 12;

/** The parts of the theme that follow the viewer's font size. */
function sizeTheme(fontSize: number): Extension {
  return EditorView.theme({
    "&": { fontSize: fontSize + "px" },
    ".cm-scroller": { lineHeight: editorLineHeight(fontSize) + "px" },
  });
}

const theme = EditorView.theme({
  "&": {
    height: "100%",
    color: "var(--text)",
    backgroundColor: "var(--surface)",
    fontSize: "14px",
  },
  ".cm-scroller": {
    fontFamily: "var(--font-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace)",
    lineHeight: "21px",
    overflow: "auto",
  },
  ".cm-content": { caretColor: "var(--primary)", padding: "12px 0" },
  "&.cm-focused": { outline: "2px solid var(--ring)", outlineOffset: "-2px" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--primary)", borderLeftWidth: "2px" },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground": {
    backgroundColor: "color-mix(in srgb, var(--primary) 24%, transparent)",
  },
  ".cm-activeLine": { backgroundColor: "color-mix(in srgb, var(--primary-subtle) 60%, transparent)" },
  ".cm-gutters": { backgroundColor: "var(--surface)", color: "var(--muted)", border: "none" },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--text)" },
  ".cm-matchingBracket": {
    backgroundColor: "color-mix(in srgb, var(--primary) 15%, transparent)",
    outline: "1px solid var(--primary)",
  },
  // Keywords are primary-coloured text. The canonical dark --primary is below
  // 4.5:1 as text on the dark surfaces, so the dark theme uses
  // --primary-hover — the rule in packages/design/utilities.css.
  ".cm-recx-keyword": { color: "var(--primary)" },
  ".dark & .cm-recx-keyword": { color: "var(--primary-hover)" },
});

const highlight = HighlightStyle.define([
  { tag: tags.comment, color: "var(--muted)", fontStyle: "italic" },
  { tag: [tags.keyword, tags.controlKeyword, tags.modifier, tags.operatorKeyword], class: "cm-recx-keyword" },
  { tag: [tags.string, tags.special(tags.string), tags.character], color: "var(--success)" },
  { tag: [tags.number, tags.bool, tags.null, tags.atom], color: "var(--accent)" },
  { tag: [tags.typeName, tags.className, tags.standard(tags.typeName)], color: "var(--info)" },
  { tag: [tags.processingInstruction, tags.meta], color: "var(--text-secondary)" },
  { tag: tags.invalid, color: "var(--danger)" },
]);

/** The grammar for a catalog editor-language id; each is a separate lazy chunk. */
async function languageSupport(id: string): Promise<Extension> {
  switch (id) {
    case "c":
    case "cpp":
      return (await import("@codemirror/lang-cpp")).cpp();
    case "python":
      return (await import("@codemirror/lang-python")).python();
    // Kotlin has no first-party grammar; Java's is the closest highlighter.
    case "java":
    case "kotlin":
      return (await import("@codemirror/lang-java")).java();
    case "javascript":
      return (await import("@codemirror/lang-javascript")).javascript();
    case "go":
      return (await import("@codemirror/lang-go")).go();
    // Phase 12k. The PostgreSQL dialect, because that is the only dialect
    // judged here, and lower-case keywords because that is what a student
    // typed: this grammar highlights, it does not rewrite.
    case "sql": {
      const mod = await import("@codemirror/lang-sql");
      return mod.sql({ dialect: mod.PostgreSQL, upperCaseKeywords: false });
    }
    default:
      return [];
  }
}

/**
 * The console drawer covers the bottom `px` of the editor (only possible
 * when a window that opened with CodeMirror is widened to the overlay
 * layout): CodeMirror's scroll margins treat that strip as off screen when
 * it keeps the cursor in view, and the content gets as much bottom padding
 * so the last lines can scroll above it. The editor itself keeps its size.
 */
function occlusion(px: number, lineHeight: number): Extension {
  if (px <= 0) return [];
  return [
    EditorView.scrollMargins.of(() => ({ bottom: px + lineHeight })),
    EditorView.contentAttributes.of({ style: `padding-bottom: ${px + CONTENT_PADDING}px` }),
  ];
}

/** Tab size, in the two places CodeMirror keeps it. */
function tabExtensions(tabSize: number): Extension {
  return [indentUnit.of(" ".repeat(tabSize)), EditorState.tabSize.of(tabSize)];
}

function contentAttributes(label: string) {
  return EditorView.contentAttributes.of({
    "aria-label": label,
    // Explicit, so checkers see the scroller's keyboard access (contenteditable is focusable anyway).
    tabindex: "0",
    autocapitalize: "off",
    autocorrect: "off",
    spellcheck: "false",
  });
}

/**
 * A keymap as a CodeMirror extension, loaded on demand.
 *
 * `Prec.highest` so the keymap's own bindings beat the default ones, which
 * is what both extensions expect. The way OUT of the editor is handled
 * above CodeMirror in the capture phase, so raising this precedence
 * cannot trap anybody.
 */
async function keymapExtension(which: EditorKeymap): Promise<Extension> {
  switch (which) {
    case "VIM":
      return Prec.highest((await import("@replit/codemirror-vim")).vim({ status: true }));
    case "EMACS":
      return Prec.highest((await import("@replit/codemirror-emacs")).emacs());
    default:
      return [];
  }
}

const createCodeMirror: CreateEditor = (host, options) => {
  const languageSlot = new Compartment();
  const labelSlot = new Compartment();
  const occlusionSlot = new Compartment();
  const sizeSlot = new Compartment();
  const tabSlot = new Compartment();
  const keymapSlot = new Compartment();
  let occluded = 0;
  let prefs: EditorPrefs = options.prefs;
  let lineHeight = editorLineHeight(prefs.fontSize);

  const view = new EditorView({
    parent: host,
    state: EditorState.create({
      doc: options.value,
      extensions: [
        lineNumbers(),
        highlightActiveLineGutter(),
        highlightActiveLine(),
        drawSelection(),
        history(),
        indentOnInput(),
        bracketMatching(),
        tabSlot.of(tabExtensions(prefs.tabSize)),
        keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
        syntaxHighlighting(highlight),
        theme,
        sizeSlot.of(sizeTheme(prefs.fontSize)),
        keymapSlot.of([]),
        languageSlot.of([]),
        labelSlot.of(contentAttributes(options.label)),
        occlusionSlot.of(occlusion(0, lineHeight)),
        EditorView.updateListener.of((update) => {
          if (!update.docChanged) return;
          if (update.transactions.some((tr) => tr.annotation(External))) return;
          options.onChange(update.state.doc.toString());

          // Exam telemetry (Phase 6c). One report per transaction, carrying
          // CM6's own `userEvent` — "input.type" for typing, "input.paste"
          // for a paste, and ABSENT for a change nothing announced, which is
          // what an extension writing into the document looks like.
          const report = options.onInsertion;
          if (!report) return;
          for (const tr of update.transactions) {
            if (!tr.docChanged) continue;
            let inserted = 0;
            tr.changes.iterChanges((_fromA, _toA, _fromB, _toB, text) => {
              inserted += text.length;
            });
            if (inserted === 0) continue;
            report({ chars: inserted, origin: tr.annotation(Transaction.userEvent) ?? null });
          }
        }),
      ],
    }),
  });

  /**
   * The keymap, fetched on demand. `keymapRequest` makes the last choice
   * win when somebody switches twice while a chunk is still in flight.
   */
  let keymapRequest = 0;
  const setKeymap = (which: EditorKeymap) => {
    const request = ++keymapRequest;
    keymapExtension(which)
      .then((extension) => {
        if (request === keymapRequest) view.dispatch({ effects: keymapSlot.reconfigure(extension) });
      })
      .catch((error: unknown) => {
        console.warn("[editor] keymap failed to load", error);
        options.onKeymapFailed?.();
      });
  };
  if (prefs.keymap !== "DEFAULT") setKeymap(prefs.keymap);

  let languageRequest = 0;
  const setLanguage = (language: string) => {
    const request = ++languageRequest;
    languageSupport(language)
      .then((support) => {
        if (request === languageRequest) view.dispatch({ effects: languageSlot.reconfigure(support) });
      })
      .catch(() => {
        // No highlighting is still a working editor.
      });
  };
  setLanguage(options.language);

  const controller: EditorController = {
    getValue: () => view.state.doc.toString(),
    setValue(value) {
      if (view.state.doc.toString() === value) return;
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: value },
        annotations: [External.of(true), Transaction.addToHistory.of(false)],
      });
    },
    setLanguage,
    setLabel(label) {
      view.dispatch({ effects: labelSlot.reconfigure(contentAttributes(label)) });
    },
    setPrefs(next) {
      const was = prefs;
      prefs = next;
      lineHeight = editorLineHeight(next.fontSize);
      const effects = [];
      if (was.fontSize !== next.fontSize) {
        effects.push(sizeSlot.reconfigure(sizeTheme(next.fontSize)));
        if (occluded > 0) effects.push(occlusionSlot.reconfigure(occlusion(occluded, lineHeight)));
      }
      if (was.tabSize !== next.tabSize) effects.push(tabSlot.reconfigure(tabExtensions(next.tabSize)));
      if (effects.length > 0) view.dispatch({ effects });
      if (was.keymap !== next.keymap) setKeymap(next.keymap);
    },
    focus(caret) {
      if (caret !== undefined) {
        const anchor = Math.max(0, Math.min(caret, view.state.doc.length));
        view.dispatch({ selection: { anchor }, scrollIntoView: true });
      }
      view.focus();
    },
    setOccludedBottom(px) {
      const next = Math.max(0, Math.round(px));
      if (next === occluded) return;
      occluded = next;
      view.dispatch({
        effects: [
          occlusionSlot.reconfigure(occlusion(next, lineHeight)),
          ...(next > 0 ? [EditorView.scrollIntoView(view.state.selection.main.head, { y: "nearest" })] : []),
        ],
      });
    },
    dispose() {
      languageRequest++;
      keymapRequest++;
      view.destroy();
    },
  };
  return controller;
};

/** The runtime is this chunk itself; creation is immediate. */
export const loadCodeMirrorEditor: LoadEditor = async () => createCodeMirror;
