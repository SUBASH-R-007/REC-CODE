import { describe, expect, it } from "vitest";
import { findFiles, readRepoFile } from "./support/repo";

/**
 * Every route, student page and student query is IN the exposure
 * catalogue (Phase 13f).
 *
 * `apps/web/test/student-exposure.db.test.ts` is the canary sweep: it
 * calls every route, renders every student page and runs every student
 * query against a database whose fixture hides a secret in each place
 * only staff and judges may read — a hidden test, an answer key, a seed
 * secret — and fails if any of them comes back in a response. It is the
 * strongest security test in this repository.
 *
 * It also checks its own completeness: a route or page missing from its
 * tables fails the run. But the whole file is opt-in (`RECX_DB_TESTS=1`,
 * a live PostgreSQL) and is NOT in `pnpm test`. So the completeness check
 * only runs when somebody remembers to run it with a database — and on
 * 2026-11-02 that turned out to be rarely enough that FOUR student-facing
 * surfaces built that day had never been swept: the `.seb` configuration
 * file a candidate downloads, the query behind a candidate's own marks,
 * the page that renders them, and the CSV of everybody's marks.
 *
 * Completeness needs no database. It is a list of files against a list of
 * keys, so it belongs in the gate, where it fails on the day the surface
 * is written rather than the next time somebody runs the database suites.
 * The behavioural half — actually calling each one and looking for a
 * canary — stays where it is, because that genuinely needs the fixture.
 *
 * The keys are read out of the db test as TEXT. Parsing a test file is
 * not elegant, and the alternative is worse: a second catalogue, kept in
 * step with the first by hope.
 */

const SWEEP = "apps/web/test/student-exposure.db.test.ts";
const APP = "apps/web/src/app";
const QUERIES = "apps/web/src/server/queries";

/**
 * A staff query module, named as the sweep names them. Kept in step with
 * `STAFF_MODULE_PREFIXES` in the sweep itself, and asserted below.
 */
const STAFF_MODULE_PREFIXES = ["admin-", "super-", "mentor-", "placement-"];

/** The HTTP verbs a route file may export, as the sweep lists them. */
const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const;

/** Every quoted key in the sweep, which is how its tables are written. */
function catalogued(): Set<string> {
  const source = readRepoFile(SWEEP);
  return new Set([...source.matchAll(/"([^"\n]+)":/g)].map((m) => m[1]!));
}

/** `apps/web/src/app/x/route.ts` → `x/route.ts`, as the sweep keys it. */
function appRel(file: string): string {
  return file.slice(`${APP}/`.length);
}

describe("the exposure catalogue", () => {
  const keys = catalogued();

  it("reads the sweep (sanity)", () => {
    expect(keys.size).toBeGreaterThan(100);
    // Three keys of each kind it must hold, so a parse that silently
    // matched nothing cannot pass this file.
    expect(keys.has("api/activity/route.ts#POST")).toBe(true);
    expect(keys.has("dashboard#getDashboard")).toBe(true);
    expect(keys.has("(student)/assessments/page.tsx")).toBe(true);
  });

  it("agrees with the sweep about which modules are staff's", () => {
    // Two lists that must match, so a prefix added there and not here
    // would quietly stop this check looking at a whole family of
    // modules.
    const source = readRepoFile(SWEEP);
    const declared = source.match(/const STAFF_MODULE_PREFIXES = \[([^\]]+)\]/);
    expect(declared, "STAFF_MODULE_PREFIXES in the sweep").not.toBeNull();
    const theirs = [...declared![1]!.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
    expect(theirs.sort()).toEqual([...STAFF_MODULE_PREFIXES].sort());
  });

  it("names every exported method of every route", () => {
    /**
     * Read statically: a route's exported verbs are `export async function
     * GET` / `export const POST`, which is how every route in this
     * codebase is written. A route that exported a verb some other way
     * would be missed here and still caught by the db sweep, which
     * imports the module.
     */
    const missing: string[] = [];
    for (const file of findFiles({ under: [APP], extensions: [".ts"] }).filter((f) => f.endsWith("/route.ts"))) {
      const source = readRepoFile(file);
      for (const method of HTTP_METHODS) {
        const exported = new RegExp(`export\\s+(?:async\\s+)?(?:function|const)\\s+${method}\\b`).test(source);
        if (exported && !keys.has(`${appRel(file)}#${method}`)) missing.push(`${appRel(file)}#${method}`);
      }
    }
    expect(missing, `add these to ROUTE_CALLS in ${SWEEP}`).toEqual([]);
  });

  it("names every student page, layout and boundary", () => {
    const missing: string[] = [];
    for (const file of findFiles({ under: [`${APP}/(student)`, `${APP}/(exam)`], extensions: [".tsx"] })) {
      const name = file.split("/").pop()!;
      if (!["page.tsx", "layout.tsx", "loading.tsx", "not-found.tsx", "error.tsx"].includes(name)) continue;
      if (!keys.has(appRel(file))) missing.push(appRel(file));
    }
    expect(missing, `add these to PAGE_CALLS or PAGE_SKIPS in ${SWEEP}`).toEqual([]);
  });

  it("names every export of every student query module", () => {
    /**
     * Which modules are a student's is decided the way the sweep decides
     * it, and not by which ones the sweep happens to mention: a staff
     * module is `<role>-something.ts` and is covered by the capability
     * matrix instead. Reading the list off the catalogue would have made
     * this check blind to exactly the thing it is for — a WHOLE new
     * student query module, which is how `my-assessment-result.ts` went
     * unswept from the day it was written.
     *
     * Exports are read statically, which is how they are written:
     * `export async function`, `export function`, `export const`.
     */
    const missing: string[] = [];
    for (const file of findFiles({ under: [QUERIES], extensions: [".ts"] })) {
      const moduleName = file.split("/").pop()!.replace(/\.ts$/, "");
      if (STAFF_MODULE_PREFIXES.some((prefix) => moduleName.startsWith(prefix))) continue;
      const source = readRepoFile(file);
      for (const match of source.matchAll(/export\s+(?:async\s+)?(?:function|const)\s+([A-Za-z_$][\w$]*)/g)) {
        const name = match[1]!;
        // Types and constants are not queries; the sweep keys functions.
        if (/^[A-Z_]+$/.test(name)) continue;
        if (!keys.has(`${moduleName}#${name}`)) missing.push(`${moduleName}#${name}`);
      }
    }
    expect(missing, `add these to QUERY_CALLS or NOT_PROBLEM_SCOPED in ${SWEEP}`).toEqual([]);
  });
});
