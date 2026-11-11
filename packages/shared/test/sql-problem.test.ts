import { describe, expect, it } from "vitest";
import {
  JUDGE_ENGINES,
  JUDGE_PROTOCOL_VERSION,
  QUEUE_NAME,
  SQL_DIALECT,
  SQL_DIALECT_LABEL,
  SQL_LIMITS,
  SQL_MISMATCH_REASONS,
  SQL_NOTICES,
  SQL_QUEUE_NAME,
  SQL_REFUSALS,
  anyJobSpecSchema,
  canonicalCell,
  canonicalRow,
  compareResultSets,
  looksLikeMultipleStatements,
  queueNameFor,
  sqlCaseMessage,
  sqlJobSpecSchema,
  type SqlResultSet,
} from "../src/index";

const set = (columns: string[], rows: Array<Array<string | null>>, truncated = false): SqlResultSet => ({
  columns,
  rows,
  truncated,
});

describe("the dialect is stated, not inferred", () => {
  it("is PostgreSQL 17 and nothing else", () => {
    expect(SQL_DIALECT).toBe("postgres17");
    expect(SQL_DIALECT_LABEL[SQL_DIALECT]).toBe("PostgreSQL 17");
    expect(SQL_NOTICES.dialect).toContain("PostgreSQL 17");
    // A student who learned MySQL is told, rather than finding out from a
    // verdict.
    expect(SQL_NOTICES.dialect).toMatch(/MySQL|Oracle/);
  });

  it("says the query is read-only, single-statement and timed by the database", () => {
    expect(SQL_NOTICES.readOnly).toContain("read-only");
    expect(SQL_NOTICES.oneStatement).toContain("One statement");
    expect(SQL_NOTICES.timeout).toContain("5 seconds");
  });

  it("every refusal is a sentence somebody can act on", () => {
    for (const [key, text] of Object.entries(SQL_REFUSALS)) {
      expect(text.length, key).toBeGreaterThan(15);
      expect(text.trim(), key).toMatch(/[.!]$/);
    }
  });
});

describe("a cell, canonicalised", () => {
  it("compares numbers as numbers, so 1.50 and 1.5 are one answer", () => {
    expect(canonicalCell("1.50")).toBe(canonicalCell("1.5"));
    expect(canonicalCell("1e3")).toBe(canonicalCell("1000"));
    expect(canonicalCell("-0.0")).toBe(canonicalCell("0"));
    expect(canonicalCell("7")).not.toBe(canonicalCell("8"));
  });

  it("keeps NULL distinct from the empty string", () => {
    // SQL's three-valued logic is exactly what students get wrong here, so
    // the comparison must not paper over it.
    expect(canonicalCell(null)).not.toBe(canonicalCell(""));
    expect(canonicalCell(null)).not.toBe(canonicalCell("NULL"));
  });

  it("reads t and true as the same boolean", () => {
    expect(canonicalCell("t")).toBe(canonicalCell("true"));
    expect(canonicalCell("f")).toBe(canonicalCell("false"));
    expect(canonicalCell("t")).not.toBe(canonicalCell("f"));
  });

  it("compares everything else as exact text", () => {
    expect(canonicalCell("Priya")).not.toBe(canonicalCell("priya"));
    expect(canonicalCell(" a")).not.toBe(canonicalCell("a"));
  });

  it("builds a row key no cell's text can forge", () => {
    // Two different rows cannot produce the same key by containing the
    // separator, because the separator is a control character.
    expect(canonicalRow(["a", "b"])).not.toBe(canonicalRow(["a\u0001b"]));
  });
});

describe("comparing result sets", () => {
  const expected = set(["id", "name"], [["1", "Asha"], ["2", "Bala"]]);

  it("accepts the same rows in the same order", () => {
    expect(compareResultSets(expected, set(["id", "name"], [["1", "Asha"], ["2", "Bala"]]), { ordered: true })).toEqual(
      { ok: true },
    );
  });

  it("ignores column NAMES but not the column count", () => {
    // `count(*)` and `count(*) AS n` are the same answer.
    expect(compareResultSets(expected, set(["a", "b"], [["1", "Asha"], ["2", "Bala"]]), { ordered: true }).ok).toBe(
      true,
    );
    const missing = compareResultSets(expected, set(["id"], [["1"], ["2"]]), { ordered: true });
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.reason).toBe("COLUMN_COUNT");
      expect(missing.detail).toContain("2 columns");
    }
  });

  it("says how many rows were expected when the count is wrong", () => {
    const short = compareResultSets(expected, set(["id", "name"], [["1", "Asha"]]), { ordered: true });
    expect(short.ok).toBe(false);
    if (!short.ok) {
      expect(short.reason).toBe("ROW_COUNT");
      expect(short.detail).toBe("Expected 2 rows, got 1 row.");
    }
  });

  it("tells a student the rows are right and the order is not", () => {
    const swapped = compareResultSets(expected, set(["id", "name"], [["2", "Bala"], ["1", "Asha"]]), {
      ordered: true,
    });
    expect(swapped.ok).toBe(false);
    if (!swapped.ok) {
      expect(swapped.reason).toBe("ROW_ORDER");
      expect(swapped.detail).toContain("the order is not");
      expect(swapped.row).toBe(1);
    }
  });

  it("accepts any order when the question does not ask for one", () => {
    expect(
      compareResultSets(expected, set(["id", "name"], [["2", "Bala"], ["1", "Asha"]]), { ordered: false }),
    ).toEqual({ ok: true });
  });

  it("counts duplicates, in both modes", () => {
    const twice = set(["n"], [["1"], ["1"]]);
    const once = set(["n"], [["1"], ["2"]]);
    expect(compareResultSets(twice, once, { ordered: false }).ok).toBe(false);
    expect(compareResultSets(twice, set(["n"], [["1"], ["1"]]), { ordered: false }).ok).toBe(true);
  });

  it("refuses a truncated result rather than comparing a prefix", () => {
    const flood = compareResultSets(expected, set(["id", "name"], [["1", "Asha"]], true), { ordered: false });
    expect(flood.ok).toBe(false);
    if (!flood.ok) {
      expect(flood.reason).toBe("TRUNCATED");
      expect(flood.detail).toContain(String(SQL_LIMITS.rows));
    }
  });

  it("names a differing row when the rows themselves are wrong", () => {
    const wrong = compareResultSets(expected, set(["id", "name"], [["1", "Asha"], ["2", "Bela"]]), { ordered: true });
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) {
      expect(wrong.reason).toBe("ROW_VALUES");
      expect(wrong.row).toBe(2);
    }
  });

  it("has copy for every reason it can give", () => {
    expect(SQL_MISMATCH_REASONS.length).toBe(5);
  });
});

describe("what a student is shown", () => {
  const mismatch = compareResultSets(
    set(["n"], [["1"], ["2"]]),
    set(["n"], [["1"], ["3"]]),
    { ordered: true },
  );

  it("gives the sentence for a visible case", () => {
    expect(sqlCaseMessage(mismatch, true)).toBe("Row 2 differs.");
  });

  it("gives a hidden case the row and nothing in it", () => {
    const hidden = sqlCaseMessage(mismatch, false);
    expect(hidden).toBe("Row 2 differs.");
    expect(hidden).not.toContain("3");
  });

  it("says nothing at all when the case passed", () => {
    expect(sqlCaseMessage({ ok: true }, true)).toBeNull();
  });

  it("never leaks a cell's text into a hidden case's message", () => {
    const columns = compareResultSets(set(["a", "b"], []), set(["a"], []), { ordered: false });
    expect(sqlCaseMessage(columns, false)).toBe("The result set differs.");
  });
});

describe("the multiple-statement hint", () => {
  it("is quiet for one statement, with or without a trailing semicolon", () => {
    expect(looksLikeMultipleStatements("SELECT 1")).toBe(false);
    expect(looksLikeMultipleStatements("SELECT 1;")).toBe(false);
    expect(looksLikeMultipleStatements("SELECT 1;\n  \n")).toBe(false);
  });

  it("spots a second statement", () => {
    expect(looksLikeMultipleStatements("SELECT 1; SELECT 2")).toBe(true);
    expect(looksLikeMultipleStatements("SELECT 1;\nDROP TABLE students")).toBe(true);
  });

  it("is not fooled by a semicolon inside a string, a comment or a dollar body", () => {
    expect(looksLikeMultipleStatements("SELECT ';' AS c")).toBe(false);
    expect(looksLikeMultipleStatements(`SELECT 'it''s; here' AS c`)).toBe(false);
    expect(looksLikeMultipleStatements('SELECT "weird;name" FROM t')).toBe(false);
    expect(looksLikeMultipleStatements("SELECT 1 -- ; not a statement\n")).toBe(false);
    expect(looksLikeMultipleStatements("SELECT 1 /* ; */")).toBe(false);
    expect(looksLikeMultipleStatements("SELECT $q$a; b$q$")).toBe(false);
  });

  it("is a hint and not the fence", () => {
    // The sandbox refuses a multi-statement query outright and the role it
    // runs as cannot write, whatever the text says — this function exists
    // so the page can say so before the student waits for a verdict.
    expect(SQL_NOTICES.oneStatement).toContain("single query");
  });
});

describe("the protocol", () => {
  it("has two engines, and a version no older than the one that added them", () => {
    // 4 added the engine discriminator (Phase 12k); 5 added the interactor
    // (Phase 12l). The number only ever goes up, and what this asserts is
    // the pair of engines rather than the number of the moment.
    expect(JUDGE_PROTOCOL_VERSION).toBeGreaterThanOrEqual(4);
    expect(JUDGE_ENGINES).toEqual(["isolate", "postgres"]);
  });

  it("gives SQL jobs their own queues, never the isolate ones", () => {
    for (const lane of Object.keys(QUEUE_NAME) as Array<keyof typeof QUEUE_NAME>) {
      expect(SQL_QUEUE_NAME[lane]).not.toBe(QUEUE_NAME[lane]);
      expect(SQL_QUEUE_NAME[lane]).toContain("sql");
      expect(queueNameFor("postgres", lane)).toBe(SQL_QUEUE_NAME[lane]);
      expect(queueNameFor("isolate", lane)).toBe(QUEUE_NAME[lane]);
    }
  });

  it("parses a SQL spec, and refuses one that is not the only dialect", () => {
    const blob = { sha256: "a".repeat(64), sizeBytes: 10 };
    const spec = {
      protocolVersion: JUDGE_PROTOCOL_VERSION,
      engine: "postgres",
      kind: "submission",
      id: "sub-1",
      lane: "PRACTICE",
      claimToken: "x".repeat(16),
      attempt: 1,
      dialect: "postgres17",
      source: "SELECT 1",
      cases: [{ index: 0, visible: true, setup: blob, expected: blob, ordered: true }],
      stopOnFirstFailure: true,
      statementTimeoutMs: SQL_LIMITS.statementTimeoutMs,
      maxRows: SQL_LIMITS.rows,
    };
    // Every case names its own dataset; cases that share one share the blob.
    expect(sqlJobSpecSchema.parse(spec).cases[0]!.setup.sha256).toBe(blob.sha256);
    expect(sqlJobSpecSchema.safeParse({ ...spec, dialect: "mysql8" }).success).toBe(false);
    // And the timeout is not the service's to choose.
    expect(sqlJobSpecSchema.safeParse({ ...spec, statementTimeoutMs: 30_000 }).success).toBe(false);
  });

  it("discriminates the two engines, so neither service can parse the other's job", () => {
    const blob = { sha256: "b".repeat(64), sizeBytes: 4 };
    const sql = anyJobSpecSchema.safeParse({
      protocolVersion: JUDGE_PROTOCOL_VERSION,
      engine: "postgres",
      kind: "submission",
      id: "s",
      lane: "RUN",
      claimToken: "y".repeat(16),
      attempt: 1,
      dialect: "postgres17",
      source: "SELECT 1",
      cases: [{ index: 0, visible: false, setup: blob, expected: blob, ordered: false }],
      stopOnFirstFailure: false,
      statementTimeoutMs: SQL_LIMITS.statementTimeoutMs,
      maxRows: SQL_LIMITS.rows,
    });
    expect(sql.success).toBe(true);
    // A SQL spec claiming to be an isolate job has no language runtime, so
    // it cannot pass as one.
    expect(anyJobSpecSchema.safeParse({ engine: "isolate", kind: "submission", id: "s" }).success).toBe(false);
  });
});

describe("the limits", () => {
  it("are the ones the spec names", () => {
    expect(SQL_LIMITS.statementTimeoutMs).toBe(5_000);
    expect(SQL_LIMITS.statements).toBe(1);
  });

  it("bound what a page has to render", () => {
    expect(SQL_LIMITS.rows).toBeLessThanOrEqual(5_000);
    expect(SQL_LIMITS.columns).toBeLessThanOrEqual(64);
    expect(SQL_LIMITS.cellChars).toBeLessThanOrEqual(2_048);
  });
});
