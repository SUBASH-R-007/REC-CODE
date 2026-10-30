/**
 * SQL problems: the dialect, the limits and the comparison (Phase 12k,
 * slice 1).
 *
 * SPEC §6: "SQL problems (per-submission ephemeral Postgres schema,
 * read-only role, statement_timeout = 5s, result-set comparison,
 * PostgreSQL dialect only, stated on the problem page)".
 *
 * Everything here is pure. The sandbox that runs a student's statement is
 * a separate service with its own credential
 * (`docs/handoff/phase12/DESIGN-sql.md`); what lives in this module is the
 * part both sides have to agree about — what counts as the same result
 * set, and what a student is told when it is not.
 *
 * **Why the comparison is text with numeric normalisation.** The driver
 * hands back text, and two correct answers can differ in how a number is
 * spelled: `numeric` gives "1.50" where `float8` gives "1.5", and
 * `count(*)` is a bigint while a hand-written literal is an int. So a cell
 * that LOOKS like a number is compared as a number and everything else is
 * compared as text, exactly. The alternative — comparing types — would
 * fail a student for writing `sum(x)::int` where the author wrote
 * `sum(x)`, which is not the skill being measured.
 *
 * **Why column names do not decide the verdict.** A student writing
 * `count(*)` and an author writing `count(*) AS n` are the same answer. The
 * column COUNT must match (a missing column is a missing answer) and the
 * names are shown in the diff, because a student whose columns are in the
 * wrong order needs to see it — but a name mismatch alone is not a WA.
 */

export const SQL_DIALECT = "postgres17" as const;
export type SqlDialect = typeof SQL_DIALECT;

export const SQL_DIALECT_LABEL: Readonly<Record<SqlDialect, string>> = Object.freeze({
  postgres17: "PostgreSQL 17",
});

export const SQL_LIMITS = Object.freeze({
  /** Enforced by the database itself: a Node-side timer cannot stop a query. */
  statementTimeoutMs: 5_000,
  /** One statement per submission; "the result set" is otherwise ambiguous. */
  statements: 1,
  /** Rows a result set may carry before it is truncated and refused. */
  rows: 2_000,
  columns: 32,
  cellChars: 512,
  /** The author's schema + seed script. */
  setupBytes: 64 * 1024,
  /** A student's statement. Generous; a SELECT is not a program. */
  submissionBytes: 20_000,
});

export interface SqlResultSet {
  columns: readonly string[];
  /** Cells as text, `null` for SQL NULL. */
  rows: ReadonlyArray<ReadonlyArray<string | null>>;
  /** The query returned more than `SQL_LIMITS.rows`, so this is a prefix. */
  truncated?: boolean;
}

export const SQL_MISMATCH_REASONS = [
  "COLUMN_COUNT",
  "ROW_COUNT",
  "ROW_ORDER",
  "ROW_VALUES",
  "TRUNCATED",
] as const;
export type SqlMismatchReason = (typeof SQL_MISMATCH_REASONS)[number];

export type SqlComparison =
  | { ok: true }
  | {
      ok: false;
      reason: SqlMismatchReason;
      /** A sentence for a VISIBLE case. Hidden cases send the reason only. */
      detail: string;
      /** 1-based, for the reasons that have a row. */
      row?: number;
    };

const NUMERIC = /^-?(?:\d+|\d*\.\d+)(?:[eE][+-]?\d+)?$/;
const CELL_SEPARATOR = "\u0001";
const NULL_CELL = "\u0000NULL";

/**
 * One cell, canonicalised for comparison.
 *
 * NULL is its own value and is never equal to the empty string — a query
 * that returns `''` where the answer is NULL has a different answer, and
 * SQL's own three-valued logic is the reason students get this wrong.
 */
export function canonicalCell(cell: string | null): string {
  if (cell === null) return NULL_CELL;
  if (NUMERIC.test(cell)) {
    const asNumber = Number(cell);
    if (Number.isFinite(asNumber)) return `n:${asNumber}`;
  }
  if (cell === "t" || cell === "true") return "b:t";
  if (cell === "f" || cell === "false") return "b:f";
  return `s:${cell}`;
}

/** One row, canonicalised. The separator cannot occur in a cell's text. */
export function canonicalRow(row: ReadonlyArray<string | null>): string {
  return row.map(canonicalCell).join(CELL_SEPARATOR);
}

function multiset(rows: ReadonlyArray<ReadonlyArray<string | null>>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const key = canonicalRow(row);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function sameMultiset(a: Map<string, number>, b: Map<string, number>): boolean {
  if (a.size !== b.size) return false;
  for (const [key, count] of a) if (b.get(key) !== count) return false;
  return true;
}

/** "3 rows" / "1 row". */
function rowCount(n: number): string {
  return `${n} row${n === 1 ? "" : "s"}`;
}

/**
 * Compare a student's result set against the reference one.
 *
 * `ordered` is the problem author's choice per case: a question whose
 * statement says `ORDER BY` is compared in order, and one that does not is
 * compared as a multiset. Getting this wrong in either direction is a
 * wrong verdict, which is why it is authored rather than guessed.
 *
 * When an ordered comparison fails but the rows themselves are right, the
 * reason is ROW_ORDER rather than ROW_VALUES — "the rows are right and the
 * order is not" is the single most useful thing to tell somebody here.
 */
export function compareResultSets(
  expected: SqlResultSet,
  actual: SqlResultSet,
  options: { ordered: boolean },
): SqlComparison {
  if (actual.truncated) {
    return {
      ok: false,
      reason: "TRUNCATED",
      detail: `That query returned more than ${SQL_LIMITS.rows} rows. The answer has ${rowCount(expected.rows.length)}.`,
    };
  }

  if (expected.columns.length !== actual.columns.length) {
    return {
      ok: false,
      reason: "COLUMN_COUNT",
      detail: `Expected ${expected.columns.length} column${expected.columns.length === 1 ? "" : "s"} (${expected.columns.join(", ")}), got ${actual.columns.length} (${actual.columns.join(", ") || "none"}).`,
    };
  }

  if (expected.rows.length !== actual.rows.length) {
    return {
      ok: false,
      reason: "ROW_COUNT",
      detail: `Expected ${rowCount(expected.rows.length)}, got ${rowCount(actual.rows.length)}.`,
    };
  }

  if (options.ordered) {
    for (let i = 0; i < expected.rows.length; i += 1) {
      if (canonicalRow(expected.rows[i]!) === canonicalRow(actual.rows[i]!)) continue;
      // Right rows, wrong order: say so, because it is one ORDER BY away.
      if (sameMultiset(multiset(expected.rows), multiset(actual.rows))) {
        return {
          ok: false,
          reason: "ROW_ORDER",
          detail: `The rows are right and the order is not — row ${i + 1} differs. This question is compared in order.`,
          row: i + 1,
        };
      }
      return { ok: false, reason: "ROW_VALUES", detail: `Row ${i + 1} differs.`, row: i + 1 };
    }
    return { ok: true };
  }

  if (!sameMultiset(multiset(expected.rows), multiset(actual.rows))) {
    return { ok: false, reason: "ROW_VALUES", detail: "The rows differ. Order does not matter for this question." };
  }
  return { ok: true };
}

/**
 * A HINT for the editor, and never the fence.
 *
 * One statement per submission is enforced where it cannot be talked
 * around — the sandbox refuses a multi-statement query outright, and the
 * role it runs as cannot write whatever the text says. This function
 * exists so the page can say "that looks like two statements" before the
 * student waits for a verdict; it strips strings, dollar-quoted bodies and
 * comments first, so a `;` inside a literal is not mistaken for one.
 */
export function looksLikeMultipleStatements(sql: string): boolean {
  let stripped = "";
  let i = 0;
  while (i < sql.length) {
    const two = sql.slice(i, i + 2);
    if (two === "--") {
      const end = sql.indexOf("\n", i);
      i = end === -1 ? sql.length : end + 1;
      continue;
    }
    if (two === "/*") {
      const end = sql.indexOf("*/", i + 2);
      i = end === -1 ? sql.length : end + 2;
      continue;
    }
    const char = sql[i]!;
    if (char === "'" || char === '"') {
      i += 1;
      while (i < sql.length) {
        if (sql[i] === char) {
          // '' and "" are escaped quotes, not the end.
          if (sql[i + 1] === char) i += 2;
          else break;
        } else i += 1;
      }
      i += 1;
      continue;
    }
    const dollar = /^\$[A-Za-z_]*\$/.exec(sql.slice(i));
    if (dollar) {
      const tag = dollar[0];
      const end = sql.indexOf(tag, i + tag.length);
      i = end === -1 ? sql.length : end + tag.length;
      continue;
    }
    stripped += char;
    i += 1;
  }
  const semicolon = stripped.indexOf(";");
  if (semicolon === -1) return false;
  return stripped.slice(semicolon + 1).trim().length > 0;
}

export const SQL_NOTICES = Object.freeze({
  dialect: `This question is judged on ${SQL_DIALECT_LABEL[SQL_DIALECT]}. Dialect-specific syntax from MySQL or Oracle will not run.`,
  readOnly:
    "Your query runs against a fresh copy of the data as a read-only user: you cannot change the tables, and nothing you do affects anybody else's copy.",
  oneStatement: "One statement per submission — the question asks for a single query.",
  timeout: `A query that takes longer than ${SQL_LIMITS.statementTimeoutMs / 1000} seconds is stopped and counted as too slow.`,
  ordered: "The order of the rows is part of the answer here.",
  unordered: "The order of the rows does not matter here.",
  columnNames:
    "Column names are not marked, so an alias is up to you. The number of columns, and what is in them, is the answer.",
});

export const SQL_REFUSALS = Object.freeze({
  empty: "Write a query before you submit.",
  multiple: "That looks like more than one statement. This question asks for a single query.",
  tooLong: `Keep the query under ${SQL_LIMITS.submissionBytes} characters.`,
  notSql: "That question is not a SQL question.",
  wrongDialect: `Only ${SQL_DIALECT_LABEL[SQL_DIALECT]} is judged here.`,
});

/** What a student is shown for a case: the sentence, or nothing if hidden. */
export function sqlCaseMessage(comparison: SqlComparison, visible: boolean): string | null {
  if (comparison.ok) return null;
  if (visible) return comparison.detail;
  // Hidden cases say which row, and never what was in it — the same rule
  // as hidden stdout, which is dropped at the web boundary.
  return comparison.row ? `Row ${comparison.row} differs.` : "The result set differs.";
}
