import { comparatorIssues } from "../harness/declaration";
import { FUNCTION_COMPARATORS, functionSignatureSchema, type FunctionComparator } from "../harness/signature";
import { DEBUG_BUDGET, countEditedLines, isDebugBudget } from "../debug-problem";
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

/**
 * STDIN compare modes an author may choose.
 *
 * INTERACTIVE joined the list in Phase 12l, when the engine learned to
 * judge one. It is last on purpose: it is the only mode whose problem
 * cannot be authored by typing expected output, and the form says so.
 */
export const AUTHORABLE_COMPARE_MODES = ["EXACT", "TOKEN", "FLOAT", "CHECKER", "INTERACTIVE"] as const;
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

/**
 * A SQL version's model solution is its REFERENCE QUERY, in the one
 * language it can be written in (Phase 12k). It is an error rather than a
 * warning: the expected result sets are produced by running it, so a SQL
 * problem without one has no answer at all.
 */
export const SQL_REFERENCE_LANGUAGE = "sql17";

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
  | "NO_CPP_MODEL"
  | "SQL_FIELDS"
  | "SQL_NO_REFERENCE"
  | "SQL_FOREIGN_REFERENCE"
  | "SQL_ARTEFACT"
  | "INTERACTIVE_NO_INTERACTOR"
  | "INTERACTIVE_ARTEFACT"
  | "INTERACTIVE_EXPECTED_OUTPUT"
  | "DEBUG_BUDGET_RANGE"
  | "DEBUG_NO_STARTER"
  | "DEBUG_NOT_APPLICABLE"
  | "DEBUG_UNSOLVABLE";

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
  /** SQL versions only (Phase 12k): null for every other io mode. */
  sqlDialect?: string | null;
  sqlOrdered?: boolean | null;
  floatEpsilon: number | null;
  functionSignature: unknown;
  checkerSha256: string | null;
  /** INTERACTIVE versions only (Phase 12l). */
  interactorSha256?: string | null;
  testlibId: string | null;
  scoringMode: ScoringMode;
  timeLimitMs: number;
  memoryLimitKb: number;
  statementMd: string;
  tests: readonly VersionContentTest[];
  subtasks: ReadonlyArray<{ index: number; points: number; dependsOn: readonly number[] }>;
  references: ReadonlyArray<{ language: string; expectedVerdict: Verdict; source?: string }>;
  /**
   * The starter programs, per language (Phase 12m). A debugging problem's
   * starter is the BROKEN program, so for one of those this list is the
   * question itself — and the languages in it are the only ones the
   * problem is offered in.
   */
  starters?: ReadonlyArray<{ language: string; code: string }>;
  /** A debugging problem's edit budget (Phase 12m); null for every other problem. */
  maxEditedLines?: number | null;
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

/**
 * A SQL version's own rules (Phase 12k).
 *
 * The CHECKs in the database say most of this too, and deliberately: an
 * author should read it here, in a sentence, rather than meet a constraint
 * violation. The one rule that is ONLY here is the reference query, because
 * no constraint can say "this version has a model solution in the one
 * language that can produce its expected results".
 */
function sqlIssues(v: VersionContentInput): Array<{ code: ContentIssueCode; message: string }> {
  const out: Array<{ code: ContentIssueCode; message: string }> = [];
  if (v.compareMode !== "ROWS") {
    out.push({ code: "SQL_FIELDS", message: "A SQL problem compares result sets; set the compare mode to ROWS." });
  }
  if (!v.sqlDialect) {
    out.push({ code: "SQL_FIELDS", message: "A SQL problem must state its dialect." });
  }
  if (v.sqlOrdered === null || v.sqlOrdered === undefined) {
    out.push({
      code: "SQL_FIELDS",
      message: "Say whether the row order is part of the answer: a question with ORDER BY is marked in order.",
    });
  }
  if (v.functionSignature !== null && v.functionSignature !== undefined) {
    out.push({ code: "SQL_ARTEFACT", message: "A SQL problem has no function signature; remove it." });
  }
  if (v.checkerSha256 !== null || v.testlibId !== null) {
    out.push({
      code: "SQL_ARTEFACT",
      message: "A SQL problem has no checker: the comparison is the result set. Remove the checker.",
    });
  }
  const references = v.references.filter((r) => r.language === SQL_REFERENCE_LANGUAGE);
  if (!references.some((r) => r.expectedVerdict === "AC")) {
    out.push({
      code: "SQL_NO_REFERENCE",
      message: "A SQL problem needs a reference query (expected AC): running it is what produces the expected results.",
    });
  }
  const foreign = v.references.filter((r) => r.language !== SQL_REFERENCE_LANGUAGE).map((r) => r.language);
  if (foreign.length > 0) {
    out.push({
      code: "SQL_FOREIGN_REFERENCE",
      message: `A SQL problem's solutions are queries; remove the ${[...new Set(foreign)].join(", ")} one${foreign.length === 1 ? "" : "s"}.`,
    });
  }
  return out;
}

/**
 * An interactive version's own rules (Phase 12l).
 *
 * The database says the first three too (the CHECKs of migration
 * 20261101140000), and deliberately: an author reads a sentence here
 * rather than meeting a constraint violation. The one rule that is ONLY
 * here is the expected output — no constraint can say "these bytes are
 * meaningless", because `TestCase.outputSha256` is required for every kind
 * of problem and an interactive case stores the empty blob in it.
 */
function interactiveIssues(v: VersionContentInput): Array<{ code: ContentIssueCode; message: string }> {
  const out: Array<{ code: ContentIssueCode; message: string }> = [];
  if (!v.interactorSha256 || !v.testlibId) {
    out.push({
      code: "INTERACTIVE_NO_INTERACTOR",
      message:
        "An interactive problem needs an interactor (C++ with testlib): it talks to the student's program and decides the verdict.",
    });
  }
  if (v.checkerSha256) {
    out.push({
      code: "INTERACTIVE_ARTEFACT",
      message: "An interactive problem is judged by its interactor, not by a checker as well. Remove the checker.",
    });
  }
  if (v.floatEpsilon !== null) {
    out.push({
      code: "INTERACTIVE_ARTEFACT",
      message: "An interactive problem compares no output, so a float tolerance would change nothing. Remove it.",
    });
  }
  const withOutput = v.tests.filter((t) => t.outputBytes > 0).map((t) => t.index);
  if (withOutput.length > 0) {
    out.push({
      code: "INTERACTIVE_EXPECTED_OUTPUT",
      message:
        `Test${withOutput.length === 1 ? "" : "s"} ${withOutput.slice(0, 5).join(", ")} carr${withOutput.length === 1 ? "ies" : "y"} ` +
        "expected output, and an interactive problem compares none: the case's input is the interactor's data, and the interactor decides. " +
        "Clear the expected output.",
    });
  }
  return out;
}

/**
 * A debugging version's own rules (Phase 12m).
 *
 * The first two the database says as well (the CHECKs of migration
 * 20261101150000), for the reason the SQL and interactive rules are said
 * twice: an author should read a sentence rather than meet a constraint
 * violation.
 *
 * The other two cannot be CHECKs, and they are the ones that matter. A
 * budget with no broken program is a question with nothing to repair and
 * no language to repair it in — the workspace offers exactly the languages
 * that have a starter. And a budget the author's OWN fix does not fit is a
 * question nobody can answer: the model solution is the proof that the
 * mistake can be put right in the lines allowed, so it is measured here
 * rather than discovered by the first student who tries.
 */
function debugIssues(v: VersionContentInput): Array<{ code: ContentIssueCode; message: string }> {
  const budget = v.maxEditedLines ?? null;
  if (budget === null) return [];
  const out: Array<{ code: ContentIssueCode; message: string }> = [];
  if (!isDebugBudget(budget)) {
    out.push({
      code: "DEBUG_BUDGET_RANGE",
      message: `The edit budget must be a whole number of lines between ${DEBUG_BUDGET.min} and ${DEBUG_BUDGET.max} (got ${budget}).`,
    });
  }
  if (v.ioMode === "SQL" || v.compareMode === "INTERACTIVE") {
    out.push({
      code: "DEBUG_NOT_APPLICABLE",
      message:
        "An edit budget belongs to a problem that hands the student a program to repair. A SQL query and a conversation are neither; remove the budget.",
    });
    return out;
  }
  const starters = v.starters ?? [];
  const written = starters.filter((s) => s.code.trim().length > 0);
  if (written.length === 0) {
    out.push({
      code: "DEBUG_NO_STARTER",
      message:
        "A debugging problem needs the broken program as starter code: it is the question, and the languages it is written in are the only ones the problem is offered in.",
    });
    return out;
  }
  for (const starter of written) {
    const model = v.references.find(
      (r) => r.language === starter.language && r.expectedVerdict === "AC" && typeof r.source === "string",
    );
    if (!model?.source) continue;
    const changed = countEditedLines(starter.code, model.source);
    if (changed > budget) {
      out.push({
        code: "DEBUG_UNSOLVABLE",
        message: `The ${starter.language} model solution changes ${changed} lines of the ${starter.language} starter, and the budget allows ${budget}. Either the budget is too small or the model solution was rewritten rather than repaired.`,
      });
    }
  }
  return out;
}

/** Every structural problem of a revision's content. Empty of errors = may be approved and published. */
export function versionContentIssues(v: VersionContentInput): ContentIssue[] {
  const issues: ContentIssue[] = [];
  const error = (code: ContentIssueCode, message: string) => issues.push({ code, severity: "error", message });
  const warning = (code: ContentIssueCode, message: string) => issues.push({ code, severity: "warning", message });

  if (v.ioMode === "SQL") for (const issue of sqlIssues(v)) error(issue.code, issue.message);
  else for (const message of comparatorIssues(v)) error("COMPARATOR", message);
  if (v.compareMode === "INTERACTIVE" && v.ioMode === "STDIN") {
    for (const issue of interactiveIssues(v)) error(issue.code, issue.message);
  }
  for (const issue of debugIssues(v)) error(issue.code, issue.message);
  if (v.ioMode === "STDIN" && v.functionSignature !== null && v.functionSignature !== undefined) {
    error("SIGNATURE_ON_STDIN", "A standard-input problem must not carry a function signature.");
  }
  if (v.ioMode === "FUNCTION") {
    const sig = functionSignatureSchema.safeParse(v.functionSignature);
    if (sig.success && !JUDGEABLE_FUNCTION_COMPARATORS.includes(sig.data.comparator)) {
      error("COMPARATOR_NOT_JUDGEABLE", `The ${sig.data.comparator} comparator is not judged by this judge fleet yet.`);
    }
  }
  if (v.ioMode !== "SQL" && (v.sqlDialect || v.sqlOrdered !== null) && v.sqlOrdered !== undefined) {
    error("SQL_FIELDS", "Only a SQL problem carries a dialect and an ordering rule.");
  }
  if (v.checkerSha256 && v.compareMode !== "CHECKER" && v.ioMode !== "SQL" && v.compareMode !== "INTERACTIVE") {
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

  if (v.ioMode !== "SQL") {
    const cppModel = v.references.some((r) => r.expectedVerdict === "AC" && CPP_MODEL_LANGUAGES.includes(r.language));
    if (!cppModel) warning("NO_CPP_MODEL", "There is no C++ (cpp17 / cpp20) model solution yet; validation needs one before publishing.");
  }
  return issues;
}

export function contentErrors(issues: readonly ContentIssue[]): ContentIssue[] {
  return issues.filter((i) => i.severity === "error");
}
