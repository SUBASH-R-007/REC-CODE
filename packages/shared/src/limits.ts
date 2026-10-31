import { deepFreeze } from "./freeze";

/**
 * The judge limits table (prompt §3, "Limits table — implement exactly").
 * This module is the only definition in the repository; the worker, the
 * web app's zod boundaries and the /judge transparency page all read it.
 *
 * Units are in the name: Ms, Sec, Kb (kibibytes, isolate's unit), Bytes.
 */
export const LIMITS = deepFreeze({
  /** CPU time is authoritative; per-language TL is derived per problem. */
  cpuTime: { ceilingMs: 15_000, floorMs: 200 },
  /** --extra-time: accurate overrun reporting instead of a hard kill. */
  extraTimeSec: 0.5,
  /** Wall time is only a safety net: ceil(2.5 × CPU TL) + 2s, ≤ 30s. */
  wallTime: { multiplier: 2.5, addSec: 2, ceilingSec: 30 },
  /** --cg-mem. Never --mem / RLIMIT_AS (breaks JVM, Go, Node before main()). */
  memory: { defaultKb: 262_144, ceilingKb: 1_048_576 },
  /** --stack = memory limit, so deep recursive DP does not spuriously segfault. */
  stack: { equalsMemoryLimit: true, ceilingKb: 1_048_576 },
  /** --processes → RLIMIT_NPROC + pids.max. */
  processes: { native: 1, managed: 64, ceiling: 128 },
  /** --open-files. */
  openFiles: { native: 64, managed: 256, ceiling: 1024 },
  /** --fsize (SIGXFSZ → OLE). */
  outputFile: { defaultKb: 65_536, ceilingKb: 262_144 },
  /** Supervisor polls stdout size and kills the cgroup early. */
  earlyOle: { pollMs: 200, capBytes: 64 * 1024 * 1024, perExpectedMultiplier: 2, slackBytes: 1024 * 1024 },
  stderrCapture: { defaultBytes: 8 * 1024, ceilingBytes: 64 * 1024 },
  scratchDisk: { defaultMb: 256, inodes: 4096, ceilingMb: 512 },
  coreDumpKb: 0,
  source: { defaultBytes: 256 * 1024, ceilingBytes: 512 * 1024 },
  compile: {
    cpuSec: 10,
    cpuSecSlow: 25,
    wallSec: 20,
    wallSecSlow: 40,
    memoryKb: 1_048_576,
    processes: 64,
    fsizeKb: 131_072,
    outputBytes: 8 * 1024,
  },
  customRun: {
    cpuMaxMs: 5_000,
    stdinBytes: 64 * 1024,
    stdoutBytes: 64 * 1024,
    stderrBytes: 8 * 1024,
    ttlHours: 24,
  },
  /** SubmissionTestDetail truncation (visible cases only). */
  detail: { perTestBytes: 4 * 1024, perSubmissionBytes: 32 * 1024, retentionDays: 30 },
  /** Samples get a truncated diff; hidden tests get no diff at all. */
  sampleDiffBytes: 256,
  /** TestBlob.inline holds blobs up to this size; larger go to object storage. */
  inlineBlobBytes: 64 * 1024,
  /** Checker box (separate uid, answer.txt read-only). */
  checker: { cpuSec: 10, wallSec: 20, memoryKb: 524_288, outputBytes: 4 * 1024 },
  /**
   * Interactive problems (Phase 12l). The interactor runs under the
   * checker's own caps — it is a testlib program in the checker box — and
   * these are the two numbers that belong to the CONVERSATION rather than
   * to either program.
   *
   * `idleMs`: no byte in either direction for this long means both
   * programs are blocked reading, which is a deadlock and in practice a
   * missing flush. SPEC §11 names the 2 seconds.
   *
   * `interactorOutputBytes`: what the interactor may send the solution
   * across one case. An interactor that floods is the author's bug, so
   * crossing this is a FAIL rather than the student's OLE.
   */
  interactive: { idleMs: 2_000, interactorOutputBytes: 64 * 1024 * 1024 },
  /** Per-user judge caps (super-admin may override per user, audited). */
  userCaps: {
    inFlightSubmissions: 2,
    inFlightRuns: 1,
    practicePerDay: 300,
    runsPerHour: 60,
    cpuMinutesPerDay: 20,
  },
  /** Worker-local compile-artifact cache, shared by Run and Submit. */
  compileCache: { ttlMs: 60 * 60 * 1000, budgetBytes: 5 * 1024 * 1024 * 1024 },
  /** 1-second benchmark at boot and every 6 h; > 10 % off the fleet median bars sensitive lanes. */
  calibration: {
    benchmarkMs: 1_000,
    intervalMs: 6 * 60 * 60 * 1000,
    staleAfterMs: 6.5 * 60 * 60 * 1000,
    maxDeviation: 0.1,
  },
  /** Adversarial self-check at boot and every 6 h; stale after 6.5 h. */
  selfCheck: { intervalMs: 6 * 60 * 60 * 1000, staleAfterMs: 6.5 * 60 * 60 * 1000 },
  /** Hello-world runs per language at boot to measure the startup credit. */
  /** A credit above maxMs means a broken toolchain, not a slow one: it is capped. */
  startupCredit: { runs: 20, maxMs: 1_000 },
  /** TL = clamp(ceil_100ms(max(2.5 × measured model ms, …)), 200 ms, 15 s). */
  timeLimit: { modelMultiplier: 2.5, roundToMs: 100 },
});

/** Wall-time safety net for a CPU time limit, clamped to the ceiling. */
export function wallTimeSecFor(cpuLimitMs: number): number {
  const sec = Math.ceil(LIMITS.wallTime.multiplier * (cpuLimitMs / 1000)) + LIMITS.wallTime.addSec;
  return Math.min(sec, LIMITS.wallTime.ceilingSec);
}

/** Early-OLE trip point for a test with a known expected-output size. */
export function earlyOleCapBytes(expectedOutputBytes: number): number {
  return Math.min(
    LIMITS.earlyOle.capBytes,
    LIMITS.earlyOle.perExpectedMultiplier * expectedOutputBytes + LIMITS.earlyOle.slackBytes,
  );
}

/**
 * Per-language CPU limit from the problem's base (C++) limit using the
 * language's fallback multiplier — used when the problem has no measured
 * model solution in that language (Phase 2 adds measured limits):
 * clamp(ceil_100ms(base × multiplier + extra), 200 ms, 15 s).
 */
export function fallbackTimeLimitMs(baseMs: number, multiplier: number, extraMs: number): number {
  const scaled = Math.ceil((baseMs * multiplier + extraMs) / 100) * 100;
  return clampCpuLimitMs(Math.max(baseMs, scaled));
}

/**
 * Per-language CPU limit for a published problem version (Phase 2):
 *  - with a measured model solution in that language:
 *      clamp(ceil_100ms(max(2.5 × measured, baseTL)), 200 ms, 15 s)
 *  - without one, the fallback multiplier applies:
 *      clamp(ceil_100ms(baseTL × multiplier + extra), 200 ms, 15 s)
 * where baseTL is the author's C++ limit (itself ≥ 2.5 × the mandatory C++
 * model). The node's measured startup credit is added at claim time.
 */
export function deriveTimeLimitMs(input: {
  baseMs: number;
  measuredModelMs: number | null;
  multiplier: number;
  extraMs: number;
}): number {
  const round = LIMITS.timeLimit.roundToMs;
  if (input.measuredModelMs !== null) {
    const scaled = Math.ceil(Math.max(LIMITS.timeLimit.modelMultiplier * input.measuredModelMs, input.baseMs) / round) * round;
    return clampCpuLimitMs(scaled);
  }
  return fallbackTimeLimitMs(input.baseMs, input.multiplier, input.extraMs);
}

export function clampCpuLimitMs(ms: number): number {
  return Math.min(LIMITS.cpuTime.ceilingMs, Math.max(LIMITS.cpuTime.floorMs, Math.round(ms)));
}

export function clampMemoryKb(kb: number): number {
  return Math.min(LIMITS.memory.ceilingKb, Math.max(16 * 1024, Math.round(kb)));
}
