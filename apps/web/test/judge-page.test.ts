import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  LANGUAGE_CATALOG,
  LIMITS,
  RUN_OUTCOME_RULES,
  VERDICT_PRECEDENCE,
  jvmRunFlags,
  type LanguageKey,
} from "@recx/shared";

/**
 * The public /judge page rendered to HTML with the database stubbed:
 *   - it reads exactly the enabled, current LanguageConfig rows (five public
 *     fields), never anything else, and needs no sign-in;
 *   - every rendered language shows its label, version, every compile and
 *     run argument, its environment, process and file limits, multiplier and
 *     extra time, under its own anchor — taken from the row's runtime JSON,
 *     so a language the catalog leaves off but the database enables shows,
 *     and one the database disables does not;
 *   - every published limit value, the run-outcome rules and the verdict
 *     precedence appear in the published order;
 *   - a database failure still renders every constant section.
 */

interface FixtureRow {
  key: string;
  label: string;
  version: string;
  toolchainId: string;
  runtime: unknown;
  enabled: boolean;
  isCurrent: boolean;
}

const h = vi.hoisted(() => ({
  rows: [] as FixtureRow[],
  fail: false,
  findMany: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ db: { languageConfig: { findMany: h.findMany } } }));
vi.mock("next/cache", () => ({ unstable_cache: <T>(fn: T) => fn, revalidateTag: vi.fn() }));
vi.mock("@/lib/auth/guards", () => {
  const refuse = () => {
    throw new Error("/judge must not require sign-in");
  };
  return {
    requireUser: refuse,
    requireRole: refuse,
    requirePageRole: refuse,
    requireActionUser: refuse,
    requireActionRole: refuse,
    requireSuperAdmin: refuse,
  };
});
vi.mock("@/lib/auth/session", () => ({
  getCurrentUser: () => {
    throw new Error("/judge must not read the session");
  },
}));

const React = await import("react");
(globalThis as { React?: unknown }).React = React;
const { renderToStaticMarkup } = await import("react-dom/server");
const { default: JudgePage, dynamic } = await import("@/app/(public)/judge/page");
const { buildJudgeFacts, displayArgv, shellQuote } = await import("@/lib/judge/transparency");
const { judgeLanguageAnchor } = await import("@/lib/judge/judge-links");

function catalogRow(key: LanguageKey, enabled: boolean, isCurrent = true): FixtureRow {
  const rt = LANGUAGE_CATALOG[key];
  return { key, label: rt.label, version: rt.version, toolchainId: rt.toolchainId, runtime: rt, enabled, isCurrent };
}

/** React's escaping of text and attribute values. */
const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");

async function render(): Promise<string> {
  const element = await JudgePage();
  // Adjacent text nodes are separated by <!-- --> in server markup.
  return renderToStaticMarkup(element).replaceAll("<!-- -->", "");
}

function between(html: string, start: string, end: string): string {
  const from = html.indexOf(start);
  expect(from, `${start} is rendered`).toBeGreaterThanOrEqual(0);
  const to = html.indexOf(end, from);
  return html.slice(from, to < 0 ? undefined : to);
}

beforeEach(() => {
  vi.clearAllMocks();
  h.fail = false;
  h.rows = [
    catalogRow("cpp20", false), // the catalog enables it; the database turned it off
    catalogRow("py312", true),
    catalogRow("java21", true), // the catalog leaves it off; the database enabled it
    catalogRow("c17", false),
    {
      ...catalogRow("py312", true, false),
      label: "Python 3.11 (CPython 3.11.9)",
      version: "3.11.9",
      toolchainId: "cpython-3.11.9",
    },
  ];
  h.findMany.mockImplementation(async (args: { where: { enabled?: boolean; isCurrent?: boolean } }) => {
    if (h.fail) throw new Error("database unreachable");
    return h.rows
      .filter((r) => (args.where.enabled === undefined || r.enabled === args.where.enabled) && (args.where.isCurrent === undefined || r.isCurrent === args.where.isCurrent))
      .sort((a, b) => a.key.localeCompare(b.key))
      .map(({ key, label, version, toolchainId, runtime }) => ({ key, label, version, toolchainId, runtime }));
  });
});

describe("/judge", () => {
  it("is rendered per request (never prerendered at build time)", () => {
    expect(dynamic).toBe("force-dynamic");
  });

  it("reads only the enabled, current rows and five public fields", async () => {
    await render();
    expect(h.findMany).toHaveBeenCalledTimes(1);
    expect(h.findMany).toHaveBeenCalledWith({
      where: { enabled: true, isCurrent: true },
      select: { key: true, label: true, version: true, toolchainId: true, runtime: true },
      orderBy: { key: "asc" },
    });
  });

  it("shows every enabled language's exact specification under its anchor", async () => {
    const html = await render();
    for (const key of ["java21", "py312"] as const) {
      const rt = LANGUAGE_CATALOG[key];
      const card = between(html, `id="${judgeLanguageAnchor(key)}"`, "</article>");
      expect(card).toContain(esc(rt.label));
      expect(card).toContain(esc(rt.version));
      expect(card).toContain(esc(rt.toolchainId));
      expect(card).toContain(esc(rt.sourceFile));
      for (const argv of [rt.run.argv, ...(rt.compile ? [rt.compile.argv] : [])]) {
        expect(card).toContain(esc(displayArgv(argv)));
        for (const token of argv) expect(card).toContain(esc(shellQuote(token)));
      }
      for (const [k, v] of [...Object.entries(rt.env), ["HOME", "/box"], ["LANG", "C.UTF-8"]]) {
        expect(card).toContain(esc(`${k}=${v}`));
      }
      expect(card).toMatch(new RegExp(`Processes</dt><dd[^>]*>${rt.processes}</dd>`));
      expect(card).toMatch(new RegExp(`Open files</dt><dd[^>]*>${rt.openFiles}</dd>`));
      expect(card).toContain(`×${rt.fallbackMultiplier}`);
      expect(card).toContain(`+ ${rt.fallbackExtraMs} ms`);
    }
    // The multiplier table has the same numbers.
    const table = between(html, 'aria-label="Time limit multipliers by language', "</table>");
    expect(table).toContain("×2");
    expect(table).toContain("+ 300 ms");
    expect(table).toContain("×5");
    expect(table).toContain("+ 1000 ms");
  });

  it("orders languages by the catalog order and leaves out disabled and non-current rows", async () => {
    const html = await render();
    expect(html.indexOf('id="lang-java21"')).toBeLessThan(html.indexOf('id="lang-py312"'));
    expect(html).not.toContain('id="lang-cpp20"');
    expect(html).not.toContain('id="lang-c17"');
    expect(html).not.toContain(esc(LANGUAGE_CATALOG.cpp20.label));
    expect(html).not.toContain("Python 3.11");
    expect(html).not.toContain("cpython-3.11.9");
  });

  it("shows every published limit value", async () => {
    const html = await render();
    const facts = buildJudgeFacts([]);
    const table = between(html, 'aria-label="Every judge limit', "</table>");
    for (const limit of facts.limits) {
      expect(table).toContain(esc(limit.resource));
      expect(table).toContain(esc(limit.value));
      expect(table).toContain(`data-limit="${limit.id}"`);
    }
    expect(table).toContain("<caption");
    expect(table).toContain('scope="col"');
    expect(table).toContain('scope="row"');
  });

  it("lists the run-outcome rules and the verdict precedence in the published order", async () => {
    const html = await render();
    const rules = between(html, 'id="run-outcome-rules"', "</ol>");
    expect([...rules.matchAll(/data-rule="([^"]+)"/g)].map((m) => m[1])).toEqual(RUN_OUTCOME_RULES.map((r) => r.id));
    for (const rule of RUN_OUTCOME_RULES) {
      const item = between(rules, `data-rule="${rule.id}"`, "</li>");
      if (rule.verdict) expect(item).toContain(`data-verdict="${rule.verdict}"`);
      else expect(item).toContain("Output compared");
    }
    const precedence = between(html, 'id="verdict-precedence"', "</ol>");
    expect([...precedence.matchAll(/data-verdict="([^"]+)"/g)].map((m) => m[1])).toEqual([...VERDICT_PRECEDENCE]);
  });

  it("shows the JVM's memory-derived flags (jvmRunFlags) instead of a heap caveat", async () => {
    const html = await render();
    const card = between(html, 'id="lang-java21"', "</article>");
    for (const kb of [LIMITS.memory.defaultKb, LIMITS.memory.ceilingKb]) {
      expect(card).toContain(esc(displayArgv(jvmRunFlags(kb))));
    }
    expect(between(html, 'id="lang-py312"', "</article>")).not.toContain("-Xmx");
    const memory = between(html, 'id="memory"', "</section>");
    expect(memory).toContain(esc(LANGUAGE_CATALOG.java21.label));
    expect(memory).toContain("OutOfMemoryError");
    expect(memory).not.toContain("garbage collector");
  });

  it("keeps the heap caveat for a collected runtime without a heap ceiling, and only then", async () => {
    h.rows = [catalogRow("py312", true), catalogRow("node22", true)];
    let memory = between(await render(), 'id="memory"', "</section>");
    expect(memory).toContain("garbage collector");
    expect(memory).toContain(esc(LANGUAGE_CATALOG.node22.label));
    h.rows = [catalogRow("py312", true), catalogRow("cpp20", true)];
    memory = between(await render(), 'id="memory"', "</section>");
    expect(memory).not.toContain("garbage collector");
    expect(memory).not.toContain("OutOfMemoryError");
  });

  it("gives every scroll region a name and keyboard access", async () => {
    const html = await render();
    const regions = [...html.matchAll(/<div[^>]*role="region"[^>]*>/g)].map((m) => m[0]);
    expect(regions.length).toBeGreaterThanOrEqual(2);
    for (const region of regions) {
      expect(region).toContain('tabindex="0"');
      expect(region).toMatch(/aria-label="[^"]+"/);
    }
  });

  it("still renders every constant section when the database is down", async () => {
    h.fail = true;
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const html = await render();
    expect(error).toHaveBeenCalled();
    error.mockRestore();
    expect(html).toContain("The language list is unavailable right now.");
    expect(html).not.toContain('id="lang-');
    for (const limit of buildJudgeFacts([]).limits) expect(html).toContain(esc(limit.value));
    const precedence = between(html, 'id="verdict-precedence"', "</ol>");
    expect([...precedence.matchAll(/data-verdict="([^"]+)"/g)].map((m) => m[1])).toEqual([...VERDICT_PRECEDENCE]);
    for (const id of ["languages", "time-limits", "tle", "memory", "output", "verdicts", "limits", "sandbox"]) {
      expect(html).toContain(`id="${id}"`);
    }
  });

  it("says so when no language is enabled", async () => {
    h.rows = [catalogRow("cpp20", false)];
    expect(await render()).toContain("No language is enabled right now.");
  });

  it("shows a row whose runtime cannot be read without inventing its flags", async () => {
    h.rows = [{ ...catalogRow("py312", true), runtime: { broken: true } }];
    const html = await render();
    const card = between(html, 'id="lang-py312"', "</article>");
    expect(card).toContain("could not be read");
    expect(card).not.toContain("<code");
  });
});
