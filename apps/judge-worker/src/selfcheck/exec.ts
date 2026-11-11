import { LANGUAGE_CATALOG, LIMITS, wallTimeSecFor, type LanguageRuntime, type Verdict } from "@recx/shared";
import { InfraError } from "../errors";
import { classifyCompile, classifyRun } from "../judge/verdict";
import type { Sandbox, SandboxLimits } from "../sandbox/types";

/**
 * Minimal compile-and-run on a Sandbox for the node's own maintenance
 * programs — the self-check fixtures, the calibration benchmark and the
 * per-language hello-world startup credit. It is NOT the student judging path
 * (src/judge/run-job.ts): no harness, no output comparison, no scoring. It
 * reuses the same classifiers so a maintenance program's verdict means exactly
 * what a submission's would.
 */

const SOURCE_UNSUPPORTED = "a maintenance program cannot be built without a compile or run command";

interface Artifact {
  name: string;
  data: Buffer;
  mode: number;
}

const COMPILE_STDOUT = "compile.stdout";
const COMPILE_STDERR = "compile.stderr";
const OUTPUT_FILE = "output.txt";
const ERROR_FILE = "error.txt";
const CAPTURE_BYTES = 16 * 1024;

export function nativeRunLimits(overrides: Partial<SandboxLimits> = {}): SandboxLimits {
  const cpuMs = overrides.cpuMs ?? 2_000;
  const memoryKb = overrides.memoryKb ?? LIMITS.memory.defaultKb;
  return {
    cpuMs,
    wallSec: overrides.wallSec ?? wallTimeSecFor(cpuMs),
    memoryKb,
    stackKb: overrides.stackKb ?? Math.min(memoryKb, LIMITS.stack.ceilingKb),
    processes: overrides.processes ?? LIMITS.processes.native,
    openFiles: overrides.openFiles ?? LIMITS.openFiles.native,
    fsizeKb: overrides.fsizeKb ?? LIMITS.outputFile.defaultKb,
  };
}

function compileLimits(language: LanguageRuntime): SandboxLimits {
  const slow = language.compile?.slow ?? false;
  const memoryKb = LIMITS.compile.memoryKb;
  return {
    cpuMs: (slow ? LIMITS.compile.cpuSecSlow : LIMITS.compile.cpuSec) * 1000,
    wallSec: slow ? LIMITS.compile.wallSecSlow : LIMITS.compile.wallSec,
    memoryKb,
    stackKb: Math.min(memoryKb, LIMITS.stack.ceilingKb),
    processes: LIMITS.compile.processes,
    openFiles: Math.max(language.openFiles, LIMITS.openFiles.managed),
    fsizeKb: LIMITS.compile.fsizeKb,
  };
}

/** Compile a maintenance program; throws InfraError if it does not compile cleanly. */
export async function compileProgram(
  sandbox: Sandbox,
  language: LanguageRuntime,
  source: string,
): Promise<Artifact[]> {
  const toolchainIds = [language.toolchainId, ...language.extraToolchainIds];
  if (!language.compile) {
    return [{ name: language.sourceFile, data: Buffer.from(source, "utf8"), mode: 0o644 }];
  }
  await sandbox.init("compile");
  try {
    await sandbox.writeFile("compile", language.sourceFile, source, 0o644);
    const result = await sandbox.exec({
      role: "compile",
      argv: language.compile.argv,
      toolchainIds,
      env: language.env,
      limits: compileLimits(language),
      stdin: null,
      stdout: COMPILE_STDOUT,
      stderr: COMPILE_STDERR,
      stdoutCapBytes: CAPTURE_BYTES,
      stderrCapBytes: CAPTURE_BYTES,
      outputLimitBytes: null,
    });
    const klass = classifyCompile(result.meta);
    if (klass !== "ok") {
      const diag = [result.stdout.head.toString("utf8"), result.stderr.head.toString("utf8")].join("\n").trim();
      throw new InfraError(`maintenance program failed to compile (${klass}): ${diag.slice(0, 400)}`);
    }
    const files = (await sandbox.listFiles("compile")).filter((f) => f.name !== COMPILE_STDOUT && f.name !== COMPILE_STDERR);
    const artifacts: Artifact[] = [];
    for (const f of files) {
      artifacts.push({ name: f.name, data: await sandbox.readFile("compile", f.name, LIMITS.scratchDisk.defaultMb * 1024 * 1024), mode: f.mode & 0o111 ? 0o755 : 0o644 });
    }
    if (artifacts.length === 0) throw new InfraError(SOURCE_UNSUPPORTED);
    return artifacts;
  } finally {
    await sandbox.cleanup("compile");
  }
}

export interface NativeRunResult {
  /** The deterministic verdict (AC = finished cleanly within every limit). */
  verdict: Verdict;
  stdout: string;
  stderr: string;
  timeMs: number;
  memoryKb: number;
  idle: boolean;
  outputLimitExceeded: boolean;
}

export interface NativeRunOptions {
  limits: SandboxLimits;
  stdin?: { name: string; data: Buffer | string } | null;
  outputLimitBytes?: number | null;
  signal?: AbortSignal;
}

/** Run a compiled maintenance program in a fresh run box and classify it. */
export async function runProgram(
  sandbox: Sandbox,
  language: LanguageRuntime,
  artifacts: Artifact[],
  options: NativeRunOptions,
): Promise<NativeRunResult> {
  const toolchainIds = [language.toolchainId, ...language.extraToolchainIds];
  await sandbox.init("run");
  try {
    for (const artifact of artifacts) await sandbox.writeFile("run", artifact.name, artifact.data, artifact.mode);
    let stdinName: string | null = null;
    if (options.stdin) {
      await sandbox.writeFile("run", options.stdin.name, options.stdin.data, 0o444);
      stdinName = options.stdin.name;
    }
    const outputLimitBytes = options.outputLimitBytes ?? null;
    const exec = await sandbox.exec({
      role: "run",
      argv: language.run.argv,
      toolchainIds,
      env: language.env,
      limits: options.limits,
      stdin: stdinName,
      stdout: OUTPUT_FILE,
      stderr: ERROR_FILE,
      stdoutCapBytes: outputLimitBytes ?? LIMITS.customRun.stdoutBytes,
      stderrCapBytes: LIMITS.stderrCapture.defaultBytes,
      outputLimitBytes,
      signal: options.signal,
    });
    const run = classifyRun(exec.meta, {
      timeLimitMs: options.limits.cpuMs,
      memoryLimitKb: options.limits.memoryKb,
      language: language.key,
      stderr: exec.stderr.head.toString("utf8"),
      outputLimitExceeded: exec.outputLimitExceeded,
    });
    if (run.verdict === "IE") throw new InfraError(`isolate internal error running a maintenance program: ${run.message ?? ""}`);
    return {
      verdict: run.verdict ?? "AC",
      stdout: exec.stdout.head.toString("utf8"),
      stderr: exec.stderr.head.toString("utf8"),
      timeMs: run.timeMs,
      memoryKb: run.memoryKb,
      idle: run.idle,
      outputLimitExceeded: exec.outputLimitExceeded,
    };
  } finally {
    await sandbox.cleanup("run");
  }
}

/** The C toolchain used for the fixtures and the calibration benchmark. */
export const C_RUNTIME: LanguageRuntime = LANGUAGE_CATALOG.c17;
