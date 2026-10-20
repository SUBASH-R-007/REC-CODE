import {
  LIMITS,
  sanitizeToolOutput,
  truncateUtf8,
  type CompileResult,
  type JudgeJobSpec,
  type LanguageRuntime,
  type ProgressEvent,
  type TestResult,
  type TestSpec,
} from "@recx/shared";
import {
  HarnessUnsupportedError,
  buildHarness,
  canonicalizeFunctionOutput,
  compareFunctionOutput,
  renderDiagnostics,
  type FunctionCompareSpec,
  type HarnessBuild,
} from "@recx/shared/harness";
import { compileCacheKey, type CompileCache, type CompiledArtifact } from "../compile-cache";
import type { BlobSource, JudgeOutcome } from "../drivers/types";
import { InfraError, PermanentJudgeError, errorMessage } from "../errors";
import type { Logger } from "../logger";
import type { CapturedOutput, Sandbox } from "../sandbox/types";
import { aggregate, compileErrorOutcome } from "./aggregate";
import { CheckerRunner, checkerMessage, prepareChecker } from "./checker";
import { compareOutputs } from "./compare";
import { compileLimits, outputLimitBytes, runArgv, runLimits } from "./limits";
import { executeTests, planJob, type JudgePlan, type TestOutcome } from "./plan";
import { classifyCompile, classifyRun } from "./verdict";

/**
 * The shared judging logic every real driver runs on a Sandbox:
 *
 *   0. Plan (src/judge/plan.ts): refuse, permanently, anything no node could
 *      judge as specified — before any box exists.
 *   1. FUNCTION mode: wrap the student's code in the language harness.
 *   2. Compile in the compile box (own uid, own cgroup, LIMITS.compile caps),
 *      unless the compile cache already holds this exact compile (then
 *      compile.cached = true and compile.timeMs is the ORIGINAL compile's
 *      CPU time). A non-zero exit is CE with the compiler's diagnostics
 *      (remapped to the student's own line numbers, then sanitised); a
 *      compile killed by the caps is CE "compilation exceeded resource
 *      limits". Nothing runs after a CE, and a CE is never cached.
 *   3. CHECKER problems: the checker is compiled (or taken from the cache)
 *      before the first test (src/judge/checker.ts).
 *   4. Run the tests in plan order, each in a FRESH run box: isolate keeps
 *      one cgroup per box and its memory peak and OOM counters are
 *      cumulative across --run calls, so a box (and cgroup) per test is what
 *      makes MLE and the reported memory per-test. Only the current input is
 *      staged (input.txt, 0444); expected output never enters the run box —
 *      it is compared here, or by the checker in its own box.
 *      FUNCTION problems (protocol 3): the output is decoded strictly against
 *      the compared type and compared by the problem's comparator
 *      (@recx/shared/harness compare.ts) — never token by token. Output that
 *      does not decode is WA; an expected answer that does not decode is the
 *      problem's bug (released permanently). CUSTOM_CHECKER output is
 *      re-serialised canonically and only then handed to the checker.
 *   5. Aggregate (src/judge/aggregate.ts). Visible tests (samples, custom
 *      input) carry capped stdout and sanitised stderr; hidden tests carry
 *      neither, ever.
 *
 * Infrastructure failures throw InfraError (PermanentJudgeError when no node
 * could succeed); verdicts never throw.
 */

export interface RunJobContext {
  sandbox: Sandbox;
  blobs: BlobSource;
  progress(event: ProgressEvent): void;
  logger: Logger;
  signal?: AbortSignal;
  /** The node's compile-artifact cache; absent = compile every time. */
  compileCache?: CompileCache | null;
}

const INPUT_FILE = "input.txt";
const OUTPUT_FILE = "output.txt";
const ERROR_FILE = "error.txt";
const COMPILE_STDOUT = "compile.stdout";
const COMPILE_STDERR = "compile.stderr";
/** Diagnostics read before remapping and sanitising (which truncates to 8 KB). */
const COMPILE_CAPTURE_BYTES = 64 * 1024;
const MAX_ARTIFACT_BYTES = LIMITS.scratchDisk.defaultMb * 1024 * 1024;
const MAX_ARTIFACT_FILES = 512;

export const COMPILE_RESOURCE_MESSAGE = "compilation exceeded resource limits";
export const CUSTOM_INPUT_MESSAGE = "Custom input: there is no expected output to compare against.";
export const NOT_UTF8_MESSAGE = "The output is not valid UTF-8 text.";
/** TestResult.message is ≤ 512 characters (testResultSchema). */
const MESSAGE_CHARS = 500;

/** Strict UTF-8 decode: null for invalid bytes (malformed output, never silently replaced). */
function utf8OrNull(data: Buffer): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    return null;
  }
}

export type FunctionJudgement = { verdict: "AC" | "WA"; reason: string | null } | { verdict: "checker"; output: Buffer };

/**
 * A FUNCTION test's output against its expected answer: AC / WA with the
 * reason a visible test may show, or — CUSTOM_CHECKER — the canonical output
 * the checker must judge. Throws PermanentJudgeError for an expected answer
 * that does not decode (the problem's bug, never the student's WA).
 */
export function judgeFunctionOutput(
  compare: FunctionCompareSpec,
  expected: Buffer,
  actual: Buffer,
  testIndex: number,
): FunctionJudgement {
  const actualText = utf8OrNull(actual);
  if (compare.comparator === "CUSTOM_CHECKER") {
    if (actualText === null) return { verdict: "WA", reason: NOT_UTF8_MESSAGE };
    const canonical = canonicalizeFunctionOutput(compare, actualText);
    if (!canonical.ok) return { verdict: "WA", reason: canonical.reason };
    return { verdict: "checker", output: Buffer.from(`${canonical.text}\n`, "utf8") };
  }
  const expectedText = utf8OrNull(expected);
  if (expectedText === null) throw new PermanentJudgeError(`test ${testIndex}: the expected answer is not valid UTF-8`);
  if (actualText === null) return { verdict: "WA", reason: NOT_UTF8_MESSAGE };
  const result = compareFunctionOutput(compare, expectedText, actualText);
  switch (result.kind) {
    case "equal":
      return { verdict: "AC", reason: null };
    case "different":
    case "malformed-output":
      return { verdict: "WA", reason: result.reason };
    case "malformed-answer":
      throw new PermanentJudgeError(`test ${testIndex}: ${result.reason}`);
  }
}

function prepareProgram(spec: JudgeJobSpec): { source: string; build: HarnessBuild | null } {
  if (spec.ioMode !== "FUNCTION") return { source: spec.source, build: null };
  if (!spec.functionSignature) throw new PermanentJudgeError("FUNCTION-mode job without a function signature");
  try {
    const build = buildHarness(spec.language.key, spec.functionSignature, spec.source);
    return { source: build.source, build };
  } catch (error) {
    if (error instanceof HarnessUnsupportedError) throw new PermanentJudgeError(error.message);
    throw error;
  }
}

/**
 * Compile-cache key of a program: everything that decides what the compile
 * box produces — language, toolchains, the fixed argv and environment, the
 * source file name and the exact (harness-wrapped) source.
 */
export function programCacheKey(language: LanguageRuntime, source: string): string {
  return compileCacheKey([
    "program",
    language.key,
    language.toolchainId,
    language.version,
    language.extraToolchainIds,
    language.compile?.argv ?? null,
    language.env,
    language.sourceFile,
    source,
  ]);
}

function captureText(output: CapturedOutput): string {
  const head = output.head.toString("utf8");
  if (output.bytes <= output.head.length) return head;
  return `${head}\n…\n${output.tail.toString("utf8")}`;
}

type Diagnostics = (raw: string, maxBytes: number) => string;

export async function runJob(spec: JudgeJobSpec, ctx: RunJobContext): Promise<JudgeOutcome> {
  const plan = planJob(spec);
  const program = prepareProgram(spec);
  const language = spec.language;

  /**
   * Student-facing tool output: drop the /box/ prefix (so "/box/main.cpp:1"
   * is remapped like "main.cpp:1"), remap harness lines to the student's own
   * (FUNCTION), then strip every remaining host path and cap.
   */
  const diagnostics: Diagnostics = (raw, maxBytes) => {
    const unboxed = raw.replace(/(^|[\s'"(])\/box\//g, "$1");
    return program.build
      ? renderDiagnostics(unboxed, program.build, language.sourceFile, maxBytes)
      : sanitizeToolOutput(unboxed, maxBytes);
  };

  // ── Compile ───────────────────────────────────────────────────────────
  let compile: CompileResult | null = null;
  let artifacts: CompiledArtifact[];
  if (language.compile) {
    const compiled = await compileProgram(spec, plan, program.source, diagnostics, ctx);
    if (compiled.kind === "ce") return compiled.outcome;
    compile = compiled.compile;
    artifacts = compiled.artifacts;
  } else {
    artifacts = [{ name: language.sourceFile, data: Buffer.from(program.source, "utf8"), mode: 0o644 }];
  }

  // ── Checker ───────────────────────────────────────────────────────────
  let checker: CheckerRunner | null = null;
  if (plan.checker && spec.tests.some((t) => t.output !== null)) {
    const prepared = await prepareChecker(plan.checker, ctx);
    checker = new CheckerRunner(ctx.sandbox, prepared.binary, ctx.signal);
    ctx.logger.debug({ cached: prepared.cached }, "checker ready");
  }

  // ── Tests ─────────────────────────────────────────────────────────────
  ctx.progress({ type: "state", state: "RUNNING" });
  try {
    const executed = await executeTests(
      spec,
      plan,
      (test) => runTest(spec, plan, test, artifacts, checker, diagnostics, ctx),
      ctx.progress,
      ctx.signal,
    );
    return aggregate(spec, executed, compile);
  } finally {
    if (checker) await ctx.sandbox.cleanup("checker");
    await ctx.sandbox.cleanup("run");
  }
}

type Compiled =
  | { kind: "ok"; compile: CompileResult; artifacts: CompiledArtifact[] }
  | { kind: "ce"; outcome: JudgeOutcome };

async function compileProgram(
  spec: JudgeJobSpec,
  plan: JudgePlan,
  source: string,
  diagnostics: Diagnostics,
  ctx: RunJobContext,
): Promise<Compiled> {
  const language = spec.language;
  const compileStep = language.compile;
  if (!compileStep) throw new InfraError("compileProgram called for a language without a compile step");
  const { sandbox } = ctx;
  const key = programCacheKey(language, source);

  const hit = await ctx.compileCache?.get(key);
  if (hit) {
    return {
      kind: "ok",
      compile: { ok: true, output: hit.output, timeMs: hit.timeMs, cached: true, resourceExceeded: false },
      artifacts: hit.artifacts,
    };
  }

  ctx.progress({ type: "state", state: "COMPILING" });
  const toolchainIds = [language.toolchainId, ...language.extraToolchainIds];
  const ce = (compile: Omit<CompileResult, "ok" | "cached">): Compiled => ({
    kind: "ce",
    outcome: compileErrorOutcome(spec, { ok: false, cached: false, ...compile }, plan.subtasks),
  });

  await sandbox.init("compile");
  try {
    await sandbox.writeFile("compile", language.sourceFile, source, 0o644);
    const result = await sandbox.exec({
      role: "compile",
      argv: compileStep.argv,
      toolchainIds,
      env: language.env,
      limits: compileLimits(language),
      stdin: null,
      stdout: COMPILE_STDOUT,
      stderr: COMPILE_STDERR,
      stdoutCapBytes: COMPILE_CAPTURE_BYTES,
      stderrCapBytes: COMPILE_CAPTURE_BYTES,
      outputLimitBytes: null,
      signal: ctx.signal,
    });
    const timeMs = Math.round((result.meta.timeSec ?? 0) * 1000);
    const raw = [result.stdout.head.toString("utf8"), result.stderr.head.toString("utf8")]
      .filter((s) => s.trim().length > 0)
      .join("\n");

    switch (classifyCompile(result.meta)) {
      case "infra":
        throw new InfraError(`isolate internal error while compiling: ${result.meta.message ?? "unknown"}`);
      case "resource":
        return ce({ output: COMPILE_RESOURCE_MESSAGE, timeMs, resourceExceeded: true });
      case "error": {
        /**
         * A compile that failed because the SOURCE IS NOT IN THE BOX is an
         * infrastructure failure, not a student's compile error (Phase 10f).
         *
         * Found by the plug-pull drill: `kill -9` on a worker leaves its
         * isolate boxes allocated, and the restarted worker's `--init` on
         * one of those boxes does not give it a usable box. The compile step
         * then ran against an empty box and Python said
         * `FileNotFoundError: 'solution.py'` — which classified as a
         * compile error, so **six students' correct programs were recorded
         * as CE** (docs/RUNBOOK.md §3, the 10f drill).
         *
         * A wrong verdict shown to a student is the one failure this
         * platform must not have, and it is cheap to rule out: if the source
         * file is not there, the box is broken, so this is an InfraError —
         * the lease is released, the job is retried on a healthy node, and
         * three consecutive releases drain this one.
         *
         * `listFiles` failing is treated as "present", so a transient
         * listing error can never turn a genuine CE into an InfraError: the
         * student's real compile error still reaches them.
         */
        const present = await sandbox
          .listFiles("compile")
          .then((files) => files.some((f) => f.name === language.sourceFile))
          .catch(() => true);
        if (!present) {
          throw new InfraError(
            `the compile box has no ${language.sourceFile} after writing it: the box is not usable (a stale box from a crashed worker looks exactly like this)`,
          );
        }
        return ce({ output: diagnostics(raw, LIMITS.compile.outputBytes), timeMs, resourceExceeded: false });
      }
      case "ok":
        break;
    }

    const collected = await collectArtifacts(sandbox);
    if (!collected) return ce({ output: COMPILE_RESOURCE_MESSAGE, timeMs, resourceExceeded: true });
    const output = diagnostics(raw, LIMITS.compile.outputBytes);
    await ctx.compileCache?.put(key, { output, timeMs, artifacts: collected });
    return {
      kind: "ok",
      compile: { ok: true, output, timeMs, cached: false, resourceExceeded: false },
      artifacts: collected,
    };
  } finally {
    await sandbox.cleanup("compile");
  }
}

/**
 * Every regular file the compile left at the top of its box (binary, class
 * files, jar, or the checked source itself). Null when the output is beyond
 * the scratch budget — treated as a compile that exceeded its limits.
 */
async function collectArtifacts(sandbox: Sandbox): Promise<CompiledArtifact[] | null> {
  const files = (await sandbox.listFiles("compile")).filter((f) => f.name !== COMPILE_STDOUT && f.name !== COMPILE_STDERR);
  const total = files.reduce((sum, f) => sum + f.size, 0);
  if (files.length > MAX_ARTIFACT_FILES || total > MAX_ARTIFACT_BYTES) return null;
  const artifacts: CompiledArtifact[] = [];
  for (const f of files) {
    artifacts.push({
      name: f.name,
      data: await sandbox.readFile("compile", f.name, MAX_ARTIFACT_BYTES),
      mode: f.mode & 0o111 ? 0o755 : 0o644,
    });
  }
  return artifacts;
}

async function runTest(
  spec: JudgeJobSpec,
  plan: JudgePlan,
  test: TestSpec,
  artifacts: CompiledArtifact[],
  checker: CheckerRunner | null,
  diagnostics: Diagnostics,
  ctx: RunJobContext,
): Promise<TestOutcome> {
  const { sandbox } = ctx;
  const language = spec.language;
  const visible = test.isSample || test.output === null;
  const toolchainIds = [language.toolchainId, ...language.extraToolchainIds];

  await sandbox.init("run");
  for (const artifact of artifacts) await sandbox.writeFile("run", artifact.name, artifact.data, artifact.mode);
  const input = await ctx.blobs.get(test.input);
  await sandbox.writeFile("run", INPUT_FILE, input, 0o444);

  const tripBytes = outputLimitBytes(test);
  const exec = await sandbox.exec({
    role: "run",
    argv: runArgv(spec),
    toolchainIds,
    env: language.env,
    limits: runLimits(spec),
    stdin: INPUT_FILE,
    stdout: OUTPUT_FILE,
    stderr: ERROR_FILE,
    // The whole output up to the trip point: the checker needs all of it.
    stdoutCapBytes: tripBytes,
    stderrCapBytes: LIMITS.stderrCapture.defaultBytes,
    outputLimitBytes: tripBytes,
    signal: ctx.signal,
  });

  const run = classifyRun(exec.meta, {
    timeLimitMs: spec.timeLimitMs,
    memoryLimitKb: spec.memoryLimitKb,
    language: language.key,
    stderr: captureText(exec.stderr),
    outputLimitExceeded: exec.outputLimitExceeded,
  });
  if (run.verdict === "IE") throw new InfraError(`isolate internal error on test ${test.index}: ${run.message ?? ""}`);

  const result: TestResult = { i: test.index, v: "AC", ms: run.timeMs, kb: run.memoryKb, exitCode: run.exitCode, signal: run.signal };
  let fraction = 0;
  let checkerReport: string | undefined;
  /** FUNCTION: why the output is wrong (shown only where checker reports are). */
  let functionReport: string | null = null;
  if (run.verdict !== null) {
    result.v = run.verdict;
  } else if (test.output === null) {
    result.message = CUSTOM_INPUT_MESSAGE;
    fraction = 1;
  } else {
    const answer = await ctx.blobs.get(test.output);
    /** What the checker judges: raw stdout (STDIN), canonical output (CUSTOM_CHECKER), or nothing. */
    let checkerInput: Buffer | null = checker ? exec.stdout.head : null;
    if (plan.functionCompare) {
      const judged = judgeFunctionOutput(plan.functionCompare, answer, exec.stdout.head, test.index);
      if (judged.verdict === "checker") {
        if (!checker) throw new PermanentJudgeError("CUSTOM_CHECKER comparison without a checker");
        checkerInput = judged.output;
      } else {
        // Judged structurally — or CUSTOM_CHECKER output that does not decode: WA, the checker never runs.
        result.v = judged.verdict;
        fraction = judged.verdict === "AC" ? 1 : 0;
        functionReport = judged.reason;
        checkerInput = null;
      }
    }
    if (checker && checkerInput) {
      const decision = await checker.check({ input, output: checkerInput, answer });
      if (decision.kind === "infra") throw new InfraError(`${decision.reason} (test ${test.index})`);
      if (decision.kind === "fail") throw new PermanentJudgeError(decision.reason);
      result.v = decision.verdict;
      fraction = decision.fraction;
      checkerReport = checkerMessage(decision.report);
    } else if (!plan.functionCompare) {
      const equal = compareOutputs(plan.compareMode, answer, exec.stdout.head, { floatEpsilon: spec.floatEpsilon });
      result.v = equal ? "AC" : "WA";
      fraction = equal ? 1 : 0;
    }
  }
  if (run.idle) result.idle = true;
  if (run.message) result.message = run.message.slice(0, 512);
  // What the checker said about the output: visible tests and validation
  // jobs only — a hidden test of a submission reveals nothing about its output.
  if (checkerReport && (visible || spec.kind === "validation")) result.message = checkerReport;
  if (functionReport && (visible || spec.kind === "validation")) result.message = functionReport.slice(0, MESSAGE_CHARS);

  if (visible) {
    const stdoutCap = spec.kind === "run" ? LIMITS.customRun.stdoutBytes : LIMITS.detail.perTestBytes;
    result.stdout = truncateUtf8(exec.stdout.head.toString("utf8"), stdoutCap);
    result.stderr = diagnostics(captureText(exec.stderr), LIMITS.stderrCapture.defaultBytes);
  }

  // Tidy up before the next test re-initialises the box.
  try {
    for (const name of [INPUT_FILE, OUTPUT_FILE, ERROR_FILE]) await sandbox.unlink("run", name);
  } catch (error) {
    ctx.logger.debug({ err: errorMessage(error) }, "could not unlink run files; the next init wipes the box");
  }
  return { result, fraction };
}
