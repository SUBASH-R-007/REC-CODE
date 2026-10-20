import { LIMITS, type TestResult, type Verdict } from "@recx/shared";

/**
 * Pure shaping of a worker's result before it is stored. Two rules matter:
 *
 *  1. Hidden tests keep only {i, v, ms, kb}. Their stdout/stderr are dropped
 *     here even if a (buggy or hostile) worker sent them — hidden data never
 *     reaches a row a student can read.
 *  2. Visible-case detail is bounded: every field ≤ 4 KB, the whole
 *     submission ≤ 32 KB (LIMITS.detail), cut on a UTF-8 character boundary.
 */

const MARKER = "\n… (truncated)";
const MARKER_BYTES = Buffer.byteLength(MARKER, "utf8");

export function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/**
 * At most maxBytes of UTF-8, never splitting a multi-byte character. When
 * there is room, the cut is marked; the marker counts toward maxBytes.
 */
export function truncateBytes(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  const buf = Buffer.from(text, "utf8");
  if (buf.byteLength <= maxBytes) return text;
  const marked = maxBytes > MARKER_BYTES;
  let cut = marked ? maxBytes - MARKER_BYTES : maxBytes;
  // Back up over continuation bytes (10xxxxxx) to a character start.
  while (cut > 0 && (buf[cut]! & 0xc0) === 0x80) cut--;
  return buf.subarray(0, cut).toString("utf8") + (marked ? MARKER : "");
}

/** The compact per-test jsonb stored on Submission.testResults. */
export interface CompactTestResult {
  i: number;
  v: Verdict;
  ms: number;
  kb: number;
}

/** One entry per test index (first wins), in index order, nothing but i/v/ms/kb. */
export function compactTestResults(tests: readonly TestResult[]): CompactTestResult[] {
  const seen = new Set<number>();
  const out: CompactTestResult[] = [];
  for (const t of [...tests].sort((a, b) => a.i - b.i)) {
    if (seen.has(t.i)) continue;
    seen.add(t.i);
    out.push({ i: t.i, v: t.v, ms: t.ms, kb: t.kb });
  }
  return out;
}

/** Visible test content as text (sample input and expected output). */
export interface SampleText {
  index: number;
  input: string;
  expected: string;
}

export interface SubmissionDetailRow {
  testIndex: number;
  input: string | null;
  expected: string | null;
  stdout: string | null;
  stderr: string | null;
}

/**
 * SubmissionTestDetail rows: sample tests only, each field ≤ perTestBytes,
 * all fields together ≤ perSubmissionBytes. Once the submission budget is
 * spent, later fields are stored as null.
 */
export function buildSubmissionDetails(
  tests: readonly TestResult[],
  samples: readonly SampleText[],
  limits: { perTestBytes: number; perSubmissionBytes: number } = LIMITS.detail,
): SubmissionDetailRow[] {
  const sampleByIndex = new Map(samples.map((s) => [s.index, s]));
  let budget = limits.perSubmissionBytes;
  const take = (text: string | null | undefined): string | null => {
    if (text === null || text === undefined) return null;
    const allowance = Math.min(limits.perTestBytes, budget);
    if (allowance <= 0) return null;
    const out = truncateBytes(text, allowance);
    budget -= utf8Bytes(out);
    return out;
  };

  const rows: SubmissionDetailRow[] = [];
  const seen = new Set<number>();
  for (const t of [...tests].sort((a, b) => a.i - b.i)) {
    const sample = sampleByIndex.get(t.i);
    // A hidden test never gets a detail row, whatever the worker sent.
    if (!sample || seen.has(t.i)) continue;
    seen.add(t.i);
    rows.push({
      testIndex: t.i,
      input: take(sample.input),
      expected: take(sample.expected),
      stdout: take(t.stdout),
      stderr: take(t.stderr),
    });
  }
  return rows;
}

/** One entry of RunRequest.result. */
export interface RunResultEntry {
  i: number;
  v: Verdict;
  ms: number;
  kb: number;
  stdout: string;
  stderr: string;
  input?: string;
  expected?: string;
}

/**
 * RunRequest.result. A run's tests are all visible (samples, or the one
 * custom-stdin case), so stdout (≤ 64 KB) and stderr (≤ 8 KB) are kept;
 * sample runs also carry the case's input and expected output (≤ 4 KB each).
 * Indices outside the run's own tests are dropped.
 */
export function buildRunResult(
  tests: readonly TestResult[],
  visible: { kind: "samples"; samples: readonly SampleText[] } | { kind: "custom" },
): RunResultEntry[] {
  const sampleByIndex = visible.kind === "samples" ? new Map(visible.samples.map((s) => [s.index, s])) : null;
  const seen = new Set<number>();
  const out: RunResultEntry[] = [];
  for (const t of [...tests].sort((a, b) => a.i - b.i)) {
    if (seen.has(t.i)) continue;
    const sample = sampleByIndex?.get(t.i);
    if (sampleByIndex ? !sample : t.i !== 0) continue;
    seen.add(t.i);
    const entry: RunResultEntry = {
      i: t.i,
      v: t.v,
      ms: t.ms,
      kb: t.kb,
      stdout: truncateBytes(t.stdout ?? "", LIMITS.customRun.stdoutBytes),
      stderr: truncateBytes(t.stderr ?? "", LIMITS.customRun.stderrBytes),
    };
    if (sample) {
      entry.input = truncateBytes(sample.input, LIMITS.detail.perTestBytes);
      entry.expected = truncateBytes(sample.expected, LIMITS.detail.perTestBytes);
    }
    out.push(entry);
  }
  return out;
}
