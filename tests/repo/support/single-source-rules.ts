import { LIMITS, TOPICS, VERDICTS } from "../../../packages/shared/src/index";
import { lexSource, lineAt } from "./repo";

/**
 * Detectors for copies of the definitions that may live only in
 * packages/shared/src: Verdict, the limits table, the XP constants, the
 * 14-topic enum and JUDGE_PROTOCOL_VERSION. Imports and usages are fine;
 * assignments, literal lists of the members and literal copies of the values
 * are not. The vocabularies themselves are imported from @recx/shared so this
 * file never becomes a second copy.
 */

export interface Violation {
  file: string;
  line: number;
  rule: string;
  excerpt: string;
}

/**
 * `const NAME: Type = …` (declaration, optionally annotated) or any bare
 * `NAME = …` / `obj.NAME = …`, but not `NAME ==`, `NAME =>` or a destructuring
 * rename such as `const { NAME: local } = shared`.
 */
const assignmentTo = (name: string) =>
  new RegExp(
    String.raw`\b(?:const|let|var|readonly|static)\s+${name}\b\s*(?::[^=;\n]+)?=(?![=>])|\b${name}\b\s*=(?![=>])`,
    "g",
  );

interface PatternRule {
  rule: string;
  pattern: RegExp;
}

const PATTERN_RULES: PatternRule[] = [
  // ── JUDGE_PROTOCOL_VERSION ──
  { rule: "assigns JUDGE_PROTOCOL_VERSION", pattern: assignmentTo("JUDGE_PROTOCOL_VERSION") },
  { rule: "defines JUDGE_PROTOCOL_VERSION as a property", pattern: /\bJUDGE_PROTOCOL_VERSION\b["']?\s*:\s*\d/g },
  { rule: "hard-codes the judge protocol version", pattern: /\bprotocolVersion\b["']?\s*(?::|[!=]==?)\s*\d/g },
  { rule: "hard-codes the judge protocol header value", pattern: /["'`]x-recx-judge-protocol["'`]\s*[:,]\s*["'`]?\d/g },

  // ── Verdict ──
  { rule: "assigns VERDICTS", pattern: assignmentTo("VERDICTS") },
  {
    // Declarations only: `import { type Verdict }` must not match.
    rule: "redeclares Verdict",
    pattern: /\b(?:(?:const|let|var)\s+Verdict\b\s*[:=]|type\s+Verdict\b\s*[=<]|(?:interface|class|enum)\s+Verdict\b)/g,
  },

  // ── Topics ──
  { rule: "assigns TOPICS", pattern: assignmentTo("TOPICS") },
  { rule: "redeclares the Topic enum", pattern: /\benum\s+Topic\b/g },

  // ── XP ──
  { rule: "assigns XP_RULES", pattern: assignmentTo("XP_RULES") },
  { rule: "assigns XP_RULES_VERSION", pattern: assignmentTo("XP_RULES_VERSION") },
  {
    rule: "copies the first-solve XP values",
    pattern: /\bfirstSolve\b["']?\s*:\s*\{[^}]*\b(?:50|120|250)\b/g,
  },
  {
    rule: "copies the first-solve XP values",
    pattern: /\bEASY\b["']?\s*:\s*50\b[\s\S]{0,160}?\bMEDIUM\b["']?\s*:\s*120\b[\s\S]{0,160}?\bHARD\b["']?\s*:\s*250\b/g,
  },
  {
    rule: "copies an XP rule constant",
    pattern:
      /\b(?:dailyChallengeMultiplier|assistedMultiplier|revisionMultiplier|repeatSolve|easyPerDay|totalPerDay)\b["']?\s*(?::|=(?![=>]))\s*-?\d/g,
  },

  // ── Limits ──
  { rule: "assigns LIMITS", pattern: assignmentTo("LIMITS") },
];

/**
 * LIMITS keys distinctive enough that three of them defined with literal
 * values in one file can only be a copy of the table. Generic names (memory,
 * source, compile, …) are left out to avoid false positives.
 */
const GENERIC_LIMIT_KEYS = new Set(["memory", "stack", "processes", "source", "compile", "detail"]);
const LIMIT_KEYS = Object.keys(LIMITS).filter((k) => !GENERIC_LIMIT_KEYS.has(k));
const LIMIT_KEY_DEFINITION = new RegExp(String.raw`\b(${LIMIT_KEYS.join("|")})\b["']?\s*:\s*[{\d]`, "g");
const LIMIT_KEY_THRESHOLD = 3;

/**
 * When a literal list of verdict codes is a copy of the vocabulary: it lists
 * AC together with at least three other codes (the shape of an "all verdicts"
 * list), or it is nearly complete. A narrowing subset such as
 * `Extract<Verdict, "TLE" | "MLE" | "RE">` or a function's failure-only
 * return type is derived from the shared type and is not a copy.
 */
function isVerdictListCopy(codes: string[]): boolean {
  return (codes.includes("AC") && codes.length >= 4) || codes.length >= VERDICTS.length - 2;
}
const TOPIC_LIST_THRESHOLD = 5;

const STR = String.raw`(?:"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|` + "`" + String.raw`(?:[^` + "`" + String.raw`\\$]|\\.)*` + "`)";
const LITERAL = new RegExp(STR, "g");
/** An array literal made only of string literals: ["a", 'b', `c`,]. */
const STRING_ARRAY = new RegExp(String.raw`\[\s*(?:${STR}\s*,\s*)*${STR}\s*,?\s*\]`, "g");
/** A union of string literal types: "a" | "b" | "c". */
const STRING_UNION = new RegExp(String.raw`(?:${STR}\s*\|\s*)+${STR}`, "g");

const VERDICT_SET = new Set<string>(VERDICTS);
const TOPIC_SET = new Set<string>(TOPICS);

function literalValues(text: string): string[] {
  return [...text.matchAll(LITERAL)].map((m) => m[0].slice(1, -1));
}

function excerptAt(source: string, line: number): string {
  const text = source.split("\n")[line - 1] ?? "";
  const trimmed = text.trim();
  return trimmed.length > 160 ? `${trimmed.slice(0, 157)}...` : trimmed;
}

/** Every single-source violation in one JS/TS file. */
export function scanSource(file: string, source: string): Violation[] {
  const { code } = lexSource(source);
  const violations: Violation[] = [];
  const add = (rule: string, offset: number) => {
    const line = lineAt(code, offset);
    if (violations.some((v) => v.line === line && v.rule === rule)) return;
    violations.push({ file, line, rule, excerpt: excerptAt(source, line) });
  };

  for (const { rule, pattern } of PATTERN_RULES) {
    pattern.lastIndex = 0;
    for (const m of code.matchAll(pattern)) add(rule, m.index);
  }

  for (const shape of [STRING_ARRAY, STRING_UNION]) {
    shape.lastIndex = 0;
    for (const m of code.matchAll(shape)) {
      const values = new Set(literalValues(m[0]));
      const verdicts = [...values].filter((v) => VERDICT_SET.has(v));
      const topics = [...values].filter((v) => TOPIC_SET.has(v));
      if (isVerdictListCopy(verdicts)) {
        add(`lists ${verdicts.length} verdict codes (use VERDICTS from @recx/shared)`, m.index);
      }
      if (topics.length >= TOPIC_LIST_THRESHOLD) {
        add(`lists ${topics.length} topic keys (use TOPICS from @recx/shared)`, m.index);
      }
    }
  }

  LIMIT_KEY_DEFINITION.lastIndex = 0;
  const limitHits = [...code.matchAll(LIMIT_KEY_DEFINITION)];
  const distinctLimitKeys = new Set(limitHits.map((m) => m[1]));
  if (distinctLimitKeys.size >= LIMIT_KEY_THRESHOLD && limitHits[0]) {
    add(`defines ${distinctLimitKeys.size} limits-table keys with literal values (use LIMITS)`, limitHits[0].index);
  }

  return violations.sort((a, b) => a.line - b.line);
}

/**
 * `enum Verdict` in a Prisma schema or a JS/TS file. Only
 * packages/db/prisma/schema.prisma may declare it (the storage mirror).
 */
export function scanEnumVerdict(file: string, source: string): Violation[] {
  const code = file.endsWith(".prisma")
    ? source.replace(/\/\/.*$/gm, (c) => " ".repeat(c.length))
    : lexSource(source).code;
  return [...code.matchAll(/\benum\s+Verdict\b/g)].map((m) => {
    const line = lineAt(code, m.index);
    return { file, line, rule: "declares enum Verdict", excerpt: excerptAt(source, line) };
  });
}

export function formatViolation(v: Violation): string {
  return `${v.file}:${v.line}  ${v.rule}  →  ${v.excerpt}`;
}
