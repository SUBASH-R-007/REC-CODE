import { existsSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SQL_LIMITS } from "@recx/shared";
import { checkCluster } from "../src/hardening";
import { SqlSandbox } from "../src/sandbox";
import { runSelfCheck } from "../src/selfcheck";

/**
 * The sandbox against a real PostgreSQL (Phase 12k).
 *
 * This is the file that decides whether the sandbox is a sandbox. Every
 * case below is something a student will try, and the assertion is that the
 * CLUSTER refuses it — not that the application checked the text first.
 *
 * Opt-in: RECX_SQL_TESTS=1, with the sandbox created by
 * `node scripts/dev/sql-sandbox-up.mjs`.
 */

const ENV_FILE = path.resolve(import.meta.dirname, "..", ".env.local");
const ENABLED = process.env.RECX_SQL_TESTS === "1" && existsSync(ENV_FILE);
if (ENABLED) process.loadEnvFile(ENV_FILE);

const SETUP = `
CREATE TABLE students (id int PRIMARY KEY, name text NOT NULL, mark numeric);
INSERT INTO students VALUES (1, 'Asha', 7.50), (2, 'Bala', NULL);
`;

describe.skipIf(!ENABLED)("the sandbox against a real cluster", () => {
  let sandbox: SqlSandbox;
  let urls: { ownerUrl: string; studentUrl: string };

  beforeAll(async () => {
    urls = {
      ownerUrl: process.env.RECX_SQL_OWNER_URL!,
      studentUrl: process.env.RECX_SQL_STUDENT_URL!,
    };
    sandbox = new SqlSandbox(urls);
    // A schema can only be left behind by a judge that died mid-case; the
    // suite starts from a swept cluster, which is also what the node does
    // at boot.
    await sandbox.dropStaleSchemas();
  });

  afterAll(async () => {
    if (sandbox) await sandbox.dropStaleSchemas();
  });

  const run = (source: string, over: { setup?: string; maxRows?: number } = {}) =>
    sandbox.runCase({ setup: over.setup ?? SETUP, source, maxRows: over.maxRows ?? SQL_LIMITS.rows });

  // ── What it must allow ────────────────────────────────────────────────

  it("runs a query against the case's own data, as text", async () => {
    const outcome = await run("SELECT id, name, mark FROM students ORDER BY id");
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    expect(outcome.result.columns).toEqual(["id", "name", "mark"]);
    // Everything is the text PostgreSQL printed, and NULL is null.
    expect(outcome.result.rows).toEqual([
      ["1", "Asha", "7.50"],
      ["2", "Bala", null],
    ]);
    expect(outcome.result.truncated).toBeUndefined();
    expect(outcome.ms).toBeGreaterThanOrEqual(0);
  });

  it("resolves an unqualified name in the case's schema and not in public", async () => {
    const outcome = await run("SELECT count(*) AS n FROM students");
    expect(outcome.kind).toBe("ok");
    if (outcome.kind === "ok") expect(outcome.result.rows).toEqual([["2"]]);
  });

  it("gives each case its own data", async () => {
    const first = await run("SELECT count(*) AS n FROM students");
    const second = await run("SELECT count(*) AS n FROM students", {
      setup: "CREATE TABLE students (id int); INSERT INTO students VALUES (1), (2), (3);",
    });
    expect(first.kind === "ok" && first.result.rows).toEqual([["2"]]);
    expect(second.kind === "ok" && second.result.rows).toEqual([["3"]]);
  });

  // ── What it must refuse ───────────────────────────────────────────────

  it("refuses every way of writing", async () => {
    for (const sql of [
      "DELETE FROM students",
      "UPDATE students SET name = 'x'",
      "INSERT INTO students VALUES (3, 'C', 1)",
      "DROP TABLE students",
      "TRUNCATE students",
      "ALTER TABLE students ADD COLUMN x int",
    ]) {
      const outcome = await run(sql);
      expect(["refused", "error"], sql).toContain(outcome.kind);
      if (outcome.kind === "refused" || outcome.kind === "error") {
        expect(outcome.code, sql).not.toBe("");
      }
    }
  });

  it("refuses to create a table, a temporary table or a schema", async () => {
    for (const sql of [
      "CREATE TABLE escape (x int)",
      "CREATE TEMP TABLE escape (x int)",
      "CREATE SCHEMA escape",
      "CREATE VIEW escape AS SELECT 1",
    ]) {
      const outcome = await run(sql);
      expect(["refused", "error"], sql).toContain(outcome.kind);
    }
  });

  it("refuses a second statement, because the protocol does", async () => {
    const outcome = await run("SELECT 1; SELECT 2");
    expect(outcome.kind).toBe("refused");
    if (outcome.kind === "refused") expect(outcome.message).toContain("One statement");
  });

  it("refuses to read a file or a program", async () => {
    for (const sql of [
      "SELECT pg_read_file('/etc/passwd')",
      "SELECT pg_ls_dir('/')",
      "COPY students FROM PROGRAM 'id'",
      "COPY students TO PROGRAM 'cat > /tmp/x'",
    ]) {
      const outcome = await run(sql);
      expect(["refused", "error"], sql).toContain(outcome.kind);
    }
  });

  it("refuses the password table", async () => {
    const outcome = await run("SELECT rolname, rolpassword FROM pg_authid");
    expect(["refused", "error"]).toContain(outcome.kind);
  });

  it("refuses to change its own role", async () => {
    // A single statement can call set_config, so this is the hole that
    // `SET ROLE` would have left open. The student role is a member of
    // nothing, so there is nothing to change to.
    for (const sql of [
      "SELECT set_config('role', 'recx_sql_owner', false)",
      "SELECT set_config('search_path', 'public', false)",
    ]) {
      const outcome = await run(sql);
      // search_path IS settable (it is not a privilege), so what matters is
      // that it buys nothing: public holds nothing this role may read.
      if (sql.includes("'role'")) expect(["refused", "error"], sql).toContain(outcome.kind);
    }
  });

  it("cannot see another job's schema", async () => {
    const outcome = await run(
      "SELECT count(*) AS n FROM information_schema.tables WHERE table_schema LIKE 'job_%' AND table_schema <> current_schema()",
    );
    expect(outcome.kind).toBe("ok");
    if (outcome.kind === "ok") expect(outcome.result.rows).toEqual([["0"]]);
  });

  it("is stopped by the database when it spins", async () => {
    const outcome = await run("SELECT count(*) FROM generate_series(1, 400000000) AS g(i)");
    expect(outcome.kind).toBe("timeout");
    if (outcome.kind === "timeout") {
      // The database held the clock, not a timer in this process.
      expect(outcome.ms).toBeGreaterThanOrEqual(SQL_LIMITS.statementTimeoutMs - 500);
      expect(outcome.ms).toBeLessThan(SQL_LIMITS.statementTimeoutMs + 4_000);
    }
  }, 30_000);

  it("truncates a flood rather than reading it all", async () => {
    const outcome = await run("SELECT i FROM generate_series(1, 100) AS g(i)", { maxRows: 5 });
    expect(outcome.kind).toBe("ok");
    if (outcome.kind === "ok") {
      expect(outcome.result.truncated).toBe(true);
      expect(outcome.result.rows).toHaveLength(5);
    }
  });

  // ── The lifecycle ─────────────────────────────────────────────────────

  it("drops the schema when the case is over, whatever happened", async () => {
    const owner = new Client({ connectionString: urls.ownerUrl });
    await owner.connect();
    try {
      const count = async () => {
        const { rows } = await owner.query<{ n: string }>(
          "SELECT count(*) AS n FROM information_schema.schemata WHERE schema_name LIKE 'job_%'",
        );
        return Number(rows[0]!.n);
      };
      const before = await count();
      await run("SELECT 1");
      await run("SELCT bad syntax");
      await run("DELETE FROM students");
      expect(await count()).toBe(before);
    } finally {
      await owner.end();
    }
  });

  it("refuses the job permanently when the author's setup does not run", async () => {
    await expect(run("SELECT 1", { setup: "CREATE TABLE ( oops" })).rejects.toThrow(/setup script failed/);
  });

  // ── The checks the node runs on itself ────────────────────────────────

  it("passes its own adversarial self-check", async () => {
    const result = await runSelfCheck(sandbox);
    expect(result.failures).toEqual([]);
    expect(result.ok).toBe(true);
  }, 60_000);

  it("knows this is a sandbox and not the application's database", async () => {
    const cluster = await checkCluster(urls);
    const byName = new Map(cluster.checks.map((c) => [c.name, c]));
    expect(byName.get("sandbox-only database")?.ok).toBe(true);
    expect(byName.get("student role is unprivileged")?.ok).toBe(true);
    expect(byName.get("student role inherits nothing")?.ok).toBe(true);
    expect(byName.get("student cannot create")?.ok).toBe(true);
    expect(byName.get("no untrusted extensions")?.ok).toBe(true);
    expect(cluster.engineVersion).toMatch(/^PostgreSQL 1[5-9]/);
  });

  it("reports the engine version for the heartbeat", async () => {
    expect(await sandbox.engineVersion()).toMatch(/^PostgreSQL /);
  });
});
