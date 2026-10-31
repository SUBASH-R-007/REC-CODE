import { SQL_LIMITS } from "@recx/shared";
import type { SandboxLike } from "./judge";

/**
 * The adversarial self-check: the sandbox, asked to do the things it must
 * refuse (Phase 12k).
 *
 * The isolate worker runs a suite like this at boot and every six hours,
 * and the fleet withholds the sensitive lanes from a node whose self-check
 * failed or went stale. This is the database's version of it, and it runs
 * the same way: the real sandbox, a real statement, a real refusal.
 *
 * Every case here is a thing a student will eventually try. They are worth
 * running on the node rather than only in CI, because what they test is
 * the CLUSTER's configuration — a grant somebody loosened by hand on a
 * Tuesday is exactly what this catches.
 */

const SETUP = `
CREATE TABLE students (id int PRIMARY KEY, name text NOT NULL);
INSERT INTO students VALUES (1, 'Asha'), (2, 'Bala');
`;

export interface SelfCheckCase {
  name: string;
  sql: string;
  /** What the sandbox must answer. */
  expect: "refused" | "error" | "timeout" | "ok";
  /** Why this case exists, for the log when it fails. */
  because: string;
}

export const SELF_CHECK_CASES: readonly SelfCheckCase[] = [
  {
    name: "reads its own dataset",
    sql: "SELECT id, name FROM students ORDER BY id",
    expect: "ok",
    because: "a sandbox that cannot read the dataset cannot judge anything",
  },
  {
    name: "cannot write",
    sql: "DELETE FROM students",
    expect: "refused",
    because: "the transaction is READ ONLY and the role has no write grant",
  },
  {
    name: "cannot create a table",
    sql: "CREATE TABLE escape (x int)",
    expect: "refused",
    because: "the role has no CREATE on the database or the schema",
  },
  {
    name: "cannot create a temporary table",
    sql: "CREATE TEMP TABLE escape (x int)",
    expect: "refused",
    because: "a temp table would outlive the case and reach the next one",
  },
  {
    name: "cannot run two statements",
    sql: "SELECT 1; SELECT 2",
    expect: "refused",
    because: "the extended protocol refuses a second command, so one statement is the server's rule",
  },
  {
    name: "cannot read a file",
    sql: "SELECT pg_read_file('/etc/passwd')",
    expect: "refused",
    because: "pg_read_file is superuser-only, and the student role is not one",
  },
  {
    name: "cannot read the role table",
    sql: "SELECT rolname, rolpassword FROM pg_authid",
    expect: "refused",
    because: "pg_authid holds password hashes and is superuser-only",
  },
  {
    name: "cannot copy from a program",
    sql: "COPY students FROM PROGRAM 'id'",
    expect: "refused",
    because: "COPY … PROGRAM is a shell, and it is superuser-only",
  },
  {
    name: "cannot reach another schema",
    sql: "SELECT * FROM information_schema.tables WHERE table_schema LIKE 'job_%' AND table_schema <> current_schema()",
    expect: "ok",
    because: "information_schema is readable, and it must show no other job's schema (the rows are checked below)",
  },
  {
    name: "is stopped when it spins",
    sql: `SELECT count(*) FROM generate_series(1, 2000000000) AS g(i) WHERE pg_sleep(0) IS NULL`,
    expect: "timeout",
    because: `statement_timeout is ${SQL_LIMITS.statementTimeoutMs} ms and the database holds the clock`,
  },
  {
    name: "cannot change its own role",
    sql: "SELECT set_config('role', 'postgres', false)",
    expect: "refused",
    because: "a single statement can call set_config, so the student role must be a member of nothing",
  },
];

export interface SelfCheckResult {
  ok: boolean;
  failures: string[];
  ranAt: Date;
}

/**
 * Run the suite. A case that answers something other than what it must is a
 * failure with the reason attached — the point is that a human reading the
 * log learns what is now possible that should not be.
 */
export async function runSelfCheck(
  sandbox: SandboxLike,
  now: () => Date = () => new Date(),
): Promise<SelfCheckResult> {
  const failures: string[] = [];

  for (const testCase of SELF_CHECK_CASES) {
    let kind: string;
    let detail = "";
    try {
      const outcome = await sandbox.runCase({ setup: SETUP, source: testCase.sql, maxRows: SQL_LIMITS.rows });
      kind = outcome.kind;
      if (outcome.kind === "ok" && testCase.name === "cannot reach another schema" && outcome.result.rows.length > 0) {
        failures.push(
          `${testCase.name}: another job's schema is visible (${outcome.result.rows.length} rows) — ${testCase.because}`,
        );
        continue;
      }
      if (outcome.kind === "refused" || outcome.kind === "error") detail = ` (${outcome.code})`;
    } catch (error) {
      failures.push(`${testCase.name}: the sandbox threw — ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }

    // "refused" and "error" are both the server saying no; the suite cares
    // that the statement did not do what it asked, not which code came back.
    const refusedEither = kind === "refused" || kind === "error";
    const matched = testCase.expect === "refused" ? refusedEither : kind === testCase.expect;
    if (!matched) failures.push(`${testCase.name}: expected ${testCase.expect}, got ${kind}${detail} — ${testCase.because}`);
  }

  return { ok: failures.length === 0, failures, ranAt: now() };
}
