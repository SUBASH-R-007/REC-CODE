import { JVM_LANGUAGE_KEYS, type LanguageKey } from "@recx/shared";
import type { IsolateMeta } from "../sandbox/types";

/**
 * isolate meta → verdict. These rules are published on the /judge
 * transparency page, so they are exact and ordered. The published list is
 * RUN_OUTCOME_RULES in packages/shared/src/verdict.ts; a change of order or
 * of a rule here must change it too (test/verdict-rules.test.ts fails
 * otherwise):
 *
 *   1. status XX                          → IE (infrastructure; retried, never shown)
 *   2. the supervisor's early output trip → OLE
 *   3. status TO, CPU ≥ limit             → TLE
 *      status TO, CPU < limit             → TLE + idle flag (wall clock ran out
 *                                           while the CPU idled; admin-visible only)
 *      any other status, CPU > limit      → TLE (the program ended inside
 *                                           --extra-time; isolate then reports its
 *                                           exit status, RE or SG, instead of TO)
 *   4. cg-oom-killed, or cg-mem ≥ limit   → MLE
 *   5. status SG: SIGXFSZ (25)            → OLE; any other signal → RE (signal name)
 *   6. status RE                          → RE with the exit code, refined:
 *        JVM exit 1 + java.lang.OutOfMemoryError → MLE
 *        JVM + java.lang.StackOverflowError      → RE labelled as such
 *        Python + MemoryError                    → MLE
 *   7. exit 0 within every limit          → compare the output (AC / WA)
 */

const LINUX_SIGNALS: Readonly<Record<number, string>> = {
  1: "SIGHUP",
  2: "SIGINT",
  3: "SIGQUIT",
  4: "SIGILL",
  5: "SIGTRAP",
  6: "SIGABRT",
  7: "SIGBUS",
  8: "SIGFPE",
  9: "SIGKILL",
  10: "SIGUSR1",
  11: "SIGSEGV",
  12: "SIGUSR2",
  13: "SIGPIPE",
  14: "SIGALRM",
  15: "SIGTERM",
  16: "SIGSTKFLT",
  17: "SIGCHLD",
  18: "SIGCONT",
  19: "SIGSTOP",
  20: "SIGTSTP",
  21: "SIGTTIN",
  22: "SIGTTOU",
  23: "SIGURG",
  24: "SIGXCPU",
  25: "SIGXFSZ",
  26: "SIGVTALRM",
  27: "SIGPROF",
  28: "SIGWINCH",
  29: "SIGIO",
  30: "SIGPWR",
  31: "SIGSYS",
};

export const SIGXFSZ = 25;

export function signalName(signal: number): string {
  return LINUX_SIGNALS[signal] ?? `SIG${signal}`;
}

const JVM_LANGUAGES: ReadonlySet<LanguageKey> = new Set(JVM_LANGUAGE_KEYS);
const PYTHON_LANGUAGES: ReadonlySet<LanguageKey> = new Set(["py312", "pypy310"]);

export interface RunContext {
  timeLimitMs: number;
  memoryLimitKb: number;
  language: LanguageKey;
  /** The program's stderr (head and tail), for the runtime refinements. */
  stderr: string;
  /** The supervisor stopped the run for exceeding the output limit. */
  outputLimitExceeded: boolean;
}

export interface RunClassification {
  /** null = finished cleanly within every limit: the output decides AC / WA. */
  verdict: "TLE" | "MLE" | "RE" | "OLE" | "IE" | null;
  /** cgroup CPU time. */
  timeMs: number;
  /** cgroup memory peak, else max RSS. */
  memoryKb: number;
  exitCode: number | null;
  signal: string | null;
  /** Wall-clock TLE with an idle CPU. Still TLE to the student. */
  idle: boolean;
  message: string | null;
}

export function classifyRun(meta: IsolateMeta, ctx: RunContext): RunClassification {
  const base: RunClassification = {
    verdict: null,
    timeMs: Math.round((meta.timeSec ?? 0) * 1000),
    memoryKb: Math.round(meta.cgMemKb ?? meta.maxRssKb ?? 0),
    exitCode: meta.exitCode,
    signal: meta.exitSignal === null ? null : signalName(meta.exitSignal),
    idle: false,
    message: null,
  };

  if (meta.status === "XX") {
    return { ...base, verdict: "IE", message: meta.message ?? "isolate internal error" };
  }
  if (ctx.outputLimitExceeded) {
    return { ...base, verdict: "OLE", exitCode: null, signal: null, message: "Output exceeded the limit." };
  }
  if (meta.status === "TO") {
    const idle = base.timeMs < ctx.timeLimitMs;
    return {
      ...base,
      verdict: "TLE",
      exitCode: null,
      signal: null,
      idle,
      message: idle ? "Wall-clock limit reached while the CPU was idle." : null,
    };
  }
  if (base.timeMs > ctx.timeLimitMs) {
    return { ...base, verdict: "TLE", exitCode: null, signal: null };
  }
  if (meta.cgOomKilled || (meta.cgMemKb !== null && meta.cgMemKb >= ctx.memoryLimitKb)) {
    return { ...base, verdict: "MLE" };
  }
  if (meta.status === "SG") {
    if (meta.exitSignal === SIGXFSZ) {
      return { ...base, verdict: "OLE", message: "Output file size limit exceeded (SIGXFSZ)." };
    }
    return { ...base, verdict: "RE", message: base.signal ? `Killed by ${base.signal}.` : "Killed by a signal." };
  }
  if (meta.status === "RE" || (meta.exitCode !== null && meta.exitCode !== 0)) {
    return refineRuntimeError(base, ctx);
  }
  return base;
}

function refineRuntimeError(base: RunClassification, ctx: RunContext): RunClassification {
  if (JVM_LANGUAGES.has(ctx.language)) {
    if (base.exitCode === 1 && ctx.stderr.includes("java.lang.OutOfMemoryError")) {
      return { ...base, verdict: "MLE", message: "java.lang.OutOfMemoryError" };
    }
    if (ctx.stderr.includes("java.lang.StackOverflowError")) {
      return { ...base, verdict: "RE", message: "java.lang.StackOverflowError" };
    }
  }
  if (PYTHON_LANGUAGES.has(ctx.language) && /(^|\n)MemoryError\b/.test(ctx.stderr)) {
    return { ...base, verdict: "MLE", message: "MemoryError" };
  }
  return { ...base, verdict: "RE", message: base.exitCode === null ? null : `Exit code ${base.exitCode}.` };
}

export type CompileClassification = "ok" | "error" | "resource" | "infra";

/**
 * A compile is an error (CE with the compiler's diagnostics) when the
 * compiler exits non-zero, and a resource failure (CE "compilation exceeded
 * resource limits") when the caps killed it: time, memory or a signal.
 */
export function classifyCompile(meta: IsolateMeta): CompileClassification {
  if (meta.status === "XX") return "infra";
  if (meta.status === "TO" || meta.status === "SG" || meta.cgOomKilled) return "resource";
  if (meta.status === "RE" || (meta.exitCode !== null && meta.exitCode !== 0)) return "error";
  return "ok";
}
