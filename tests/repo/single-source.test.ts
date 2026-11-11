import { describe, expect, it } from "vitest";
import { CODE_EXTENSIONS, findFiles, isTestPath, lexSource, readRepoFile } from "./support/repo";
import { formatViolation, scanEnumVerdict, scanSource } from "./support/single-source-rules";

/**
 * Single-source rule (docs/ARCHITECTURE.md): Verdict, the limits table, the
 * XP constants, the 14-topic enum and JUDGE_PROTOCOL_VERSION are defined only
 * in packages/shared/src. The Prisma enums are storage mirrors held equal by
 * packages/db/test/enum-parity.test.ts; schema.prisma is the one exemption.
 */

const SHARED_SRC = "packages/shared/src/";
const PRISMA_SCHEMA = "packages/db/prisma/schema.prisma";

const scanned = () =>
  findFiles({
    extensions: CODE_EXTENSIONS,
    exclude: (rel) => rel.startsWith(SHARED_SRC) || isTestPath(rel),
  });

// Synthetic copies, one per rule family. Each MUST be reported.
const DUPLICATES: Array<[name: string, snippet: string]> = [
  ["protocol version constant", "export const JUDGE_PROTOCOL_VERSION = 2;"],
  ["typed protocol version constant", "export const JUDGE_PROTOCOL_VERSION: number = 2;"],
  ["protocol version property", "export const wire = { JUDGE_PROTOCOL_VERSION: 2 };"],
  ["protocol version overwrite", "shared.JUDGE_PROTOCOL_VERSION = 3;"],
  ["hard-coded protocolVersion field", "await post('/api/judge/claim', { protocolVersion: 1, kind, id });"],
  ["hard-coded protocolVersion check", "if (body.protocolVersion !== 1) return new Response(null, { status: 426 });"],
  ["hard-coded protocol header", 'const headers = { "x-recx-judge-protocol": "1" };'],
  ["VERDICTS constant", 'export const VERDICTS = ["AC"] as const;'],
  ["verdict array literal", "const all = ['AC', 'WA', 'TLE', 'MLE', 'RE'];"],
  ["verdict array across lines", 'const all = [\n  "AC",\n  "WA",\n  "TLE",\n  "MLE",\n];'],
  ["verdict union type", 'type V = "AC" | "WA" | "TLE" | "MLE";'],
  ["multi-line verdict union", 'type V =\n  | "AC"\n  | "WA"\n  | "TLE"\n  | "MLE";'],
  ["verdict zod enum", 'const v = z.enum(["AC", "WA", "TLE", "MLE", "RE", "CE"]);'],
  [
    "near-complete verdict list without AC",
    'const failures = ["WA", "TLE", "MLE", "RE", "CE", "OLE", "PARTIAL", "SKIPPED"];',
  ],
  ["Verdict enum", "enum Verdict { AC, WA }"],
  ["Verdict object", "export const Verdict = Object.freeze({});"],
  ["Verdict type alias", "export type Verdict = string;"],
  ["TOPICS constant", "export const TOPICS = [] as const;"],
  [
    "topic list literal",
    'const t = ["ARRAYS_HASHING", "TWO_POINTERS", "SLIDING_WINDOW", "STACK_QUEUE", "BINARY_SEARCH"];',
  ],
  ["Topic enum", "enum Topic { ARRAYS_HASHING }"],
  ["XP_RULES constant", "export const XP_RULES = Object.freeze({});"],
  ["XP rules version", "export const XP_RULES_VERSION = 2;"],
  ["first-solve XP literal", "const xp = { firstSolve: { EASY: 50, MEDIUM: 120, HARD: 250 } };"],
  ["first-solve XP by difficulty", "const BASE = { EASY: 50, MEDIUM: 120, HARD: 250 };"],
  ["XP caps literal", "const caps = { easyPerDay: 600, totalPerDay: 2000 };"],
  ["XP multiplier constant", "const assistedMultiplier = 0.4;"],
  ["LIMITS constant", "export const LIMITS = {};"],
  [
    "limits table copy",
    "const t = { cpuTime: { ceilingMs: 15000, floorMs: 200 }, wallTime: { multiplier: 2.5 }, earlyOle: { pollMs: 200 } };",
  ],
];

// Imports and usages. None of these may be reported.
const USAGES = [
  'import { VERDICTS, LIMITS, TOPICS, XP_RULES, JUDGE_PROTOCOL_VERSION } from "@recx/shared";',
  'import type { Verdict, Topic } from "@recx/shared";',
  'import { progressEventSchema, type JobKind, type Verdict } from "@recx/shared";',
  'import {\n  type Verdict,\n  VERDICTS,\n} from "@recx/shared";',
  "function f(v: Verdict): Verdict { return v; }",
  'export { VERDICTS, type Verdict } from "@recx/shared";',
  "if (body.protocolVersion !== JUDGE_PROTOCOL_VERSION) return new Response(null, { status: 426 });",
  "const spec = { protocolVersion: JUDGE_PROTOCOL_VERSION, kind, id };",
  "const { JUDGE_PROTOCOL_VERSION: version } = shared;",
  'const shown = VERDICTS.filter((v) => v !== "IE");',
  "const ceiling = LIMITS.cpuTime.ceilingMs * 2;",
  "const same = other === LIMITS;",
  "const RATE_LIMITS = { login: 5 };",
  'const xp = solveXp({ difficulty: "EASY", firstSolve: true, assisted: false, dailyChallenge: false, revision: false });',
  'const allowed = applyDailyCaps({ amount, isEasy: difficulty === "EASY", earnedTodayTotal, earnedTodayEasy });',
  "// const VERDICTS = ['AC', 'WA', 'TLE', 'MLE'];",
  "/* type V = 'AC' | 'WA' | 'TLE' | 'MLE' */",
  'switch (v) { case "AC": return 1; case "WA": return 2; case "TLE": return 3; case "MLE": return 4; }',
  "const icons: Record<Verdict, Icon> = { AC: Check, WA: X, TLE: Clock, MLE: Cpu, RE: Bug };",
  'const results = [{ i: 0, v: "AC" }, { i: 1, v: "WA" }, { i: 2, v: "TLE" }, { i: 3, v: "MLE" }];',
  'const tags = ["ARRAYS_HASHING", "TWO_POINTERS"];',
  'const pending: VerdictDisplay[] = ["QUEUED", "RUNNING"];',
  'type FailingVerdict = Extract<Verdict, "WA" | "TLE" | "MLE" | "RE" | "OLE">;',
  'interface Outcome { verdict: "TLE" | "MLE" | "RE" | "OLE" | "IE" | null }',
  'const RESOURCE: readonly Verdict[] = ["TLE", "MLE", "OLE"];',
  "const wall = wallTimeSecFor(spec.timeLimitMs);",
  'const url = "https://example.edu/a//b"; const VERDICT_COUNT = VERDICTS.length;',
];

describe("source lexer (shared by every scanner in tests/repo)", () => {
  it.each([
    ["line comment after a URL string", 'const u = "http://x"; // VERDICTS = []', 'const u = "http://x";'],
    ["block comment", "a(); /* LIMITS = {} */ b();", "a();"],
    ["regex containing slashes", "const re = /\\/\\/x/g; // TOPICS = []", "const re = /\\/\\/x/g;"],
    ["template with a URL", "const t = `http://x ${y} //kept`;", "const t = `http://x ${y} //kept`;"],
    ["comment inside an interpolation", "const t = `a${b /* gone */}c`;", "const t = `a${b"],
    ["JSX apostrophe stays on its line", "<p>Don't</p>\n// XP_RULES = {}\nconst z = 1;", "const z = 1;"],
  ])("%s", (_name, src, kept) => {
    const { code } = lexSource(src);
    expect(code).toHaveLength(src.length);
    expect(code.split("\n").length).toBe(src.split("\n").length);
    expect(code).toContain(kept);
    expect(code).not.toMatch(/VERDICTS = |LIMITS = |TOPICS = |XP_RULES = |gone/);
  });

  it("records string and template literals", () => {
    const { strings } = lexSource("f('a', \"b\", `c${d}e`);");
    expect(strings.map((s) => s.body)).toEqual(["a", "b", "c${d}e"]);
  });
});

describe("single-source definitions", () => {
  describe("self-test", () => {
    it.each(DUPLICATES)("detects a synthetic duplicate: %s", (_name, snippet) => {
      expect(scanSource("synthetic.ts", snippet).length).toBeGreaterThan(0);
    });

    it.each(USAGES.map((u) => [u]))("does not flag an import or usage: %s", (snippet) => {
      expect(scanSource("synthetic.ts", snippet).map(formatViolation)).toEqual([]);
    });

    it("detects enum Verdict in a Prisma or TS file", () => {
      expect(scanEnumVerdict("other.prisma", "// mirror\nenum Verdict {\n  AC\n  WA\n}\n")).toHaveLength(1);
      expect(scanEnumVerdict("other.prisma", "// enum Verdict lives in schema.prisma\n")).toHaveLength(0);
      expect(scanEnumVerdict("other.ts", "export enum Verdict { AC = 'AC' }")).toHaveLength(1);
      expect(scanEnumVerdict("other.ts", "// not an enum Verdict\nconst x = 1;")).toHaveLength(0);
    });

    // The canonical definitions are real code the scanner must recognise; if it
    // stops finding them, the repository-wide scan below proves nothing.
    it.each([
      ["packages/shared/src/verdict.ts", "assigns VERDICTS"],
      ["packages/shared/src/limits.ts", "assigns LIMITS"],
      ["packages/shared/src/topics.ts", "assigns TOPICS"],
      ["packages/shared/src/xp.ts", "assigns XP_RULES"],
      ["packages/shared/src/protocol.ts", "assigns JUDGE_PROTOCOL_VERSION"],
    ])("recognises the canonical definition in %s", (file, rule) => {
      const rules = scanSource(file, readRepoFile(file)).map((v) => v.rule);
      expect(rules).toContain(rule);
    });
  });

  it("nothing outside packages/shared/src defines them", () => {
    const files = scanned();
    expect(files.length).toBeGreaterThan(0);
    const violations = files.flatMap((file) => scanSource(file, readRepoFile(file)));
    expect(
      violations.map(formatViolation),
      "Import these from @recx/shared instead of redefining them.",
    ).toEqual([]);
  });

  it("enum Verdict appears only in packages/db/prisma/schema.prisma", () => {
    // Includes packages/shared/src: the canonical Verdict is a const list, never an enum.
    const files = findFiles({
      extensions: [".prisma", ...CODE_EXTENSIONS],
      exclude: (rel) => rel === PRISMA_SCHEMA || isTestPath(rel),
    });
    const violations = files.flatMap((file) => scanEnumVerdict(file, readRepoFile(file)));
    expect(violations.map(formatViolation)).toEqual([]);
    expect(scanEnumVerdict(PRISMA_SCHEMA, readRepoFile(PRISMA_SCHEMA))).toHaveLength(1);
  });
});
