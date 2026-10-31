import { describe, expect, it } from "vitest";
import { CODE_EXTENSIONS, findFiles, lexSource, lineAt, readRepoFile } from "./support/repo";

/**
 * XP is an append-only ledger with period buckets (structural decision 4,
 * Phase 3). Totals and leaderboards read the buckets; no page or route may
 * aggregate XpEvent rows on request. The guard exists from day one so the
 * first Phase 3 page cannot quietly add a SUM over the ledger.
 */

const WEB_SRC = "apps/web/src";
/** Lines after an xpEvent.findMany call in which a summation counts as using it for sums. */
const SUM_WINDOW_LINES = 25;

interface Finding {
  line: number;
  rule: string;
}

const AGGREGATE_CALL = /\bxpEvent\b["'`]?\]?\s*\??\.\s*(aggregate\w*|groupBy|count)\s*\(/g;
const FIND_MANY_CALL = /\bxpEvent\b["'`]?\]?\s*\??\.\s*findMany\s*\(/g;
const SUMMATION = /\.reduce\s*\(|\+=|\bsum(?:By)?\s*\(|\b_sum\b/;
const SQL_SUM = /\bSUM\s*\(/i;
const SQL_XP_EVENT = /\bxp_?events?\b/i;

function scanXpAggregation(source: string): Finding[] {
  const { code, strings } = lexSource(source);
  const lines = code.split("\n");
  const findings: Finding[] = [];

  for (const m of code.matchAll(AGGREGATE_CALL)) {
    findings.push({ line: lineAt(code, m.index), rule: `xpEvent.${m[1]}()` });
  }

  for (const m of code.matchAll(FIND_MANY_CALL)) {
    const line = lineAt(code, m.index);
    const window = lines.slice(line - 1, line - 1 + SUM_WINDOW_LINES).join("\n");
    if (SUMMATION.test(window)) findings.push({ line, rule: "xpEvent.findMany() summed in code" });
  }

  // Raw SQL: SUM( and XpEvent in one literal, or in literals within a few lines.
  const sqlish = strings.map((s) => ({
    line: lineAt(code, s.start),
    sum: SQL_SUM.test(s.body),
    table: SQL_XP_EVENT.test(s.body),
  }));
  for (const s of sqlish) {
    if (s.sum && s.table) {
      findings.push({ line: s.line, rule: "raw SQL SUM over XpEvent" });
    } else if (s.sum && sqlish.some((o) => o.table && Math.abs(o.line - s.line) <= 5)) {
      findings.push({ line: s.line, rule: "raw SQL SUM over XpEvent (split literal)" });
    }
  }

  return findings
    .filter((f, i, all) => all.findIndex((g) => g.line === f.line && g.rule === f.rule) === i)
    .sort((a, b) => a.line - b.line);
}

describe("XP ledger is never aggregated on request", () => {
  describe("self-test", () => {
    const flagged: Array<[name: string, snippet: string]> = [
      ["aggregate", "const t = await db.xpEvent.aggregate({ _sum: { amount: true }, where: { userId } });"],
      ["groupBy", "const rows = await db.xpEvent.groupBy({ by: ['userId'], _sum: { amount: true } });"],
      ["count", "const n = await tx.xpEvent.count({ where: { userId } });"],
      ["bracket access", 'const t = await db["xpEvent"].aggregate({ _sum: { amount: true } });'],
      [
        "findMany then reduce",
        "const rows = await db.xpEvent.findMany({ where: { userId } });\nconst total = rows.reduce((s, r) => s + r.amount, 0);",
      ],
      [
        "findMany then loop sum",
        "const rows = await db.xpEvent.findMany({ where: { userId } });\nlet total = 0;\nfor (const r of rows) total += r.amount;",
      ],
      ["queryRaw SUM", 'const r = await db.$queryRaw`SELECT SUM("amount") FROM "XpEvent" WHERE "userId" = ${id}`;'],
      ["queryRawUnsafe SUM", "await db.$queryRawUnsafe('select sum(amount) from \"XpEvent\" group by \"userId\"');"],
      ["split SQL literal", 'const sql = "SELECT SUM(amount) " +\n  \'FROM "XpEvent"\';'],
    ];

    it.each(flagged)("flags %s", (_name, snippet) => {
      expect(scanXpAggregation(snippet).length).toBeGreaterThan(0);
    });

    it.each([
      ["append to the ledger", "await db.xpEvent.create({ data: { userId, amount, reason } });"],
      ["list history without summing", "const history = await db.xpEvent.findMany({ where: { userId }, take: 20 });"],
      ["read the period bucket", "const week = await db.xpBucket.findUnique({ where: { userId_period: { userId, period } } });"],
      ["unrelated SUM", 'await db.$queryRaw`SELECT SUM("passedCases") FROM "Submission"`;'],
      ["commented out", "// const t = await db.xpEvent.aggregate({ _sum: { amount: true } });"],
    ])("does not flag: %s", (_name, snippet) => {
      expect(scanXpAggregation(snippet)).toEqual([]);
    });
  });

  it(`no file under ${WEB_SRC} aggregates XpEvent`, () => {
    const files = findFiles({ under: [WEB_SRC], extensions: CODE_EXTENSIONS });
    expect(files.length).toBeGreaterThan(0);
    const hits = files.flatMap((file) =>
      scanXpAggregation(readRepoFile(file)).map((f) => `${file}:${f.line}  ${f.rule}`),
    );
    expect(hits, "Read XP totals from the period buckets, never by aggregating XpEvent.").toEqual([]);
  });
});
