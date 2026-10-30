import { Client } from "pg";
import { InfraError } from "./errors";

/**
 * What must be true of the sandbox cluster before this node takes a job
 * (Phase 12k).
 *
 * The isolate worker checks the kernel at boot; this is the same idea for a
 * database. Each check is here because a cluster that fails it would make
 * one of the sandbox's promises untrue, and the promise is named in the
 * failure so whoever reads the log knows what they are fixing.
 */

export interface ClusterCheck {
  name: string;
  ok: boolean;
  detail: string;
}

/** Tables that would mean this is the application's database, not a sandbox. */
const APPLICATION_TABLES = ["User", "Submission", "Problem", "AssessmentAttempt", "AuditLog"];

/** Extensions that would hand a student a filesystem or a network. */
const DANGEROUS_EXTENSIONS = ["plpythonu", "plpython3u", "plperlu", "pltclu", "file_fdw", "postgres_fdw", "dblink"];

export async function checkCluster(options: {
  ownerUrl: string;
  studentUrl: string;
}): Promise<{ ok: boolean; checks: ClusterCheck[]; engineVersion: string }> {
  const owner = new Client({ connectionString: options.ownerUrl, application_name: "recx-sql-judge-boot" });
  const student = new Client({ connectionString: options.studentUrl, application_name: "recx-sql-judge-boot" });
  const checks: ClusterCheck[] = [];
  let engineVersion = "";

  await owner.connect().catch((error: unknown) => {
    throw new InfraError(`the sandbox cluster is unreachable as the owner: ${msg(error)}`, { cause: error });
  });
  try {
    await student.connect().catch((error: unknown) => {
      throw new InfraError(`the sandbox cluster is unreachable as the student: ${msg(error)}`, { cause: error });
    });
    try {
      const version = await owner.query<{ v: string; n: string }>(
        "SELECT current_setting('server_version') AS v, current_database() AS n",
      );
      engineVersion = `PostgreSQL ${version.rows[0]?.v ?? "unknown"}`;

      /**
       * 1. This is not the application's database. The strongest check
       *    available: if the tables are here, so is the student data, and
       *    no amount of role juggling makes that safe.
       */
      const app = await owner.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables WHERE table_name = ANY($1::text[]) LIMIT 5`,
        [APPLICATION_TABLES],
      );
      checks.push({
        name: "sandbox-only database",
        ok: app.rowCount === 0,
        detail:
          app.rowCount === 0
            ? `${version.rows[0]?.n ?? "the database"} holds no application tables`
            : `REFUSING TO RUN: ${version.rows[0]?.n} contains ${app.rows.map((r) => r.table_name).join(", ")} — this is the application's database, not a sandbox`,
      });

      /** 2. The student role is not a superuser and cannot create anything. */
      const role = await student.query<{ user: string; su: boolean; createdb: boolean; createrole: boolean }>(
        `SELECT current_user AS user, r.rolsuper AS su, r.rolcreatedb AS createdb, r.rolcreaterole AS createrole
           FROM pg_roles r WHERE r.rolname = current_user`,
      );
      const r = role.rows[0];
      checks.push({
        name: "student role is unprivileged",
        ok: r !== undefined && !r.su && !r.createdb && !r.createrole,
        detail: r
          ? `${r.user}: superuser=${r.su}, createdb=${r.createdb}, createrole=${r.createrole}`
          : "the student connection reported no role",
      });

      /** 3. The student role is not a member of the owner's. */
      const member = await student.query<{ owner: string }>(
        `SELECT g.rolname AS owner FROM pg_auth_members m
           JOIN pg_roles g ON g.oid = m.roleid
          WHERE m.member = (SELECT oid FROM pg_roles WHERE rolname = current_user)
            AND g.rolname NOT IN ('pg_read_all_data', 'pg_monitor', 'pg_stat_scan_tables')`,
      );
      checks.push({
        name: "student role inherits nothing",
        ok: member.rowCount === 0,
        detail:
          member.rowCount === 0
            ? "the student role is a member of no other role"
            : `the student role is a member of ${member.rows.map((m) => m.owner).join(", ")} — SET ROLE would escape the sandbox`,
      });

      /** 4. The student cannot create a schema or a temp table. */
      const grants = await student.query<{ can_create: boolean; can_temp: boolean }>(
        `SELECT has_database_privilege(current_user, current_database(), 'CREATE') AS can_create,
                has_database_privilege(current_user, current_database(), 'TEMPORARY') AS can_temp`,
      );
      const g = grants.rows[0];
      checks.push({
        name: "student cannot create",
        ok: g !== undefined && !g.can_create && !g.can_temp,
        detail: g ? `CREATE=${g.can_create}, TEMPORARY=${g.can_temp}` : "could not read the database privileges",
      });

      /** 5. No extension that hands out a filesystem or a network. */
      const extensions = await owner.query<{ extname: string }>(
        `SELECT extname FROM pg_extension WHERE extname = ANY($1::text[])`,
        [DANGEROUS_EXTENSIONS],
      );
      checks.push({
        name: "no untrusted extensions",
        ok: extensions.rowCount === 0,
        detail:
          extensions.rowCount === 0
            ? "none of the untrusted procedural languages or foreign-data wrappers are installed"
            : `installed: ${extensions.rows.map((e) => e.extname).join(", ")}`,
      });
    } finally {
      await student.end().catch(() => undefined);
    }
  } finally {
    await owner.end().catch(() => undefined);
  }

  return { ok: checks.every((c) => c.ok), checks, engineVersion };
}

function msg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
