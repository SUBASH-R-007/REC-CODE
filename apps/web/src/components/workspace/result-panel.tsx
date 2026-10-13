"use client";

import { Loader2, RefreshCw } from "lucide-react";
import { Button, ProgressBar, VerdictBadge } from "@recx/design";
import type { JudgeTarget, VerdictStreamState } from "@/hooks/use-verdict-stream";
import { formatMemoryKb, formatTimeMs, subtaskLabel, type StudentView } from "@/lib/judge/view";
import {
  CompileOutput,
  OutputBlock,
  ResultNotes,
  ResultSummary,
  TestResults,
} from "@/components/workspace/result-view";

export { HIDDEN_TEST_NOTE, WA_NOTE, WA_NOTES } from "@/components/workspace/result-view";

function kindLabel(view: StudentView): string {
  if (view.kind === "submission") return "Submission";
  return view.isCustom ? "Run · custom input" : "Run · sample tests";
}

function liveLabel(i: number, sampleIndexes: readonly number[]): string {
  const k = sampleIndexes.indexOf(i);
  return k >= 0 ? `Sample ${k + 1}` : `Hidden test ${i + 1}`;
}

/**
 * While judging: what the worker is doing, a progress bar, each finished
 * test's verdict and — for SUBTASK problems — each subtask's verdict as it is
 * decided. Visible only; the single aria-live announcement is the final
 * verdict (the workspace owns it).
 */
function LiveProgress({
  stream,
  sampleIndexes,
}: {
  stream: VerdictStreamState;
  sampleIndexes: readonly number[];
}) {
  const progress = stream.progress;
  const status =
    !progress || progress.state === "QUEUED"
      ? stream.view?.display === "RUNNING"
        ? "Preparing the judge…"
        : "Waiting for a judge…"
      : progress.state === "COMPILING"
        ? "Compiling…"
        : progress.total > 0
          ? `Running test ${Math.min(progress.done + 1, progress.total)} of ${progress.total}`
          : "Running tests…";
  const finished = progress ? [...progress.tests].sort((a, b) => a.i - b.i) : [];
  const subtasks = progress?.subtasks ?? [];
  const custom = stream.view?.kind === "run" && stream.view.isCustom;
  return (
    <div className="space-y-3">
      <p className="flex items-center gap-2 text-sm text-text-secondary">
        <Loader2 className="h-4 w-4 animate-spin text-primary" aria-hidden />
        {status}
      </p>
      {progress && progress.total > 0 && (
        <ProgressBar value={progress.done} max={progress.total} size="sm" label="Tests finished" />
      )}
      {subtasks.length > 0 && (
        <ul className="flex flex-wrap gap-x-4 gap-y-2" aria-label="Finished subtasks">
          {subtasks.map((st) => (
            <li key={st.index} className="flex items-center gap-1.5 text-xs font-medium text-text">
              <span>{subtaskLabel(st.index)}</span>
              <VerdictBadge verdict={st.v} size="sm" />
            </li>
          ))}
        </ul>
      )}
      {finished.length > 0 && (
        <ul className="flex flex-wrap gap-2" aria-label="Finished tests">
          {finished.map((t) => (
            <li key={t.i} className="flex items-center gap-1.5 text-xs text-text-secondary">
              <span>{custom ? "Custom input" : liveLabel(t.i, sampleIndexes)}</span>
              <VerdictBadge verdict={t.v} size="sm" />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** The body of the results console: idle, sending, live, or the final view. */
export function ResultPanel({
  target,
  sending,
  stream,
  sampleIndexes,
}: {
  target: JudgeTarget | null;
  sending: "submission" | "run" | null;
  stream: VerdictStreamState & { retry: () => void };
  sampleIndexes: readonly number[];
}) {
  if (sending) {
    return (
      <p className="flex items-center gap-2 text-sm text-text-secondary">
        <Loader2 className="h-4 w-4 animate-spin text-primary" aria-hidden />
        {sending === "submission" ? "Submitting your code…" : "Sending your code to run…"}
      </p>
    );
  }
  if (!target) {
    return (
      <p className="text-sm text-text-secondary">
        <strong className="font-semibold text-text">Run</strong> checks your code against the sample tests (or your
        own input). <strong className="font-semibold text-text">Submit</strong> judges it against every test. Results
        appear here.
      </p>
    );
  }
  if (stream.phase === "error") {
    return (
      <div className="space-y-3">
        <p role="alert" className="text-sm text-danger">
          {stream.error ?? "This result could not be loaded."}
        </p>
        <Button variant="outline" size="sm" onClick={stream.retry}>
          <RefreshCw className="h-4 w-4" aria-hidden />
          Try again
        </Button>
      </div>
    );
  }

  const view = stream.view;
  if (!view && stream.phase === "stalled") {
    return (
      <div className="space-y-3">
        <p className="text-sm text-text">The result could not be reached. Check your connection.</p>
        <Button variant="outline" size="sm" onClick={stream.retry}>
          <RefreshCw className="h-4 w-4" aria-hidden />
          Check again
        </Button>
      </div>
    );
  }
  if (!view) {
    return (
      <p className="flex items-center gap-2 text-sm text-text-secondary">
        <Loader2 className="h-4 w-4 animate-spin text-primary" aria-hidden />
        Connecting…
      </p>
    );
  }

  // A custom run has no expected output, so "Accepted" would claim a check
  // that never happened: a clean exit is reported as finished instead.
  const cleanCustomRun = view.kind === "run" && view.isCustom && view.verdict === "AC";
  // Live progress can run ahead of the last snapshot (the row still says
  // QUEUED while the worker is already compiling).
  const display =
    !view.terminal && stream.progress && stream.progress.state !== "QUEUED" ? "RUNNING" : view.display;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        {cleanCustomRun ? (
          <span className="text-sm font-semibold text-text">Finished</span>
        ) : (
          <VerdictBadge
            verdict={display}
            {...(display === "PARTIAL" ? { passed: view.passed, total: view.total } : {})}
          />
        )}
        <span className="text-sm text-text-secondary">{kindLabel(view)}</span>
        <span className="text-xs text-muted">{view.languageLabel}</span>
      </div>

      {!view.terminal && <LiveProgress stream={stream} sampleIndexes={sampleIndexes} />}

      {stream.phase === "stalled" && !view.terminal && (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-warning/25 bg-warning-subtle px-3 py-2">
          <p className="text-sm text-text">Still judging — this is taking longer than usual.</p>
          <Button variant="outline" size="sm" onClick={stream.retry}>
            <RefreshCw className="h-4 w-4" aria-hidden />
            Check again
          </Button>
        </div>
      )}

      <ResultSummary view={view} />

      <CompileOutput view={view} />

      {view.kind === "run" && view.custom && (
        <div className="space-y-2">
          {cleanCustomRun && (
            <p className="text-xs text-muted">Custom input has no expected output, so nothing was compared.</p>
          )}
          <div className="flex flex-wrap items-center gap-3 font-mono text-xs text-text-secondary">
            <span>{formatTimeMs(view.custom.ms)}</span>
            <span>{formatMemoryKb(view.custom.kb)}</span>
          </div>
          <OutputBlock title="Output (stdout)" text={view.custom.stdout} />
          {view.custom.stderr.length > 0 && (
            <OutputBlock title="Error output (stderr)" text={view.custom.stderr} tone="danger" />
          )}
        </div>
      )}

      {view.terminal && <TestResults view={view} />}

      {view.terminal && <ResultNotes view={view} />}
    </div>
  );
}
