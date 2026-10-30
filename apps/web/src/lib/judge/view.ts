import { z } from "zod";
import {
  FUNCTION_COMPARATORS,
  LIMITS,
  SCORING_MODES,
  isVerdict,
  sanitizeToolOutput,
  truncateUtf8,
  verdictSchema,
  type CompareMode,
  type FunctionComparator,
  type ScoringMode,
  type Verdict,
  type VerdictDisplay,
} from "@recx/shared";

/**
 * The student-facing projection of a submission or a run. Pure and
 * server-safe: the JSON API, the SSE stream and the workspace all build what
 * a student sees through toStudentView(), so the hidden-test rule lives in
 * exactly one place.
 *
 *   Hidden (non-sample) tests expose ONLY {i, v, ms, kb} — no input, no
 *   expected output, no contestant output, no diff, no stderr.
 *   Sample tests may also expose input, expected and the contestant's stdout
 *   and stderr, each truncated to LIMITS.sampleDiffBytes with a marker.
 *   Custom runs expose their own stdout (≤ 64 KB) and stderr (≤ 8 KB).
 *   Compile output (sanitised by the worker, re-sanitised here) is shown
 *   only for a CE.
 *   Scores (PER_TEST / SUBTASK) live in a separate `scoring` block (per
 *   subtask {index, earned, max, verdict, tests[]}, per test {i, earned,
 *   max}), so a hidden test entry itself never grows a key.
 */

export type JudgeStatus = "QUEUED" | "JUDGING" | "DONE" | "INTERNAL_ERROR" | "CANCELLED";

const TERMINAL: ReadonlySet<JudgeStatus> = new Set(["DONE", "INTERNAL_ERROR", "CANCELLED"]);

/** A hidden test. Exactly these four keys — asserted by test/view.test.ts. */
export interface HiddenTestView {
  i: number;
  v: Verdict;
  ms: number;
  kb: number;
}

export interface SampleDetail {
  /** 1-based position among the problem's sample tests ("Sample 1"). */
  n: number;
  input: string | null;
  expected: string | null;
  stdout: string | null;
  stderr: string | null;
  /**
   * The judge's one sentence about this case: which row differs, or the
   * database's own message for a query that failed (Phase 12k). Stored for
   * visible cases only, so a hidden test can never have one.
   */
  message: string | null;
}

export interface SampleTestView extends HiddenTestView {
  sample: SampleDetail;
}

export type TestView = HiddenTestView | SampleTestView;

export function isSampleTest(test: TestView): test is SampleTestView {
  return "sample" in test;
}

export interface CustomRunOutput {
  v: Verdict;
  ms: number;
  kb: number;
  stdout: string;
  stderr: string;
}

interface BaseView {
  id: string;
  status: JudgeStatus;
  /** What the overall VerdictBadge shows (pending states included). */
  display: VerdictDisplay;
  verdict: Verdict | null;
  terminal: boolean;
  language: string;
  languageLabel: string;
  passed: number;
  total: number;
  compileOutput: string | null;
  tests: TestView[];
  createdAt: string;
  judgedAt: string | null;
  /** How output is compared — drives the "why was this Wrong Answer?" note. */
  compareMode: CompareMode | null;
  /** FUNCTION problems: the pinned version comparator (decides that note instead of compareMode). */
  functionComparator: FunctionComparator | null;
}

/** One subtask of a SUBTASK-scored submission. */
export interface SubtaskView {
  index: number;
  earned: number;
  max: number;
  verdict: Verdict;
  /** Indexes of the tests in this subtask, ascending. */
  tests: number[];
}

/** Points of one test (PER_TEST scoring). Hidden tests keep only {i, v, ms, kb} in `tests`. */
export interface TestPointsView {
  i: number;
  /**
   * Null for checker partial credit that cannot be itemised: the stored
   * result keeps only the total, so with two or more PARTIAL tests their
   * individual shares are unknown.
   */
  earned: number | null;
  max: number;
}

/** Points scoring. Null for ICPC problems, runs and unfinished submissions. */
export interface ScoreView {
  mode: Exclude<ScoringMode, "ICPC">;
  score: number;
  maxScore: number;
  /** SUBTASK only, by subtask index. */
  subtasks: SubtaskView[];
  /** Tests that belong to no reported subtask (SUBTASK only). */
  ungrouped: number[];
  /** PER_TEST only, by test index. */
  testPoints: TestPointsView[];
}

export interface SubmissionStudentView extends BaseView {
  kind: "submission";
  maxTimeMs: number | null;
  maxMemoryKb: number | null;
  scoring: ScoreView | null;
}

export interface RunStudentView extends BaseView {
  kind: "run";
  isCustom: boolean;
  custom: CustomRunOutput | null;
}

export type StudentView = SubmissionStudentView | RunStudentView;

// ── Inputs (plain data, shaped like the Prisma rows) ───────────────────

/** A sample TestCase of the pinned version, with its inline blobs. */
export interface SampleCase {
  index: number;
  input: string | null;
  expected: string | null;
}

/** Points and subtask of a TestCase of the pinned version (no content). */
export interface TestMeta {
  index: number;
  points: number | null;
  subtask: number | null;
}

/** A SubmissionTestDetail row (visible cases only). */
export interface VisibleDetail {
  testIndex: number;
  input: string | null;
  expected: string | null;
  stdout: string | null;
  stderr: string | null;
}

interface BaseSource {
  id: string;
  status: JudgeStatus;
  verdict: string | null;
  language: string;
  languageLabel: string;
  compileOutput: string | null;
  createdAt: Date;
  judgedAt: Date | null;
  /** Only the version's isSample cases. Hidden blobs are never loaded. */
  samples: SampleCase[];
  /** The pinned version's compare mode (optional for older callers). */
  compareMode?: CompareMode | null;
  /** The pinned version's functionSignature jsonb (FUNCTION problems); only its comparator is read. */
  functionSignature?: unknown;
}

export interface SubmissionViewSource extends BaseSource {
  kind: "submission";
  passedCases: number;
  totalCases: number;
  maxTimeMs: number | null;
  maxMemoryKb: number | null;
  /** Submission.testResults jsonb. */
  testResults: unknown;
  details: VisibleDetail[];
  /**
   * Scoring (Phase 2). Optional so a caller that does not load them still
   * builds; without them the view has no `scoring` block. scoringMode is
   * the pinned version's.
   */
  scoringMode?: ScoringMode | null;
  score?: number | null;
  maxScore?: number | null;
  /** Submission.subtaskResults jsonb: [{index, earned, max, verdict}]. */
  subtaskResults?: unknown;
  /** Every TestCase of the pinned version: index, points and subtask only. */
  testMeta?: TestMeta[];
}

export interface RunViewSource extends BaseSource {
  kind: "run";
  customInput: string | null;
  /** RunRequest.result jsonb. */
  result: unknown;
}

export type ViewSource = SubmissionViewSource | RunViewSource;

// ── Projection ─────────────────────────────────────────────────────────

/** Lenient reader for stored per-test entries; unknown keys are dropped. */
const storedTestSchema = z.object({
  i: z.number().int().nonnegative(),
  v: verdictSchema,
  ms: z.number().finite().nonnegative().catch(0),
  kb: z.number().finite().nonnegative().catch(0),
  stdout: z.string().nullish().catch(null),
  stderr: z.string().nullish().catch(null),
  input: z.string().nullish().catch(null),
  expected: z.string().nullish().catch(null),
  message: z.string().nullish().catch(null),
});
type StoredTest = z.infer<typeof storedTestSchema>;

function parseStoredTests(raw: unknown): StoredTest[] {
  if (!Array.isArray(raw)) return [];
  const byIndex = new Map<number, StoredTest>();
  for (const item of raw) {
    const parsed = storedTestSchema.safeParse(item);
    if (parsed.success) byIndex.set(parsed.data.i, parsed.data);
  }
  return [...byIndex.values()].sort((a, b) => a.i - b.i);
}

function clip(text: string | null | undefined, maxBytes: number): string | null {
  return text == null ? null : truncateUtf8(text, maxBytes);
}

/** The comparator declared in a stored functionSignature, or null (STDIN, missing, unknown). */
export function functionComparatorOf(signature: unknown): FunctionComparator | null {
  if (typeof signature !== "object" || signature === null) return null;
  const comparator = (signature as { comparator?: unknown }).comparator;
  return (FUNCTION_COMPARATORS as readonly unknown[]).includes(comparator) ? (comparator as FunctionComparator) : null;
}

/** The badge a row shows: pending states before a verdict, IE when none. */
export function displayFor(status: JudgeStatus, rawVerdict: string | null): VerdictDisplay {
  const verdict = isVerdict(rawVerdict) ? rawVerdict : null;
  switch (status) {
    case "QUEUED":
      return "QUEUED";
    case "JUDGING":
      return "RUNNING";
    case "DONE":
      return verdict ?? "IE";
    case "INTERNAL_ERROR":
      return "IE";
    case "CANCELLED":
      return verdict ?? "SKIPPED";
  }
}

/** The four permitted keys of a hidden test, built explicitly — never spread. */
function hiddenTest(t: StoredTest): HiddenTestView {
  return { i: t.i, v: t.v, ms: Math.round(t.ms), kb: Math.round(t.kb) };
}

function sampleTest(t: StoredTest, n: number, fields: Omit<SampleDetail, "n">): SampleTestView {
  const max = LIMITS.sampleDiffBytes;
  return {
    ...hiddenTest(t),
    sample: {
      n,
      input: clip(fields.input, max),
      expected: clip(fields.expected, max),
      stdout: clip(fields.stdout, max),
      stderr: clip(fields.stderr, max),
      message: clip(fields.message, 512),
    },
  };
}

function sampleOrdinals(samples: SampleCase[]): Map<number, { n: number; sample: SampleCase }> {
  const ordered = [...samples].sort((a, b) => a.index - b.index);
  return new Map(ordered.map((sample, k) => [sample.index, { n: k + 1, sample }]));
}

function base(source: ViewSource) {
  const verdict = isVerdict(source.verdict) ? source.verdict : null;
  const terminal = TERMINAL.has(source.status);
  return {
    id: source.id,
    status: source.status,
    display: displayFor(source.status, source.verdict),
    verdict,
    terminal,
    language: source.language,
    languageLabel: source.languageLabel,
    compileOutput:
      verdict === "CE" && source.compileOutput ? sanitizeToolOutput(source.compileOutput) : null,
    createdAt: source.createdAt.toISOString(),
    judgedAt: source.judgedAt ? source.judgedAt.toISOString() : null,
    compareMode: source.compareMode ?? null,
    functionComparator: functionComparatorOf(source.functionSignature),
  };
}

const storedSubtaskSchema = z.object({
  index: z.number().int().nonnegative(),
  earned: z.number().finite().nonnegative().catch(0),
  max: z.number().finite().nonnegative().catch(0),
  verdict: verdictSchema,
});
type StoredSubtask = z.infer<typeof storedSubtaskSchema>;

function parseStoredSubtasks(raw: unknown): StoredSubtask[] {
  if (!Array.isArray(raw)) return [];
  const byIndex = new Map<number, StoredSubtask>();
  for (const item of raw) {
    const parsed = storedSubtaskSchema.safeParse(item);
    if (parsed.success) byIndex.set(parsed.data.index, parsed.data);
  }
  return [...byIndex.values()].sort((a, b) => a.index - b.index);
}

/** A test without points weighs 1 (the worker's rule). */
const testWeight = (points: number | null) => points ?? 1;

function isScoringMode(value: unknown): value is ScoringMode {
  return typeof value === "string" && (SCORING_MODES as readonly string[]).includes(value);
}

/**
 * The points block of a finished, non-ICPC submission. The stored score is
 * authoritative; the per-test and per-subtask figures explain it.
 */
function scoringView(source: SubmissionViewSource, tests: StoredTest[]): ScoreView | null {
  if (source.status !== "DONE") return null;
  const subtasks = parseStoredSubtasks(source.subtaskResults);
  const mode = isScoringMode(source.scoringMode) ? source.scoringMode : subtasks.length > 0 ? "SUBTASK" : null;
  if (mode === null || mode === "ICPC") return null;
  const score = source.score;
  const maxScore = source.maxScore;
  if (score == null || maxScore == null || !Number.isFinite(score) || !Number.isFinite(maxScore) || maxScore <= 0) {
    return null;
  }
  const meta = [...(source.testMeta ?? [])].sort((a, b) => a.index - b.index);

  if (mode === "SUBTASK") {
    const known = new Set(subtasks.map((st) => st.index));
    return {
      mode,
      score,
      maxScore,
      subtasks: subtasks.map((st) => ({
        index: st.index,
        earned: st.earned,
        max: st.max,
        verdict: st.verdict,
        tests: meta.filter((m) => m.subtask === st.index).map((m) => m.index),
      })),
      ungrouped: meta.filter((m) => m.subtask === null || !known.has(m.subtask)).map((m) => m.index),
      testPoints: [],
    };
  }

  return { mode, score, maxScore, subtasks: [], ungrouped: [], testPoints: perTestPoints(meta, tests, score) };
}

/**
 * PER_TEST points: an AC test earns its points, a failed or skipped one 0.
 * A PARTIAL test (checker partial credit) earned a fraction the stored
 * result does not itemise; with exactly one such test it is the remainder
 * of the stored score, otherwise it is shown as unknown.
 */
function perTestPoints(meta: readonly TestMeta[], tests: readonly StoredTest[], score: number): TestPointsView[] {
  const verdictOf = new Map(tests.map((t) => [t.i, t.v]));
  const rows = meta.map((m) => {
    const max = testWeight(m.points);
    const v = verdictOf.get(m.index);
    return { i: m.index, max, partial: v === "PARTIAL", earned: v === "AC" ? max : 0 };
  });
  const partial = rows.filter((r) => r.partial);
  const known = rows.filter((r) => !r.partial).reduce((sum, r) => sum + r.earned, 0);
  const remainder = Math.round((score - known) * 100) / 100;
  return rows.map(({ i, max, partial: isPartial, earned }) => {
    if (!isPartial) return { i, max, earned };
    if (partial.length === 1 && remainder >= 0 && remainder <= max) return { i, max, earned: remainder };
    return { i, max, earned: null };
  });
}

function submissionView(source: SubmissionViewSource): SubmissionStudentView {
  const samples = sampleOrdinals(source.samples);
  const details = new Map(source.details.map((d) => [d.testIndex, d]));
  const stored = parseStoredTests(source.testResults);
  const tests = stored.map((t): TestView => {
    const known = samples.get(t.i);
    if (!known) return hiddenTest(t);
    const detail = details.get(t.i);
    return sampleTest(t, known.n, {
      input: detail?.input ?? known.sample.input,
      expected: detail?.expected ?? known.sample.expected,
      stdout: detail?.stdout ?? t.stdout ?? null,
      stderr: detail?.stderr ?? t.stderr ?? null,
      message: t.message ?? null,
    });
  });
  return {
    kind: "submission",
    ...base(source),
    passed: source.passedCases,
    total: source.totalCases,
    maxTimeMs: source.maxTimeMs,
    maxMemoryKb: source.maxMemoryKb,
    scoring: scoringView(source, stored),
    tests,
  };
}

function runView(source: RunViewSource): RunStudentView {
  const common = base(source);
  const stored = parseStoredTests(source.result);
  const isCustom = source.customInput !== null;

  if (isCustom) {
    const first = stored[0];
    const custom: CustomRunOutput | null =
      common.terminal && first && common.verdict !== "CE"
        ? {
            v: first.v,
            ms: Math.round(first.ms),
            kb: Math.round(first.kb),
            stdout: clip(first.stdout, LIMITS.customRun.stdoutBytes) ?? "",
            stderr: clip(first.stderr, LIMITS.customRun.stderrBytes) ?? "",
          }
        : null;
    return { kind: "run", ...common, isCustom, custom, tests: [], passed: 0, total: 0 };
  }

  // A sample run only ever contains sample tests; anything else is treated
  // as hidden, so a mis-built job can never leak a hidden test's output.
  const samples = sampleOrdinals(source.samples);
  const tests = stored.map((t): TestView => {
    const known = samples.get(t.i);
    if (!known) return hiddenTest(t);
    return sampleTest(t, known.n, {
      input: t.input ?? known.sample.input,
      expected: t.expected ?? known.sample.expected,
      stdout: t.stdout ?? null,
      stderr: t.stderr ?? null,
      message: t.message ?? null,
    });
  });
  return {
    kind: "run",
    ...common,
    isCustom,
    custom: null,
    tests,
    passed: tests.filter((t) => t.v === "AC").length,
    total: tests.length,
  };
}

export function toStudentView(source: SubmissionViewSource): SubmissionStudentView;
export function toStudentView(source: RunViewSource): RunStudentView;
export function toStudentView(source: ViewSource): StudentView;
export function toStudentView(source: ViewSource): StudentView {
  return source.kind === "submission" ? submissionView(source) : runView(source);
}

// ── Formatting (shared by the console and the history table) ──────────

export function formatTimeMs(ms: number | null | undefined): string {
  return ms == null ? "—" : `${Math.round(ms)} ms`;
}

/** isolate reports KiB; below 1 MB show KB, otherwise MB. */
export function formatMemoryKb(kb: number | null | undefined): string {
  if (kb == null) return "—";
  if (kb < 1024) return `${Math.round(kb)} KB`;
  const mb = kb / 1024;
  return `${mb < 100 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

/** Points without float noise: 62, 12.5, 33.33. */
export function formatPoints(points: number): string {
  if (!Number.isFinite(points)) return "—";
  const rounded = Math.round(points * 100) / 100;
  return Number.isInteger(rounded) ? String(rounded) : String(Number(rounded.toFixed(2)));
}

/** "62 / 100". */
export function formatScore(score: number, maxScore: number): string {
  return `${formatPoints(score)} / ${formatPoints(maxScore)}`;
}

/** Subtasks are shown 1-based, like tests ("Subtask 1" is index 0). */
export function subtaskLabel(index: number): string {
  return `Subtask ${index + 1}`;
}

/** "Sample 1" / "Hidden test 7" (hidden tests use the overall test number). */
export function testLabel(test: TestView): string {
  return isSampleTest(test) ? `Sample ${test.sample.n}` : `Hidden test ${test.i + 1}`;
}
