import { createHash } from "node:crypto";
import {
  clampCpuLimitMs,
  deriveTimeLimitMs,
  functionSignatureSchema,
  JUDGE_PROTOCOL_VERSION,
  judgeJobSpecSchema,
  languageRuntimeSchema,
  LIMITS,
  type CompareMode,
  type IoMode,
  type JobKind,
  type JudgeJobSpec,
  type JudgeLane,
  type ScoringMode,
  type SubtaskAggregation,
  type SubtaskSpec,
  type TestSpec,
  type Verdict,
} from "@recx/shared";

/**
 * Pure mapping from database rows to the JudgeJobSpec sent in a claim
 * response. Everything the worker needs is in here — pinned version limits,
 * the language runtime from the LanguageConfig row, subtasks, the checker
 * reference, and the test manifest as (sha256, size) references only.
 * Expected outputs and the checker source are fetched separately (only by the
 * node holding the job) and expected outputs never enter the sandbox.
 *
 * Time limit for one job (all clamped to LIMITS.cpuTime):
 *   base     = ProblemLanguageLimit.timeLimitMs for (version, language) when
 *              the row exists (measured at publish), else the language's
 *              fallback multiplier applied to the version's base (C++) limit;
 *   + credit = the claiming node's startup credit for the language (median
 *              hello-world CPU ms, measured at worker boot);
 *   runs       are additionally capped at LIMITS.customRun.cpuMaxMs;
 *   validation of a model solution (expected AC) runs at the ceiling, to
 *              measure it; a deliberately-wrong one runs at the derived limit.
 */

export interface JobSpecTestRow {
  index: number;
  isSample: boolean;
  points: number | null;
  subtaskIndex: number | null;
  input: { sha256: string; sizeBytes: number };
  output: { sha256: string; sizeBytes: number };
}

export interface JobSpecVersionRow {
  ioMode: IoMode;
  functionSignature: unknown;
  compareMode: CompareMode;
  floatEpsilon: number | null;
  scoringMode: ScoringMode;
  stopOnFirstFailure: boolean;
  timeLimitMs: number;
  memoryLimitKb: number;
  /** SQL versions only (Phase 12k); null for every other io mode. */
  sqlDialect?: "postgres17" | null;
  sqlOrdered?: boolean | null;
}

export interface JobSpecSubtaskRow {
  index: number;
  points: number;
  aggregation: SubtaskAggregation;
  dependsOn: number[];
}

/** The resolved checker of a CHECKER version: its TestBlob and pinned testlib. */
export interface JobSpecChecker {
  sha256: string;
  sizeBytes: number;
  testlibId: string | null;
}

/** ProblemLanguageLimit for (version, language), when one exists. */
export interface JobSpecLanguageLimit {
  timeLimitMs: number;
  memoryLimitKb: number;
}

export interface JobSpecInput {
  kind: JobKind;
  id: string;
  lane: JudgeLane;
  claimToken: string;
  /** attemptCount after the claim incremented it (1-based). */
  attempt: number;
  /** The job row's language — must match the runtime's key. */
  language: string;
  /** LanguageConfig.runtime (jsonb). */
  runtime: unknown;
  source: string;
  version: JobSpecVersionRow;
  /** All of the pinned version's tests, any order. */
  tests: readonly JobSpecTestRow[];
  /** The version's Subtask rows (used for SUBTASK scoring only). */
  subtasks?: readonly JobSpecSubtaskRow[];
  /** CHECKER compare mode: the checker blob, or null when the version has none. */
  checker?: JobSpecChecker | null;
  /** INTERACTIVE compare mode (Phase 12l): the interactor blob, same shape. */
  interactor?: JobSpecChecker | null;
  languageLimit?: JobSpecLanguageLimit | null;
  /** The claiming node's startup credit for this language (ms, ≥ 0). */
  startupCreditMs?: number;
  /** Runs only: null = the sample tests; a string = one custom-stdin test. */
  customInput?: string | null;
  /** Validation only: the reference solution's expected verdict. */
  expectedVerdict?: Verdict;
}

export class JobSpecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JobSpecError";
  }
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function toTestSpec(row: JobSpecTestRow): TestSpec {
  return {
    index: row.index,
    isSample: row.isSample,
    input: { sha256: row.input.sha256, sizeBytes: row.input.sizeBytes },
    output: { sha256: row.output.sha256, sizeBytes: row.output.sizeBytes },
    points: row.points,
    subtask: row.subtaskIndex,
  };
}

function inCpuRange(ms: number): boolean {
  return Number.isInteger(ms) && ms >= LIMITS.cpuTime.floorMs && ms <= LIMITS.cpuTime.ceilingMs;
}

/**
 * SUBTASK scoring: the version's subtasks, ordered. Every test's subtask and
 * every dependency must name a defined subtask, and a subtask may depend only
 * on lower-numbered ones (so dependencies can never form a cycle).
 */
function subtaskSpecs(input: JobSpecInput, tests: readonly TestSpec[]): SubtaskSpec[] {
  if (input.version.scoringMode !== "SUBTASK") return [];
  const rows = [...(input.subtasks ?? [])].sort((a, b) => a.index - b.index);
  if (rows.length === 0) throw new JobSpecError("A SUBTASK-scored version has no subtasks.");
  const defined = new Set(rows.map((s) => s.index));
  if (defined.size !== rows.length) throw new JobSpecError("Subtask indexes are not unique.");
  for (const s of rows) {
    for (const dep of s.dependsOn) {
      if (!defined.has(dep) || dep >= s.index) {
        throw new JobSpecError(`Subtask ${s.index} depends on subtask ${dep}, which is not an earlier subtask.`);
      }
    }
  }
  for (const t of tests) {
    if (t.subtask !== null && !defined.has(t.subtask)) {
      throw new JobSpecError(`Test ${t.index} belongs to subtask ${t.subtask}, which is not defined.`);
    }
  }
  return rows.map((s) => ({
    index: s.index,
    points: s.points,
    aggregation: s.aggregation,
    dependsOn: [...new Set(s.dependsOn)].sort((a, b) => a - b),
  }));
}

/** The time limit for this job (see the module comment). */
export function jobTimeLimitMs(input: {
  kind: JobKind;
  baseMs: number;
  fallbackMultiplier: number;
  fallbackExtraMs: number;
  languageLimit: JobSpecLanguageLimit | null;
  startupCreditMs: number;
  expectedVerdict: Verdict | null;
}): number {
  if (input.kind === "validation" && input.expectedVerdict === "AC") return LIMITS.cpuTime.ceilingMs;
  const base =
    input.languageLimit?.timeLimitMs ??
    deriveTimeLimitMs({
      baseMs: input.baseMs,
      measuredModelMs: null,
      multiplier: input.fallbackMultiplier,
      extraMs: input.fallbackExtraMs,
    });
  const credit = Number.isFinite(input.startupCreditMs) ? Math.max(0, Math.round(input.startupCreditMs)) : 0;
  const limit = clampCpuLimitMs(base + credit);
  if (input.kind === "run") return Math.max(LIMITS.cpuTime.floorMs, Math.min(limit, LIMITS.customRun.cpuMaxMs));
  return limit;
}

/**
 * Build and validate the job spec. Throws JobSpecError when the rows cannot
 * form a valid job (corrupt runtime json, bad signature, out-of-range
 * limits, a CHECKER version without a checker, inconsistent subtasks) — a
 * data problem no retry can fix.
 */
export function buildJudgeJobSpec(input: JobSpecInput): JudgeJobSpec {
  const runtime = languageRuntimeSchema.safeParse(input.runtime);
  if (!runtime.success) throw new JobSpecError(`LanguageConfig runtime is invalid: ${runtime.error.issues[0]?.message}`);
  if (runtime.data.key !== input.language) {
    throw new JobSpecError(`Language mismatch: job is ${input.language}, runtime is ${runtime.data.key}.`);
  }
  if (input.kind === "validation" && !input.expectedVerdict) {
    throw new JobSpecError("A validation job needs its reference solution's expected verdict.");
  }

  let functionSignature: JudgeJobSpec["functionSignature"] = null;
  if (input.version.ioMode === "FUNCTION") {
    const sig = functionSignatureSchema.safeParse(input.version.functionSignature);
    if (!sig.success) throw new JobSpecError(`Function signature is invalid: ${sig.error.issues[0]?.message}`);
    functionSignature = sig.data;
    // The CHECKER mirror (protocol 3): a checker runs exactly for CUSTOM_CHECKER.
    if ((sig.data.comparator === "CUSTOM_CHECKER") !== (input.version.compareMode === "CHECKER")) {
      throw new JobSpecError(
        `Comparator ${sig.data.comparator} does not match compare mode ${input.version.compareMode}: CHECKER goes with CUSTOM_CHECKER only.`,
      );
    }
  }

  const baseMs = input.version.timeLimitMs;
  if (!inCpuRange(baseMs)) throw new JobSpecError(`Time limit ${baseMs} ms is outside the limits table.`);
  const languageLimit = input.languageLimit ?? null;
  if (languageLimit && !inCpuRange(languageLimit.timeLimitMs)) {
    throw new JobSpecError(`Per-language time limit ${languageLimit.timeLimitMs} ms is outside the limits table.`);
  }

  const ordered = [...input.tests].sort((a, b) => a.index - b.index);
  let tests: TestSpec[];
  const inlineBlobs: Record<string, string> = {};
  let stopOnFirstFailure = input.version.stopOnFirstFailure;

  if (input.kind === "run") {
    // The Run button shows every visible case and never stops early.
    stopOnFirstFailure = false;
    if (input.customInput !== null && input.customInput !== undefined) {
      const sha256 = sha256Hex(input.customInput);
      inlineBlobs[sha256] = input.customInput;
      tests = [
        {
          index: 0,
          isSample: true,
          input: { sha256, sizeBytes: Buffer.byteLength(input.customInput, "utf8") },
          output: null,
          points: null,
          subtask: null,
        },
      ];
    } else {
      tests = ordered.filter((t) => t.isSample).map(toTestSpec);
    }
  } else {
    tests = ordered.map(toTestSpec);
    // A model solution is measured on every test; a deliberately-wrong one
    // only has to fail, so it may stop at its first failure.
    if (input.kind === "validation") stopOnFirstFailure = input.expectedVerdict !== "AC";
  }
  if (tests.length === 0) throw new JobSpecError("The pinned problem version has no tests to run.");

  let checker: JudgeJobSpec["checker"] = null;
  if (input.version.compareMode === "CHECKER") {
    if (!input.checker) throw new JobSpecError("A CHECKER version has no checker source.");
    if (!input.checker.testlibId) throw new JobSpecError("A CHECKER version has no pinned testlib toolchain.");
    checker = {
      source: { sha256: input.checker.sha256, sizeBytes: input.checker.sizeBytes },
      language: "cpp20",
      testlibId: input.checker.testlibId,
    };
  }

  /**
   * Phase 12l. The interactor is to an interactive version what the checker
   * is to a CHECKER one, with one difference worth stating: without it the
   * job cannot be judged AT ALL, because nothing else decides the verdict.
   * A version in that state should never exist (the database's own mirror
   * CHECK), so finding one here is a data problem no retry can fix.
   */
  let interactor: JudgeJobSpec["interactor"] = null;
  if (input.version.compareMode === "INTERACTIVE") {
    if (input.version.ioMode !== "STDIN") {
      throw new JobSpecError(`An interactive problem reads standard input; this version is ${input.version.ioMode}.`);
    }
    if (!input.interactor) throw new JobSpecError("An INTERACTIVE version has no interactor source.");
    if (!input.interactor.testlibId) throw new JobSpecError("An INTERACTIVE version has no pinned testlib toolchain.");
    interactor = {
      source: { sha256: input.interactor.sha256, sizeBytes: input.interactor.sizeBytes },
      language: "cpp20",
      testlibId: input.interactor.testlibId,
    };
  }

  const timeLimitMs = jobTimeLimitMs({
    kind: input.kind,
    baseMs,
    fallbackMultiplier: runtime.data.fallbackMultiplier,
    fallbackExtraMs: runtime.data.fallbackExtraMs,
    languageLimit,
    startupCreditMs: input.startupCreditMs ?? 0,
    expectedVerdict: input.expectedVerdict ?? null,
  });

  const spec = judgeJobSpecSchema.safeParse({
    protocolVersion: JUDGE_PROTOCOL_VERSION,
    kind: input.kind,
    id: input.id,
    lane: input.lane,
    claimToken: input.claimToken,
    attempt: input.attempt,
    language: runtime.data,
    source: input.source,
    ioMode: input.version.ioMode,
    functionSignature,
    compareMode: input.version.compareMode,
    floatEpsilon: input.version.floatEpsilon,
    scoringMode: input.version.scoringMode,
    stopOnFirstFailure,
    timeLimitMs,
    memoryLimitKb: languageLimit?.memoryLimitKb ?? input.version.memoryLimitKb,
    tests,
    subtasks: subtaskSpecs(input, tests),
    checker,
    interactor,
    inlineBlobs,
  });
  if (!spec.success) {
    const issue = spec.error.issues[0];
    throw new JobSpecError(`Job spec failed validation at ${issue?.path.join(".") || "spec"}: ${issue?.message}`);
  }
  return spec.data;
}
