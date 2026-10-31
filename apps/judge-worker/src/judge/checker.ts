import { existsSync } from "node:fs";
import {
  LANGUAGE_CATALOG,
  LIMITS,
  TOOLCHAIN_ROOT,
  sanitizeToolOutput,
  truncateUtf8,
  type CheckerSpec,
} from "@recx/shared";
import { compileCacheKey, type CompileCache } from "../compile-cache";
import type { BlobSource } from "../drivers/types";
import { InfraError, PermanentJudgeError } from "../errors";
import type { IsolateMeta, Sandbox } from "../sandbox/types";
import { checkerLimits, compileLimits } from "./limits";
import { classifyCompile, signalName } from "./verdict";

/**
 * testlib-compatible checkers (compareMode CHECKER).
 *
 * Compile: in the slot's COMPILE box with the pinned gcc-13.2.0 toolchain and
 * the job's read-only testlib directory /opt/toolchains/<testlibId>
 * (-I…, which holds testlib.h). The binary is cached in the compile cache
 * under sha256(checker source sha256 + toolchain ids + flags), so a checker
 * compiles once per node per hour, not once per submission. A checker that
 * does not compile is the problem's bug, never the student's: the job is
 * released permanently and an admin sees why.
 *
 * Run: in the slot's CHECKER box (BASE+200+slot — its own uid, a fresh box
 * and cgroup per test) with input.txt, output.txt (the contestant's output,
 * copied out of the run box by the worker) and answer.txt (the expected
 * output) staged read-only (0444):  ./checker input.txt output.txt answer.txt
 * The contestant's program never sees answer.txt: the run box and the
 * checker box are different boxes with different uids.
 *
 * Exit codes (testlib):
 *   0          ok                      → AC
 *   1          wrong answer            → WA
 *   2          presentation error      → WA (there is no PE verdict)
 *   3          FAIL — the checker itself found a bug (bad answer file,
 *              inconsistent test): NEVER the student's WA. Released
 *              permanently as "checker FAIL: <first line>" so an admin is
 *              alerted.
 *   16 + n     partially correct, n = 0..100 (testlib _pc(n); the worker
 *              compiles with -DPC_BASE_EXIT_CODE=16 so this holds whatever
 *              testlib's own default): n/100 of the test's points, verdict
 *              PARTIAL; n = 100 → AC; n = 0 → WA (no credit is not partial
 *              credit).
 *   7 (testlib _points) and anything else, a crash, or the checker's own
 *   limits (LIMITS.checker) → treated as checker FAIL (permanent release).
 *
 * The checker's report (stderr, else stdout; ≤ 4 KB, sanitised) becomes the
 * test's message only where the caller allows it: visible tests and
 * validation jobs. A hidden test of a submission carries nothing about its
 * output beyond verdict, time and memory.
 */

export const CHECKER_BINARY = "checker";
export const CHECKER_SOURCE = "checker.cpp";
export const CHECKER_ARGV = ["./checker", "input.txt", "output.txt", "answer.txt"] as const;
const CHECKER_STDOUT = "checker.stdout";
const CHECKER_STDERR = "checker.stderr";
const COMPILE_STDOUT = "compile.stdout";
const COMPILE_STDERR = "compile.stderr";
const COMPILE_CAPTURE_BYTES = 64 * 1024;
const MAX_CHECKER_BYTES = LIMITS.scratchDisk.defaultMb * 1024 * 1024;
/** A box environment needs a PATH; a static checker uses nothing from it. */
const CHECKER_ENV = { PATH: "/usr/bin:/bin" } as const;
/** Release reasons are ≤ 500 characters (releaseRequestSchema). */
const REASON_LINE_BYTES = 400;
/** TestResult.message is ≤ 512 characters (testResultSchema). */
const MESSAGE_BYTES = 500;

/** testlib's _pc(n) exits PC_BASE_EXIT_CODE + n; the worker pins the base at compile time. */
export const CHECKER_PARTIAL_BASE = 16;

const checkerCompiler = LANGUAGE_CATALOG.cpp20;

export function checkerToolchainIds(checker: Pick<CheckerSpec, "testlibId">): string[] {
  return [checkerCompiler.toolchainId, checker.testlibId];
}

export function checkerCompileArgv(checker: Pick<CheckerSpec, "testlibId">): string[] {
  return [
    `${TOOLCHAIN_ROOT}/${checkerCompiler.toolchainId}/bin/g++`,
    "-std=c++20",
    "-O2",
    "-pipe",
    "-static",
    "-s",
    `-DPC_BASE_EXIT_CODE=${CHECKER_PARTIAL_BASE}`,
    "-I",
    `${TOOLCHAIN_ROOT}/${checker.testlibId}`,
    "-o",
    CHECKER_BINARY,
    CHECKER_SOURCE,
  ];
}

/** Compile-cache key of a checker: its source's sha256, the toolchains and the exact flags. */
export function checkerCacheKey(checker: CheckerSpec): string {
  return compileCacheKey([
    "checker",
    checker.language,
    checkerToolchainIds(checker),
    checkerCompileArgv(checker),
    checkerCompiler.env,
    checker.source.sha256,
  ]);
}

/**
 * Throws a retryable InfraError unless THIS node has the checker's compiler
 * and testlib directory. Another node may have them, so this is never
 * permanent.
 */
export function assertCheckerToolchainsPresent(
  checker: Pick<CheckerSpec, "testlibId">,
  exists: (path: string) => boolean = existsSync,
): void {
  const compiler = checkerCompileArgv(checker)[0]!;
  if (!exists(`${TOOLCHAIN_ROOT}/${checkerCompiler.toolchainId}`) || !exists(compiler)) {
    throw new InfraError(`checker compiler ${checkerCompiler.toolchainId} is not installed on this node`);
  }
  if (!exists(`${TOOLCHAIN_ROOT}/${checker.testlibId}/testlib.h`)) {
    throw new InfraError(`testlib toolchain missing on this node: ${TOOLCHAIN_ROOT}/${checker.testlibId}/testlib.h`);
  }
}

export interface CheckerContext {
  sandbox: Sandbox;
  blobs: BlobSource;
  compileCache?: CompileCache | null;
  signal?: AbortSignal;
}

export interface PreparedChecker {
  binary: Buffer;
  /** Served from the compile cache. */
  cached: boolean;
}

/**
 * The checker binary: from the compile cache, else compiled in the compile
 * box (and cached).
 *
 * `what` is the word the author reads when it does not compile. An
 * interactor is compiled by this same function (Phase 12l) and telling its
 * author that "the checker does not compile" would send them looking for a
 * checker the problem does not have.
 */
export async function prepareChecker(
  checker: CheckerSpec,
  ctx: CheckerContext,
  what: "checker" | "interactor" = "checker",
): Promise<PreparedChecker> {
  const key = checkerCacheKey(checker);
  const hit = await ctx.compileCache?.get(key);
  const cachedBinary = hit?.artifacts.find((a) => a.name === CHECKER_BINARY);
  if (cachedBinary) return { binary: cachedBinary.data, cached: true };

  const source = await ctx.blobs.get(checker.source);
  const { sandbox } = ctx;
  await sandbox.init("compile");
  try {
    await sandbox.writeFile("compile", CHECKER_SOURCE, source, 0o644);
    const argv = checkerCompileArgv(checker);
    const result = await sandbox.exec({
      role: "compile",
      argv,
      toolchainIds: checkerToolchainIds(checker),
      env: { ...checkerCompiler.env },
      // A checker is compiled once and cached; testlib.h is a large header.
      limits: compileLimits({ compile: { argv, slow: true }, openFiles: checkerCompiler.openFiles }),
      stdin: null,
      stdout: COMPILE_STDOUT,
      stderr: COMPILE_STDERR,
      stdoutCapBytes: COMPILE_CAPTURE_BYTES,
      stderrCapBytes: COMPILE_CAPTURE_BYTES,
      outputLimitBytes: null,
      signal: ctx.signal,
    });
    const diagnostics = sanitizeToolOutput(
      [result.stdout.head.toString("utf8"), result.stderr.head.toString("utf8")].join("\n"),
      LIMITS.compile.outputBytes,
    );
    switch (classifyCompile(result.meta)) {
      case "infra":
        throw new InfraError(`isolate internal error while compiling the ${what}: ${result.meta.message ?? "unknown"}`);
      case "resource":
        throw new PermanentJudgeError(`${what} does not compile: compilation exceeded resource limits`);
      case "error":
        throw new PermanentJudgeError(`${what} does not compile: ${errorLine(diagnostics) || "the compiler reported an error"}`);
      case "ok":
        break;
    }
    const built = (await sandbox.listFiles("compile")).find((f) => f.name === CHECKER_BINARY);
    if (!built || built.size === 0 || built.size > MAX_CHECKER_BYTES) {
      throw new PermanentJudgeError(`${what} does not compile: no usable binary was produced`);
    }
    const binary = await sandbox.readFile("compile", CHECKER_BINARY, MAX_CHECKER_BYTES);
    await ctx.compileCache?.put(key, {
      output: "",
      timeMs: Math.round((result.meta.timeSec ?? 0) * 1000),
      artifacts: [{ name: CHECKER_BINARY, data: binary, mode: 0o755 }],
    });
    return { binary, cached: false };
  } finally {
    await sandbox.cleanup("compile");
  }
}

export type CheckerDecision =
  | {
      kind: "verdict";
      verdict: "AC" | "WA" | "PARTIAL";
      /** Share of the test's points: 1, 0, or n/100. */
      fraction: number;
      /** The checker's sanitised report (may be empty). */
      report: string;
    }
  /** The checker is broken or reported FAIL: release permanently with this reason. */
  | { kind: "fail"; reason: string }
  /** isolate itself failed: a retryable infrastructure failure. */
  | { kind: "infra"; reason: string };

/** isolate's meta for a checker run plus its sanitised report → what it decided. Pure. */
export function interpretChecker(meta: IsolateMeta, report: string): CheckerDecision {
  const line = firstLine(report);
  const suffix = line ? `: ${line}` : "";
  if (meta.status === "XX") {
    return { kind: "infra", reason: `isolate internal error in the checker box: ${meta.message ?? "unknown"}` };
  }
  if (meta.status === "TO") return { kind: "fail", reason: `checker FAIL: the checker exceeded its time limit${suffix}` };
  if (meta.cgOomKilled) return { kind: "fail", reason: `checker FAIL: the checker exceeded its memory limit${suffix}` };
  if (meta.status === "SG") {
    const name = meta.exitSignal === null ? "a signal" : signalName(meta.exitSignal);
    return { kind: "fail", reason: `checker FAIL: the checker was killed by ${name}${suffix}` };
  }
  const code = meta.exitCode ?? (meta.status === null ? 0 : null);
  if (code === null) return { kind: "fail", reason: `checker FAIL: the checker ended without an exit code${suffix}` };

  if (code === 0) return { kind: "verdict", verdict: "AC", fraction: 1, report };
  if (code === 1 || code === 2) return { kind: "verdict", verdict: "WA", fraction: 0, report };
  if (code === 3) return { kind: "fail", reason: `checker FAIL: ${line || "(no message)"}` };
  if (code >= CHECKER_PARTIAL_BASE && code <= CHECKER_PARTIAL_BASE + 100) {
    const n = code - CHECKER_PARTIAL_BASE;
    if (n === 100) return { kind: "verdict", verdict: "AC", fraction: 1, report };
    if (n === 0) return { kind: "verdict", verdict: "WA", fraction: 0, report };
    return { kind: "verdict", verdict: "PARTIAL", fraction: n / 100, report };
  }
  return { kind: "fail", reason: `checker FAIL (unsupported exit code ${code})${suffix}` };
}

/** The checker report as a test message (≤ 512 characters). */
export function checkerMessage(report: string): string | undefined {
  const text = report.trim();
  return text ? truncateUtf8(text, MESSAGE_BYTES) : undefined;
}

/** Runs one comparison in a fresh checker box. */
export class CheckerRunner {
  constructor(
    private readonly sandbox: Sandbox,
    private readonly binary: Buffer,
    private readonly signal?: AbortSignal,
  ) {}

  async check(files: { input: Buffer; output: Buffer; answer: Buffer }): Promise<CheckerDecision> {
    const { sandbox } = this;
    await sandbox.init("checker");
    await sandbox.writeFile("checker", CHECKER_BINARY, this.binary, 0o755);
    await sandbox.writeFile("checker", "input.txt", files.input, 0o444);
    await sandbox.writeFile("checker", "output.txt", files.output, 0o444);
    await sandbox.writeFile("checker", "answer.txt", files.answer, 0o444);
    const exec = await sandbox.exec({
      role: "checker",
      argv: [...CHECKER_ARGV],
      toolchainIds: [],
      env: { ...CHECKER_ENV },
      limits: checkerLimits(),
      stdin: null,
      stdout: CHECKER_STDOUT,
      stderr: CHECKER_STDERR,
      stdoutCapBytes: LIMITS.checker.outputBytes,
      stderrCapBytes: LIMITS.checker.outputBytes,
      outputLimitBytes: null,
      signal: this.signal,
    });
    const stderr = exec.stderr.head.toString("utf8");
    const raw = stderr.trim() ? stderr : exec.stdout.head.toString("utf8");
    return interpretChecker(exec.meta, sanitizeToolOutput(raw, LIMITS.checker.outputBytes));
  }
}

function firstLine(text: string): string {
  const line = text.split("\n").find((l) => l.trim().length > 0)?.trim() ?? "";
  return truncateUtf8(line, REASON_LINE_BYTES);
}

/** The first line mentioning an error, else the first line. */
function errorLine(diagnostics: string): string {
  const line = diagnostics.split("\n").find((l) => /\berror\b/i.test(l))?.trim();
  return line ? truncateUtf8(line, REASON_LINE_BYTES) : firstLine(diagnostics);
}
