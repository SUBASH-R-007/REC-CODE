import {
  JVM_LANGUAGE_KEYS,
  LIMITS,
  earlyOleCapBytes,
  jvmRunFlags,
  wallTimeSecFor,
  type JudgeJobSpec,
  type LanguageRuntime,
  type TestSpec,
} from "@recx/shared";
import { requireRuntime } from "./plan";
import type { SandboxLimits } from "../sandbox/types";

/**
 * Resource caps for each kind of execution, straight from the limits table
 * in @recx/shared. Nothing here is negotiable by a job spec beyond the
 * problem's own (already clamped) time and memory limits.
 */

/** A test run: the problem's CPU/memory limits; stack = memory (deep recursion is legitimate). */
export function runLimits(spec: Pick<JudgeJobSpec, "timeLimitMs" | "memoryLimitKb" | "language">): SandboxLimits {
  const memoryKb = Math.min(spec.memoryLimitKb, LIMITS.memory.ceilingKb);
  return {
    cpuMs: spec.timeLimitMs,
    wallSec: wallTimeSecFor(spec.timeLimitMs),
    memoryKb,
    stackKb: Math.min(memoryKb, LIMITS.stack.ceilingKb),
    processes: Math.min(requireRuntime(spec).processes, LIMITS.processes.ceiling),
    openFiles: Math.min(requireRuntime(spec).openFiles, LIMITS.openFiles.ceiling),
    fsizeKb: LIMITS.outputFile.defaultKb,
  };
}

/**
 * The run command of a test: the language's fixed argv, plus — for JVM
 * languages — the JVM flags sized from the job's memory limit
 * (jvmRunFlags: -Xmx, -Xss), inserted right after the java program. Nothing
 * here comes from the student; the flags are published on /judge.
 */
export function runArgv(spec: Pick<JudgeJobSpec, "language" | "memoryLimitKb">): string[] {
  const language = requireRuntime(spec);
  const argv = language.run.argv;
  if (!JVM_LANGUAGE_KEYS.includes(language.key)) return [...argv];
  const memoryKb = Math.min(spec.memoryLimitKb, LIMITS.memory.ceilingKb);
  return [argv[0]!, ...jvmRunFlags(memoryKb), ...argv.slice(1)];
}

/** The compile box: fixed, generous caps (LIMITS.compile), longer for slow compilers. */
export function compileLimits(language: Pick<LanguageRuntime, "compile" | "openFiles">): SandboxLimits {
  const slow = language.compile?.slow ?? false;
  return {
    cpuMs: (slow ? LIMITS.compile.cpuSecSlow : LIMITS.compile.cpuSec) * 1000,
    wallSec: slow ? LIMITS.compile.wallSecSlow : LIMITS.compile.wallSec,
    memoryKb: LIMITS.compile.memoryKb,
    stackKb: Math.min(LIMITS.compile.memoryKb, LIMITS.stack.ceilingKb),
    processes: LIMITS.compile.processes,
    openFiles: Math.max(language.openFiles, LIMITS.openFiles.managed),
    fsizeKb: LIMITS.compile.fsizeKb,
  };
}

/**
 * A checker's per-file write cap. A testlib checker writes only its verdict
 * line(s) to stderr; 4 MiB is far beyond any honest message and keeps a
 * runaway checker from filling the box-root tmpfs (SIGXFSZ → checker failure).
 */
export const CHECKER_FSIZE_KB = 4096;

/** The checker box: LIMITS.checker, one process, a native program's file count. */
export function checkerLimits(): SandboxLimits {
  return {
    cpuMs: LIMITS.checker.cpuSec * 1000,
    wallSec: LIMITS.checker.wallSec,
    memoryKb: LIMITS.checker.memoryKb,
    stackKb: Math.min(LIMITS.checker.memoryKb, LIMITS.stack.ceilingKb),
    processes: LIMITS.processes.native,
    openFiles: LIMITS.openFiles.native,
    fsizeKb: CHECKER_FSIZE_KB,
  };
}

/**
 * Where the supervisor stops a run for printing too much: twice the expected
 * output plus slack, never above 64 MB. A custom run has no expected output;
 * its trip point is sized from the most stdout a run can ever display.
 */
export function outputLimitBytes(test: Pick<TestSpec, "output">): number {
  return earlyOleCapBytes(test.output ? test.output.sizeBytes : LIMITS.customRun.stdoutBytes);
}

/** Wall-clock budget for the supervisor's own watchdog around one isolate call. */
export function watchdogMs(limits: SandboxLimits): number {
  return (limits.wallSec + 15) * 1000;
}
