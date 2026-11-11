import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { LIMITS, SQL_LIMITS } from "@recx/shared";
import {
  SQL_CALIBRATION_CHECKSUM,
  SQL_CALIBRATION_SETUP,
  SQL_CALIBRATION_SOURCE,
  SQL_CALIBRATION_WORK_UNITS,
  runSqlCalibration,
} from "../src/calibration";
import { SqlSandbox } from "../src/sandbox";

/**
 * The calibration benchmark against a real cluster (Phase 16n).
 *
 * The pure test proves the arithmetic. This one proves the three things only
 * a database can answer:
 *
 *   1. the statement RUNS inside the sandbox, as the student role, in a READ
 *      ONLY transaction, under the same `statement_timeout` a candidate's
 *      query gets — so the benchmark measures the path it claims to;
 *   2. the cluster agrees with the checksum, which is what makes the score
 *      mean anything;
 *   3. it is REPEATABLE — two measurements of one host agree far more
 *      closely than the deviation the fleet allows — and it finishes with
 *      head-room.
 *
 * Both of those are asserted through the SCORE and never through one run's
 * wall time. Measured here while a Playwright suite was running, five runs
 * were 1813, 1880, 1036, 992 and 994 ms: the fastest two agree to 0.2 % and
 * the slowest is nearly twice the fastest. A test that asserted a single
 * run's duration would be asserting what else the machine was doing, which
 * is the whole reason the score is a fastest-of and not a mean.
 *
 * Opt-in: RECX_SQL_TESTS=1, with the sandbox created by
 * `node scripts/dev/sql-sandbox-up.mjs`.
 */

const ENV_FILE = path.resolve(import.meta.dirname, "..", ".env.local");
const ENABLED = process.env.RECX_SQL_TESTS === "1" && existsSync(ENV_FILE);
if (ENABLED) process.loadEnvFile(ENV_FILE);

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as unknown as Parameters<typeof runSqlCalibration>[0]["logger"];

describe.skipIf(!ENABLED)("the calibration benchmark on a real cluster", () => {
  const sandbox = () =>
    new SqlSandbox({
      ownerUrl: process.env.RECX_SQL_OWNER_URL!,
      studentUrl: process.env.RECX_SQL_STUDENT_URL!,
    });

  it("runs through the sandbox and agrees with the checksum", async () => {
    const outcome = await sandbox().runCase({
      setup: SQL_CALIBRATION_SETUP,
      source: SQL_CALIBRATION_SOURCE,
      maxRows: 1,
    });
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    expect(outcome.result.rows).toHaveLength(1);
    // Every value arrives as the text PostgreSQL printed.
    expect(outcome.result.rows[0]![0]).toBe(String(SQL_CALIBRATION_CHECKSUM));
  }, 60_000);

  it("reports a score with head-room under the limit a judged query gets", async () => {
    const result = await runSqlCalibration({ sandbox: sandbox(), logger, runs: 5 });
    expect(result.score).not.toBeNull();
    expect(Number.isFinite(result.score!)).toBe(true);
    expect(Number.isNaN(Date.parse(result.at))).toBe(false);

    /**
     * The score is work units per second, so the fastest run took
     * `workUnits / score` seconds. Asserting on THAT rather than on one
     * run's wall time is the head-room assertion: half the statement
     * timeout a candidate's query gets, which this host cleared at about a
     * fifth of it.
     *
     * A cluster that cannot clear half is one where a benchmark sized to a
     * second takes two and a half — and five seconds is then not a time
     * limit, it is a coin toss. Refusing it the sensitive lanes is correct.
     */
    const fastestMs = (SQL_CALIBRATION_WORK_UNITS / result.score!) * 1000;
    expect(fastestMs).toBeLessThan(SQL_LIMITS.statementTimeoutMs / 2);
  }, 180_000);

  it("is repeatable to well inside the deviation the fleet allows", async () => {
    /**
     * The measurement that decides whether this benchmark is usable at all.
     * Two independent measurements of the SAME host must agree inside
     * LIMITS.calibration.maxDeviation (10 %) — the deviation the fleet
     * allows — or a healthy node would withhold the sensitive lanes from
     * itself at random, and the comparison across nodes would be noise.
     *
     * The limit itself rather than a tighter number I happened to measure:
     * this is the property the product depends on. For the record, a
     * development laptop running a dev server, a judge worker and a browser
     * at the same time produced 992 and 994 ms as its two fastest runs —
     * 0.2 % apart.
     */
    const first = await runSqlCalibration({ sandbox: sandbox(), logger, runs: 5 });
    const second = await runSqlCalibration({ sandbox: sandbox(), logger, runs: 5 });
    expect(first.score).not.toBeNull();
    expect(second.score).not.toBeNull();
    const deviation = Math.abs(first.score! - second.score!) / first.score!;
    expect(deviation).toBeLessThan(LIMITS.calibration.maxDeviation);
  }, 300_000);

  it("leaves no schema behind", async () => {
    const box = sandbox();
    await runSqlCalibration({ sandbox: box, logger, runs: 2 });
    // `runCase` drops its schema in a finally; a leaked one is a leaked
    // dataset, and the benchmark runs unattended every six hours.
    expect(await box.dropStaleSchemas()).toEqual([]);
  }, 120_000);
});
