"use client";

import { AlertTriangle, Cloud, CloudOff, Loader2 } from "lucide-react";

/**
 * The save-state pill (Phase 6c).
 *
 * SPEC §5: "four explicit colour+icon+text states: 'Saved · 3s ago' (Cloud),
 * 'Saving…' (Loader2), 'Offline — retrying' (CloudOff, with a retry
 * countdown), 'Not saved — check your connection' (AlertTriangle, plus a
 * 'Copy my code' button so a student can rescue work into Notepad)."
 *
 * The "Copy my code" button is the part that matters most and is easiest to
 * leave out. Everything else about this component is reassurance; that button
 * is the candidate's last resort when the network has gone and the clock has
 * not. It is rendered ONLY in the failed state, where it is the honest thing
 * to offer.
 *
 * Each state carries a colour, an icon AND text, so none of them is
 * distinguishable only by colour. The live region is polite, not assertive:
 * a save state changing is not worth interrupting a screen reader mid-word,
 * and the failed state is announced as part of the same region.
 */

export type SaveState =
  | { readonly kind: "saved"; readonly secondsAgo: number }
  | { readonly kind: "saving" }
  | { readonly kind: "offline"; readonly retryInSeconds: number }
  | { readonly kind: "failed" };

export function SaveStatePill({
  state,
  onCopyCode,
}: {
  readonly state: SaveState;
  /** Rendered only in the failed state, where it is the honest offer. */
  readonly onCopyCode?: () => void;
}) {
  const view = (() => {
    switch (state.kind) {
      case "saved":
        return {
          text: `Saved · ${state.secondsAgo}s ago`,
          Icon: Cloud,
          tone: "border-success/40 bg-success-subtle text-success",
          spin: false,
        };
      case "saving":
        return {
          text: "Saving…",
          Icon: Loader2,
          tone: "border-border bg-elevated text-text-secondary",
          spin: true,
        };
      case "offline":
        return {
          text: `Offline — retrying in ${state.retryInSeconds}s`,
          Icon: CloudOff,
          tone: "border-warning/40 bg-warning-subtle text-warning",
          spin: false,
        };
      case "failed":
        return {
          text: "Not saved — check your connection",
          Icon: AlertTriangle,
          tone: "border-danger/40 bg-danger-subtle text-danger",
          spin: false,
        };
    }
  })();

  return (
    <div className="flex items-center gap-2">
      <span
        className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium ${view.tone}`}
      >
        <view.Icon className={`h-3.5 w-3.5 ${view.spin ? "animate-spin" : ""}`} aria-hidden />
        {/* Polite: a save state is not worth interrupting a word. */}
        <span role="status" aria-live="polite">
          {view.text}
        </span>
      </span>
      {state.kind === "failed" && onCopyCode ? (
        <button
          type="button"
          onClick={onCopyCode}
          className="rounded-md border border-danger/40 px-2 py-1 text-xs font-medium text-danger focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          Copy my code
        </button>
      ) : null}
    </div>
  );
}
