import { LIMITS } from "@recx/shared";
import { errorMessage } from "./errors";
import type { Logger } from "./logger";
import type { Sandbox } from "./sandbox/types";
import { C_RUNTIME, compileProgram, nativeRunLimits, runProgram } from "./selfcheck/exec";

/**
 * Node calibration: a fixed, deterministic CPU benchmark run through the
 * sandbox a few times at boot and every LIMITS.calibration.intervalMs. The
 * score is work units per CPU second (the median across runs); higher is
 * faster. The fleet-median comparison that bars sensitive lanes on a node more
 * than LIMITS.calibration.maxDeviation off the median happens in the web app —
 * the node only reports its score and the time it was measured.
 */

/** Fixed amount of integer work the benchmark performs; the unit of the score. */
export const CALIBRATION_WORK_UNITS = 1_000_000_000;

/** Runs through the sandbox at boot and every 6 h. */
export const CALIBRATION_RUNS = 3;

/**
 * A tight, side-effect-light integer loop (an xorshift-style mix) of exactly
 * CALIBRATION_WORK_UNITS iterations. -O2 cannot elide it because the result is
 * printed, and it touches no memory beyond a register, so the score reflects
 * core integer throughput rather than the memory system. ~1 s on a modern core.
 */
export const CALIBRATION_SOURCE = `#include <stdio.h>
#include <stdint.h>
int main(void) {
  uint64_t x = 0x9e3779b97f4a7c15ULL;
  for (uint64_t i = 0; i < ${CALIBRATION_WORK_UNITS}ULL; i++) {
    x ^= x << 13;
    x ^= x >> 7;
    x ^= x << 17;
    x += 0x2545f4914f6cdd1dULL;
  }
  printf("%llu\\n", (unsigned long long)x);
  return 0;
}
`;

/** PURE: median of a list of numbers (average of the two middle values for an even count). */
export function median(values: readonly number[]): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  if (sorted.length % 2 === 1) return sorted[mid]!;
  return (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * PURE: the calibration score from a list of per-run CPU times (ms). Each run's
 * score is work units ÷ CPU seconds; the reported score is their median.
 * Returns null when no run produced a positive CPU time.
 */
export function calibrationScore(cpuMsSamples: readonly number[], workUnits: number = CALIBRATION_WORK_UNITS): number | null {
  const scores = cpuMsSamples.filter((ms) => ms > 0).map((ms) => workUnits / (ms / 1000));
  if (scores.length === 0) return null;
  return Math.round(median(scores));
}

export interface CalibrationResult {
  score: number | null;
  at: string;
}

export interface CalibrationOptions {
  sandbox: Sandbox;
  logger: Logger;
  runs?: number;
  signal?: AbortSignal;
}

/** Compile the benchmark once, run it `runs` times, and report the median score. */
export async function runCalibration(options: CalibrationOptions): Promise<CalibrationResult> {
  const { sandbox, logger } = options;
  const runs = options.runs ?? CALIBRATION_RUNS;
  const at = new Date().toISOString();
  try {
    const artifacts = await compileProgram(sandbox, C_RUNTIME, CALIBRATION_SOURCE);
    // The benchmark targets ~1 s; give it generous CPU and wall head-room.
    const limits = nativeRunLimits({ cpuMs: Math.min(LIMITS.cpuTime.ceilingMs, 10_000) });
    const samples: number[] = [];
    for (let i = 0; i < runs; i++) {
      if (options.signal?.aborted) break;
      const run = await runProgram(sandbox, C_RUNTIME, artifacts, {
        limits,
        ...(options.signal ? { signal: options.signal } : {}),
      });
      if (run.verdict !== "AC") {
        logger.warn({ run: i, verdict: run.verdict }, "calibration run did not finish cleanly");
        continue;
      }
      samples.push(run.timeMs);
    }
    const score = calibrationScore(samples);
    logger.info({ score, samples, benchmarkMs: LIMITS.calibration.benchmarkMs }, "calibration measured");
    return { score, at };
  } catch (error) {
    logger.error({ err: errorMessage(error) }, "calibration failed to run");
    return { score: null, at };
  }
}
