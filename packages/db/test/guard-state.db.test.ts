import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  GUARD_FUNCTIONS,
  GUARD_TRIGGERS,
  GUARDED_TABLES,
  HAND_WRITTEN_CHECKS,
  OTHER_TRIGGERS_ON_GUARDED_TABLES,
  PARTIAL_UNIQUE_INDEXES,
  type GuardTrigger,
} from "./support/guard-catalog";
import { normalizePredicate, stripSqlComments } from "./support/sql-text";
import { applyMigrations, openTestDb, RUN_DB_TESTS, testDatabaseName, type TestDb } from "./support/test-db";

/**
 * The live half of the guard fence: what only a database can show. A
 * migration (or a hand-run statement) that switched a guard trigger to
 * REPLICA or ALWAYS mode, disabled it, re-created it with a WHEN clause or
 * other events, hollowed out a guard function, dropped a CHECK, left one
 * NOT VALID, or dropped a partial unique index, fails here even when the
 * static fence (frozen-coverage.test.ts) cannot see the statement. So does
 * any extra trigger on a guarded table, a guard trigger that runs a
 * same-named function outside public, or a recx_refuse_* function in another
 * schema. The expected state is the catalogue in support/guard-catalog.ts.
 *
 * DB-backed: runs only with RECX_DB_TESTS=1, against recx_test (never recx).
 * Read-only: it writes nothing.
 */

const TITLE = RUN_DB_TESTS
  ? "live database guards (recx_test)"
  : "live database guards [skipped: set RECX_DB_TESTS=1 to run against recx_test on localhost:5433]";

/** pg_trigger.tgtype bits. */
const TG = { ROW: 1, BEFORE: 2, INSERT: 4, DELETE: 8, UPDATE: 16, TRUNCATE: 32, INSTEAD: 64 } as const;

function expectedType(t: GuardTrigger): number {
  const [timing, ...rest] = t.timing.split(" ");
  let type = (t.level === "ROW" ? TG.ROW : 0) | (timing === "BEFORE" ? TG.BEFORE : 0);
  for (const word of rest) {
    if (word === "INSERT" || word === "DELETE" || word === "UPDATE" || word === "TRUNCATE") type |= TG[word];
  }
  return type;
}

interface LiveTrigger {
  name: string;
  table: string;
  schema: string;
  fn: string;
  enabled: string;
  type: number;
  columns: string;
  def: string;
}

describe.skipIf(!RUN_DB_TESTS)(TITLE, () => {
  let db: TestDb;
  let restoreEnv: () => void = () => {};
  let triggers: LiveTrigger[] = [];

  beforeAll(async () => {
    const dbName = testDatabaseName();
    applyMigrations();
    ({ db, restore: restoreEnv } = await openTestDb());
    const [current] = await db.$queryRawUnsafe<Array<{ name: string }>>("SELECT current_database() AS name");
    expect(current?.name).toBe(dbName);
    triggers = await db.$queryRawUnsafe<LiveTrigger[]>(
      `SELECT t.tgname AS name, c.relname AS "table", n.nspname AS schema, p.proname AS fn,
              t.tgenabled::text AS enabled, t.tgtype::int AS type, t.tgattr::text AS columns,
              pg_get_triggerdef(t.oid) AS def
         FROM pg_trigger t
         JOIN pg_class c ON c.oid = t.tgrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_proc p ON p.oid = t.tgfoid
        WHERE NOT t.tgisinternal`,
    );
  });

  afterAll(async () => {
    await db?.$disconnect();
    restoreEnv();
  });

  it.each(GUARD_TRIGGERS.map((t) => [t.name, t] as const))(
    "%s exists once on its table, runs its guard function on exactly its events, is enabled (tgenabled = 'O') and has only its WHEN clause",
    (name, t) => {
      const found = triggers.filter((r) => r.name === name);
      expect(found, `${name} is missing`).toHaveLength(1);
      const live = found[0]!;
      expect({ table: live.table, schema: live.schema, fn: live.fn }).toEqual({ table: t.table, schema: "public", fn: t.fn });
      // 'O' fires in normal sessions. 'D' is disabled; 'R' (ENABLE REPLICA) fires only when
      // session_replication_role = replica, so it never fires for the app; 'A' is ENABLE ALWAYS.
      expect(live.enabled, `${name} is not plainly enabled`).toBe("O");
      expect(live.type, `${name} fires on other events: ${live.def}`).toBe(expectedType(t));
      expect(live.columns, `${name} is limited to columns: ${live.def}`).toBe("");
      const when = /\bWHEN\s*\(([\s\S]*)\)\s*EXECUTE\s+FUNCTION\b/i.exec(live.def)?.[1] ?? null;
      expect(when === null ? null : normalizePredicate(when), live.def).toBe(t.when ? normalizePredicate(t.when) : null);
    },
  );

  it("no other trigger runs a guard function, and no user trigger in the database is disabled or in replica/always mode", () => {
    const listed = new Set(GUARD_TRIGGERS.map((t) => t.name));
    const guardFns = new Set<string>(GUARD_FUNCTIONS);
    expect(triggers.filter((r) => guardFns.has(r.fn) && !listed.has(r.name)).map((r) => r.name)).toEqual([]);
    expect(triggers.filter((r) => r.enabled !== "O").map((r) => `${r.table}.${r.name}=${r.enabled}`)).toEqual([]);
  });

  it("the triggers on every guarded table are exactly the catalogued ones (no extra trigger, whatever function it runs)", () => {
    const expected = [...GUARD_TRIGGERS, ...OTHER_TRIGGERS_ON_GUARDED_TABLES].map((t) => `${t.table}.${t.name}`).sort();
    const live = triggers
      .filter((r) => r.schema === "public" && GUARDED_TABLES.includes(r.table))
      .map((r) => `${r.table}.${r.name}`)
      .sort();
    expect(live).toEqual(expected);
    // A guarded table of the same name in another schema would shadow nothing, but must not exist either.
    expect(triggers.filter((r) => r.schema !== "public" && GUARDED_TABLES.includes(r.table)).map((r) => `${r.schema}.${r.table}.${r.name}`)).toEqual([]);
  });

  it("every guard trigger executes exactly public.<function>() (tgfoid = 'public.<fn>()'::regprocedure)", async () => {
    const rows = await db.$queryRawUnsafe<Array<{ name: string; table: string; same: boolean | null }>>(
      `SELECT g.name, g.tbl AS "table", (t.tgfoid = to_regprocedure('public.' || g.fn || '()')) AS same
         FROM unnest($1::text[], $2::text[], $3::text[]) AS g(name, tbl, fn)
         LEFT JOIN pg_trigger t ON t.tgname = g.name AND NOT t.tgisinternal
              AND t.tgrelid = to_regclass(format('public.%I', g.tbl))`,
      GUARD_TRIGGERS.map((t) => t.name),
      GUARD_TRIGGERS.map((t) => t.table),
      GUARD_TRIGGERS.map((t) => t.fn),
    );
    expect(rows).toHaveLength(GUARD_TRIGGERS.length);
    expect(rows.filter((r) => r.same !== true).map((r) => `${r.table}.${r.name}`)).toEqual([]);
  });

  it("no recx_refuse_* function exists outside the public schema", async () => {
    const rows = await db.$queryRawUnsafe<Array<{ fn: string }>>(
      `SELECT n.nspname || '.' || p.proname AS fn
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE p.proname LIKE 'recx\\_refuse\\_%' AND n.nspname <> 'public'`,
    );
    expect(rows.map((r) => r.fn)).toEqual([]);
  });

  it("every guard function exists once (no overload), is plpgsql, and its live source raises", async () => {
    const rows = await db.$queryRawUnsafe<Array<{ name: string; lang: string; src: string; args: number }>>(
      `SELECT p.proname AS name, l.lanname AS lang, p.prosrc AS src, p.pronargs::int AS args
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
         JOIN pg_language l ON l.oid = p.prolang
        WHERE n.nspname = 'public' AND p.proname = ANY($1::text[])`,
      [...GUARD_FUNCTIONS],
    );
    for (const fn of GUARD_FUNCTIONS) {
      const found = rows.filter((r) => r.name === fn);
      expect(found, `${fn}: ${found.length} definitions`).toHaveLength(1);
      expect(found[0], fn).toMatchObject({ lang: "plpgsql", args: 0 });
      expect(stripSqlComments(found[0]!.src), `${fn} no longer raises`).toMatch(/\bRAISE\s+EXCEPTION\b/i);
    }
  });

  it.each(HAND_WRITTEN_CHECKS.map((c) => [c.name, c] as const))("CHECK %s exists on its table and is validated", async (name, c) => {
    const rows = await db.$queryRawUnsafe<Array<{ table: string; validated: boolean }>>(
      `SELECT cl.relname AS "table", co.convalidated AS validated
         FROM pg_constraint co
         JOIN pg_class cl ON cl.oid = co.conrelid
         JOIN pg_namespace n ON n.oid = cl.relnamespace
        WHERE co.contype = 'c' AND co.conname = $1 AND n.nspname = 'public'`,
      name,
    );
    expect(rows, `${name} is missing`).toEqual([{ table: c.table, validated: true }]);
  });

  it.each(PARTIAL_UNIQUE_INDEXES.map((i) => [i.name, i] as const))("partial unique index %s is unique, valid and keeps its predicate", async (name, idx) => {
    const rows = await db.$queryRawUnsafe<Array<{ table: string; unique: boolean; valid: boolean; ready: boolean; nnd: boolean; def: string }>>(
      `SELECT t.relname AS "table", x.indisunique AS "unique", x.indisvalid AS valid, x.indisready AS ready,
              x.indnullsnotdistinct AS nnd, pg_get_indexdef(x.indexrelid) AS def
         FROM pg_index x
         JOIN pg_class i ON i.oid = x.indexrelid
         JOIN pg_class t ON t.oid = x.indrelid
        WHERE i.relname = $1`,
      name,
    );
    expect(rows, `${name} is missing`).toHaveLength(1);
    const live = rows[0]!;
    expect(live).toMatchObject({ table: idx.table, unique: true, valid: true, ready: true, nnd: idx.nullsNotDistinct });
    // pg_get_indexdef quotes only identifiers that need it (status, but "revokedAt"): compare without quotes.
    const def = live.def.replace(/"/g, "");
    expect(def).toContain(`(${idx.columns.join(", ")})`);
    expect(def).toMatch(new RegExp(String.raw`WHERE\s+\(*\s*${idx.where.replace(/"/g, "")}`, "i"));
  });

  it("triggers fire in this session and by default (session_replication_role is origin and is not overridden for a database or role)", async () => {
    const [role] = await db.$queryRawUnsafe<Array<{ value: string }>>(`SELECT current_setting('session_replication_role') AS value`);
    expect(role?.value).toBe("origin");
    const overrides = await db.$queryRawUnsafe<Array<{ setting: string }>>(
      `SELECT s AS setting FROM pg_db_role_setting, unnest(setconfig) AS s WHERE s ILIKE 'session_replication_role%'`,
    );
    expect(overrides).toEqual([]);
  });
});
