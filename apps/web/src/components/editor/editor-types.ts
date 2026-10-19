/**
 * What the workspace's CodeEditor needs from a real editor, so Monaco
 * (≥ 768 px) and CodeMirror 6 (< 768 px) are interchangeable. Both
 * implementations are loaded lazily; neither is in any route's first load.
 */

export interface EditorOptions {
  value: string;
  /** Editor language id from the language catalog ("cpp", "python", …). */
  language: string;
  /** Accessible name, e.g. "Code editor, C++20 (GCC 13.2.0)". */
  label: string;
  /** Called with the full text after every edit made in the editor. */
  onChange: (value: string) => void;
  /**
   * Exam telemetry (Phase 6c). Called once per document-changing transaction
   * with the number of characters inserted and the editor's OWN account of
   * where they came from.
   *
   * SPEC §5: "Capture editor telemetry through CodeMirror 6 transaction
   * annotations (updateListener + transactionFilter), not DOM events. CM6
   * tells you the exact inserted character count and whether the origin was
   * input.type, input.paste or programmatic; a DOM paste listener tells you
   * almost nothing and is silenced by one addEventListener override."
   *
   * Implemented by the CodeMirror controller only. Monaco has no equivalent
   * that distinguishes typed from programmatic input, which is why the exam
   * forces `kind: "codemirror"` rather than accepting a weaker signal on
   * wide screens (docs/OPEN-QUESTIONS.md).
   */
  onInsertion?: (change: { chars: number; origin: string | null }) => void;
}

export interface EditorController {
  getValue(): string;
  /** Replace the text (language switch, restore, reset). Does not call onChange. */
  setValue(value: string): void;
  setLanguage(language: string): void;
  setLabel(label: string): void;
  /** Focus, optionally placing the caret at a character offset. */
  focus(caret?: number): void;
  /**
   * The bottom `px` of the editor are covered by an overlay (the workspace's
   * console drawer; 0 = nothing). The editor keeps its size — no squeeze —
   * but treats that strip as off screen: the text can scroll above it, and
   * the caret line (plus one line of context) is kept clear of it now and on
   * every caret move while it lasts.
   */
  setOccludedBottom(px: number): void;
  dispose(): void;
}

/** Creates an editor synchronously, once its runtime has loaded. */
export type CreateEditor = (host: HTMLElement, options: EditorOptions) => EditorController;

/**
 * Loads an editor's runtime (network, chunks) and resolves to a synchronous
 * factory, so the caller can read the fallback textarea's latest text at the
 * moment of creation — not before a multi-second download.
 */
export type LoadEditor = () => Promise<CreateEditor>;
