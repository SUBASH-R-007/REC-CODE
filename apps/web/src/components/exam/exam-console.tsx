"use client";

import { ChevronDown, ChevronUp } from "lucide-react";
import { useVerdictStream } from "@/hooks/use-verdict-stream";
import { ResultPanel } from "@/components/workspace/result-panel";

/**
 * The results console, in a sitting (Phase 12q, slice 5).
 *
 * A candidate used to have an editor, a clock and a Submit button, and no
 * way to learn whether their program compiled — while the practice
 * workspace they revised in has had a Run button and a console since Phase
 * 1. Submit was the first time anybody found out, and in a proctored exam
 * that is the worst possible moment: a missing semicolon became a zero.
 *
 * It is the SAME console. `ResultPanel` and `useVerdictStream` are the
 * practice components, pointed at a run made through
 * `/api/exam/[attemptId]/run`, which reads back through the owner-scoped
 * `/api/runs/[id]` like any other. A candidate under exam conditions
 * should not have to learn a second one, and anything written only for the
 * exam surface is a second thing to keep right (Phase 12k's lesson about
 * an instrument written for one engine).
 *
 * Samples only, so every case it shows is one already printed on the
 * question. There is nothing here a candidate could not work out by hand,
 * only sooner.
 */
export function ExamConsole({
  runId,
  sending,
  sampleCount,
  open,
  onToggle,
  error,
}: {
  readonly runId: string | null;
  /** A run has been asked for but has no id yet. */
  readonly sending: boolean;
  readonly sampleCount: number;
  readonly open: boolean;
  readonly onToggle: () => void;
  /**
   * Why the last run was refused, in the route's own words. It refuses for
   * reasons a candidate can act on — a run already going, a question with
   * no samples, the wrong language — and those belong on screen, not in a
   * console nobody opened.
   */
  readonly error?: string | null;
}) {
  const stream = useVerdictStream(runId ? { kind: "run", id: runId } : null);
  // Every case a run reports is a sample; there are no hidden ones here.
  const sampleIndexes = Array.from({ length: sampleCount }, (_, i) => i);

  return (
    <section
      aria-label="Run results"
      className="shrink-0 border-t border-border bg-elevated/60"
      data-exam-console={open ? "open" : "closed"}
    >
      <h2>
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm font-medium text-text hover:bg-primary-subtle"
        >
          {open ? <ChevronDown className="h-4 w-4" aria-hidden /> : <ChevronUp className="h-4 w-4" aria-hidden />}
          Run results
          {/* The verdict in the header, so a collapsed console still says
              how it went. */}
          {stream.view?.verdict ? (
            <span className="ml-1 font-mono text-xs text-text-secondary">{stream.view.verdict}</span>
          ) : null}
        </button>
      </h2>
      {error ? (
        <p role="status" aria-live="polite" className="px-4 pb-2 text-sm text-danger">
          {error}
        </p>
      ) : null}
      {open ? (
        <div className="max-h-64 overflow-y-auto px-4 pb-4">
          <ResultPanel
            target={runId ? { kind: "run", id: runId } : null}
            sending={sending ? "run" : null}
            stream={stream}
            sampleIndexes={sampleIndexes}
          />
        </div>
      ) : null}
    </section>
  );
}
