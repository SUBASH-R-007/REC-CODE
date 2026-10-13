import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Shared setup of the opt-in database tests in packages/db (RECX_DB_TESTS=1):
 * the recx_test URL, the "_test" name check, and `prisma migrate deploy`
 * (skipped with RECX_DB_TESTS_MIGRATE=0). Same rules as frozen-version.test.ts.
 */

export const RUN_DB_TESTS = process.env.RECX_DB_TESTS === "1";
export const TEST_URL = process.env.RECX_TEST_DATABASE_URL ?? "postgresql://recx:recx-dev-only@localhost:5433/recx_test";
const DB_PACKAGE_DIR = fileURLToPath(new URL("../..", import.meta.url));

export type DbModule = typeof import("../../src/index");
export type TestDb = ReturnType<DbModule["createPrismaClient"]>;

/** The database name of TEST_URL; throws unless it ends in "_test". */
export function testDatabaseName(): string {
  const name = new URL(TEST_URL).pathname.replace(/^\//, "");
  if (!name.endsWith("_test")) {
    throw new Error(`Refusing to run destructive tests against "${name}": the database name must end in _test.`);
  }
  return name;
}

export function applyMigrations(): void {
  if (process.env.RECX_DB_TESTS_MIGRATE === "0") return;
  const require = createRequire(import.meta.url);
  const cli = path.join(path.dirname(require.resolve("prisma/package.json")), "build", "index.js");
  execFileSync(process.execPath, [cli, "migrate", "deploy"], {
    cwd: DB_PACKAGE_DIR,
    env: { ...process.env, DATABASE_URL: TEST_URL, DATABASE_URL_DIRECT: TEST_URL },
    stdio: "pipe",
    timeout: 150_000,
  });
}

/**
 * Point DATABASE_URL at recx_test BEFORE the Prisma client loads (so
 * packages/db/.env, the dev database, is never used), then open a guarded
 * client. `restore()` puts the environment back.
 */
export async function openTestDb(): Promise<{ mod: DbModule; db: TestDb; restore: () => void }> {
  const saved = { url: process.env.DATABASE_URL, direct: process.env.DATABASE_URL_DIRECT };
  process.env.DATABASE_URL = TEST_URL;
  process.env.DATABASE_URL_DIRECT = TEST_URL;
  const mod = await import("../../src/index");
  // No error logging: most queries in these suites are expected to be refused.
  const db = mod.createPrismaClient({ url: TEST_URL, log: [] });
  const restore = () => {
    if (saved.url === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = saved.url;
    if (saved.direct === undefined) delete process.env.DATABASE_URL_DIRECT;
    else process.env.DATABASE_URL_DIRECT = saved.direct;
  };
  return { mod, db, restore };
}

/**
 * Names of user triggers anywhere in the database that are not plainly
 * enabled: disabled ('D'), or switched to REPLICA ('R', never fires in a
 * normal session) or ALWAYS ('A') mode.
 */
export async function disabledTriggers(db: TestDb): Promise<string[]> {
  const rows = await db.$queryRawUnsafe<Array<{ tgname: string }>>(
    `SELECT "tgname" FROM pg_trigger WHERE NOT "tgisinternal" AND "tgenabled" <> 'O' ORDER BY 1`,
  );
  return rows.map((r) => r.tgname);
}
