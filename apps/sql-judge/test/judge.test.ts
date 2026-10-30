import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { JUDGE_PROTOCOL_VERSION, SQL_LIMITS, type SqlJobSpec, type SqlResultSet } from "@recx/shared";
import { PermanentJudgeError } from "../src/errors";
import { judgeSqlJob, type SandboxLike } from "../src/judge";
import { silentLogger } from "../src/logger";
import type { QueryOutcome } from "../src/sandbox";

/**
 * The verdict mapping, with a fake sandbox: what the database said in, what
 * the student is told out.
 */

const blob = (text: string) => ({
  sha256: createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex"),
  sizeBytes: Buffer.byteLength(text, "utf8"),
  text,
});

const expected: SqlResultSet = { columns: ["id"], rows: [["1"], ["2"]] };
const SETUP = blob("CREATE TABLE t (id int);");
const EXPECTED = blob(JSON.stringify(expected));

function spec(over: Partial<SqlJobSpec> = {}): SqlJobSpec {
  return {
    protocolVersion: JUDGE_PROTOCOL_VERSION,
    engine: "postgres",
    kind: "submission",
    id: "sub-1",
    lane: "PRACTICE",
    claimToken: "t".repeat(16),
    attempt: 1,
    dialect: "postgres17",
    source: "SELECT id FROM t ORDER BY id",
    setup: { sha256: SETUP.sha256, sizeBytes: SETUP.sizeBytes },
    cases: [
      { index: 0, visible: true, setup: null, expected: { sha256: EXPECTED.sha256, sizeBytes: EXPECTED.sizeBytes }, ordered: true },
      { index: 1, visible: false, setup: null, expected: { sha256: EXPECTED.sha256, sizeBytes: EXPECTED.sizeBytes }, ordered: true },
    ],
    stopOnFirstFailure: true,
    statementTimeoutMs: SQL_LIMITS.statementTimeoutMs,
    maxRows: SQL_LIMITS.rows,
    ...over,
  } as SqlJobSpec;
}

const readBlob = async (ref: { sha256: string }) => {
  if (ref.sha256 === SETUP.sha256) return Buffer.from(SETUP.text, "utf8");
  if (ref.sha256 === EXPECTED.sha256) return Buffer.from(EXPECTED.text, "utf8");
  throw new Error(`unexpected blob ${ref.sha256}`);
};

const sandboxThat = (...outcomes: QueryOutcome[]): SandboxLike => {
  let i = 0;
  return {
    runCase: async () => outcomes[Math.min(i++, outcomes.length - 1)]!,
  };
};

const ok = (result: SqlResultSet, ms = 3): QueryOutcome => ({ kind: "ok", result, ms });

describe("the verdict for one case", () => {
  const judge = (sandbox: SandboxLike, over?: Partial<SqlJobSpec>) =>
    judgeSqlJob(spec(over), { sandbox, readBlob, logger: silentLogger() });

  it("is AC when the result sets match", async () => {
    const outcome = await judge(sandboxThat(ok(expected)));
    expect(outcome.verdict).toBe("AC");
    expect(outcome.passedCases).toBe(2);
    expect(outcome.totalCases).toBe(2);
    expect(outcome.score).toBe(1);
    expect(outcome.compile).toBeNull();
    expect(outcome.maxMemoryKb).toBe(0);
  });

  it("is WA when they differ, and names the row for a visible case", async () => {
    const outcome = await judge(sandboxThat(ok({ columns: ["id"], rows: [["1"], ["3"]] })));
    expect(outcome.verdict).toBe("WA");
    expect(outcome.tests[0]).toMatchObject({ i: 0, v: "WA", message: "Row 2 differs." });
    expect(outcome.firstFailedIndex).toBe(0);
    expect(outcome.score).toBe(0);
  });

  it("is TLE when the database stopped the query", async () => {
    const outcome = await judge(sandboxThat({ kind: "timeout", ms: 5_000 }));
    expect(outcome.verdict).toBe("TLE");
    expect(outcome.maxTimeMs).toBe(5_000);
  });

  it("is OLE when the query returned more rows than the cap", async () => {
    const outcome = await judge(sandboxThat(ok({ columns: ["id"], rows: [["1"]], truncated: true })));
    expect(outcome.verdict).toBe("OLE");
    expect(outcome.tests[0]?.message).toContain(String(SQL_LIMITS.rows));
  });

  it("is CE for a syntax error, and the other cases are not run", async () => {
    let calls = 0;
    const sandbox: SandboxLike = {
      runCase: async () => {
        calls += 1;
        return { kind: "error", code: "42601", ms: 1, message: 'syntax error at or near "SELCT"' };
      },
    };
    const outcome = await judgeSqlJob(spec(), { sandbox, readBlob, logger: silentLogger() });
    expect(outcome.verdict).toBe("CE");
    expect(outcome.compile?.output).toContain("syntax error");
    expect(outcome.tests).toEqual([]);
    expect(calls).toBe(1);
  });

  it("is CE for an unknown column or table, which PostgreSQL refuses before running", async () => {
    for (const code of ["42703", "42P01", "42883", "3F000"]) {
      const outcome = await judge(sandboxThat({ kind: "error", code, ms: 1, message: "no such thing" }));
      expect(outcome.verdict, code).toBe("CE");
    }
  });

  it("is CE when the server refused a second statement", async () => {
    const outcome = await judge(
      sandboxThat({ kind: "refused", code: "42601", ms: 1, message: "One statement per submission." }),
    );
    expect(outcome.verdict).toBe("CE");
    expect(outcome.compile?.output).toContain("One statement");
  });

  it("is RE for a refused write or a privilege, which happen at runtime", async () => {
    for (const code of ["25006", "42501"]) {
      const outcome = await judge(
        sandboxThat({ kind: "refused", code, ms: 1, message: "cannot execute DELETE in a read-only transaction" }),
      );
      expect(outcome.verdict, code).toBe("RE");
      expect(outcome.tests[0]?.message, code).toContain("read-only");
    }
  });

  it("is RE for a runtime data error, and a hidden case says nothing about the data", async () => {
    const outcome = await judge(
      sandboxThat(ok(expected), { kind: "error", code: "22012", ms: 1, message: "division by zero" }),
      { stopOnFirstFailure: true },
    );
    expect(outcome.verdict).toBe("RE");
    const hidden = outcome.tests.find((t) => t.i === 1);
    expect(hidden?.message).toBe("The query failed on a hidden dataset.");
    expect(hidden?.message).not.toContain("division");
  });
});

describe("the cases as a whole", () => {
  it("stops at the first failure and marks the rest SKIPPED", async () => {
    const outcome = await judgeSqlJob(spec({ stopOnFirstFailure: true }), {
      sandbox: sandboxThat(ok({ columns: ["id"], rows: [] })),
      readBlob,
      logger: silentLogger(),
    });
    expect(outcome.tests.map((t) => t.v)).toEqual(["WA", "SKIPPED"]);
    expect(outcome.passedCases).toBe(0);
  });

  it("runs every case when the problem says not to stop", async () => {
    const outcome = await judgeSqlJob(spec({ stopOnFirstFailure: false }), {
      sandbox: sandboxThat(ok({ columns: ["id"], rows: [] }), ok(expected)),
      readBlob,
      logger: silentLogger(),
    });
    expect(outcome.tests.map((t) => t.v)).toEqual(["WA", "AC"]);
    expect(outcome.passedCases).toBe(1);
    expect(outcome.verdict).toBe("WA");
  });

  it("charges the sum of the query times, and reports the slowest", async () => {
    const outcome = await judgeSqlJob(spec({ stopOnFirstFailure: false }), {
      sandbox: sandboxThat(ok(expected, 12), ok(expected, 30)),
      readBlob,
      logger: silentLogger(),
    });
    expect(outcome.cpuMs).toBe(42);
    expect(outcome.maxTimeMs).toBe(30);
  });

  it("gives a run no score at all", async () => {
    const outcome = await judgeSqlJob(spec({ kind: "run" }), {
      sandbox: sandboxThat(ok(expected)),
      readBlob,
      logger: silentLogger(),
    });
    expect(outcome.score).toBeNull();
    expect(outcome.maxScore).toBeNull();
  });
});

describe("what it refuses to judge at all", () => {
  it("refuses a dialect it does not speak", async () => {
    await expect(
      judgeSqlJob(spec({ dialect: "mysql8" as never }), {
        sandbox: sandboxThat(ok(expected)),
        readBlob,
        logger: silentLogger(),
      }),
    ).rejects.toThrow(PermanentJudgeError);
  });

  it("refuses an expected result that is not a result set", async () => {
    const bad = blob(JSON.stringify({ columns: ["a"], rows: [["1", "2"]] }));
    await expect(
      judgeSqlJob(
        spec({
          cases: [
            { index: 0, visible: true, setup: null, expected: { sha256: bad.sha256, sizeBytes: bad.sizeBytes }, ordered: true },
          ],
        }),
        {
          sandbox: sandboxThat(ok(expected)),
          readBlob: async (ref) => (ref.sha256 === bad.sha256 ? Buffer.from(bad.text, "utf8") : readBlob(ref)),
          logger: silentLogger(),
        },
      ),
    ).rejects.toThrow(/not a result set/);
  });

  it("refuses a blob whose bytes do not match its digest", async () => {
    await expect(
      judgeSqlJob(spec(), {
        sandbox: sandboxThat(ok(expected)),
        readBlob: async () => Buffer.from("tampered", "utf8"),
        logger: silentLogger(),
      }),
    ).rejects.toThrow(/digest/);
  });
});
