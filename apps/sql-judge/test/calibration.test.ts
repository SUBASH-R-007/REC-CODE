import { describe, expect, it, vi } from "vitest";
import { LIMITS, SQL_LIMITS, type SqlResultSet } from "@recx/shared";
import type { QueryOutcome } from "../src/sandbox";
import {
  SQL_CALIBRATION_CHECKSUM,
  SQL_CALIBRATION_RUNS,
  SQL_CALIBRATION_SETUP,
  SQL_CALIBRATION_SOURCE,
  SQL_CALIBRATION_WORK_UNITS,
  runSqlCalibration,
  sqlCalibrationScore,
} from "../src/calibration";

/**
 * The SQL engine's calibration benchmark (Phase 16n, `docs/ROADMAP.md` §2.1).
 *
 * The thing worth testing is not that a number comes out. It is the four
 * properties that make the number mean something:
 *
 *   1. the statement is ONE statement, reads no table and compares no text,
 *      so what it measures is the cluster rather than a dataset or a
 *      collation;
 *   2. it verifies itself — md5() is 32 characters per row, so the checksum
 *      is fixed by the work units, and a cluster that answers anything else
 *      reports NO score rather than a meaningless one;
 *   3. the score is the FASTEST run, because wall time on a busy host is
 *      noisy upwards only;
 *   4. a run that does not finish cleanly costs a sample and nothing else,
 *      and no clean run at all means no calibration — which the fleet reads
 *      as "withhold the sensitive lanes".
 */

const silent = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as unknown as Parameters<typeof runSqlCalibration>[0]["logger"];

function resultSet(checksum: string): SqlResultSet {
  return { columns: ["checksum"], rows: [[checksum]] };
}

/** A sandbox that answers each call with the next scripted outcome. */
function scripted(outcomes: readonly (QueryOutcome | Error)[]) {
  let i = 0;
  const seen: { setup: string; source: string; maxRows: number }[] = [];
  return {
    seen,
    sandbox: {
      runCase: async (input: { setup: string; source: string; maxRows: number }) => {
        seen.push(input);
        const next = outcomes[Math.min(i++, outcomes.length - 1)]!;
        if (next instanceof Error) throw next;
        return next;
      },
    },
  };
}

const ok = (ms: number): QueryOutcome => ({
  kind: "ok",
  ms,
  result: resultSet(String(SQL_CALIBRATION_CHECKSUM)),
});

describe("the benchmark statement", () => {
  it("is one statement, and a SELECT", () => {
    // The sandbox sends it on the extended protocol, which refuses a second
    // command — so a semicolon here would be a refusal, not two statements.
    expect(SQL_CALIBRATION_SOURCE).not.toContain(";");
    expect(SQL_CALIBRATION_SOURCE.trimStart().toUpperCase().startsWith("SELECT")).toBe(true);
  });

  it("writes nothing and reads no table", () => {
    const text = SQL_CALIBRATION_SOURCE.toUpperCase();
    for (const forbidden of ["INSERT", "UPDATE", "DELETE", "CREATE", "DROP", "ALTER", "GRANT", "COPY", "SET "]) {
      expect(text, forbidden).not.toContain(forbidden);
    }
    // generate_series only: a benchmark that read a table would measure the
    // dataset somebody happened to leave behind.
    expect(SQL_CALIBRATION_SOURCE).toContain("generate_series");
    expect(SQL_CALIBRATION_SOURCE).toContain(String(SQL_CALIBRATION_WORK_UNITS));
  });

  it("compares no text, so a cluster's collation cannot move the score", () => {
    // `md5(x) < 'f'` would be collation-dependent, and two clusters with
    // different collations would report different speeds for the same host.
    expect(SQL_CALIBRATION_SOURCE).not.toMatch(/[<>]\s*'/);
    expect(SQL_CALIBRATION_SOURCE.toUpperCase()).not.toContain("ORDER BY");
    expect(SQL_CALIBRATION_SOURCE.toUpperCase()).not.toContain("COLLATE");
  });

  it("needs no dataset, and its setup script creates nothing", () => {
    expect(SQL_CALIBRATION_SETUP.trim().startsWith("--")).toBe(true);
    expect(SQL_CALIBRATION_SETUP.toUpperCase()).not.toContain("CREATE");
  });

  it("has a checksum fixed by the work units, not a copied literal", () => {
    // md5() returns 32 hex characters for every row, whatever the row is.
    expect(SQL_CALIBRATION_CHECKSUM).toBe(32 * SQL_CALIBRATION_WORK_UNITS);
  });

  it("runs enough times for a fastest-of to mean something", () => {
    expect(SQL_CALIBRATION_RUNS).toBeGreaterThanOrEqual(3);
  });
});

describe("sqlCalibrationScore", () => {
  it("is work units per second of the FASTEST run", () => {
    // 500 ms for 1,000,000 units = 2,000,000 units/second.
    expect(sqlCalibrationScore([900, 500, 1_400], 1_000_000)).toBe(2_000_000);
    // Not the median, which would be 1,000,000 here.
    expect(sqlCalibrationScore([900, 500, 1_400], 1_000_000)).not.toBe(1_111_111);
  });

  it("ignores a non-positive time and returns null when nothing is usable", () => {
    expect(sqlCalibrationScore([0, 250], 1_000_000)).toBe(4_000_000);
    expect(sqlCalibrationScore([0, -1])).toBeNull();
    expect(sqlCalibrationScore([])).toBeNull();
  });

  it("defaults to the benchmark's own work units", () => {
    expect(sqlCalibrationScore([1_000])).toBe(SQL_CALIBRATION_WORK_UNITS);
  });
});

describe("runSqlCalibration", () => {
  it("reports the fastest of its runs, and asks for one row", async () => {
    const { sandbox, seen } = scripted([ok(700), ok(640), ok(690), ok(710), ok(660)]);
    const result = await runSqlCalibration({ sandbox, logger: silent, runs: 5 });
    expect(result.score).toBe(Math.round(SQL_CALIBRATION_WORK_UNITS / 0.64));
    expect(seen).toHaveLength(5);
    // One row is all an aggregate returns; asking for 2,000 would let a
    // broken benchmark stream a result set into the judge's memory.
    expect(seen[0]!.maxRows).toBe(1);
    expect(seen[0]!.source).toBe(SQL_CALIBRATION_SOURCE);
  });

  it("skips a run that timed out and scores the ones that finished", async () => {
    // A timeout is the cluster hitting SQL_LIMITS.statementTimeoutMs, which
    // is the same limit a candidate's query gets.
    const { sandbox } = scripted([{ kind: "timeout", ms: SQL_LIMITS.statementTimeoutMs }, ok(800)]);
    const result = await runSqlCalibration({ sandbox, logger: silent, runs: 2 });
    expect(result.score).toBe(Math.round(SQL_CALIBRATION_WORK_UNITS / 0.8));
  });

  it("reports NO score when no run finished cleanly", async () => {
    const { sandbox } = scripted([{ kind: "timeout", ms: 5_000 }]);
    const result = await runSqlCalibration({ sandbox, logger: silent, runs: 3 });
    expect(result.score).toBeNull();
    // The time is still reported: the node measured, and the answer was
    // "cannot". The fleet reads a null score as calibration missing.
    expect(Number.isNaN(Date.parse(result.at))).toBe(false);
  });

  it("reports NO score when the checksum is wrong, and stops asking", async () => {
    const { sandbox, seen } = scripted([{ kind: "ok", ms: 700, result: resultSet("1") }, ok(700)]);
    const result = await runSqlCalibration({ sandbox, logger: silent, runs: 5 });
    expect(result.score).toBeNull();
    // A cluster that answers the wrong number did not run the benchmark, so
    // there is nothing to learn from running it four more times.
    expect(seen).toHaveLength(1);
  });

  it("reports NO score when the sandbox throws", async () => {
    const { sandbox } = scripted([new Error("sandbox owner connection failed")]);
    const result = await runSqlCalibration({ sandbox, logger: silent, runs: 3 });
    expect(result.score).toBeNull();
  });

  it("stops when it is aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const { sandbox, seen } = scripted([ok(700)]);
    const result = await runSqlCalibration({ sandbox, logger: silent, runs: 5, signal: controller.signal });
    expect(seen).toHaveLength(0);
    expect(result.score).toBeNull();
  });
});

describe("the benchmark's size", () => {
  it("targets the same duration the isolate benchmark does", () => {
    // Both are "about a second of work": LIMITS.calibration.benchmarkMs is
    // the shared target, and this records that the SQL one was sized to it
    // rather than to whatever number happened to be quick.
    expect(LIMITS.calibration.benchmarkMs).toBe(1_000);
  });

  it("leaves head-room under the statement timeout a judged query gets", () => {
    /**
     * Measured through the real sandbox path on the development laptop,
     * with a Playwright suite running at the same time: five runs of
     * 1813, 1880, 1036, 992 and 994 ms, so the fastest-of-five is 992 ms —
     * the benchmarkMs target almost exactly — and the 5,000 ms statement
     * timeout is five times it.
     *
     * A cluster five times slower than a laptop reports no calibration at
     * all (the run times out, there is no sample, the score is null) and is
     * refused the sensitive lanes. That is the right answer for it: a
     * five-second limit on a cluster that slow is not a time limit.
     */
    expect(SQL_LIMITS.statementTimeoutMs).toBeGreaterThanOrEqual(5 * LIMITS.calibration.benchmarkMs);
  });
});
