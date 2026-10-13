"use client";

import { forwardRef, useId } from "react";
import { X } from "lucide-react";
import { Button, Textarea, cn, formatBytes } from "@recx/design";
import { utf8Length } from "@recx/shared";
import type { JudgeTarget, VerdictStreamState } from "@/hooks/use-verdict-stream";
import { MAX_CUSTOM_INPUT_BYTES } from "@/lib/judge/submit-schema";
import { ResultPanel } from "@/components/workspace/result-panel";

export type ConsoleTab = "result" | "input";

export interface CustomInputState {
  enabled: boolean;
  text: string;
}

const TABS: readonly { value: ConsoleTab; label: string }[] = [
  { value: "result", label: "Result" },
  { value: "input", label: "Custom input" },
];

/**
 * The results console.
 *
 *   ≥ 1024 px  an OVERLAY drawer anchored to the bottom of the editor pane.
 *              It floats over the editor and never resizes it (the editor
 *              keeps its layout; the student keeps their scroll position).
 *              Escape closes it; the workspace moves focus in on open and
 *              back to the toggle on close.
 *   < 1024 px  the body of the workspace's Result tab (no overlay).
 */
export const ResultConsole = forwardRef<
  HTMLHeadingElement,
  {
    id: string;
    /** Overlay open (wide screens). */
    open: boolean;
    /** The Result tab is the active one (narrow screens). */
    tabActive: boolean;
    /** Wide screens only: closing is meaningful. */
    dismissible: boolean;
    onClose: () => void;
    tab: ConsoleTab;
    onTabChange: (tab: ConsoleTab) => void;
    target: JudgeTarget | null;
    sending: "submission" | "run" | null;
    stream: VerdictStreamState & { retry: () => void };
    sampleIndexes: readonly number[];
    custom: CustomInputState;
    onCustomChange: (next: CustomInputState) => void;
    customHint: string;
  }
>(function ResultConsole(
  {
    id,
    open,
    tabActive,
    dismissible,
    onClose,
    tab,
    onTabChange,
    target,
    sending,
    stream,
    sampleIndexes,
    custom,
    onCustomChange,
    customHint,
  },
  headingRef,
) {
  const baseId = useId();
  const inputBytes = utf8Length(custom.text);
  const overLimit = inputBytes > MAX_CUSTOM_INPUT_BYTES;

  return (
    <section
      id={id}
      aria-labelledby={`${baseId}-title`}
      onKeyDown={(e) => {
        if (e.key === "Escape" && dismissible) {
          e.stopPropagation();
          onClose();
        }
      }}
      className={cn(
        "flex-col bg-surface",
        // Wide: the overlay drawer.
        "lg:absolute lg:inset-x-0 lg:bottom-0 lg:z-20 lg:h-[55%] lg:max-h-[85%] lg:min-h-48 lg:rounded-t-2xl lg:border-t lg:border-border-strong lg:shadow-pop",
        open ? "lg:flex" : "lg:hidden",
        // Narrow: the Result tab fills the pane.
        tabActive ? "max-lg:flex max-lg:h-full max-lg:min-h-0" : "max-lg:hidden",
      )}
    >
      <div className="flex min-h-(--ws-bar) items-center gap-3 border-b border-border px-3 py-1">
        <h2
          ref={headingRef}
          id={`${baseId}-title`}
          tabIndex={-1}
          className="font-display text-sm font-semibold tracking-tight outline-none"
        >
          Console
        </h2>
        <div role="tablist" aria-label="Console view" className="flex gap-1 rounded-lg bg-background p-0.5">
          {TABS.map((t) => (
            <button
              key={t.value}
              type="button"
              role="tab"
              id={`${baseId}-tab-${t.value}`}
              aria-selected={tab === t.value}
              aria-controls={`${baseId}-panel-${t.value}`}
              tabIndex={tab === t.value ? 0 : -1}
              onClick={() => onTabChange(t.value)}
              onKeyDown={(e) => {
                if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
                  e.preventDefault();
                  const next: ConsoleTab = t.value === "result" ? "input" : "result";
                  onTabChange(next);
                  document.getElementById(`${baseId}-tab-${next}`)?.focus();
                }
              }}
              className={cn(
                "inline-flex h-(--ws-ctl-sm) items-center rounded-md px-2.5 text-xs font-medium transition-colors",
                tab === t.value
                  ? "bg-surface text-text shadow-sm"
                  : "text-text-secondary hover:bg-primary-subtle hover:text-text",
              )}
            >
              {t.label}
              {t.value === "input" && custom.enabled ? (
                <span className="ml-1 text-primary">
                  <span aria-hidden>●</span>
                  <span className="sr-only"> (in use)</span>
                </span>
              ) : null}
            </button>
          ))}
        </div>
        {dismissible && (
          <Button
            variant="ghost"
            size="icon"
            className="ml-auto h-(--ws-ctl)! w-(--ws-ctl)! max-lg:hidden"
            aria-label="Close console"
            onClick={onClose}
          >
            <X className="h-4 w-4" aria-hidden />
          </Button>
        )}
      </div>

      <div
        role="tabpanel"
        id={`${baseId}-panel-${tab}`}
        aria-labelledby={`${baseId}-tab-${tab}`}
        tabIndex={0}
        className="scroll-thin min-h-0 flex-1 overflow-y-auto p-4 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/40"
      >
        {tab === "result" ? (
          <ResultPanel target={target} sending={sending} stream={stream} sampleIndexes={sampleIndexes} />
        ) : (
          <div className="space-y-3">
            <label className="flex min-h-(--ws-ctl) items-center gap-2 text-sm font-medium text-text">
              <input
                type="checkbox"
                checked={custom.enabled}
                onChange={(e) => onCustomChange({ ...custom, enabled: e.target.checked })}
                className="h-4 w-4 accent-primary"
              />
              Run with this input instead of the sample tests
            </label>
            <Textarea
              value={custom.text}
              onChange={(e) => onCustomChange({ ...custom, text: e.target.value })}
              aria-label="Custom input"
              aria-describedby={`${baseId}-hint`}
              aria-invalid={overLimit || undefined}
              spellCheck={false}
              rows={6}
              className="font-mono text-xs"
            />
            <p id={`${baseId}-hint`} className={cn("text-xs", overLimit ? "text-danger" : "text-muted")}>
              {customHint} {formatBytes(inputBytes)} of {formatBytes(MAX_CUSTOM_INPUT_BYTES)}.
              {overLimit && " Too large to run."}
            </p>
          </div>
        )}
      </div>
    </section>
  );
});
