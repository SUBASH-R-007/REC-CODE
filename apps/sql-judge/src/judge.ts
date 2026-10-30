import { createHash } from "node:crypto";
import {
  compareResultSets,
  parseExpectedResultSet,
  sqlCaseMessage,
  type BlobRef,
  type SqlCaseSpec,
  type SqlJobSpec,
  type SqlResultSet,
  type TestResult,
  type Verdict,
} from "@recx/shared";
import { InfraError, PermanentJudgeError } from "./errors";
import type { Logger } from "./logger";
import type { QueryOutcome } from "./sandbox";

/**
 * Judging one SQL job: fetch the data, run each case, decide the verdict
 * (Phase 12k).
 *
 * The mapping from what the database said to what the student is told is
 * the whole of this file, and it is written down here rather than spread
 * through the sandbox:
 *
 *   a parse-time error (class 42: syntax, unknown column, unknown table)
 *                                 → CE, and the submission ends there.
 *                                   PostgreSQL refusing to prepare a
 *                                   statement is the SQL analogue of a
 *                                   compiler refusing to compile, and it is
 *                                   deterministic — running the other cases
 *                                   would say the same thing four times.
 *   more than one statement        → CE, same reasoning: the server refused
 *                                   it before it ran.
 *   a runtime error (division by
 *   zero, a bad cast, a refused
 *   write, a privilege)            → RE for that case.
 *   statement_timeout              → TLE for that case.
 *   more rows than the cap         → OLE: too much output is too much
 *                                   output, whatever produced it.
 *   a different result set         → WA.
 *   the same result set            → AC.
 *
 * MLE has no meaning here: a query's memory is the server's business and
 * `work_mem` spills to disk rather than failing, so a query that would have
 * been MLE is a query that is TLE instead. That is stated rather than
 * hidden, because a verdict the engine cannot produce is one nobody should
 * go looking for in a log.
 */

/** Parse-time refusals: the query never ran, so the submission is CE. */
function isCompileError(outcome: Extract<QueryOutcome, { kind: "error" | "refused" }>): boolean {
  if (outcome.kind === "refused") {
    // A write refused by a read-only transaction, or a privilege, happened
    // at runtime. A second command was refused before anything ran.
    return outcome.code !== "25006" && outcome.code !== "42501";
  }
  // Class 42 is "syntax error or access rule violation"; 3F000 is an
  // unknown schema. Both are parse-time.
  return outcome.code.startsWith("42") || outcome.code === "3F000";
}

export interface SandboxLike {
  runCase(input: { setup: string; source: string; maxRows: number }): Promise<QueryOutcome>;
}

export interface BlobReader {
  (ref: BlobRef): Promise<Buffer>;
}

export interface SqlOutcome {
  verdict: Verdict;
  compile: { ok: boolean; output: string; timeMs: number; cached: boolean; resourceExceeded: boolean } | null;
  tests: TestResult[];
  passedCases: number;
  totalCases: number;
  maxTimeMs: number;
  maxMemoryKb: number;
  firstFailedIndex: number | null;
  score: number | null;
  maxScore: number | null;
  cpuMs: number;
}

/** sha256 of a blob's bytes, so a corrupt delivery is never judged. */
function verify(ref: BlobRef, bytes: Buffer, what: string): Buffer {
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== ref.sha256) {
    throw new InfraError(`${what} blob ${ref.sha256.slice(0, 12)}… arrived with digest ${digest.slice(0, 12)}…`);
  }
  return bytes;
}

function expectedOf(bytes: Buffer, index: number): SqlResultSet {
  let json: unknown;
  try {
    json = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new PermanentJudgeError(`case ${index}: the expected result is not JSON`);
  }
  try {
    return parseExpectedResultSet(json);
  } catch (error) {
    throw new PermanentJudgeError(
      `case ${index}: the expected result is not a result set — ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function judgeSqlJob(
  spec: SqlJobSpec,
  deps: { sandbox: SandboxLike; readBlob: BlobReader; logger: Logger },
): Promise<SqlOutcome> {
  if (spec.dialect !== "postgres17") {
    throw new PermanentJudgeError(`this judge speaks postgres17, not ${spec.dialect}`);
  }

  const versionSetup = verify(spec.setup, await deps.readBlob(spec.setup), "setup").toString("utf8");
  const cases = [...spec.cases].sort((a, b) => a.index - b.index);

  const tests: TestResult[] = [];
  let passed = 0;
  let maxTimeMs = 0;
  let cpuMs = 0;
  let firstFailedIndex: number | null = null;

  for (const testCase of cases) {
    const setup = testCase.setup
      ? verify(testCase.setup, await deps.readBlob(testCase.setup), `case ${testCase.index} setup`).toString("utf8")
      : versionSetup;

    const outcome = await deps.sandbox.runCase({ setup, source: spec.source, maxRows: spec.maxRows });
    const judged = judgeCase(testCase, outcome);

    // The expected blob is only needed when the query actually produced a
    // result set, so it is fetched here rather than up front: a submission
    // that cannot parse never reads one.
    let verdict = judged.verdict;
    let message = judged.message;
    if (outcome.kind === "ok") {
      const expected = expectedOf(
        verify(testCase.expected, await deps.readBlob(testCase.expected), `case ${testCase.index} expected`),
        testCase.index,
      );
      const comparison = compareResultSets(expected, outcome.result, { ordered: testCase.ordered });
      verdict = comparison.ok ? "AC" : outcome.result.truncated ? "OLE" : "WA";
      message = sqlCaseMessage(comparison, testCase.visible) ?? undefined;
    }

    // A submission that could not be prepared is a compile error, and the
    // other cases would say the same thing.
    if (verdict === "CE") {
      return {
        verdict: "CE",
        compile: { ok: false, output: message ?? "That query was refused.", timeMs: 0, cached: false, resourceExceeded: false },
        tests: [],
        passedCases: 0,
        totalCases: cases.length,
        maxTimeMs: 0,
        maxMemoryKb: 0,
        firstFailedIndex: null,
        score: spec.kind === "run" ? null : 0,
        maxScore: spec.kind === "run" ? null : 1,
        cpuMs: 0,
      };
    }

    const ms = outcome.ms;
    maxTimeMs = Math.max(maxTimeMs, ms);
    cpuMs += ms;
    tests.push({
      i: testCase.index,
      v: verdict,
      ms,
      kb: 0,
      ...(message ? { message: message.slice(0, 512) } : {}),
    });
    if (verdict === "AC") passed += 1;
    else if (firstFailedIndex === null) firstFailedIndex = testCase.index;

    if (verdict !== "AC" && spec.stopOnFirstFailure) {
      for (const skipped of cases.filter((c) => c.index > testCase.index)) {
        tests.push({ i: skipped.index, v: "SKIPPED", ms: 0, kb: 0 });
      }
      break;
    }
  }

  const verdict: Verdict = firstFailedIndex === null ? "AC" : (tests.find((t) => t.v !== "AC" && t.v !== "SKIPPED")?.v ?? "WA");
  deps.logger.debug({ verdict, passed, total: cases.length }, "sql job judged");

  return {
    verdict,
    compile: null,
    tests,
    passedCases: passed,
    totalCases: cases.length,
    maxTimeMs,
    maxMemoryKb: 0,
    firstFailedIndex,
    score: spec.kind === "run" ? null : verdict === "AC" ? 1 : 0,
    maxScore: spec.kind === "run" ? null : 1,
    cpuMs,
  };
}

/**
 * One case's verdict from what the database said, before the comparison.
 * `ok` is decided by the caller, which has the expected result set.
 */
export function judgeCase(testCase: SqlCaseSpec, outcome: QueryOutcome): { verdict: Verdict; message?: string } {
  switch (outcome.kind) {
    case "ok":
      // Decided by the comparison, not here.
      return { verdict: "AC" };
    case "timeout":
      return { verdict: "TLE" };
    case "refused":
    case "error": {
      const compile = isCompileError(outcome);
      // A hidden case never shows the database's words; the student is told
      // what KIND of thing happened and nothing about the dataset.
      const message = testCase.visible
        ? outcome.message
        : compile
          ? outcome.message
          : "The query failed on a hidden dataset.";
      return { verdict: compile ? "CE" : "RE", message };
    }
  }
}
