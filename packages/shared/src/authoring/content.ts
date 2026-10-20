import { comparatorIssues } from "../harness/declaration";
import { FUNCTION_COMPARATORS, functionSignatureSchema, type FunctionComparator } from "../harness/signature";
import { LIMITS } from "../limits";
import type { CompareMode, IoMode, ScoringMode } from "../protocol";
import type { Verdict } from "../verdict";

/**
 * The structural publish rules of a revision: what its content must look
 * like before it can be approved or published. Pure, so the authoring UI,
 * the import pipeline, the approve gate and the publish gate share one
 * definition. Errors block; warnings are shown.
 *
 * The comparator rules ("a problem cannot publish without a declared
 * comparator") come from the harness stream's comparatorIssues(): every
 * string it returns is an error here.
 */

/** STDIN compare modes an author may choose. INTERACTIVE is not available on this judge. */
export const AUTHORABLE_COMPARE_MODES = ["EXACT", "TOKEN", "FLOAT", "CHECKER"] as const;
export type AuthorableCompareMode = (typeof AUTHORABLE_COMPARE_MODES)[number];

/**
 * FUNCTION comparators this judge fleet applies. The worker judges all six
 * (protocol 3), so every declared comparator is judgeable.
 */
export const JUDGEABLE_FUNCTION_COMPARATORS: readonly FunctionComparator[] = FUNCTION_COMPARATORS;

/** The verdicts a reference solution may be expected to produce. */
export const REFERENCE_EXPECTED_VERDICTS = ["AC", "WA", "TLE", "MLE", "RE"] as const;
export type ReferenceExpectedVerdict = (typeof REFERENCE_EXPECTED_VERDICTS)[number];

/** A C++ model solution in one of these is mandatory before publishing. */
export const CPP_MODEL_LANGUAGES: readonly string[] = ["cpp17", "cpp20"];

/** Memory floor an author may set (16 MiB, the judge's own clamp). */
export const MIN_MEMORY_LIMIT_KB = 16 * 1024;

export type ContentIssueCode =
  | "COMPARATOR"
  | "COMPARATOR_NOT_JUDGEABLE"
  | "SIGNATURE_ON_STDIN"
  | "CHECKER_UNUSED"
  | "LIMIT_OUT_OF_RANGE"
  | "NO_SAMPLE"
  | "NO_HIDDEN_TEST"
  | "SAMPLE_NOT_INLINE"
  | "TEST_INDEX_GAP"
  | "TEST_POINTS"
  | "SUBTASK_TABLE"
  | "STATEMENT_EMPTY"
  | "NO_CPP_MODEL";

export interface ContentIssue {
  code: ContentIssueCode;
  severity: "error" | "warning";
  message: string;
}

export interface VersionContentTest {
  index: number;
  isSample: boolean;
  subtaskIndex: number | null;
  points: number | null;
  inputBytes: number;
  outputBytes: number;
  /** Both blobs are stored inline (≤ 64 KB of UTF-8): the workspace shows only inline samples. */
  sampleInlineable: boolean;
}

export interface VersionContentInput {
  ioMode: IoMode;
  compareMode: CompareMode;
  floatEpsilon: number | null;
  functionSignature: unknown;
  checkerSha256: string | null;
  testlibId: string | null;
  scoringMode: ScoringMode;
  timeLimitMs: number;
  memoryLimitKb: number;
  statementMd: string;
  tests: readonly VersionContentTest[];
  subtasks: ReadonlyArray<{ index: number; points: number; dependsOn: readonly number[] }>;
  references: ReadonlyArray<{ language: string; expectedVerdict: Verdict }>;
}

function subtaskIssues(v: VersionContentInput): string[] {
  const out: string[] = [];
  if (v.scoringMode !== "SUBTASK") {
    if (v.subtasks.length > 0) out.push(`Subtasks are defined but the scoring mode is ${v.scoringMode}; remove them or score by SUBTASK.`);
    const tagged = v.tests.filter((t) => t.subtaskIndex !== null).map((t) => t.index);
    if (tagged.length > 0) out.push(`Tests ${tagged.slice(0, 5).join(", ")} name a subtask, but the scoring mode is ${v.scoringMode}.`);
    return out;
  }
  if (v.subtasks.length === 0) {
    out.push("SUBTASK scoring needs at least one subtask.");
    return out;
  }
  const defined = new Set<number>();
  for (const s of [...v.subtasks].sort((a, b) => a.index - b.index)) {
    if (defined.has(s.index)) out.push(`Subtask ${s.index} is defined twice.`);
    if (!(s.points > 0)) out.push(`Subtask ${s.index} must be worth more than 0 points.`);
    for (const dep of s.dependsOn) {
      if (dep >= s.index || !defined.has(dep)) out.push(`Subtask ${s.index} may depend only on an earlier subtask (not ${dep}).`);
    }
    defined.add(s.index);
  }
  const used = new Set<number>();
  for (const t of v.tests) {
    if (t.subtaskIndex === null) out.push(`Test ${t.index} belongs to no subtask.`);
    else if (!defined.has(t.subtaskIndex)) out.push(`Test ${t.index} names subtask ${t.subtaskIndex}, which is not defined.`);
    else used.add(t.subtaskIndex);
  }
  for (const s of defined) if (!used.has(s)) out.push(`Subtask ${s} has no tests.`);
  return out;
}

/** Every structural problem of a revision's content. Empty of errors = may be approved and published. */
export function versionContentIssues(v: VersionContentInput): ContentIssue[] {
  const issues: ContentIssue[] = [];
  const error = (code: ContentIssueCode, message: string) => issues.push({ code, severity: "error", message });
  const warning = (code: ContentIssueCode, message: string) => issues.push({ code, severity: "warning", message });

  for (const message of comparatorIssues(v)) error("COMPARATOR", message);
  if (v.ioMode === "STDIN" && v.functionSignature !== null && v.functionSignature !== undefined) {
    error("SIGNATURE_ON_STDIN", "A standard-input problem must not carry a function signature.");
  }
  if (v.ioMode === "FUNCTION") {
    const sig = functionSignatureSchema.safeParse(v.functionSignature);
    if (sig.success && !JUDGEABLE_FUNCTION_COMPARATORS.includes(sig.data.comparator)) {
      error("COMPARATOR_NOT_JUDGEABLE", `The ${sig.data.comparator} comparator is not judged by this judge fleet yet.`);
    }
  }
  if (v.checkerSha256 && v.compareMode !== "CHECKER") {
    warning("CHECKER_UNUSED", "A checker is attached but the compare mode is not CHECKER, so it is never run.");
  }

  const { floorMs, ceilingMs } = LIMITS.cpuTime;
  if (!Number.isInteger(v.timeLimitMs) || v.timeLimitMs < floorMs || v.timeLimitMs > ceilingMs) {
    error("LIMIT_OUT_OF_RANGE", `The time limit must be between ${floorMs} ms and ${ceilingMs / 1000} s (got ${v.timeLimitMs} ms).`);
  }
  const ceilingKb = LIMITS.memory.ceilingKb;
  if (!Number.isInteger(v.memoryLimitKb) || v.memoryLimitKb < MIN_MEMORY_LIMIT_KB || v.memoryLimitKb > ceilingKb) {
    error(
      "LIMIT_OUT_OF_RANGE",
      `The memory limit must be between ${MIN_MEMORY_LIMIT_KB / 1024} MB and ${ceilingKb / 1024} MB (got ${Math.round(v.memoryLimitKb / 1024)} MB).`,
    );
  }

  if (v.statementMd.trim().length === 0) error("STATEMENT_EMPTY", "The statement is empty.");

  const samples = v.tests.filter((t) => t.isSample);
  if (samples.length === 0) error("NO_SAMPLE", "At least one sample test is needed (students see samples in the statement).");
  if (v.tests.every((t) => t.isSample)) error("NO_HIDDEN_TEST", "At least one hidden (non-sample) test is needed.");
  for (const t of samples) {
    if (!t.sampleInlineable) {
      error(
        "SAMPLE_NOT_INLINE",
        `Sample test ${t.index} is larger than ${LIMITS.inlineBlobBytes / 1024} KB or is not UTF-8 text, so students cannot see it. Make it hidden or smaller.`,
      );
    }
  }
  const indexes = [...v.tests.map((t) => t.index)].sort((a, b) => a - b);
  if (indexes.some((index, i) => index !== i)) error("TEST_INDEX_GAP", "Test indexes must run 0, 1, 2, … without gaps.");
  for (const t of v.tests) {
    if (t.points !== null && (!Number.isInteger(t.points) || t.points <= 0)) {
      error("TEST_POINTS", `Test ${t.index} has invalid points (${t.points}); use a positive whole number or none.`);
    }
  }
  for (const message of subtaskIssues(v)) error("SUBTASK_TABLE", message);

  const cppModel = v.references.some((r) => r.expectedVerdict === "AC" && CPP_MODEL_LANGUAGES.includes(r.language));
  if (!cppModel) warning("NO_CPP_MODEL", "There is no C++ (cpp17 / cpp20) model solution yet; validation needs one before publishing.");
  return issues;
}

export function contentErrors(issues: readonly ContentIssue[]): ContentIssue[] {
  return issues.filter((i) => i.severity === "error");
}
