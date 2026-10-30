import { VerdictBadge } from "@recx/design";
import { FUNCTION_COMPARATOR_DESCRIPTIONS, type CompareMode } from "@recx/shared";
import {
  formatMemoryKb,
  formatPoints,
  formatScore,
  formatTimeMs,
  isSampleTest,
  subtaskLabel,
  testLabel,
  type ScoreView,
  type StudentView,
  type SubmissionStudentView,
  type TestPointsView,
  type TestView,
} from "@/lib/judge/view";

/**
 * The presentational pieces of a judged result — no hooks, no handlers — so
 * the workspace console (client) and the full submission page (server)
 * render the same thing from the same StudentView. The hidden-test rule is
 * already applied by toStudentView(); this only displays.
 */

/** Shown under every result that lists hidden tests. */
export const HIDDEN_TEST_NOTE = "Hidden tests report only the test number, verdict, time and memory.";
/** Shown whenever a Wrong Answer is on screen. */
export const WA_NOTE = "Output is compared token by token — extra spaces and blank lines are ignored.";

/** The "why Wrong Answer?" note for each compare mode (TOKEN is the default). */
export const WA_NOTES: Readonly<Record<CompareMode, string>> = {
  TOKEN: WA_NOTE,
  EXACT: "Output must match exactly, byte for byte — including spaces and line breaks.",
  FLOAT: "Numbers are compared with a small tolerance (absolute or relative); everything else token by token.",
  CHECKER: "A checker program verifies your answer, so any correct answer is accepted — this one was not.",
  INTERACTIVE: "Your program's dialogue with the interactor did not reach a correct result.",
  // Phase 12k. A SQL answer is a result set: the columns, the rows and
  // (when the question asks for an order) the order.
  ROWS: "Your query's result set is compared with the answer's: the number of columns, the rows, and the order when the question asks for one.",
};

/**
 * The "why Wrong Answer?" note: a FUNCTION problem's comparator decides it
 * (its output is compared structurally, never token by token); otherwise the
 * compare mode.
 */
export function waNote(view: Pick<StudentView, "compareMode" | "functionComparator">): string {
  if (view.functionComparator) return FUNCTION_COMPARATOR_DESCRIPTIONS[view.functionComparator].student;
  return WA_NOTES[view.compareMode ?? "TOKEN"];
}

export function OutputBlock({ title, text, tone }: { title: string; text: string; tone?: "danger" }) {
  return (
    <div className="min-w-0">
      <p className="mb-1 text-xs font-medium uppercase tracking-wide text-muted">{title}</p>
      {/* Focusable so a long output can be scrolled from the keyboard. */}
      <pre
        tabIndex={0}
        aria-label={title}
        className={
          tone === "danger"
            ? "scroll-thin max-h-48 overflow-auto rounded-lg border border-danger/20 bg-danger-subtle px-3 py-2 font-mono text-xs whitespace-pre-wrap break-words text-text"
            : "scroll-thin max-h-48 overflow-auto rounded-lg border border-border bg-background px-3 py-2 font-mono text-xs whitespace-pre-wrap break-words text-text"
        }
      >
        {text.length > 0 ? text : "(empty)"}
      </pre>
    </div>
  );
}

/** "10 / 10 pts" for a PER_TEST problem; "? / 10 pts" when partial credit is not itemised. */
function PointsLabel({ points }: { points: TestPointsView }) {
  const earned = points.earned === null ? "?" : formatPoints(points.earned);
  return (
    <span className="font-sans text-text">
      {earned} / {formatPoints(points.max)} pts
      {points.earned === null && <span className="sr-only"> (partial credit, share not itemised)</span>}
    </span>
  );
}

function TestRow({ test, points }: { test: TestView; points?: TestPointsView | undefined }) {
  const metrics = (
    <span className="ml-auto flex shrink-0 items-center gap-3 font-mono text-xs text-text-secondary tabular-nums">
      {points && <PointsLabel points={points} />}
      <span>{formatTimeMs(test.ms)}</span>
      <span>{formatMemoryKb(test.kb)}</span>
    </span>
  );
  if (!isSampleTest(test)) {
    return (
      <li className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
        <span className="w-28 shrink-0 text-sm font-medium">{testLabel(test)}</span>
        <VerdictBadge verdict={test.v} size="sm" />
        {metrics}
      </li>
    );
  }
  const { sample } = test;
  return (
    <li className="px-3 py-2">
      <details className="group" open={test.v !== "AC"}>
        <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-3 gap-y-1 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-primary/40 [&::-webkit-details-marker]:hidden">
          <span className="w-28 shrink-0 text-sm font-medium">
            {testLabel(test)}
            <span className="sr-only"> (show details)</span>
          </span>
          <VerdictBadge verdict={test.v} size="sm" />
          {metrics}
        </summary>
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          {sample.input !== null && <OutputBlock title="Input" text={sample.input} />}
          {sample.expected !== null && <OutputBlock title="Expected output" text={sample.expected} />}
          {sample.stdout !== null && <OutputBlock title="Your output" text={sample.stdout} />}
          {sample.stderr ? <OutputBlock title="Error output (stderr)" text={sample.stderr} tone="danger" /> : null}
        </div>
      </details>
    </li>
  );
}

export function ResultNotes({ view }: { view: StudentView }) {
  const hasHidden = view.tests.some((t) => !isSampleTest(t));
  const hasWa = view.verdict === "WA" || view.tests.some((t) => t.v === "WA");
  if (!hasHidden && !hasWa) return null;
  return (
    <ul className="space-y-1 text-xs text-muted">
      {hasWa && <li>{waNote(view)}</li>}
      {hasHidden && <li>{HIDDEN_TEST_NOTE}</li>}
    </ul>
  );
}

/** The overall points line of a PER_TEST / SUBTASK submission: "Score 62 / 100". */
function ScoreLine({ scoring }: { scoring: ScoreView }) {
  return (
    <p className="flex flex-wrap items-baseline gap-x-2 text-sm text-text-secondary">
      <span>Score</span>
      <span className="font-display text-2xl font-bold tracking-tight text-text tabular-nums">
        {formatScore(scoring.score, scoring.maxScore)}
      </span>
      <span className="text-xs text-muted">{scoring.mode === "SUBTASK" ? "points from subtasks" : "points from tests"}</span>
    </p>
  );
}

export function ResultSummary({ view }: { view: StudentView }) {
  if (!view.terminal) return null;
  if (view.kind === "submission" && view.scoring && view.verdict === "CE") return <ScoreLine scoring={view.scoring} />;
  if (view.verdict === "CE") return null;
  if (view.kind === "submission") {
    return (
      <div className="space-y-1">
        {view.scoring && <ScoreLine scoring={view.scoring} />}
        <p className="text-sm text-text-secondary tabular-nums">
          Passed <span className="font-semibold text-text">{view.passed}</span> of {view.total} tests
          <span className="mx-1.5 text-muted" aria-hidden>
            ·
          </span>
          <span className="font-mono text-xs">{formatTimeMs(view.maxTimeMs)}</span>
          <span className="mx-1.5 text-muted" aria-hidden>
            ·
          </span>
          <span className="font-mono text-xs">{formatMemoryKb(view.maxMemoryKb)}</span>
        </p>
      </div>
    );
  }
  if (view.isCustom) return null;
  return (
    <p className="text-sm text-text-secondary">
      Passed <span className="font-semibold text-text">{view.passed}</span> of {view.total} sample tests
    </p>
  );
}

/** Compiler output of a CE (already sanitised by toStudentView). */
export function CompileOutput({ view }: { view: StudentView }) {
  if (view.verdict !== "CE") return null;
  return (
    <div>
      <p className="mb-1 text-xs font-medium uppercase tracking-wide text-muted">Compiler output</p>
      <pre
        tabIndex={0}
        aria-label="Compiler output"
        className="scroll-thin max-h-72 overflow-auto rounded-lg border border-danger/20 bg-danger-subtle px-3 py-2 font-mono text-xs whitespace-pre-wrap break-words text-text"
      >
        {view.compileOutput ?? "The compiler reported an error but produced no output."}
      </pre>
    </div>
  );
}

/** A plain list of test rows, with per-test points for PER_TEST problems. */
function TestList({ tests, points, label }: { tests: TestView[]; points?: ReadonlyMap<number, TestPointsView>; label: string }) {
  return (
    <ul className="divide-y divide-border rounded-xl border border-border" aria-label={label}>
      {tests.map((t) => (
        <TestRow key={t.i} test={t} points={points?.get(t.i)} />
      ))}
    </ul>
  );
}

/**
 * SUBTASK results: one block per subtask (earned / max points and its
 * verdict), holding the tests that ran in it. Tests that belong to no
 * reported subtask are listed last.
 */
function SubtaskResults({
  view,
  scoring,
  headingLevel,
}: {
  view: SubmissionStudentView;
  scoring: ScoreView;
  headingLevel: 3 | 4;
}) {
  const Heading = headingLevel === 3 ? "h3" : "h4";
  const byIndex = new Map(view.tests.map((t) => [t.i, t]));
  const pick = (indexes: readonly number[]) =>
    indexes.flatMap((i) => {
      const t = byIndex.get(i);
      return t ? [t] : [];
    });
  const grouped = new Set(scoring.subtasks.flatMap((st) => st.tests));
  const others = view.tests.filter((t) => !grouped.has(t.i));
  return (
    <div className="space-y-3">
      {scoring.subtasks.map((st) => {
        const tests = pick(st.tests);
        return (
          <section
            key={st.index}
            aria-label={`${subtaskLabel(st.index)}: ${formatPoints(st.earned)} of ${formatPoints(st.max)} points`}
            className="rounded-xl border border-border"
          >
            <header className="flex flex-wrap items-center gap-3 border-b border-border bg-background px-3 py-2">
              <Heading className="text-sm font-semibold text-text">{subtaskLabel(st.index)}</Heading>
              <VerdictBadge verdict={st.verdict} size="sm" />
              <span className="ml-auto text-sm text-text-secondary tabular-nums">
                <span className="font-semibold text-text">{formatPoints(st.earned)}</span> / {formatPoints(st.max)} points
              </span>
            </header>
            {tests.length > 0 ? (
              <ul className="divide-y divide-border" aria-label={`${subtaskLabel(st.index)} tests`}>
                {tests.map((t) => (
                  <TestRow key={t.i} test={t} />
                ))}
              </ul>
            ) : (
              <p className="px-3 py-2 text-xs text-muted">
                {st.tests.length > 0
                  ? "No test in this subtask was run."
                  : "The tests of this subtask are not listed for this submission."}
              </p>
            )}
          </section>
        );
      })}
      {others.length > 0 && <TestList tests={others} label="Other test results" />}
    </div>
  );
}

/** Per-test rows (grouped by subtask for SUBTASK problems). */
export function TestResults({ view, headingLevel = 3 }: { view: StudentView; headingLevel?: 3 | 4 }) {
  const scoring = view.kind === "submission" ? view.scoring : null;
  if (view.kind === "submission" && scoring?.mode === "SUBTASK" && view.verdict !== "CE") {
    return <SubtaskResults view={view} scoring={scoring} headingLevel={headingLevel} />;
  }
  if (view.tests.length === 0) return null;
  if (scoring?.mode === "PER_TEST") {
    const points = new Map(scoring.testPoints.map((p) => [p.i, p]));
    return <TestList tests={view.tests} points={points} label="Test results" />;
  }
  return <TestList tests={view.tests} label="Test results" />;
}
