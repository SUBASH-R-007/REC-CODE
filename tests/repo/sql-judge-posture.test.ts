import { describe, expect, it } from "vitest";
import { CODE_EXTENSIONS, findFiles, isTestPath, lexSource, readRepoFile } from "./support/repo";

/**
 * The SQL judge's posture (Phase 12k).
 *
 * This process is the exception to a rule the rest of the fleet lives by:
 * SPEC's anti-requirements say a judge host holds no database credentials,
 * and this one holds two. So the rule it lives by instead is narrower, and
 * these are the parts of it that a test can hold true:
 *
 *   1. **The credentials it holds are the sandbox's, and only those.** No
 *      application DATABASE_URL, no AUTH_SECRET, no pepper, no storage key
 *      — the process refuses to start if one is in its environment, and
 *      this fence refuses the environment KEY ever being added to its own
 *      schema.
 *   2. **It cannot reach the application's data, by construction.** No
 *      `@recx/db`, no Prisma, no application schema anywhere in its source.
 *   3. **Student SQL never runs anywhere else.** The web app holds
 *      DATABASE_URL, so a student's statement must never be executed there
 *      — SPEC: "Do not run student code in the Next.js process, a server
 *      action, a route handler, or any container holding DATABASE_URL".
 *   4. **One statement, read-only, and the database holds the clock.**
 *      Enforced by the sandbox rather than by reading the text.
 */

const MANIFEST = "apps/sql-judge/package.json";
const SANDBOX = "apps/sql-judge/src/sandbox.ts";
const CONFIG = "apps/sql-judge/src/config.ts";

interface PackageJson {
  name?: string;
  description?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

const manifest = JSON.parse(readRepoFile(MANIFEST)) as PackageJson;
const runtime = Object.keys(manifest.dependencies ?? {});
const sources = findFiles({ under: ["apps/sql-judge/src"], extensions: [...CODE_EXTENSIONS] });

describe("the credentials it holds", () => {
  it("are the sandbox's two, named so nobody mistakes them for the application's", () => {
    const config = readRepoFile(CONFIG);
    expect(config).toContain("RECX_SQL_OWNER_URL");
    expect(config).toContain("RECX_SQL_STUDENT_URL");
  });

  it("do not include the application's database URL, secret, pepper or storage key", () => {
    const config = readRepoFile(CONFIG);
    // The forbidden list is in the module, and the SHAPE must not contain
    // any of them as a key of its own.
    const shape = config.slice(config.indexOf("sqlJudgeEnvShape"), config.indexOf("sqlJudgeEnvSchema"));
    for (const key of ["DATABASE_URL", "AUTH_SECRET", "IP_HASH_PEPPER", "S3_SECRET_ACCESS_KEY", "AI_API_KEY"]) {
      expect(shape, `${key} must not be an environment key of the SQL judge`).not.toContain(`${key}:`);
      expect(config, `${key} must be on the refused list`).toContain(`"${key}"`);
    }
  });

  it("refuses to start when one of them is present anyway", () => {
    const config = readRepoFile(CONFIG);
    expect(config).toContain("forbiddenKeysPresent");
    expect(config).toMatch(/refuses to start with application credentials/);
  });
});

describe("it cannot reach the application's data", () => {
  it("does not depend on @recx/db, Prisma or any other client", () => {
    for (const name of runtime) {
      expect(/prisma/i.test(name), `${name} has no business in the SQL judge`).toBe(false);
      expect(name).not.toBe("@recx/db");
      expect(/mysql|mongo|better-sqlite3/i.test(name), `${name} has no business here`).toBe(false);
    }
    // `pg` IS expected here, and nowhere else on a judge host.
    expect(runtime).toContain("pg");
  });

  it("imports nothing from @recx/db anywhere in its source", () => {
    for (const file of sources) {
      const { code } = lexSource(readRepoFile(file));
      expect(code, `${file} must not import @recx/db`).not.toContain("@recx/db");
    }
  });

  it("says what it is, and what it does not hold, in its own manifest", () => {
    expect(manifest.description ?? "").toMatch(/sandbox/i);
    expect(manifest.description ?? "").toMatch(/never depend on @recx\/db/i);
  });

  it("names no application table in its source, except to refuse the database that has them", () => {
    const hardening = readRepoFile("apps/sql-judge/src/hardening.ts");
    // The one place application table names appear is the boot check whose
    // whole job is to refuse the application's database.
    expect(hardening).toContain("APPLICATION_TABLES");
    expect(hardening).toMatch(/REFUSING TO RUN/);
    for (const file of sources.filter((f) => !f.endsWith("hardening.ts"))) {
      const text = readRepoFile(file);
      for (const table of ["AssessmentAttempt", "AuditLog", "CodeDraft"]) {
        expect(text, `${file} must not name ${table}`).not.toContain(table);
      }
    }
  });
});

describe("student SQL runs in the sandbox and nowhere else", () => {
  it("the web app never executes SQL it did not write itself", () => {
    /**
     * A student's statement reaching the application's database would have
     * to go through `$queryRawUnsafe` / `$executeRawUnsafe` with a text
     * that is not a literal. The three calls that exist are each a fixed
     * string (a health probe, a migration count, a sequence read), and the
     * fence is on the ARGUMENT rather than on the method: forbidding the
     * method outright would have failed three honest calls and taught
     * everybody to work around the test.
     *
     * `tests/repo/admin-scope.test.ts` already forbids the method entirely
     * on every admin path, where the stakes are a student's rows.
     */
    const web = findFiles({ under: ["apps/web/src"], extensions: [...CODE_EXTENSIONS], exclude: isTestPath });
    const offenders: string[] = [];
    for (const file of web) {
      const { code } = lexSource(readRepoFile(file));
      for (const match of code.matchAll(/\$(?:query|execute)RawUnsafe\s*(?:<[^>]*>)?\s*\(\s*/g)) {
        const after = code.slice(match.index + match[0].length, match.index + match[0].length + 400);
        const literal = /^(["'])/.test(after) || (after.startsWith("`") && !after.slice(0, after.indexOf("`", 1) + 1).includes("${"));
        if (!literal) offenders.push(`${file}: ${after.slice(0, 60).trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("only the SQL judge depends on a PostgreSQL client", () => {
    const manifests = findFiles({ under: ["apps", "packages"], extensions: [".json"] }).filter((f) =>
      f.endsWith("package.json"),
    );
    const withPg = manifests.filter((file) => {
      const json = JSON.parse(readRepoFile(file)) as PackageJson;
      return Object.keys(json.dependencies ?? {}).includes("pg");
    });
    expect(withPg).toEqual([MANIFEST]);
  });
});

describe("one statement, read-only, and the database holds the clock", () => {
  const sandbox = readRepoFile(SANDBOX);

  it("runs the student's statement through the extended protocol", () => {
    // `values: []` is what makes it Parse/Bind/Execute, and the server is
    // what refuses a second command.
    expect(sandbox).toContain("values: []");
    expect(sandbox).toMatch(/cannot insert multiple commands into a prepared statement/);
  });

  it("sets the timeouts on the connection rather than timing the query itself", () => {
    expect(sandbox).toContain("SET statement_timeout TO");
    expect(sandbox).toContain("SET lock_timeout TO");
    expect(sandbox).toContain("SET idle_in_transaction_session_timeout TO");
    expect(sandbox).toContain("SET default_transaction_read_only TO on");
    expect(sandbox).toContain("BEGIN READ ONLY");
  });

  it("gives every case its own schema and drops it in a finally", () => {
    expect(sandbox).toContain("CREATE SCHEMA");
    expect(sandbox).toContain("DROP SCHEMA IF EXISTS");
    expect(sandbox).toContain("dropStaleSchemas");
  });

  it("never reads the student's statement to decide what it may do", () => {
    // No blocklist: a `DROP` in a comment is not a write, and a write
    // spelled in a CTE is. The role and the transaction decide.
    expect(sandbox).not.toMatch(/\/(DROP|DELETE|UPDATE|INSERT)\//);
    expect(sandbox).not.toContain("toUpperCase().includes(");
  });
});
