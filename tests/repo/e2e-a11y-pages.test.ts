import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { abs, readRepoFile } from "./support/repo";

/**
 * The e2e README lists the pages the axe gate scans. The spec decides them
 * (Phase 15o).
 *
 * Those two drifted, which is how this fence came to exist. `e2e/README.md`
 * is the entry point for anyone running these suites — it is where you look
 * to find out what is GATED (zero serious or critical violations, a failure
 * is a failure) and what is only REPORTED. It listed about thirty pages. The
 * spec scans sixty-five. Every phase that added a surface added a target and
 * left the README behind, and a reader checking whether their new page was
 * covered would have been told no when the answer was yes — or, worse, the
 * other way round.
 *
 * So the lists are generated from the spec and compared, exactly as the
 * capability matrix in `docs/SECURITY.md` is (`apps/web/test/
 * capabilities.test.ts`): a stale README fails the gate, and
 * `RECX_UPDATE_DOCS=1` rewrites it.
 *
 * The parse is deliberately shallow — every `path: "…"` in `TARGETS`, and
 * whether `gating: true` appears before the next one. A target is a literal
 * in a flat array, and a fence that needed a TypeScript parser to read one
 * would be a fence nobody could fix.
 */

const SPEC = "apps/web/e2e/a11y.spec.ts";
const README = "apps/web/e2e/README.md";
const START = "<!-- axe-pages:start -->";
const END = "<!-- axe-pages:end -->";

export interface Target {
  readonly path: string;
  /** The seeded account that opens it, or "signed out". */
  readonly as: string;
}

export interface ScannedPages {
  readonly gated: readonly Target[];
  readonly reported: readonly Target[];
}

export function scannedPages(source: string): ScannedPages {
  const begin = source.indexOf("const TARGETS");
  if (begin < 0) throw new Error(`${SPEC} no longer declares TARGETS`);
  const body = source.slice(begin, source.indexOf("\n];", begin));
  const gated: Target[] = [];
  const reported: Target[] = [];
  const entries = [...body.matchAll(/path:\s*"([^"]+)"([\s\S]*?)(?=path:\s*"|$)/g)];
  for (const [, path = "", rest = ""] of entries) {
    // A query string is an input to the page, not another page.
    const page = path.split("?")[0] ?? path;
    const account = /as:\s*null/.test(rest) ? "signed out" : (/as:\s*"([^"]+)"/.exec(rest)?.[1] ?? "?");
    (/gating:\s*true/.test(rest) ? gated : reported).push({ path: page, as: account });
  }
  return { gated, reported };
}

export function axePagesMarkdown(pages: ScannedPages): string {
  /**
   * The account is part of a target, not decoration: `/admin/judge` is
   * GATED as the scoped admin and REPORTED as the super-admin, which is the
   * same page scanned twice because the two roles see different controls on
   * it. A list keyed on the path alone would read as a contradiction.
   */
  const list = (targets: readonly Target[]) => targets.map((t) => `\`${t.path}\` (${t.as})`).join(", ");
  return [
    `**Gated** (${pages.gated.length} scans — a serious or critical violation fails the run):`,
    "",
    list(pages.gated),
    "",
    `**Reported only** (${pages.reported.length} scans — scanned the same way, annotated and attached, never failing):`,
    "",
    list(pages.reported),
  ].join("\n");
}

describe("the e2e README lists the pages the axe gate scans", () => {
  const pages = scannedPages(readRepoFile(SPEC));

  it("finds the targets, and both kinds of them", () => {
    // A guard on the parse itself: if TARGETS moves or changes shape, this
    // says so rather than quietly generating an empty list.
    expect(pages.gated.length).toBeGreaterThan(20);
    expect(pages.reported.length).toBeGreaterThan(5);
    for (const target of [...pages.gated, ...pages.reported]) {
      expect(target.path).toMatch(/^\//);
      expect(target.as, target.path).not.toBe("?");
    }
    expect(pages.gated.map((t) => t.path)).toContain("/login");
    expect(pages.gated.map((t) => t.path)).toContain("/super/settings/ai");
    // `/admin/judge` is the page scanned both ways on purpose: gated as the
    // scoped admin, reported as the super-admin, who sees more controls.
    expect(pages.reported.map((t) => t.path)).toContain("/admin/judge");
    expect(pages.gated.map((t) => t.path)).toContain("/admin/judge");
    expect(pages.gated.map((t) => t.path)).toContain("/judge");
    /**
     * A page may be in BOTH lists, and `/admin/judge` is: gated as the
     * scoped admin, reported as the super-admin, because the two roles see
     * different controls on it. What must never happen is the SAME scan in
     * both — that would be a target the run both fails on and ignores.
     */
    const key = (t: Target) => `${t.path} as ${t.as}`;
    const reported = new Set(pages.reported.map(key));
    expect(pages.gated.map(key).filter((k) => reported.has(k))).toEqual([]);
  });

  it("matches the README (RECX_UPDATE_DOCS=1 rewrites it)", () => {
    const file = abs(README);
    const doc = readFileSync(file, "utf8").replace(/\r\n/g, "\n");
    const start = doc.indexOf(START);
    const end = doc.indexOf(END);
    expect(start, `${README} has ${START}`).toBeGreaterThan(-1);
    expect(end, `${README} has ${END} after the start marker`).toBeGreaterThan(start);
    const expected = `${START}\n${axePagesMarkdown(pages)}\n${END}`;
    const actual = doc.slice(start, end + END.length);
    if (actual !== expected && process.env.RECX_UPDATE_DOCS === "1") {
      writeFileSync(file, doc.slice(0, start) + expected + doc.slice(end + END.length), "utf8");
      return;
    }
    expect(actual, `the axe page list in ${README} is stale: run with RECX_UPDATE_DOCS=1`).toBe(expected);
  });
});
