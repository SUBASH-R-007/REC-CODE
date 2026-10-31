"use client";

import { useEffect, useRef } from "react";

/**
 * The covering overlay (Phase 6c).
 *
 * SPEC §5: "Fullscreen exit / visibility hidden / window blur: within the
 * same tick render a fixed inset-0 z-[9999] opaque overlay that COVERS THE
 * QUESTION ENTIRELY (aria-modal, focus trapped on its single button) [...]
 * Write the ProctorEvent server-side before the overlay becomes dismissible.
 * Covering the content is what makes a tab-switch useless — even where
 * detection can be defeated, the question being hidden the instant focus is
 * lost buys a second monitor far less."
 *
 * So the overlay has two jobs, and the second one is the real one:
 *
 *   1. tell the candidate what happened and what it costs — plainly, with no
 *      accusation, because a wifi drop and an OS notification both land here;
 *   2. HIDE THE QUESTION, immediately, whether or not anything was recorded.
 *
 * It is therefore rendered opaque from the first frame and only becomes
 * DISMISSIBLE once the server has confirmed the event. `pending` is that
 * wait: the button is disabled and says so, and the candidate cannot read the
 * question in the meantime because the overlay is already over it.
 *
 * The text comes from the server (`overlayBody` in @recx/shared, composed in
 * the events route), so the warning number a candidate is shown is the one
 * the server counted — not one the client guessed.
 */
export function FocusOverlay({
  open,
  heading,
  body,
  pending,
  onDismiss,
}: {
  readonly open: boolean;
  readonly heading: string;
  /** The server's wording, including "warning 2 of 3". */
  readonly body: string;
  /** True while the ProctorEvent is still in flight. */
  readonly pending: boolean;
  readonly onDismiss: () => void;
}) {
  const button = useRef<HTMLButtonElement>(null);
  const container = useRef<HTMLDivElement>(null);

  // Focus the one button as soon as the overlay opens, so a keyboard or
  // screen-reader user is inside the dialog rather than behind it.
  useEffect(() => {
    if (open) button.current?.focus();
  }, [open]);

  // Trap focus on the single button: Tab and Shift+Tab both return to it, so
  // nothing behind the overlay can be reached or read.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Tab") {
        event.preventDefault();
        button.current?.focus();
      }
      // Escape must NOT close it. The only way out is the button, and only
      // once the event is recorded.
      if (event.key === "Escape") event.preventDefault();
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [open]);

  if (!open) return null;

  return (
    <div
      ref={container}
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="exam-overlay-heading"
      aria-describedby="exam-overlay-body"
      // Opaque, full-viewport, above everything. The question is gone.
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-surface p-6"
    >
      <div className="w-full max-w-md rounded-xl border border-border bg-elevated p-6 shadow-lg">
        <h2 id="exam-overlay-heading" className="font-display text-xl font-semibold text-text">
          {heading}
        </h2>
        <p id="exam-overlay-body" className="mt-3 text-sm leading-relaxed text-text-secondary">
          {body}
        </p>
        <button
          ref={button}
          type="button"
          disabled={pending}
          onClick={onDismiss}
          className="mt-6 w-full rounded-md bg-primary px-4 py-2.5 text-sm font-semibold text-primary-fg disabled:opacity-60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          {/* Says why it is waiting, rather than looking broken. */}
          {pending ? "Recording…" : "Return to the exam"}
        </button>
      </div>
    </div>
  );
}
