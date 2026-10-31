import {
  JUDGE_RETRY,
  JVM_LANGUAGE_KEYS,
  LANGUAGE_KEYS,
  LIMITS,
  RUN_OUTCOME_RULES,
  SANDBOX_FORCED_ENV,
  TOOLCHAIN_ROOT,
  VERDICT_PRECEDENCE,
  Verdict,
  deriveTimeLimitMs,
  jvmRunFlags,
  languageRuntimeSchema,
  wallTimeSecFor,
  type RunOutcomeRuleId,
} from "@recx/shared";
import { judgeLanguageAnchor } from "@/lib/judge/judge-links";

/**
 * The view model of the public /judge transparency page (and the language
 * rows of /help). Pure: no database, no server-only, no I/O.
 *
 * Every value comes from a single source the judge itself uses:
 *   - the enabled, current LanguageConfig rows' `runtime` JSON — exactly what
 *     the worker receives at claim time (compile/run argv, environment,
 *     process and file limits, fallback multiplier);
 *   - LIMITS and its derivations (deriveTimeLimitMs, wallTimeSecFor), and
 *     jvmRunFlags() for the memory-derived JVM flags;
 *   - RUN_OUTCOME_RULES, VERDICT_PRECEDENCE and SANDBOX_FORCED_ENV.
 * Only ENFORCED limits are published: there is no per-box inode limit, so
 * LIMITS.scratchDisk.inodes is not listed.
 */

/** One LanguageConfig row as /judge reads it (enabled && isCurrent). */
export interface PublicLanguageRow {
  key: string;
  label: string;
  version: string;
  toolchainId: string;
  runtime: unknown;
}

/** The C++ limit the worked examples start from: an illustration, not a rule. */
export const EXAMPLE_BASE_MS = 1_000;
/** CPU limits whose wall-clock safety net is shown as an example. */
export const WALL_EXAMPLES_MS = [1_000, 2_000] as const;
/** Memory limits the JVM flags are shown for: the default and the ceiling. */
export const HEAP_EXAMPLES_KB = [LIMITS.memory.defaultKb, LIMITS.memory.ceilingKb] as const;

// ── Formatting ────────────────────────────────────────────────────────────

const group = (n: number) => n.toLocaleString("en-US");
const unit = (x: number) => (Number.isInteger(x) ? group(x) : x.toFixed(1));
const KIB = 1024;
const MIB = 1024 * 1024;

const SHELL_SAFE = /^[A-Za-z0-9_@%+=:,./-]+$/;

/** One argument as a POSIX shell would need it: single-quoted only when needed. */
export function shellQuote(arg: string): string {
  if (arg === "") return "''";
  return SHELL_SAFE.test(arg) ? arg : `'${arg.replace(/'/g, "'\\''")}'`;
}

/** An argv as one copy-pasteable command line. */
export function displayArgv(argv: readonly string[]): string {
  return argv.map(shellQuote).join(" ");
}

/** isolate's KiB, both ways: "256 MiB (262,144 KiB)". */
export function formatKib(kb: number): string {
  const exact = `${group(kb)} KiB`;
  if (kb >= MIB) return `${unit(kb / MIB)} GiB (${exact})`;
  if (kb >= KIB) return `${unit(kb / KIB)} MiB (${exact})`;
  return exact;
}

/** Bytes, exact: "64 MiB", "8 KiB", "1,000 bytes". */
export function formatBytes(bytes: number): string {
  if (bytes >= MIB && bytes % MIB === 0) return `${group(bytes / MIB)} MiB`;
  if (bytes >= KIB && bytes % KIB === 0) return `${group(bytes / KIB)} KiB`;
  return `${group(bytes)} bytes`;
}

/** "1.5 s", "15 s", "300 ms". */
export function formatMs(ms: number): string {
  return ms >= 1000 ? `${ms / 1000} s` : `${group(ms)} ms`;
}

// ── Facts ─────────────────────────────────────────────────────────────────

export interface JudgeLanguageFact {
  key: string;
  /** Heading id on /judge (judgeLanguageAnchor). */
  anchor: string;
  label: string;
  version: string;
  toolchainId: string;
  /** False when the stored runtime does not parse or names another language. */
  available: boolean;
  /** Read-only toolchain directories bound into the box (Kotlin also gets the JDK). */
  toolchains: string[];
  sourceFile: string | null;
  /** null = no compile step at all. */
  compile: { command: string; cpuSec: number; wallSec: number; slow: boolean } | null;
  run: string | null;
  /** The language's variables minus the forced ones, then SANDBOX_FORCED_ENV (the sandbox's own order). */
  env: ReadonlyArray<readonly [string, string]>;
  processes: number | null;
  openFiles: number | null;
  managed: boolean;
  /**
   * JVM languages: the flags the worker inserts after the `java` program,
   * sized from the problem's memory limit (jvmRunFlags), shown for
   * HEAP_EXAMPLES_KB. null for every other language.
   */
  jvmFlags: Array<{ memoryKb: number; flags: string }> | null;
  /** The limit used when a problem has no measured model solution in this language. */
  fallback: { multiplier: number; extraMs: number; exampleMs: number } | null;
}

export type JudgeLimitId =
  | "cpu"
  | "extra"
  | "wall"
  | "memory"
  | "stack"
  | "processes"
  | "open-files"
  | "file-size"
  | "stdout"
  | "stderr"
  | "artefacts"
  | "core"
  | "source"
  | "compile"
  | "custom-run"
  | "visible-detail"
  | "startup-credit";

/** What happens when a limit is reached: a verdict, a refusal before judging, a cut, or nothing visible. */
export type JudgeLimitBreach = Verdict | "rejected" | "truncated" | null;

export interface JudgeLimitFact {
  id: JudgeLimitId;
  resource: string;
  value: string;
  mechanism: string;
  breach: JudgeLimitBreach;
}

export interface JudgeTimingFacts {
  floorMs: number;
  ceilingMs: number;
  roundToMs: number;
  modelMultiplier: number;
  extraTimeSec: number;
  startupRuns: number;
  startupMaxMs: number;
  runCpuMaxMs: number;
  wall: Array<{ cpuMs: number; wallSec: number }>;
  wallMultiplier: number;
  wallAddSec: number;
  wallCeilingSec: number;
  /** LIMITS.calibration.maxDeviation as a percentage. */
  flipMarginPct: number;
}

export interface JudgeOutcomeRule {
  id: RunOutcomeRuleId;
  verdict: Verdict | null;
  text: string;
}

export interface JudgeFacts {
  /** Sorted by LANGUAGE_KEYS order, one per key. */
  languages: JudgeLanguageFact[];
  limits: JudgeLimitFact[];
  timing: JudgeTimingFacts;
  outcomeRules: JudgeOutcomeRule[];
  precedence: readonly Verdict[];
}

/** Plain words for each published rule. Exhaustive: a new rule fails typecheck until it has its prose. */
export const RUN_OUTCOME_TEXT: Readonly<Record<RunOutcomeRuleId, string>> = {
  "sandbox-failure": `The sandbox itself failed. This is an internal error, never your code's: the job is retried (up to ${JUDGE_RETRY.attempts} attempts in all) and never counted against you.`,
  "output-trip": "The program printed more than the output limit for the test, so the judge stopped it early.",
  "time-limit":
    "The sandbox stopped the program at its time limit. A program that sits idle (for example waiting for input that never comes) is stopped by the wall-clock safety net instead; that is still Time Limit Exceeded.",
  "cpu-overrun":
    "The program finished inside the extra time but used more CPU time than the limit.",
  "memory-limit":
    "The memory control group stopped the program, or its peak memory reached the limit.",
  "file-size-signal": "A file the program wrote passed the per-file size limit (signal SIGXFSZ).",
  signal: "Any other signal (for example SIGSEGV or SIGFPE) is a runtime error, named by its signal.",
  "runtime-out-of-memory":
    "The language runtime reported running out of memory itself: java.lang.OutOfMemoryError (JVM exit code 1) or Python's MemoryError.",
  "exit-code":
    "A non-zero exit code is a runtime error, shown with the code; java.lang.StackOverflowError is named as such.",
  compare:
    "The program exited normally within every limit: its output is compared with the expected answer by the problem's compare mode or checker.",
};

function forcedEnvLast(env: Readonly<Record<string, string>>): Array<readonly [string, string]> {
  const own = Object.entries(env).filter(([key]) => !(key in SANDBOX_FORCED_ENV));
  return [...own, ...Object.entries(SANDBOX_FORCED_ENV)];
}

const keyOrder = (key: string) => {
  const index = (LANGUAGE_KEYS as readonly string[]).indexOf(key);
  return index < 0 ? LANGUAGE_KEYS.length : index;
};

function languageFact(row: PublicLanguageRow): JudgeLanguageFact {
  const base = {
    key: row.key,
    anchor: judgeLanguageAnchor(row.key),
    label: row.label,
    version: row.version,
    toolchainId: row.toolchainId,
  };
  const parsed = languageRuntimeSchema.safeParse(row.runtime);
  if (!parsed.success || parsed.data.key !== row.key) {
    return {
      ...base,
      available: false,
      toolchains: [],
      sourceFile: null,
      compile: null,
      run: null,
      env: [],
      processes: null,
      openFiles: null,
      managed: false,
      jvmFlags: null,
      fallback: null,
    };
  }
  const rt = parsed.data;
  const slow = rt.compile?.slow ?? false;
  const jvm = JVM_LANGUAGE_KEYS.includes(rt.key);
  return {
    ...base,
    available: true,
    toolchains: [rt.toolchainId, ...rt.extraToolchainIds].map((id) => `${TOOLCHAIN_ROOT}/${id}`),
    sourceFile: rt.sourceFile,
    compile: rt.compile
      ? {
          command: displayArgv(rt.compile.argv),
          cpuSec: slow ? LIMITS.compile.cpuSecSlow : LIMITS.compile.cpuSec,
          wallSec: slow ? LIMITS.compile.wallSecSlow : LIMITS.compile.wallSec,
          slow,
        }
      : null,
    run: displayArgv(rt.run.argv),
    env: forcedEnvLast(rt.env),
    processes: rt.processes,
    openFiles: rt.openFiles,
    managed: rt.family === "managed",
    jvmFlags: jvm
      ? HEAP_EXAMPLES_KB.map((memoryKb) => ({ memoryKb, flags: displayArgv(jvmRunFlags(memoryKb)) }))
      : null,
    fallback: {
      multiplier: rt.fallbackMultiplier,
      extraMs: rt.fallbackExtraMs,
      exampleMs: deriveTimeLimitMs({
        baseMs: EXAMPLE_BASE_MS,
        measuredModelMs: null,
        multiplier: rt.fallbackMultiplier,
        extraMs: rt.fallbackExtraMs,
      }),
    },
  };
}

function limitFacts(): JudgeLimitFact[] {
  const L = LIMITS;
  const nativeManaged = (native: number, managed: number) =>
    `${native} for native programs, ${managed} for managed runtimes`;
  return [
    {
      id: "cpu",
      resource: "CPU time",
      value: `Per problem and language, from ${formatMs(L.cpuTime.floorMs)} to ${formatMs(L.cpuTime.ceilingMs)}`,
      mechanism: "isolate --time: CPU time of the sandbox's control group",
      breach: Verdict.TLE,
    },
    {
      id: "extra",
      resource: "Extra time",
      value: `${L.extraTimeSec} s past the CPU limit`,
      mechanism: "isolate --extra-time: an overrun is measured, not cut off at the limit",
      breach: Verdict.TLE,
    },
    {
      id: "wall",
      resource: "Wall-clock time",
      value: `ceil(${L.wallTime.multiplier} × CPU limit) + ${L.wallTime.addSec} s, at most ${L.wallTime.ceilingSec} s`,
      mechanism: "isolate --wall-time: a safety net for a program that waits",
      breach: Verdict.TLE,
    },
    {
      id: "memory",
      resource: "Memory",
      value: `${formatKib(L.memory.defaultKb)} unless the problem sets another, at most ${formatKib(L.memory.ceilingKb)}`,
      mechanism: "isolate --cg-mem: peak of the sandbox's memory control group, never an address-space limit",
      breach: Verdict.MLE,
    },
    {
      id: "stack",
      resource: "Stack",
      value: `${L.stack.equalsMemoryLimit ? "Equal to the memory limit" : "Fixed"}, at most ${formatKib(L.stack.ceilingKb)}`,
      mechanism: "isolate --stack",
      breach: Verdict.RE,
    },
    {
      id: "processes",
      resource: "Processes and threads",
      value: nativeManaged(L.processes.native, L.processes.managed),
      mechanism: "isolate --processes (RLIMIT_NPROC and the control group's pids.max)",
      breach: Verdict.RE,
    },
    {
      id: "open-files",
      resource: "Open files",
      value: nativeManaged(L.openFiles.native, L.openFiles.managed),
      mechanism: "isolate --open-files",
      breach: Verdict.RE,
    },
    {
      id: "file-size",
      resource: "Each file written",
      value: formatKib(L.outputFile.defaultKb),
      mechanism: "isolate --fsize: a larger write is stopped with SIGXFSZ",
      breach: Verdict.OLE,
    },
    {
      id: "stdout",
      resource: "Standard output",
      value: `min(${formatBytes(L.earlyOle.capBytes)}, ${L.earlyOle.perExpectedMultiplier} × the expected output + ${formatBytes(L.earlyOle.slackBytes)}), checked every ${formatMs(L.earlyOle.pollMs)}`,
      mechanism: "the judge stops the program once its output passes that size",
      breach: Verdict.OLE,
    },
    {
      id: "stderr",
      resource: "Error output kept",
      value: formatBytes(L.stderrCapture.defaultBytes),
      mechanism: "the judge keeps at most this much of what the program writes to stderr",
      breach: "truncated",
    },
    {
      id: "artefacts",
      resource: "Compiled files",
      value: `${L.scratchDisk.defaultMb} MiB in all`,
      mechanism: "files the compiler produces beyond that are refused",
      breach: Verdict.CE,
    },
    {
      id: "core",
      resource: "Core dumps",
      value: L.coreDumpKb === 0 ? "None" : formatKib(L.coreDumpKb),
      mechanism: "isolate --core",
      breach: null,
    },
    {
      id: "source",
      resource: "Source code",
      value: formatBytes(L.source.defaultBytes),
      mechanism: "checked when you submit or run, before anything is judged",
      breach: "rejected",
    },
    {
      id: "compile",
      resource: "Compilation",
      value:
        `CPU ${L.compile.cpuSec} s (${L.compile.cpuSecSlow} s for slow compilers), wall clock ${L.compile.wallSec} s ` +
        `(${L.compile.wallSecSlow} s), memory ${formatKib(L.compile.memoryKb)}, ${L.compile.processes} processes, ` +
        `files ${formatKib(L.compile.fsizeKb)}, messages kept ${formatBytes(L.compile.outputBytes)}`,
      mechanism: "a separate sandbox, before any test runs",
      breach: Verdict.CE,
    },
    {
      id: "custom-run",
      resource: "Run button",
      value:
        `CPU at most ${formatMs(L.customRun.cpuMaxMs)}, input ${formatBytes(L.customRun.stdinBytes)}, ` +
        `output shown ${formatBytes(L.customRun.stdoutBytes)}, errors shown ${formatBytes(L.customRun.stderrBytes)}, ` +
        `kept ${L.customRun.ttlHours} hours`,
      mechanism: "the problem's own limits, with the CPU limit capped; never scored",
      breach: null,
    },
    {
      id: "visible-detail",
      resource: "Shown for sample tests",
      value:
        `${formatBytes(L.detail.perTestBytes)} per test, ${formatBytes(L.detail.perSubmissionBytes)} per submission, ` +
        `kept ${L.detail.retentionDays} days`,
      mechanism: "hidden tests show only their verdict, CPU time and memory",
      breach: "truncated",
    },
    {
      id: "startup-credit",
      resource: "Start-up credit",
      value: `Median CPU time of ${L.startupCredit.runs} hello-world runs on that judge, at most ${formatMs(L.startupCredit.maxMs)}`,
      mechanism: "added to the CPU limit when a judge takes the job",
      breach: null,
    },
  ];
}

function timingFacts(): JudgeTimingFacts {
  return {
    floorMs: LIMITS.cpuTime.floorMs,
    ceilingMs: LIMITS.cpuTime.ceilingMs,
    roundToMs: LIMITS.timeLimit.roundToMs,
    modelMultiplier: LIMITS.timeLimit.modelMultiplier,
    extraTimeSec: LIMITS.extraTimeSec,
    startupRuns: LIMITS.startupCredit.runs,
    startupMaxMs: LIMITS.startupCredit.maxMs,
    runCpuMaxMs: LIMITS.customRun.cpuMaxMs,
    wall: WALL_EXAMPLES_MS.map((cpuMs) => ({ cpuMs, wallSec: wallTimeSecFor(cpuMs) })),
    wallMultiplier: LIMITS.wallTime.multiplier,
    wallAddSec: LIMITS.wallTime.addSec,
    wallCeilingSec: LIMITS.wallTime.ceilingSec,
    flipMarginPct: Math.round(LIMITS.calibration.maxDeviation * 100),
  };
}

/** Everything /judge shows, from the enabled, current LanguageConfig rows. */
export function buildJudgeFacts(rows: readonly PublicLanguageRow[]): JudgeFacts {
  const seen = new Set<string>();
  const unique = rows.filter((row) => (seen.has(row.key) ? false : (seen.add(row.key), true)));
  const languages = unique
    .map(languageFact)
    .sort((a, b) => keyOrder(a.key) - keyOrder(b.key) || a.key.localeCompare(b.key));
  return {
    languages,
    limits: limitFacts(),
    timing: timingFacts(),
    outcomeRules: RUN_OUTCOME_RULES.map((rule) => ({ id: rule.id, verdict: rule.verdict, text: RUN_OUTCOME_TEXT[rule.id] })),
    precedence: VERDICT_PRECEDENCE,
  };
}
