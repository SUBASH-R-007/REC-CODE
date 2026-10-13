import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FROZEN_CHILD_MODELS, FROZEN_EXEMPT_MODELS } from "../src/frozen";
import { FACTORIES } from "./support/frozen-factories";
import {
  CHECK_CATALOG_THROUGH,
  GUARD_FUNCTIONS,
  GUARD_TRIGGERS,
  GUARDED_TABLES,
  HAND_WRITTEN_CHECKS,
  OTHER_TRIGGERS_ON_GUARDED_TABLES,
  PARTIAL_UNIQUE_INDEXES,
  TRUNCATE_GUARDED,
  type GuardTrigger,
} from "./support/guard-catalog";
import { dollarQuotedBodies, normalizePredicate, splitSqlStatements, stripSqlComments } from "./support/sql-text";

/**
 * Structural decision (a), static half: every model that references a
 * ProblemVersion is classified (frozen child or exempt, with a reason), every
 * frozen child has its database trigger, and the database test has a factory
 * for every child. Plus the static fence around every database guard (the
 * catalogue in support/guard-catalog.ts): no migration drops, disables,
 * re-scopes or hollows out a guard function, guard trigger, hand-written
 * CHECK or partial unique index. Runs everywhere (no database);
 * frozen-children.test.ts, governance-invariants.test.ts and
 * guard-state.db.test.ts are the database half.
 */

type Migration = { dir: string; sql: string };

const PRISMA_DIR = fileURLToPath(new URL("../prisma/", import.meta.url));
const schema = readFileSync(`${PRISMA_DIR}schema.prisma`, "utf8");

/** Migration SQL in apply order, comments removed (strings and dollar-quoted bodies kept). */
const migrations: Migration[] = readdirSync(`${PRISMA_DIR}migrations/`, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort()
  .map((dir) => ({ dir, sql: stripSqlComments(readFileSync(`${PRISMA_DIR}migrations/${dir}/migration.sql`, "utf8")) }));
const allSql = migrations.map((m) => m.sql).join(";\n");

/**
 * `model Name { … }` field lines, comments stripped. Line-based, because
 * field defaults such as `@default("{}")` contain braces.
 */
function parseModels(text: string): Map<string, string[]> {
  const models = new Map<string, string[]>();
  let current: { name: string; lines: string[] } | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\/\/.*$/, "").trim();
    if (!current) {
      const start = /^model\s+(\w+)\s*\{$/.exec(line);
      if (start) current = { name: start[1]!, lines: [] };
      continue;
    }
    if (line === "}") {
      models.set(current.name, current.lines);
      current = null;
    } else if (line.length > 0 && !line.startsWith("@@")) {
      current.lines.push(line);
    }
  }
  return models;
}

/** Models holding a foreign key to ProblemVersion (`x ProblemVersion[?] @relation(… fields: […])`). */
function modelsReferencingProblemVersion(models: Map<string, string[]>): string[] {
  const out: string[] = [];
  for (const [name, fields] of models) {
    const holdsKey = fields.some((line) => {
      const [, type = ""] = line.split(/\s+/);
      return /^ProblemVersion\??$/.test(type) && /@relation\([^)]*fields:\s*\[/.test(line);
    });
    if (holdsKey) out.push(name);
  }
  return out.sort();
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** `"public"."Name"`, `public.Name`, `"Name"` or `Name`, as a regex source. */
const qualified = (name: string) => String.raw`(?:"?public"?\s*\.\s*)?"?${escape(name)}"?`;
/** The bare name of a possibly schema-qualified, possibly quoted identifier ("public"."X" → X). */
const bareName = (identifier: string) =>
  identifier
    .replace(/\s+/g, "")
    .replace(/"/g, "")
    .replace(/^public\./i, "");

// ── Functions ─────────────────────────────────────────────────────────────

interface FunctionDefinition {
  name: string;
  statement: string;
  /** The dollar-quoted body (any tag), comments removed; null when the statement has no single dollar-quoted body. */
  body: string | null;
  /** The statement without its dollar-quoted strings (the header and the LANGUAGE clause). */
  outside: string;
}

/** Every `CREATE [OR REPLACE] FUNCTION` statement in `sql`, in order (the last definition of a name is live). */
function functionDefinitions(sql: string): FunctionDefinition[] {
  const out: FunctionDefinition[] = [];
  for (const statement of splitSqlStatements(sql)) {
    const m = /^CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+((?:"?\w+"?\s*\.\s*)?"?\w+"?)\s*\(/i.exec(statement);
    if (!m) continue;
    const bodies = dollarQuotedBodies(statement);
    const outside = bodies.reduce((rest, body) => rest.split(body).join(""), statement);
    out.push({ name: bareName(m[1]!), statement, body: bodies.length === 1 ? stripSqlComments(bodies[0]!) : null, outside });
  }
  return out;
}

/** Problems with the guard functions across `sql` (empty = every guard is defined, dollar-quoted, plpgsql, and its live body raises). */
function functionProblems(sql: string, names: readonly string[] = GUARD_FUNCTIONS): string[] {
  const problems: string[] = [];
  const defs = functionDefinitions(sql);
  for (const fn of names) {
    const mine = defs.filter((d) => d.name === fn);
    if (mine.length === 0) {
      problems.push(`${fn} is never defined`);
      continue;
    }
    for (const d of mine) {
      if (d.body === null) problems.push(`${fn}: a definition has no single dollar-quoted body`);
      if (!/\bLANGUAGE\s+'?plpgsql'?(?![\w$])/i.test(d.outside)) problems.push(`${fn}: a definition is not LANGUAGE plpgsql`);
    }
    const live = mine.at(-1)!;
    if (live.body !== null && !/\bRAISE\s+EXCEPTION\b/i.test(live.body)) problems.push(`${fn}: the live definition no longer raises`);
  }
  return problems;
}

// ── Triggers ──────────────────────────────────────────────────────────────

/** Every `CREATE [OR REPLACE] [CONSTRAINT] TRIGGER "<name>" …` statement in `sql`, in order (the last one is live). */
function triggerStatements(sql: string, name: string): string[] {
  const re = new RegExp(String.raw`^CREATE\s+(?:OR\s+REPLACE\s+)?(?:CONSTRAINT\s+)?TRIGGER\s+"?${escape(name)}"?\s`, "i");
  return splitSqlStatements(sql).filter((s) => re.test(s));
}

/**
 * The whole statement a guard trigger must be, anchored: timing and events
 * exactly as listed (no `UPDATE OF <columns>`), its table, its level, its
 * function, and no WHEN clause unless the catalogue gives the one allowed.
 */
function triggerPattern(t: GuardTrigger): RegExp {
  const when = t.when
    ? [String.raw`WHEN\s*(?:\(\s*)+${escape(t.when).replace(/\s+/g, String.raw`\s+`)}(?:\s*\))+`]
    : [];
  return new RegExp(
    "^" +
      [
        String.raw`CREATE\s+(?:OR\s+REPLACE\s+)?TRIGGER\s+"${escape(t.name)}"`,
        t.timing.split(" ").join(String.raw`\s+`),
        String.raw`ON\s+(?:ONLY\s+)?${qualified(t.table)}`,
        String.raw`FOR\s+EACH\s+${t.level}`,
        ...when,
        String.raw`EXECUTE\s+(?:FUNCTION|PROCEDURE)\s+${qualified(t.fn)}\s*\(\s*\)`,
      ].join(String.raw`\s+`) +
      String.raw`\s*$`,
    "i",
  );
}

/** The WHEN predicate of a CREATE TRIGGER statement, or null. */
function whenClause(statement: string): string | null {
  const m = /\bWHEN\s*\(([\s\S]*)\)\s*EXECUTE\s+(?:FUNCTION|PROCEDURE)\b/i.exec(statement);
  return m ? m[1]!.trim() : null;
}

/**
 * Problems with WHEN clauses: a trigger that executes a guard function, or
 * that carries a guard trigger's name, may have a WHEN clause only if the
 * catalogue allows exactly that predicate (ProblemVersion_born_frozen_guard).
 * `only` limits the check to those trigger names.
 */
function whenProblems(sql: string, only?: ReadonlySet<string>): string[] {
  const problems: string[] = [];
  const byName = new Map(GUARD_TRIGGERS.map((t) => [t.name, t]));
  for (const statement of splitSqlStatements(sql)) {
    const m = /^CREATE\s+(?:OR\s+REPLACE\s+)?(?:CONSTRAINT\s+)?TRIGGER\s+"?([^"\s]+)"?\s/i.exec(statement);
    if (!m || (only && !only.has(m[1]!))) continue;
    const runsGuard = GUARD_FUNCTIONS.some((fn) => new RegExp(String.raw`EXECUTE\s+(?:FUNCTION|PROCEDURE)\s+${qualified(fn)}\s*\(`, "i").test(statement));
    const known = byName.get(m[1]!);
    if (!runsGuard && !known) continue;
    const when = whenClause(statement);
    if (when === null) continue;
    if (!known?.when || normalizePredicate(when) !== normalizePredicate(known.when)) {
      problems.push(`${m[1]}: guard trigger with WHEN (${when})`);
    }
  }
  return problems;
}

/** Problems with the guard triggers across `sql` (empty = every guard trigger's live definition is exactly the catalogued one). */
function triggerProblems(sql: string, triggers: readonly GuardTrigger[] = GUARD_TRIGGERS): string[] {
  const problems: string[] = [];
  for (const t of triggers) {
    const statements = triggerStatements(sql, t.name);
    if (statements.length === 0) problems.push(`${t.name} is never created`);
    else if (!triggerPattern(t).test(statements.at(-1)!)) problems.push(`${t.name}: definition changed: ${statements.at(-1)!.replace(/\s+/g, " ")}`);
  }
  return problems.concat(whenProblems(sql, new Set(triggers.map((t) => t.name))));
}

// ── CHECK constraints ─────────────────────────────────────────────────────

/** Names of every CHECK constraint `sql` creates (`CONSTRAINT "<name>" CHECK`). */
function checkNames(sql: string): string[] {
  return [...sql.matchAll(/\bCONSTRAINT\s+"?([A-Za-z_][\w$]*)"?\s+CHECK\s*\(/gi)].map((m) => m[1]!);
}

/** Problems with the catalogued CHECKs: each created exactly once, on its table, in its migration, and VALID (no NOT VALID). */
function checkProblems(migs: readonly Migration[]): string[] {
  const problems: string[] = [];
  for (const c of HAND_WRITTEN_CHECKS) {
    const creations: Array<{ dir: string; statement: string }> = [];
    for (const { dir, sql } of migs) {
      for (const statement of splitSqlStatements(sql)) {
        if (new RegExp(String.raw`\bCONSTRAINT\s+"?${escape(c.name)}"?\s+CHECK\s*\(`, "i").test(statement)) creations.push({ dir, statement });
      }
    }
    if (creations.length !== 1) {
      problems.push(`${c.name}: created ${creations.length} times`);
      continue;
    }
    const [{ dir, statement }] = creations as [{ dir: string; statement: string }];
    if (dir !== c.migration) problems.push(`${c.name}: created in ${dir}, catalogued in ${c.migration}`);
    if (!new RegExp(String.raw`^ALTER\s+TABLE\s+(?:ONLY\s+)?${qualified(c.table)}\s`, "i").test(statement)) {
      problems.push(`${c.name}: not added by an ALTER TABLE of "${c.table}"`);
    }
    // The ADD CONSTRAINT clause runs until the next top-level ", ADD" (or the end of the statement).
    const clause = statement.slice(statement.search(new RegExp(String.raw`\bCONSTRAINT\s+"?${escape(c.name)}"?\s+CHECK`, "i"))).split(/,\s*ADD\s/i)[0]!;
    if (/\bNOT\s+VALID\b/i.test(clause)) problems.push(`${c.name}: added NOT VALID`);
  }
  return problems;
}

/** CHECK constraints created by migrations up to CHECK_CATALOG_THROUGH that the catalogue does not list. */
function uncataloguedChecks(migs: readonly Migration[]): string[] {
  const listed = new Set(HAND_WRITTEN_CHECKS.map((c) => c.name));
  return migs.filter((m) => m.dir <= CHECK_CATALOG_THROUGH).flatMap((m) => checkNames(m.sql).filter((name) => !listed.has(name)).map((name) => `${m.dir}: ${name}`));
}

// ── Statements that remove or switch off a guard ──────────────────────────

/** Statements in one migration that drop, alter, disable or bypass a guard. */
function guardViolations(sql: string): string[] {
  const found: string[] = [];
  const statementMentions = (verb: string, name: string) =>
    new RegExp(String.raw`${verb}\b[^;]*?(?:^|[\s,."(])"?${escape(name)}"?(?![\w$])`, "im");
  for (const fn of GUARD_FUNCTIONS) {
    if (statementMentions(String.raw`DROP\s+FUNCTION`, fn).test(sql)) found.push(`DROP FUNCTION ${fn}`);
    if (statementMentions(String.raw`ALTER\s+FUNCTION`, fn).test(sql)) found.push(`ALTER FUNCTION ${fn}`);
  }
  for (const { name } of GUARD_TRIGGERS) {
    if (statementMentions(String.raw`DROP\s+TRIGGER`, name).test(sql)) found.push(`DROP TRIGGER ${name}`);
    if (statementMentions(String.raw`ALTER\s+TRIGGER`, name).test(sql)) found.push(`ALTER TRIGGER ${name}`);
    if (new RegExp(String.raw`DISABLE\s+TRIGGER\s+"?${escape(name)}"?(?![\w$])`, "im").test(sql)) found.push(`DISABLE TRIGGER ${name}`);
    // REPLICA: fires only when session_replication_role = replica, i.e. never in normal sessions.
    // ALWAYS: also fires under replica, but the trigger is no longer the plain enabled one the tests expect.
    if (new RegExp(String.raw`ENABLE\s+(?:REPLICA|ALWAYS)\s+TRIGGER\s+"?${escape(name)}"?(?![\w$])`, "im").test(sql)) {
      found.push(`ENABLE REPLICA/ALWAYS TRIGGER ${name}`);
    }
  }
  if (/DISABLE\s+TRIGGER\s+(?:ALL|USER)\b/i.test(sql)) found.push("DISABLE TRIGGER ALL/USER");
  if (/ENABLE\s+(?:REPLICA|ALWAYS)\s+TRIGGER\s+(?:ALL|USER)\b/i.test(sql)) found.push("ENABLE REPLICA/ALWAYS TRIGGER ALL/USER");
  // Any trigger switch on a guarded table, whatever it names.
  for (const statement of splitSqlStatements(sql)) {
    const m = /^ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?((?:"?\w+"?\s*\.\s*)?"?\w+"?)/i.exec(statement);
    if (!m || !GUARDED_TABLES.includes(bareName(m[1]!))) continue;
    if (/\bDISABLE\s+TRIGGER\b/i.test(statement)) found.push(`DISABLE TRIGGER on guarded table ${bareName(m[1]!)}`);
    if (/\bENABLE\s+(?:REPLICA|ALWAYS)\s+TRIGGER\b/i.test(statement)) found.push(`ENABLE REPLICA/ALWAYS TRIGGER on guarded table ${bareName(m[1]!)}`);
  }
  // session_replication_role = replica silences every ordinary trigger (persistently with ALTER DATABASE/ROLE … SET).
  if (/\bsession_replication_role\b/i.test(sql)) found.push("session_replication_role");
  for (const { name } of HAND_WRITTEN_CHECKS) {
    if (new RegExp(String.raw`DROP\s+CONSTRAINT\s+(?:IF\s+EXISTS\s+)?"?${escape(name)}"?(?![\w$])`, "im").test(sql)) found.push(`DROP CONSTRAINT ${name}`);
    if (new RegExp(String.raw`RENAME\s+CONSTRAINT\s+"?${escape(name)}"?(?![\w$])`, "im").test(sql)) found.push(`RENAME CONSTRAINT ${name}`);
    if (new RegExp(String.raw`ALTER\s+CONSTRAINT\s+"?${escape(name)}"?(?![\w$])`, "im").test(sql)) found.push(`ALTER CONSTRAINT ${name}`);
  }
  return found;
}

// ── search_path and uncatalogued triggers ─────────────────────────────────

/**
 * Statements in one migration that set search_path (session, LOCAL,
 * per database, per role, per function, or through set_config). A changed
 * search_path can make an unqualified name in a later statement resolve to
 * an object in another schema, so a guard could be created, replaced or
 * called somewhere other than public. Strings are scanned too (DO blocks
 * run them with EXECUTE); comments are not.
 */
function searchPathViolations(sql: string): string[] {
  const found: string[] = [];
  for (const statement of splitSqlStatements(sql)) {
    if (/\bSET\s+(?:SESSION\s+|LOCAL\s+)?search_path\b/i.test(statement) || /\bset_config\s*\(\s*'search_path'/i.test(statement)) {
      found.push(`sets search_path: ${statement.replace(/\s+/g, " ").slice(0, 160)}`);
    }
  }
  return found;
}

/**
 * CREATE TRIGGER statements on a guarded table that are not catalogued for
 * that table (GUARD_TRIGGERS, or OTHER_TRIGGERS_ON_GUARDED_TABLES). Any
 * trigger on a guarded table can rewrite NEW before the guard sees it or
 * act after it, so each one must be reviewed and listed.
 */
function uncataloguedTriggerProblems(sql: string): string[] {
  const allowed = new Set([...GUARD_TRIGGERS, ...OTHER_TRIGGERS_ON_GUARDED_TABLES].map((t) => `${t.table}.${t.name}`));
  const problems: string[] = [];
  for (const statement of splitSqlStatements(sql)) {
    const m = /^CREATE\s+(?:OR\s+REPLACE\s+)?(?:CONSTRAINT\s+)?TRIGGER\s+("[^"]+"|\S+)\s[\s\S]*?\bON\s+(?:ONLY\s+)?((?:"?\w+"?\s*\.\s*)?"?\w+"?)/i.exec(statement);
    if (!m) continue;
    const name = m[1]!.replace(/"/g, "");
    const table = bareName(m[2]!);
    if (GUARDED_TABLES.includes(table) && !allowed.has(`${table}.${name}`)) problems.push(`uncatalogued trigger ${name} on guarded table ${table}`);
  }
  return problems;
}

// ── Partial unique indexes ────────────────────────────────────────────────

/** Problems with the partial unique indexes across all migrations (empty = intact). */
function partialIndexProblems(migs: readonly Migration[]): string[] {
  const problems: string[] = [];
  const all = migs.map((m) => m.sql).join("\n");
  for (const idx of PARTIAL_UNIQUE_INDEXES) {
    const creates = [...all.matchAll(new RegExp(String.raw`CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?"${escape(idx.name)}"[^;]*;`, "gi"))].map((m) => m[0]);
    const expected = new RegExp(
      [
        String.raw`^CREATE\s+UNIQUE\s+INDEX\s+"${escape(idx.name)}"\s+ON\s+(?:"public"\.)?"${escape(idx.table)}"\s*`,
        String.raw`\(\s*${idx.columns.map((c) => `"${escape(c)}"`).join(String.raw`\s*,\s*`)}\s*\)\s*`,
        idx.nullsNotDistinct ? String.raw`NULLS\s+NOT\s+DISTINCT\s+` : "",
        String.raw`WHERE\s+\(?\s*${idx.where}\s*\)?\s*;$`,
      ].join(""),
      "i",
    );
    if (creates.length !== 1) problems.push(`${idx.name}: created ${creates.length} times`);
    else if (!expected.test(creates[0]!)) problems.push(`${idx.name}: definition changed: ${creates[0]!.replace(/\s+/g, " ")}`);
    for (const { dir, sql } of migs) {
      if (new RegExp(String.raw`DROP\s+INDEX\b[^;]*"${escape(idx.name)}"`, "i").test(sql)) problems.push(`${dir} drops ${idx.name}`);
      if (new RegExp(String.raw`ALTER\s+INDEX\b[^;]*"${escape(idx.name)}"`, "i").test(sql)) problems.push(`${dir} alters ${idx.name}`);
    }
  }
  return problems;
}

// ──────────────────────────────────────────────────────────────────────────

describe("frozen-version coverage (schema ↔ guard ↔ triggers ↔ factories)", () => {
  const models = parseModels(schema);
  const referencing = modelsReferencingProblemVersion(models);
  const exempt = Object.keys(FROZEN_EXEMPT_MODELS);

  it("parses ProblemVersion foreign keys out of a schema", () => {
    const sample = parseModels(
      [
        "model A {",
        "  id String @id",
        "  v  ProblemVersion @relation(fields: [vId], references: [id])",
        "}",
        "model B {",
        "  // v ProblemVersion @relation(fields: [vId], references: [id])",
        "  vs ProblemVersion[]",
        "}",
      ].join("\n"),
    );
    expect(modelsReferencingProblemVersion(sample)).toEqual(["A"]);
  });

  it("finds the models that reference ProblemVersion", () => {
    // Sanity: the parser sees the known children and the known exempt models.
    expect(referencing).toEqual(expect.arrayContaining(["TestCase", "Editorial", "Problem", "Submission", "ProblemReview"]));
  });

  it.each(modelsReferencingProblemVersion(parseModels(schema)))(
    "%s is in exactly one of FROZEN_CHILD_MODELS / FROZEN_EXEMPT_MODELS",
    (model) => {
      const inChild = FROZEN_CHILD_MODELS.has(model);
      const inExempt = Object.prototype.hasOwnProperty.call(FROZEN_EXEMPT_MODELS, model);
      expect(inChild !== inExempt, `${model}: child=${inChild} exempt=${inExempt}`).toBe(true);
    },
  );

  it("lists no model that does not reference ProblemVersion", () => {
    for (const model of [...FROZEN_CHILD_MODELS, ...exempt]) {
      expect(referencing, `${model} is listed but holds no ProblemVersion relation`).toContain(model);
    }
  });

  it("gives every exempt model a reason", () => {
    for (const [model, reason] of Object.entries(FROZEN_EXEMPT_MODELS)) {
      expect(reason.trim().length, `${model} needs a reason`).toBeGreaterThan(10);
    }
  });

  it.each([...FROZEN_CHILD_MODELS])("%s has a <Model>_frozen_guard trigger (insert, update and delete)", (model) => {
    const t = GUARD_TRIGGERS.find((g) => g.name === `${model}_frozen_guard`);
    expect(t, `${model}_frozen_guard is not catalogued`).toMatchObject({
      timing: "BEFORE INSERT OR UPDATE OR DELETE",
      table: model,
      fn: "recx_refuse_frozen_child_write",
    });
    expect(triggerProblems(allSql, [t!])).toEqual([]);
  });

  it("ProblemVersion keeps its frozen guard (update and delete) and its born-frozen guard (insert, WHEN frozenAt is set)", () => {
    const names = ["ProblemVersion_frozen_guard", "ProblemVersion_born_frozen_guard", "TestBlob_immutable"];
    const listed = GUARD_TRIGGERS.filter((t) => names.includes(t.name));
    expect(listed.map((t) => t.name).sort()).toEqual([...names].sort());
    expect(listed.find((t) => t.name === "ProblemVersion_born_frozen_guard")?.when).toBe('NEW."frozenAt" IS NOT NULL');
    expect(triggerProblems(allSql, listed)).toEqual([]);
  });

  it("the version guard refuses EVERY update once frozen (so new ProblemVersion columns freeze too)", () => {
    // The latest definition wins: it must test OLD."frozenAt" alone, never a column list.
    const body = functionDefinitions(allSql)
      .filter((d) => d.name === "recx_refuse_frozen_version_write")
      .at(-1)?.body;
    expect(body).toBeTruthy();
    expect(body).toMatch(/IF\s+OLD\."frozenAt"\s+IS\s+NOT\s+NULL\s+THEN\s+RAISE\s+EXCEPTION/i);
    expect(body).not.toMatch(/IS\s+DISTINCT\s+FROM/i);
  });

  it("frozen-children.test.ts has a factory for exactly the frozen children", () => {
    expect(Object.keys(FACTORIES).sort()).toEqual([...FROZEN_CHILD_MODELS].sort());
  });
});

describe("database guards (functions, triggers, CHECKs, partial unique indexes) stay in place", () => {
  describe("self-test of the detectors", () => {
    it("reads SQL like PostgreSQL: comments (nested too) are not code, dollar tags of any name delimit bodies", () => {
      const sql = [
        "/* outer /* nested */ CREATE OR REPLACE FUNCTION recx_refuse_truncate() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'x'; END; $$ LANGUAGE plpgsql; */",
        "-- CREATE OR REPLACE FUNCTION recx_refuse_truncate() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'x'; END; $$ LANGUAGE plpgsql;",
        "CREATE OR REPLACE FUNCTION recx_refuse_truncate() RETURNS trigger AS $body$ BEGIN RETURN NULL; /* RAISE EXCEPTION 'x'; */ END; $body$ LANGUAGE plpgsql;",
        "SELECT 'a ; -- not a comment', $q$ ; $q$, E'it\\'s ; fine';",
      ].join("\n");
      const statements = splitSqlStatements(stripSqlComments(sql));
      expect(statements).toHaveLength(2);
      const defs = functionDefinitions(stripSqlComments(sql));
      expect(defs).toHaveLength(1);
      expect(defs[0]!.body).not.toMatch(/RAISE/);
      expect(dollarQuotedBodies("SELECT $1, $a$x$a$, $$y$$, foo$bar$ AS z")).toEqual(["x", "y"]);
    });

    it("flags a guard function whose live body (any dollar tag) no longer raises, or that is not dollar-quoted plpgsql", () => {
      const raises = (tag: string) =>
        `CREATE OR REPLACE FUNCTION recx_refuse_truncate() RETURNS trigger AS ${tag} BEGIN RAISE EXCEPTION 'x' USING ERRCODE = 'check_violation'; END; ${tag} LANGUAGE plpgsql;`;
      const hollow = (tag: string) => `CREATE OR REPLACE FUNCTION recx_refuse_truncate() RETURNS trigger AS ${tag} BEGIN RETURN NULL; END; ${tag} LANGUAGE plpgsql;`;
      const one = ["recx_refuse_truncate"];
      for (const tag of ["$$", "$fn$", "$body$", "$_x1$"]) {
        expect(functionProblems(raises(tag), one), tag).toEqual([]);
        expect(functionProblems(`${raises("$$")}\n${hollow(tag)}`, one), tag).toEqual(["recx_refuse_truncate: the live definition no longer raises"]);
      }
      // A hollow body followed by an unrelated $$ body must not borrow its RAISE.
      expect(
        functionProblems(`${raises("$$")}\n${hollow("$fn$")}\nDO $$ BEGIN RAISE EXCEPTION 'elsewhere'; END $$;`, one),
      ).toEqual(["recx_refuse_truncate: the live definition no longer raises"]);
      expect(
        functionProblems(`${raises("$$")}\nCREATE OR REPLACE FUNCTION public.recx_refuse_truncate() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RETURN NULL; END';`, one),
      ).toContain("recx_refuse_truncate: a definition has no single dollar-quoted body");
      expect(
        functionProblems(`CREATE OR REPLACE FUNCTION "recx_refuse_truncate"() RETURNS trigger AS $$ SELECT 1 /* RAISE EXCEPTION */ $$ LANGUAGE sql;`, one),
      ).toEqual(expect.arrayContaining(["recx_refuse_truncate: a definition is not LANGUAGE plpgsql", "recx_refuse_truncate: the live definition no longer raises"]));
      expect(functionProblems("SELECT 1;", one)).toEqual(["recx_refuse_truncate is never defined"]);
    });

    it("flags a guard trigger re-created with a WHEN clause, other events, columns or function; accepts the one known WHEN", () => {
      const scope = GUARD_TRIGGERS.filter((t) => t.name === "AdminScope_grant_immutable");
      const born = GUARD_TRIGGERS.filter((t) => t.name === "ProblemVersion_born_frozen_guard");
      const ok =
        'CREATE TRIGGER "AdminScope_grant_immutable" BEFORE UPDATE OR DELETE ON "public"."AdminScope" FOR EACH ROW EXECUTE FUNCTION recx_refuse_admin_scope_change();';
      expect(triggerProblems(ok, scope)).toEqual([]);
      const bad = [
        'CREATE OR REPLACE TRIGGER "AdminScope_grant_immutable" BEFORE UPDATE OR DELETE ON "public"."AdminScope" FOR EACH ROW WHEN (false) EXECUTE FUNCTION recx_refuse_admin_scope_change();',
        'CREATE OR REPLACE TRIGGER "AdminScope_grant_immutable" BEFORE UPDATE OR DELETE ON "public"."AdminScope" FOR EACH ROW WHEN (OLD."reason" = \'x\') EXECUTE FUNCTION recx_refuse_admin_scope_change();',
        'CREATE OR REPLACE TRIGGER "AdminScope_grant_immutable" BEFORE UPDATE OF "reason" OR DELETE ON "public"."AdminScope" FOR EACH ROW EXECUTE FUNCTION recx_refuse_admin_scope_change();',
        'CREATE OR REPLACE TRIGGER "AdminScope_grant_immutable" BEFORE DELETE ON "public"."AdminScope" FOR EACH ROW EXECUTE FUNCTION recx_refuse_admin_scope_change();',
        'CREATE OR REPLACE TRIGGER "AdminScope_grant_immutable" BEFORE UPDATE OR DELETE ON "public"."AdminScope" FOR EACH STATEMENT EXECUTE FUNCTION recx_refuse_admin_scope_change();',
        'CREATE OR REPLACE TRIGGER "AdminScope_grant_immutable" BEFORE UPDATE OR DELETE ON "public"."AdminScope" FOR EACH ROW EXECUTE FUNCTION noop();',
      ];
      for (const sql of bad) expect(triggerProblems(`${ok}\n${sql}`, scope), sql).not.toEqual([]);
      // A guard function run by an uncatalogued trigger under a WHEN clause is flagged too.
      expect(
        whenProblems('CREATE TRIGGER "Other_guard" BEFORE DELETE ON "X" FOR EACH ROW WHEN (pg_trigger_depth() > 5) EXECUTE FUNCTION recx_refuse_truncate();'),
      ).not.toEqual([]);
      const bornOk =
        'CREATE TRIGGER "ProblemVersion_born_frozen_guard" BEFORE INSERT ON "public"."ProblemVersion" FOR EACH ROW WHEN (NEW."frozenAt" IS NOT NULL) EXECUTE FUNCTION recx_refuse_born_frozen_version();';
      expect(triggerProblems(bornOk, born)).toEqual([]);
      expect(triggerProblems(bornOk.replace("WHEN (NEW", "WHEN ((NEW").replace("NULL)", "NULL))"), born)).toEqual([]);
      for (const when of ['NEW."frozenAt" IS NOT NULL AND false', 'NEW."frozenAt" IS NULL', "false"]) {
        const sql = bornOk.replace('NEW."frozenAt" IS NOT NULL', when);
        expect(triggerProblems(sql, born), when).not.toEqual([]);
      }
      expect(triggerProblems(bornOk.replace(/WHEN \([^)]*\) /, ""), born)).not.toEqual([]);
    });

    it("flags a guard that is dropped, altered, disabled or switched to replica/always mode, and nothing else", () => {
      const bad = [
        "DROP FUNCTION IF EXISTS recx_refuse_truncate() CASCADE;",
        "DROP FUNCTION public.recx_refuse_frozen_child_write();",
        "drop function other_fn(), recx_refuse_admin_scope_change();",
        "ALTER FUNCTION recx_refuse_test_blob_change() RENAME TO old_fn;",
        'DROP TRIGGER IF EXISTS "AdminScope_grant_immutable" ON "AdminScope";',
        'ALTER TRIGGER "TestBlob_no_truncate" ON "TestBlob" RENAME TO "x";',
        'ALTER TABLE "public"."Accommodation" DISABLE TRIGGER "Accommodation_granted_terms_immutable";',
        'ALTER TABLE "XpEvent" DISABLE TRIGGER ALL;',
        'ALTER TABLE "XpEvent" DISABLE TRIGGER USER;',
        'ALTER TABLE "public"."AdminScope" ENABLE REPLICA TRIGGER "AdminScope_grant_immutable";',
        'ALTER TABLE "public"."AdminScope" ENABLE ALWAYS TRIGGER "AdminScope_grant_immutable";',
        'ALTER TABLE ONLY "public"."AuditLog" ENABLE REPLICA TRIGGER "Some_new_name";',
        'ALTER TABLE IF EXISTS public."Announcement" DISABLE TRIGGER "renamed_guard";',
        'DO $$ BEGIN EXECUTE \'ALTER TABLE "TestBlob" ENABLE REPLICA TRIGGER "TestBlob_immutable"\'; END $$;',
        "ALTER DATABASE recx SET session_replication_role = replica;",
        "SET session_replication_role = 'replica';",
        'ALTER TABLE "public"."PrivilegedOperation" DROP CONSTRAINT "PrivilegedOperation_two_person";',
        'ALTER TABLE "PrivilegedOperation" DROP CONSTRAINT IF EXISTS PrivilegedOperation_decided_check;',
        'ALTER TABLE "Accommodation" DROP CONSTRAINT "Accommodation_revoke_pair_check", ADD CONSTRAINT "Accommodation_revoke_pair_check" CHECK (true);',
        'ALTER TABLE "Hint" RENAME CONSTRAINT "Hint_tier_check" TO "Hint_tier_check_old";',
      ];
      for (const sql of bad) expect(guardViolations(sql), sql).not.toEqual([]);
      const fine = [
        'DROP TRIGGER IF EXISTS "Some_other_trigger" ON "X";',
        "DROP FUNCTION recx_refuse_truncate_v0();",
        'ALTER TABLE "AdminScope" ENABLE TRIGGER "AdminScope_grant_immutable";',
        'ALTER TABLE "Session" DISABLE TRIGGER "session_touch";',
        'ALTER TABLE "Session" ENABLE REPLICA TRIGGER "session_touch";',
        'ALTER TABLE "PrivilegedOperation" DROP CONSTRAINT "PrivilegedOperation_some_fk";',
        'ALTER TABLE "PrivilegedOperation" ADD CONSTRAINT "PrivilegedOperation_new_check" CHECK ("affectedCount" >= 0);',
        "CREATE OR REPLACE FUNCTION recx_refuse_truncate() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'x'; END; $$ LANGUAGE plpgsql;",
      ];
      for (const sql of fine) expect(guardViolations(sql), sql).toEqual([]);
    });

    it("flags any statement that sets search_path, in every form, and nothing else", () => {
      const bad = [
        "SET search_path = evil, public;",
        "set search_path to evil;",
        "SET SESSION search_path TO evil, public;",
        "SET LOCAL search_path = 'evil';",
        "ALTER DATABASE recx SET search_path = evil, public;",
        "ALTER ROLE recx IN DATABASE recx SET search_path TO evil;",
        "CREATE OR REPLACE FUNCTION recx_refuse_truncate() RETURNS trigger SET search_path = evil AS $$ BEGIN RAISE EXCEPTION 'x'; END; $$ LANGUAGE plpgsql;",
        "ALTER FUNCTION some_fn() SET search_path = evil;",
        "SELECT set_config('search_path', 'evil, public', false);",
        "SELECT pg_catalog.set_config( 'search_path' , 'evil', true);",
        "DO $$ BEGIN EXECUTE 'SET search_path TO evil'; END $$;",
      ];
      for (const sql of bad) expect(searchPathViolations(stripSqlComments(sql)), sql).not.toEqual([]);
      const fine = [
        "-- SET search_path = evil;",
        "/* SET search_path = evil; */ SELECT 1;",
        "SELECT current_setting('search_path');",
        "SET TimeZone = 'UTC';",
        'ALTER DATABASE recx SET "TimeZone" = \'UTC\';',
      ];
      for (const sql of fine) expect(searchPathViolations(stripSqlComments(sql)), sql).toEqual([]);
    });

    it("flags a trigger on a guarded table that is not catalogued for that table, and nothing else", () => {
      const bad = [
        'CREATE TRIGGER "AdminScope_touch" BEFORE UPDATE ON "public"."AdminScope" FOR EACH ROW EXECUTE FUNCTION touch_updated_at();',
        'CREATE OR REPLACE TRIGGER accommodation_audit AFTER INSERT OR UPDATE ON public."Accommodation" FOR EACH ROW EXECUTE FUNCTION audit_row();',
        'CREATE CONSTRAINT TRIGGER "XpEvent_check" AFTER INSERT ON "XpEvent" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION f();',
        'CREATE TRIGGER "TestCase_first" BEFORE UPDATE OF "index" ON ONLY "public"."TestCase" FOR EACH ROW EXECUTE FUNCTION f();',
        // A guard's name on another guarded table is not that guard.
        'CREATE TRIGGER "AdminScope_grant_immutable" BEFORE UPDATE OR DELETE ON "public"."Accommodation" FOR EACH ROW EXECUTE FUNCTION recx_refuse_admin_scope_change();',
      ];
      for (const sql of bad) expect(uncataloguedTriggerProblems(stripSqlComments(sql)), sql).not.toEqual([]);
      const fine = [
        'CREATE TRIGGER "AdminScope_grant_immutable" BEFORE UPDATE OR DELETE ON "public"."AdminScope" FOR EACH ROW EXECUTE FUNCTION recx_refuse_admin_scope_change();',
        'CREATE OR REPLACE TRIGGER "Announcement_published_immutable" BEFORE UPDATE OR DELETE ON "public"."Announcement" FOR EACH ROW EXECUTE FUNCTION recx_refuse_published_announcement_change();',
        'CREATE TRIGGER "Session_touch" BEFORE UPDATE ON "public"."Session" FOR EACH ROW EXECUTE FUNCTION touch_updated_at();',
        '-- CREATE TRIGGER "AdminScope_touch" BEFORE UPDATE ON "public"."AdminScope" FOR EACH ROW EXECUTE FUNCTION f();',
      ];
      for (const sql of fine) expect(uncataloguedTriggerProblems(stripSqlComments(sql)), sql).toEqual([]);
    });

    it("flags a catalogued CHECK that is missing, created twice, NOT VALID or on another table; flags an uncatalogued CHECK", () => {
      expect(checkProblems(migrations)).toEqual([]);
      const without = (name: string) => migrations.map((m) => ({ ...m, sql: m.sql.replace(new RegExp(`"${escape(name)}"`, "g"), '"renamed_check"') }));
      expect(checkProblems(without("PrivilegedOperation_two_person"))).toContain("PrivilegedOperation_two_person: created 0 times");
      const extra = (sql: string) => [...migrations, { dir: "29990101000000_mutant", sql }];
      expect(
        checkProblems(extra('ALTER TABLE "public"."Hint" ADD CONSTRAINT "Hint_tier_check" CHECK ("tier" > 0)')),
      ).toContain("Hint_tier_check: created 2 times");
      const notValid = migrations.map((m) => ({ ...m, sql: m.sql.replace(/CHECK \("tier" BETWEEN 1 AND 3\)/, '$& NOT VALID') }));
      expect(checkProblems(notValid)).toContain("Hint_tier_check: added NOT VALID");
      const moved = migrations.map((m) => ({
        ...m,
        sql: m.sql.replace(/ALTER TABLE "public"\."Hint"(\s+ADD CONSTRAINT "Hint_tier_check")/, 'ALTER TABLE "public"."Note"$1'),
      }));
      expect(checkProblems(moved).join("\n")).toMatch(/Hint_tier_check: not added by an ALTER TABLE of "Hint"/);
      const sneaky = migrations.map((m) =>
        m.dir === CHECK_CATALOG_THROUGH ? { ...m, sql: `${m.sql};\nALTER TABLE "X" ADD CONSTRAINT "X_unlisted_check" CHECK (true)` } : m,
      );
      expect(uncataloguedChecks(sneaky)).toEqual([`${CHECK_CATALOG_THROUGH}: X_unlisted_check`]);
    });

    it("flags a partial unique index that is dropped, altered, re-created or loses its predicate", () => {
      const intact = migrations.filter((m) => /_phase4_admin_authoring$/.test(m.dir));
      expect(partialIndexProblems(intact)).toEqual([]);
      const extra = (sql: string) => [...intact, { dir: "29990101000000_mutant", sql }];
      expect(partialIndexProblems(extra('DROP INDEX "public"."AdminScope_active_grant_key";'))).not.toEqual([]);
      expect(partialIndexProblems(extra('ALTER INDEX "Accommodation_one_approved_per_user" RENAME TO "x";'))).not.toEqual([]);
      expect(
        partialIndexProblems(extra('CREATE UNIQUE INDEX "Accommodation_one_open_request_per_user" ON "Accommodation" ("userId");')),
      ).not.toEqual([]);
      const noPredicate = intact.map((m) => ({ ...m, sql: m.sql.replace(/WHERE\s+"status"\s*=\s*'APPROVED'/, "") }));
      expect(partialIndexProblems(noPredicate)).not.toEqual([]);
      const nullsDistinct = intact.map((m) => ({ ...m, sql: m.sql.replace(/NULLS\s+NOT\s+DISTINCT/, "") }));
      expect(partialIndexProblems(nullsDistinct)).not.toEqual([]);
    });
  });

  it("lists every recx_refuse_* guard function the migrations define", () => {
    const defined = new Set(functionDefinitions(allSql).map((d) => d.name).filter((n) => /^recx_refuse_/.test(n)));
    expect([...defined].sort()).toEqual([...GUARD_FUNCTIONS].sort());
  });

  it("every guard function is dollar-quoted plpgsql and its latest definition still raises", () => {
    expect(functionProblems(allSql)).toEqual([]);
  });

  it.each(GUARD_TRIGGERS.map((t) => [t.name, t] as const))("%s keeps its exact definition (timing, events, table, level, function, WHEN)", (_name, t) => {
    expect(triggerProblems(allSql, [t])).toEqual([]);
  });

  it("no trigger that runs a guard function has a WHEN clause, except the known born-frozen one", () => {
    expect(whenProblems(allSql)).toEqual([]);
  });

  it("lists every trigger that executes a guard function", () => {
    const listed = new Set(GUARD_TRIGGERS.map((t) => t.name));
    const unlisted = splitSqlStatements(allSql)
      .map((s) => /^CREATE\s+(?:OR\s+REPLACE\s+)?(?:CONSTRAINT\s+)?TRIGGER\s+"?([^"\s]+)"?[\s\S]*?EXECUTE\s+(?:FUNCTION|PROCEDURE)\s+(?:"?public"?\.)?"?(recx_refuse_\w+)/i.exec(s))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => m[1]!)
      .filter((name) => !listed.has(name));
    expect(unlisted).toEqual([]);
  });

  it("refuses TRUNCATE on ProblemVersion, every frozen child, TestBlob, the governance tables, the ledgers and announcements", () => {
    expect(TRUNCATE_GUARDED).toEqual(expect.arrayContaining(["ProblemVersion", "TestBlob", ...FROZEN_CHILD_MODELS]));
    expect(TRUNCATE_GUARDED).toEqual(
      expect.arrayContaining(["PrivilegedOperation", "Accommodation", "AdminScope", "ImpersonationSession", "XpEvent", "AuditLog", "Announcement"]),
    );
  });

  it.each(migrations.map((m) => [m.dir, m.sql] as const))("%s drops, alters, disables or bypasses no guard", (_dir, sql) => {
    expect(guardViolations(sql)).toEqual([]);
  });

  it.each(migrations.map((m) => [m.dir, m.sql] as const))("%s sets no search_path", (_dir, sql) => {
    expect(searchPathViolations(sql)).toEqual([]);
  });

  it.each(migrations.map((m) => [m.dir, m.sql] as const))("%s creates no uncatalogued trigger on a guarded table", (_dir, sql) => {
    expect(uncataloguedTriggerProblems(sql)).toEqual([]);
  });

  it("creates every catalogued CHECK exactly once, valid, on its table, and lists every CHECK up to the catalogue's migration", () => {
    expect(HAND_WRITTEN_CHECKS.map((c) => c.name)).toEqual([...new Set(HAND_WRITTEN_CHECKS.map((c) => c.name))]);
    expect(checkProblems(migrations)).toEqual([]);
    expect(uncataloguedChecks(migrations)).toEqual([]);
    expect(migrations.map((m) => m.dir)).toContain(CHECK_CATALOG_THROUGH);
  });

  it("keeps the three partial unique indexes with their predicates, never dropped or altered", () => {
    expect(partialIndexProblems(migrations)).toEqual([]);
  });
});
