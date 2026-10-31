/**
 * Editor keymaps (Phase 12j).
 *
 * SPEC §11: "vim/emacs keymaps". A student who has spent two years in vim
 * types badly in anything else, and typing badly in a contest is a
 * handicap the platform imposed rather than a skill it measured.
 *
 * Three decisions live here because all three are copy a student reads
 * before they turn one on.
 *
 * **The way out of the editor does not change.** Both editors capture Tab
 * (WCAG 2.1.2 needs a stated way out), and the way out is Esc then Tab,
 * handled ABOVE the editor in the capture phase so no keymap can take it.
 * That shadows one binding in each mode — vim's `<Tab>` jumplist jump
 * after Esc, emacs's `M-Tab` — and that is the right trade: a keyboard
 * trap is a defect, a shadowed jumplist binding is an inconvenience.
 *
 * **A keymap is off in a proctored exam, and the arena says so.** The
 * exam's typing telemetry is defined in terms of CodeMirror's own
 * transaction origins (SPEC §5), and a keymap's register commands —
 * vim's `"+p`, emacs's yank — are a paste path those origins do not
 * describe. Rather than ship a signal that means something different
 * depending on a preference, the arena keeps the default keymap and the
 * page states it.
 *
 * **Nothing here is a cheat or an advantage.** It changes which keys move
 * the caret, and nothing else: not the problem, not the limits, not the
 * verdict.
 */

export const EDITOR_KEYMAPS = ["DEFAULT", "VIM", "EMACS"] as const;
export type EditorKeymap = (typeof EDITOR_KEYMAPS)[number];

export const EDITOR_KEYMAP_DEFAULT: EditorKeymap = "DEFAULT";

export const EDITOR_KEYMAP_LABEL: Readonly<Record<EditorKeymap, string>> = Object.freeze({
  DEFAULT: "Standard",
  VIM: "Vim",
  EMACS: "Emacs",
});

export const EDITOR_KEYMAP_HINT: Readonly<Record<EditorKeymap, string>> = Object.freeze({
  DEFAULT: "The editor's own keys, as most people expect them.",
  VIM: "Modal editing. Esc returns to normal mode; : opens the command line.",
  EMACS: "Emacs bindings: C-a, C-e, C-k, C-y, M-w and the rest.",
});

/** What the escape hatch shadows in each mode, said plainly on the page. */
export const EDITOR_KEYMAP_SHADOWED: Readonly<Record<EditorKeymap, string | null>> = Object.freeze({
  DEFAULT: null,
  VIM: "Esc then Tab leaves the editor, so it does not jump forward in the jumplist.",
  EMACS: "Esc then Tab leaves the editor, so it is not M-Tab.",
});

/**
 * True for a keymap whose module has to be fetched. The default is the
 * editor's own behaviour and costs nothing.
 */
export function keymapNeedsModule(keymap: EditorKeymap): boolean {
  return keymap !== "DEFAULT";
}

/** `/monaco/keymaps/monaco-vim.js`, self-hosted — never a CDN. */
export const MONACO_KEYMAP_MODULE: Readonly<Record<EditorKeymap, string | null>> = Object.freeze({
  DEFAULT: null,
  VIM: "monaco-vim",
  EMACS: "monaco-emacs",
});

export const EDITOR_KEYMAP_NOTICES = Object.freeze({
  /** Beside the setting. */
  setting:
    "This changes which keys move the caret, and nothing else. Esc then Tab still leaves the editor, whichever keymap is on.",
  /** In the proctored arena, where the keymap is deliberately the default. */
  examDefault:
    "The assessment editor uses the standard keys, whatever your profile says. What it records about typing is defined in terms of those keys.",
  /** Shown while a keymap is loading. */
  loading: "Loading the keymap…",
  /** Shown if the keymap module cannot be fetched. */
  unavailable: "That keymap did not load, so the editor is using the standard keys.",
});

/**
 * The visible keyboard note beside the editor (WCAG 2.1.2: a non-standard
 * way out must be stated).
 *
 * Phase 12j adds the keymap's name to it rather than a second note: one
 * line, and the way out is first in it in every mode, because that is the
 * sentence somebody reads when they are stuck.
 */
export function editorKeyNote(options: {
  /** "monaco", "codemirror", or "plain" for the textarea, which captures nothing. */
  kind: "monaco" | "codemirror" | "plain";
  apple: boolean;
  keymap: EditorKeymap;
}): string | null {
  if (options.kind === "plain") return null;
  const toggle = !options.apple ? "Ctrl+M" : options.kind === "monaco" ? "Ctrl+Shift+M" : "Alt+Shift+M";
  const base = `Esc then Tab leaves the editor · ${toggle} toggles Tab key`;
  if (options.keymap === "DEFAULT") return base;
  return `${base} · ${EDITOR_KEYMAP_LABEL[options.keymap]} keys`;
}
