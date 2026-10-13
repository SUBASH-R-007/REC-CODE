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
import { tags } from "@lezer/highlight";
import type { CreateEditor, EditorController, LoadEditor } from "@/components/editor/editor-types";

/**
 * CodeMirror 6 for narrow screens (< 768 px), where Monaco is too heavy and
 * fights the on-screen keyboard. This module is its own lazy chunk; each
 * language grammar is a further chunk loaded only when that language is in
 * use. Colours are the design tokens themselves (CSS variables), so the
 * admin brand and light/dark switching apply with no theme rebuild.
 *
 * Tab indents (indentWithTab). The keyboard way out is CodeMirror's own:
 * Esc then Tab moves focus on, and Ctrl+M (Alt+Shift+M on macOS) toggles
 * "Tab moves focus" — both stated next to the editor.
 */

const External = Annotation.define<boolean>();

/** CSS px, as in the theme below (and Monaco / the plain textarea). */
const LINE_HEIGHT = 21;
const CONTENT_PADDING = 12;

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
function occlusion(px: number): Extension {
  if (px <= 0) return [];
  return [
    EditorView.scrollMargins.of(() => ({ bottom: px + LINE_HEIGHT })),
    EditorView.contentAttributes.of({ style: `padding-bottom: ${px + CONTENT_PADDING}px` }),
  ];
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

const createCodeMirror: CreateEditor = (host, options) => {
  const languageSlot = new Compartment();
  const labelSlot = new Compartment();
  const occlusionSlot = new Compartment();
  let occluded = 0;

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
        indentUnit.of("    "),
        EditorState.tabSize.of(4),
        keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
        syntaxHighlighting(highlight),
        theme,
        languageSlot.of([]),
        labelSlot.of(contentAttributes(options.label)),
        occlusionSlot.of(occlusion(0)),
        EditorView.updateListener.of((update) => {
          if (!update.docChanged) return;
          if (update.transactions.some((tr) => tr.annotation(External))) return;
          options.onChange(update.state.doc.toString());
        }),
      ],
    }),
  });

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
          occlusionSlot.reconfigure(occlusion(next)),
          ...(next > 0 ? [EditorView.scrollIntoView(view.state.selection.main.head, { y: "nearest" })] : []),
        ],
      });
    },
    dispose() {
      languageRequest++;
      view.destroy();
    },
  };
  return controller;
};

/** The runtime is this chunk itself; creation is immediate. */
export const loadCodeMirrorEditor: LoadEditor = async () => createCodeMirror;
