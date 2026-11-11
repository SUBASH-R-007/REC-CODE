import { SQL_LIMITS } from "@recx/shared";
import { errorMessage } from "./errors";
import type { SandboxLike } from "./judge";
import type { Logger } from "./logger";

/**
 * Node calibration for the SQL engine (Phase 16n, `docs/ROADMAP.md` §2.1).
 *
 * Phase 12k shipped without one and said so in the lane restriction a SQL
 * node reported: *"the SQL engine has no calibration benchmark yet: a
 * query's limit is the database's own statement_timeout"*. That sentence
 * was true, and it is what barred a SQL question from an assessment — a
 * paper's submission would queue on a lane no node may claim.
 *
 * **What a calibration is for.** Not to scale a time limit: a query's limit
 * is `statement_timeout`, a wall-clock number the database enforces, and
 * nothing scales it per node. It is to notice that one node in the fleet is
 * materially slower than its neighbours, because a 5-second limit set with a
 * healthy cluster in mind is a different exam on a cluster half the speed.
 * That question — "is this host like the others?" — is answerable for a
 * database, and this is the answer.
 *
 * **What the benchmark measures.** Per-row CPU throughput on the cluster
 * that will judge, measured through the sandbox a candidate's query runs
 * in: the same ephemeral schema, the same student role, the same READ ONLY
 * transaction and the same `statement_timeout`. Work units are rows.
 *
 * **What it deliberately does not measure.** A large hash join or an
 * on-disk sort. No judged query produces one: `SQL_LIMITS.rows` caps a
 * result set at 2,000 and an author's setup script at 64 KB, so the datasets
 * are small and what bounds a judged query is per-row work, not spill
 * behaviour. A benchmark built around `work_mem` would have measured
 * something no candidate can reach — and measured it badly, which is the
 * second reason below.
 *
 * **Why the fastest run and not the median.** The isolate benchmark reports
 * the median of CPU times, and CPU time is already immune to a busy host.
 * This one can only measure WALL time, because wall time is what
 * `statement_timeout` compares against, and wall time on a loaded host is
 * noisy upwards only. The fastest of several runs is the run least
 * disturbed, so it is the one that answers "how fast is this cluster",
 * which is the question. Measured through this exact path on a development
 * laptop running a dev server, a judge worker and a browser at the same
 * time, five runs were 1813, 1880, 1036, 992 and 994 ms: the slowest is
 * nearly twice the fastest, and the fastest two agree to 0.2 % — well
 * inside `LIMITS.calibration.maxDeviation` (10 %). A mean or a median of
 * those would measure what else the machine was doing.
 *
 * **Why the statement verifies itself.** `md5()` returns 32 characters for
 * every row, so the sum of their lengths is exactly 32 × the work units.
 * A cluster that answers anything else did not run the benchmark, and a
 * number from it would be meaningless rather than merely wrong — so no
 * score is reported at all.
 *
 * The score is comparable only between nodes running the same benchmark,
 * which is how the isolate one works too: the fleet median is taken over
 * nodes of the SAME ENGINE (the heartbeat route, Phase 12k), so a query
 * score is never compared against a C++ one.
 */

/**
 * Rows the benchmark processes; the unit of the score. Sized so the fastest
 * run is about `LIMITS.calibration.benchmarkMs` — measured at 992 ms on a
 * busy 2026 laptop, which leaves five times head-room under the
 * `statement_timeout` a judged query gets.
 */
export const SQL_CALIBRATION_WORK_UNITS = 1_000_000;

/** Runs per measurement. Cheap, and the fastest of them is the reported one. */
export const SQL_CALIBRATION_RUNS = 5;

/** md5() is 32 characters for every row, so the checksum is fixed by the work units. */
export const SQL_CALIBRATION_CHECKSUM = 32 * SQL_CALIBRATION_WORK_UNITS;

/**
 * One statement, because the sandbox allows exactly one — and one that
 * cannot be elided: `sum()` needs every `length()`, which needs every
 * `md5()`. No table, so it measures the cluster and not the dataset; no
 * text comparison, so a cluster's collation cannot change the score; no
 * sort and no join, for the reason in the header.
 */
export const SQL_CALIBRATION_SOURCE =
  `SELECT sum(length(md5(s.i::text)))::bigint AS checksum ` +
  `FROM generate_series(1, ${SQL_CALIBRATION_WORK_UNITS}) AS s(i)`;

/** The benchmark needs no dataset; the comment is a valid empty setup script. */
export const SQL_CALIBRATION_SETUP = "-- the calibration benchmark reads no table";

export interface SqlCalibrationResult {
  score: number | null;
  at: string;
}

/**
 * PURE: the score from a list of per-run wall times (ms). Work units per
 * second of the FASTEST run; null when no run produced a positive time.
 */
export function sqlCalibrationScore(
  msSamples: readonly number[],
  workUnits: number = SQL_CALIBRATION_WORK_UNITS,
): number | null {
  const usable = msSamples.filter((ms) => ms > 0);
  if (usable.length === 0) return null;
  return Math.round(workUnits / (Math.min(...usable) / 1000));
}

export interface SqlCalibrationOptions {
  sandbox: SandboxLike;
  logger: Logger;
  runs?: number;
  signal?: AbortSignal;
}

/**
 * Run the benchmark `runs` times through the sandbox and report the score.
 *
 * A run that times out, errors or returns the wrong checksum contributes no
 * sample. If none does, the score is null — which the web app reads as
 * "calibration missing" and withholds ASSESSMENT and CONTEST from the node,
 * because a cluster that cannot finish a 1-million-row sum inside the same
 * `statement_timeout` a candidate gets is not a cluster to sit an exam on.
 */
export async function runSqlCalibration(options: SqlCalibrationOptions): Promise<SqlCalibrationResult> {
  const { sandbox, logger } = options;
  const runs = options.runs ?? SQL_CALIBRATION_RUNS;
  const at = new Date().toISOString();
  const samples: number[] = [];

  for (let i = 0; i < runs; i++) {
    if (options.signal?.aborted) break;
    try {
      const outcome = await sandbox.runCase({
        setup: SQL_CALIBRATION_SETUP,
        source: SQL_CALIBRATION_SOURCE,
        maxRows: 1,
      });
      if (outcome.kind !== "ok") {
        logger.warn({ run: i, outcome: outcome.kind }, "calibration run did not finish cleanly");
        continue;
      }
      const checksum = outcome.result.rows[0]?.[0] ?? null;
      if (checksum !== String(SQL_CALIBRATION_CHECKSUM)) {
        // Not a slow cluster: a cluster that did not run the benchmark.
        logger.error({ run: i, checksum }, "calibration checksum is wrong; the score would be meaningless");
        return { score: null, at };
      }
      samples.push(outcome.ms);
    } catch (error) {
      logger.error({ run: i, err: errorMessage(error) }, "calibration failed to run");
      return { score: null, at };
    }
  }

  const score = sqlCalibrationScore(samples);
  logger.info(
    { score, samples, workUnits: SQL_CALIBRATION_WORK_UNITS, statementTimeoutMs: SQL_LIMITS.statementTimeoutMs },
    "calibration measured",
  );
  return { score, at };
}
