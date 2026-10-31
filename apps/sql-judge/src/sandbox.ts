import { randomBytes } from "node:crypto";
import { Client, type ClientConfig } from "pg";
import { SQL_LIMITS, type SqlResultSet } from "@recx/shared";
import { InfraError } from "./errors";
import { engineVersionOf } from "./version";

/**
 * The sandbox: one ephemeral schema per case, and one connection as a role
 * with nothing to go back to (Phase 12k).
 *
 * **Why a schema per CASE and not per submission.** Two cases of one
 * problem can seed different rows, and a query that saw the previous case's
 * data would be judged against the wrong dataset. Creating a schema costs
 * a few milliseconds; `DROP SCHEMA … CASCADE` is complete, which a
 * transaction rollback is not (it leaves temp objects and session state
 * behind).
 *
 * **Why two connections rather than `SET ROLE`.** A single statement can
 * call `set_config('role', …)`, and a session whose `session_user` is the
 * schema's owner has something to go back to. The student's statement runs
 * on its own connection, authenticated as a role that owns nothing, can
 * create nothing, and is a member of nothing.
 *
 * **Why a fresh student connection per case.** Session state is the
 * "pooled warm container" mistake in another shape: a `SET`, a prepared
 * statement, an advisory lock or a temp table would outlive the case that
 * made it. One connection, one case, closed in a `finally`.
 *
 * **Why the extended protocol.** `client.query({ text, values: [] })`
 * sends Parse/Bind/Execute, and PostgreSQL refuses more than one command in
 * a prepared statement — so "one statement per submission" is enforced by
 * the server rather than by counting semicolons in the application.
 *
 * **Why nothing is sent on that connection afterwards.** The student's
 * statement is executed with a row limit, which makes it a portal; when
 * such a query errors, node-postgres can leave its queue waiting, and a
 * following `ROLLBACK` then never settles — a hang, not a rejection, which
 * no `catch` can see. There is nothing to roll back in a READ ONLY
 * transaction anyway: closing the socket is what ends it, and the backend
 * releases every lock as it goes. `endQuietly` closes with a deadline and
 * destroys the socket if even that does not return, so one stuck
 * connection cannot hold a job open.
 */

/** Every value arrives as the text PostgreSQL printed, or null. */
const TEXT_ONLY: ClientConfig["types"] = { getTypeParser: () => (value: string) => value };

export type QueryOutcome =
  | { kind: "ok"; result: SqlResultSet; ms: number }
  | { kind: "timeout"; ms: number }
  /** The server refused the statement: a write, a second command, a privilege. */
  | { kind: "refused"; message: string; code: string; ms: number }
  /** Any other SQL error: a syntax error, an unknown column, a division by zero. */
  | { kind: "error"; message: string; code: string; ms: number };

/**
 * PostgreSQL error codes that mean "the sandbox said no" rather than "your
 * query is wrong". Everything else is an `error`, and `judge.ts` is what
 * decides which of those is a CE and which an RE.
 *
 * 42601 (syntax_error) is NOT here: the one syntax error that is a refusal
 * is the multi-command one, and that is recognised by its message before
 * this set is consulted.
 */
const REFUSED_CODES = new Set([
  "25006", // read_only_sql_transaction
  "42501", // insufficient_privilege
  "0A000", // feature_not_supported (COPY … PROGRAM as a non-superuser)
]);

const MULTI_COMMAND = /cannot insert multiple commands into a prepared statement/i;

export interface SandboxOptions {
  ownerUrl: string;
  studentUrl: string;
  /** Pre-flight connection timeout, in ms. */
  connectTimeoutMs?: number;
}

export class SqlSandbox {
  constructor(private readonly options: SandboxOptions) {}

  private client(url: string): Client {
    return new Client({
      connectionString: url,
      types: TEXT_ONLY,
      application_name: "recx-sql-judge",
      connectionTimeoutMillis: this.options.connectTimeoutMs ?? 5_000,
      // The judge is the only thing talking to this cluster, and a job that
      // hangs on a socket is an infrastructure failure rather than a verdict.
      query_timeout: undefined,
      statement_timeout: undefined,
    } as ClientConfig);
  }

  /**
   * Drop every `job_…` schema left behind.
   *
   * One can only exist if a judge process died between creating a schema
   * and dropping it — and a leaked schema is a leaked dataset that the
   * student role was granted SELECT on. Run at boot, before the node takes
   * a job, and reported so a host that keeps leaking is visible.
   */
  async dropStaleSchemas(): Promise<string[]> {
    const owner = this.client(this.options.ownerUrl);
    await owner.connect().catch((error: unknown) => {
      throw new InfraError(`sandbox owner connection failed: ${message(error)}`, { cause: error });
    });
    try {
      const { rows } = await owner.query<{ nspname: string }>(
        "SELECT nspname FROM pg_namespace WHERE nspname LIKE 'job\\_%' ESCAPE '\\'",
      );
      const dropped: string[] = [];
      for (const { nspname } of rows) {
        await owner.query(`DROP SCHEMA IF EXISTS "${nspname}" CASCADE`);
        dropped.push(nspname);
      }
      return dropped;
    } finally {
      await endQuietly(owner);
    }
  }

  /** The sandbox cluster's version string, for the heartbeat. */
  async engineVersion(): Promise<string> {
    const owner = this.client(this.options.ownerUrl);
    await owner.connect();
    try {
      const { rows } = await owner.query<{ v: string }>("SELECT current_setting('server_version') AS v");
      return engineVersionOf(rows[0]?.v);
    } finally {
      await endQuietly(owner);
    }
  }

  /**
   * Run one case: create a schema, seed it as the owner, run the student's
   * statement as the student, and drop the schema whatever happens.
   */
  async runCase(input: { setup: string; source: string; maxRows?: number }): Promise<QueryOutcome> {
    const maxRows = input.maxRows ?? SQL_LIMITS.rows;
    const schema = `job_${randomBytes(9).toString("hex")}`;
    const owner = this.client(this.options.ownerUrl);
    await owner.connect().catch((error: unknown) => {
      throw new InfraError(`sandbox owner connection failed: ${message(error)}`, { cause: error });
    });

    try {
      await this.seed(owner, schema, input.setup);
      return await this.runStudent(schema, input.source, maxRows);
    } finally {
      // The schema goes even if the student's statement left a lock behind:
      // a leaked schema is a leaked dataset, and the next job must not see
      // it. `IF EXISTS` so a failed create is not a second error, and a
      // lock_timeout so a drop can never be what blocks a judge.
      await owner.query("SET lock_timeout TO 5000").catch(() => undefined);
      await owner.query("SET statement_timeout TO 10000").catch(() => undefined);
      await owner.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined);
      await endQuietly(owner);
    }
  }

  /** Create the schema and run the author's script inside it, as the owner. */
  private async seed(owner: Client, schema: string, setup: string): Promise<void> {
    if (setup.length > SQL_LIMITS.setupBytes) {
      throw new InfraError(`setup script is ${setup.length} bytes (limit ${SQL_LIMITS.setupBytes})`, {
        permanent: true,
      });
    }
    try {
      await owner.query(`CREATE SCHEMA "${schema}"`);
      // The author's script is trusted content (it is authored, reviewed and
      // frozen with the problem version) and may be several statements, so it
      // runs on the simple protocol with the search_path pinned to the new
      // schema — an unqualified CREATE TABLE lands in the right place.
      await owner.query(`SET search_path TO "${schema}"`);
      await owner.query("SET statement_timeout TO 30000");
      await owner.query(setup);
      // The student may read what the setup made, and nothing else.
      await owner.query(`GRANT USAGE ON SCHEMA "${schema}" TO ${await this.studentRole(owner)}`);
      await owner.query(
        `GRANT SELECT ON ALL TABLES IN SCHEMA "${schema}" TO ${await this.studentRole(owner)}`,
      );
      await owner.query(`RESET search_path`);
    } catch (error) {
      // A setup script that does not run is the author's problem, not the
      // student's: no attempt can fix it, so the job is released permanently.
      throw new InfraError(`setup script failed: ${message(error)}`, { permanent: true, cause: error });
    }
  }

  private studentRoleName: string | null = null;

  /** The student connection's role name, read once from the cluster. */
  private async studentRole(owner: Client): Promise<string> {
    if (this.studentRoleName) return this.studentRoleName;
    const student = this.client(this.options.studentUrl);
    await student.connect();
    try {
      const { rows } = await student.query<{ role: string }>("SELECT current_user AS role");
      const role = rows[0]?.role;
      if (!role) throw new InfraError("the student connection did not report a role");
      // Quoted, so a role name with a capital or a dash is still one identifier.
      this.studentRoleName = `"${role.replace(/"/g, '""')}"`;
      void owner;
      return this.studentRoleName;
    } finally {
      await endQuietly(student);
    }
  }

  /**
   * The student's statement, on its own connection, in a read-only
   * transaction, with the database holding the clock.
   */
  private async runStudent(schema: string, source: string, maxRows: number): Promise<QueryOutcome> {
    const student = this.client(this.options.studentUrl);
    await student.connect().catch((error: unknown) => {
      throw new InfraError(`sandbox student connection failed: ${message(error)}`, { cause: error });
    });

    const started = Date.now();
    let settled = false;
    try {
      // Every limit the database can hold, held by the database.
      await student.query(`SET statement_timeout TO ${SQL_LIMITS.statementTimeoutMs}`);
      await student.query("SET lock_timeout TO 2000");
      await student.query("SET idle_in_transaction_session_timeout TO 10000");
      await student.query("SET default_transaction_read_only TO on");
      // The case's schema, and NOT public: an unqualified name is the
      // dataset's, and nothing else is on the path.
      await student.query(`SET search_path TO "${schema}"`);
      await student.query("BEGIN READ ONLY");

      const queryStarted = Date.now();
      const result = await student.query({
        text: source,
        // An empty parameter list is what makes this the EXTENDED protocol,
        // which is what refuses a second command.
        values: [],
        rowMode: "array",
        rows: maxRows + 1,
      } as never);
      const ms = Date.now() - queryStarted;

      settled = true;
      const rows = (result as unknown as { rows: Array<Array<string | null>> }).rows;
      const fields = (result as unknown as { fields: Array<{ name: string }> }).fields ?? [];
      if (rows.length > maxRows) {
        return { kind: "ok", ms, result: { columns: fields.map((f) => f.name), rows: rows.slice(0, maxRows), truncated: true } };
      }
      return { kind: "ok", ms, result: { columns: fields.map((f) => f.name), rows } };
    } catch (error) {
      const ms = Date.now() - started;
      const code = errorCode(error);
      const text = message(error);
      if (code === "57014") return { kind: "timeout", ms };
      if (MULTI_COMMAND.test(text)) {
        return { kind: "refused", code: code || "42601", ms, message: "One statement per submission.", };
      }
      if (REFUSED_CODES.has(code)) {
        return { kind: "refused", code, ms, message: sanitise(text, schema) };
      }
      return { kind: "error", code, ms, message: sanitise(text, schema) };
    } finally {
      // No ROLLBACK, by design (see the module header): the socket closing
      // is what ends the read-only transaction.
      void settled;
      await endQuietly(student);
    }
  }
}

/**
 * Close a connection, and do not wait forever for it.
 *
 * `end()` can fail to settle on a connection whose last query errored
 * mid-portal, and a judge that awaited that would stop taking jobs. After
 * the deadline the socket is destroyed, which the backend treats as the
 * client going away: the transaction rolls back and every lock is released.
 */
async function endQuietly(client: Client, deadlineMs = 3_000): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      client.end().catch(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          const socket = (client as unknown as { connection?: { stream?: { destroy?: () => void } } }).connection
            ?.stream;
          socket?.destroy?.();
          resolve();
        }, deadlineMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : "";
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * A database error, as a student may read it.
 *
 * The schema name is this job's and tells them nothing; a role name is the
 * sandbox's business. Both are replaced rather than hidden, so the sentence
 * still reads, and the whole thing is capped — an error message is not a
 * channel for the dataset.
 */
export function sanitise(text: string, schema: string): string {
  return text
    .replaceAll(schema, "the dataset")
    .replace(/\brecx_sql_[a-z0-9_]+\b/gi, "the sandbox")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 400);
}
