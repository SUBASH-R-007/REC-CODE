"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { cn } from "@recx/design";
import type { EditorController } from "@/components/editor/editor-types";
import { moveFocusOutside } from "@/components/editor/focus-escape";
import { MEDIA, type EditorKind } from "@/components/workspace/layout";

/** The plain textarea's metrics in CSS px (leading-[21px], p-3) — the same as Monaco's and CodeMirror's. */
const PLAIN_LINE_HEIGHT = 21;
const PLAIN_PADDING = 12;

/**
 * The plain textarea's version of EditorController.setOccludedBottom: scroll
 * down just enough that the caret line and the next clear an overlay
 * covering the bottom `occluded` px (lines are exact: wrap="off").
 */
function keepPlainCaretClear(textarea: HTMLTextAreaElement, occluded: number): void {
  if (occluded <= 0) return;
  const visible = textarea.clientHeight - occluded;
  if (visible < PLAIN_LINE_HEIGHT * 2) return;
  const head = textarea.selectionDirection === "backward" ? textarea.selectionStart : textarea.selectionEnd;
  const text = textarea.value;
  let line = 0;
  for (let i = text.indexOf("\n"); i !== -1 && i < head; i = text.indexOf("\n", i + 1)) line++;
  const wanted = PLAIN_PADDING + (line + 2) * PLAIN_LINE_HEIGHT - visible;
  if (wanted > textarea.scrollTop) textarea.scrollTop = wanted;
}

// Start DOWNLOADING Monaco as soon as this module runs in a wide window —
// while the page is still hydrating — instead of after the mount effect
// below. Download only (preload hints): nothing runs before hydration, and
// the effect loads Monaco exactly as before from the preloaded responses.
// Same lazy chunk, same /monaco/vs files (nothing moves into first-load JS).
// Narrow windows (CodeMirror) never fetch Monaco.
if (typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(MEDIA.monaco).matches) {
  void import("@/components/editor/monaco-controller")
    .then((m) => m.preloadMonaco())
    .catch(() => undefined);
}

/**
 * The code editor. A plain monospace <textarea> renders immediately and is
 * typable before any editor arrives; the real editor then loads lazily —
 * Monaco (self-hosted /monaco/vs) at ≥ 768 px, CodeMirror 6 (its own small
 * chunk) below — takes over the textarea's CURRENT value (and caret, if it
 * had focus) so no keystroke is lost, and replaces it. If the editor fails
 * to load (offline, blocked, an old browser) the textarea simply stays.
 * The choice is made once per mount, so crossing 768 px mid-session never
 * swaps editors (and never loses undo history).
 *
 * Controlled: `value` is the source of truth held by the workspace; a
 * changed `value` (language switch, reset, draft restore) is pushed into the
 * editor only when it differs from what the editor already holds.
 *
 * Keyboard (WCAG 2.1.2): Monaco captures Tab, so this wrapper adds the
 * documented way out — Esc, then Tab (Shift+Tab backwards) moves focus to
 * the next control outside the editor. CodeMirror has the same built in.
 *
 * `occludedBottom`: the workspace's console drawer overlays the bottom of
 * the editor (it never resizes it). Whichever editor is showing — Monaco,
 * CodeMirror or the plain textarea — keeps its size, lets its text scroll
 * above the drawer and keeps the caret line clear of it.
 */
export function CodeEditor({
  value,
  onChange,
  language,
  label,
  describedBy,
  onKind,
  occludedBottom = 0,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  /** Editor language id ("cpp", "python", …). */
  language: string;
  /** Accessible name, e.g. "Code editor, C++20 (GCC 13.2.0)". */
  label: string;
  /** Id of the visible keyboard note, for the plain textarea. */
  describedBy?: string;
  /** Which editor this mount chose (for the keyboard note). */
  onKind?: (kind: EditorKind) => void;
  /** CSS px at the bottom of the editor covered by an overlay (the console drawer); 0 = none. */
  occludedBottom?: number;
  className?: string;
}) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const controllerRef = useRef<EditorController | null>(null);
  const latest = useRef({ value, onChange, language, label, onKind });
  const [ready, setReady] = useState(false);
  const [kind, setKind] = useState<EditorKind | null>(null);

  // Synced in the commit itself, so an editor created between a commit and
  // its passive effects compares against what is actually on screen.
  useLayoutEffect(() => {
    latest.current = { value, onChange, language, label, onKind };
  });

  // Choose and load the editor once per mount; hand the textarea over to it.
  useEffect(() => {
    let disposed = false;
    let controller: EditorController | null = null;
    const chosen: EditorKind =
      typeof window.matchMedia === "function" && !window.matchMedia(MEDIA.monaco).matches ? "codemirror" : "monaco";
    setKind(chosen);
    latest.current.onKind?.(chosen);

    const load =
      chosen === "monaco"
        ? import("@/components/editor/monaco-controller").then((m) => m.loadMonacoEditor())
        : import("@/components/editor/codemirror").then((m) => m.loadCodeMirrorEditor());

    load
      .then((create) => {
        const host = hostRef.current;
        if (disposed || !host) return;
        // Read the fallback NOW (after the download), so nothing typed — or
        // restored — while the editor was loading is lost or overwritten.
        const textarea = textareaRef.current;
        const current = textarea ? textarea.value : latest.current.value;
        const hadFocus = textarea !== null && document.activeElement === textarea;
        const caret = textarea?.selectionStart ?? 0;

        const created = create(host, {
          value: current,
          language: latest.current.language,
          label: latest.current.label,
          onChange: (next) => latest.current.onChange(next),
        });
        controller = created;
        controllerRef.current = created;
        // Keystrokes the textarea took after its last render are in `current`.
        if (current !== latest.current.value) latest.current.onChange(current);
        setReady(true);
        if (hadFocus) created.focus(caret);
      })
      .catch((error: unknown) => {
        // Keep the plain editor; it is fully functional.
        console.warn("[editor] code editor unavailable, using the plain editor:", error);
      });

    return () => {
      disposed = true;
      controller?.dispose();
      controllerRef.current = null;
    };
  }, []);

  // Push external value changes into the editor.
  useEffect(() => {
    controllerRef.current?.setValue(value);
  }, [value, ready]);

  useEffect(() => {
    controllerRef.current?.setLanguage(language);
  }, [language, ready]);

  useEffect(() => {
    controllerRef.current?.setLabel(label);
  }, [label, ready]);

  // The console drawer opened, closed or resized: keep the caret above it.
  useEffect(() => {
    controllerRef.current?.setOccludedBottom(occludedBottom);
    const textarea = textareaRef.current;
    if (!textarea || occludedBottom <= 0) return;
    keepPlainCaretClear(textarea, occludedBottom);
    // Chrome extends a textarea's scroll range for new padding only at the
    // next frame (until then the scroll is clamped to the old range): repeat
    // once a frame has gone by.
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => keepPlainCaretClear(textarea, occludedBottom));
    });
    return () => cancelAnimationFrame(frame);
  }, [occludedBottom, ready]);

  // Esc then Tab leaves Monaco. Capture phase on the wrapper runs before
  // Monaco's own handlers on its hidden textarea, so the Tab never indents.
  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper || kind !== "monaco" || !ready) return;
    let armed = false;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        armed = true;
        return;
      }
      if (e.key === "Tab" && armed && !e.ctrlKey && !e.altKey && !e.metaKey) {
        armed = false;
        if (moveFocusOutside(wrapper, e.shiftKey)) {
          e.preventDefault();
          e.stopPropagation();
        }
        return;
      }
      if (e.key !== "Shift") armed = false;
    };
    const disarm = () => {
      armed = false;
    };
    wrapper.addEventListener("keydown", onKeyDown, true);
    wrapper.addEventListener("pointerdown", disarm, true);
    return () => {
      wrapper.removeEventListener("keydown", onKeyDown, true);
      wrapper.removeEventListener("pointerdown", disarm, true);
    };
  }, [kind, ready]);

  return (
    <div
      ref={wrapperRef}
      data-editor-root=""
      data-editor={ready ? (kind ?? "plain") : "plain"}
      className={cn(
        "relative h-full w-full overflow-hidden bg-surface",
        // A visible focus ring over whichever editor has focus (Monaco and
        // CodeMirror paint their own backgrounds over the wrapper).
        "after:pointer-events-none after:absolute after:inset-0 after:z-[5] focus-within:after:shadow-[inset_0_0_0_2px_var(--ring)]",
        className,
      )}
    >
      <div ref={hostRef} className="absolute inset-0" aria-hidden={!ready} />
      {!ready && (
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          // Typing, arrows, clicks: every caret move.
          onSelect={(e) => keepPlainCaretClear(e.currentTarget, occludedBottom)}
          aria-label={label}
          aria-describedby={describedBy}
          spellCheck={false}
          autoCapitalize="off"
          autoComplete="off"
          autoCorrect="off"
          wrap="off"
          // Room to scroll the last lines above the drawer (the box itself keeps its size).
          style={occludedBottom > 0 ? { paddingBottom: occludedBottom + PLAIN_PADDING } : undefined}
          className="absolute inset-0 h-full w-full resize-none bg-surface p-3 font-mono text-sm leading-[21px] text-text outline-none [tab-size:4]"
        />
      )}
    </div>
  );
}
