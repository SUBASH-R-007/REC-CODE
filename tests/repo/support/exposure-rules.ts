import ts from "typescript";
import { lexSource, lineAt } from "./repo";

/**
 * Detectors for tests/repo/student-exposure.test.ts: the static half of the
 * Phase 4 gate "no STUDENT-reachable route can return a non-sample test file
 * or a ReferenceSolution.source". Each detector is a pure function of source
 * text so the test can run it on flagged and clean snippets as well as on
 * the checkout. Comments never count (every scan runs over lexSource code).
 */

export interface Finding {
  line: number;
  rule: string;
}

function dedupe(findings: Finding[]): Finding[] {
  return findings
    .filter((f, i, all) => all.findIndex((g) => g.line === f.line && g.rule === f.rule) === i)
    .sort((a, b) => a.line - b.line);
}

/** Code with comments removed AND string bodies blanked (for brace matching). */
function structuralCode(source: string): { code: string; withStrings: string; strings: ReturnType<typeof lexSource>["strings"] } {
  const { code, strings } = lexSource(source);
  const chars = code.split("");
  for (const s of strings) {
    for (let k = s.start + 1; k < s.end - 1 && k < chars.length; k++) {
      if (chars[k] !== "\n" && chars[k] !== "\r") chars[k] = " ";
    }
  }
  return { code: chars.join(""), withStrings: code, strings };
}

/** The balanced {…} block that opens at `open` (code[open] === "{"), or null. */
function braceBlock(code: string, open: number): string | null {
  let depth = 0;
  for (let k = open; k < code.length; k++) {
    const c = code[k];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return code.slice(open, k + 1);
    }
  }
  return null;
}

// ── R1: reference solutions ──────────────────────────────────────────────

const REFERENCE_SOLUTION = /\b[Rr]eferenceSolutions?\b/g;

/** R1: the ReferenceSolution model, its delegate or relation, in code or in SQL text. */
export function scanReferenceSolutions(source: string): Finding[] {
  const { code } = lexSource(source);
  const findings: Finding[] = [];
  for (const m of code.matchAll(REFERENCE_SOLUTION)) {
    findings.push({ line: lineAt(code, m.index), rule: `R1 ${m[0]} (reference solution sources are staff-only)` });
  }
  return dedupe(findings);
}

// ── R2: hidden test bytes and checker sources ────────────────────────────

const TEST_BYTES_IDENTIFIERS: ReadonlyArray<[RegExp, string]> = [
  [/\btestBlobs?\b/g, "testBlob delegate"],
  [/\breadBlobBytes\b/g, "readBlobBytes"],
  [/\bgetTestDataStore\b/g, "getTestDataStore"],
  [/\bcheckerSha256\b/g, "checkerSha256 (checker source blob)"],
];
/** Quoted SQL identifiers that only test-data reads name. */
const TEST_BYTES_SQL = /"(TestBlob|inline|storageKey|checkerSha256)"/g;

/** R2: the test-data store, blob reads, the TestBlob table and checker sources. */
export function scanTestBytes(source: string): Finding[] {
  const { code, strings } = lexSource(source);
  const findings: Finding[] = [];
  for (const [pattern, rule] of TEST_BYTES_IDENTIFIERS) {
    for (const m of code.matchAll(pattern)) findings.push({ line: lineAt(code, m.index), rule: `R2 ${rule}` });
  }
  for (const s of strings) {
    for (const m of s.body.matchAll(TEST_BYTES_SQL)) {
      findings.push({ line: lineAt(code, s.start), rule: `R2 SQL names "${m[1]}"` });
    }
  }
  return dedupe(findings);
}

// ── R3: test-case queries select sample content only ─────────────────────

/** A testCase(s) query object (`testCase.findMany({…})` or a nested `testCases: {…}` select). */
const TEST_CASE_BLOCK = /\btestCases?\b\s*(?:\??\.\s*(\w+)\s*\(\s*|:\s*)(\{)?/g;
const CONTENT_KEY = /(?:^|[\s{,])(input|output)\s*:/;
const WHERE_KEY = /(?:^|[\s,])where\s*:/;
const SAMPLE_ONLY = /(?:^|[\s,])isSample\s*:\s*true\b/;
const READ_METHODS = new Set(["findMany", "findFirst", "findUnique", "findFirstOrThrow", "findUniqueOrThrow"]);

/**
 * The block's own entries: everything nested deeper than its outer braces
 * (objects, arrays, parentheses) is blanked, so `NOT: { isSample: true }`,
 * `OR: [...]` or `...(all ? {} : { isSample: true })` do not count.
 */
function topLevel(block: string): string {
  let depth = 0;
  let out = "";
  for (const c of block.split("")) {
    const opens = c === "{" || c === "[" || c === "(";
    const closes = c === "}" || c === "]" || c === ")";
    if (closes) depth--;
    out += depth === 1 && !opens && !closes ? c : c === "\n" ? "\n" : " ";
    if (opens) depth++;
  }
  return out;
}

/**
 * True when the block's own `where: { … }` (an object literal) has its own
 * `isSample: true` and no spread that could replace it.
 */
function filtersSampleOnly(block: string): boolean {
  const own = topLevel(block);
  const where = WHERE_KEY.exec(own);
  if (!where) return false;
  // `own` keeps offsets but blanks nested braces: find the value's "{" in the block itself.
  const value = /^\s*\{/.exec(block.slice(where.index + where[0].length));
  if (!value) return false;
  const whereBlock = braceBlock(block, where.index + where[0].length + value[0].length - 1);
  if (!whereBlock) return false;
  const entries = topLevel(whereBlock);
  return SAMPLE_ONLY.test(entries) && !entries.includes("...");
}

/**
 * R3: every testCase(s) query block that selects or includes the `input` /
 * `output` blob relation must filter `isSample: true` in its own `where`
 * object literal: not in `select`, not under NOT / OR / AND, not behind a
 * spread or a conditional. A read whose argument (or whose `where`) is not an
 * object literal cannot be checked and is flagged too.
 */
export function scanTestCaseQueries(source: string): Finding[] {
  const { code } = structuralCode(source);
  const findings: Finding[] = [];
  TEST_CASE_BLOCK.lastIndex = 0;
  for (const m of code.matchAll(TEST_CASE_BLOCK)) {
    const method = m[1];
    const line = lineAt(code, m.index);
    if (!m[2]) {
      if (method && READ_METHODS.has(method)) {
        findings.push({ line, rule: `R3 testCase.${method}() with a non-literal argument cannot be checked for isSample: true` });
      }
      continue;
    }
    const block = braceBlock(code, m.index + m[0].length - 1);
    if (!block) continue;
    if (CONTENT_KEY.test(block) && !filtersSampleOnly(block)) {
      findings.push({ line, rule: "R3 testCase query selects input/output without where: { isSample: true }" });
    }
  }
  return dedupe(findings);
}

// ── Server-action guards (R6) and route guards (R7) ──────────────────────

export const STAFF_ROLES = new Set(["TA_MENTOR", "ADMIN", "PLACEMENT_OFFICER", "SUPER_ADMIN"]);

export interface GuardCall {
  name: string;
  /** String-literal arguments (role names). */
  args: string[];
}

function calleeName(expression: ts.Expression): string | null {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  return null;
}

/** Module-level `const X = ["A", "B"] (as const)` string arrays, for resolving `g(...X)`. */
export function stringArrayConstants(file: ts.SourceFile): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const statement of file.statements) {
    if (!ts.isVariableStatement(statement) || !(statement.declarationList.flags & ts.NodeFlags.Const)) continue;
    for (const d of statement.declarationList.declarations) {
      let init = d.initializer;
      while (init && (ts.isAsExpression(init) || ts.isSatisfiesExpression(init) || ts.isParenthesizedExpression(init))) init = init.expression;
      if (ts.isIdentifier(d.name) && init && ts.isArrayLiteralExpression(init) && init.elements.every(ts.isStringLiteralLike)) {
        out.set(d.name.text, init.elements.map((e) => (e as ts.StringLiteralLike).text));
      }
    }
  }
  return out;
}

/** Placeholder for an argument the analyzer cannot read; never a staff role. */
export const UNKNOWN_ARG = "<unknown>";

/**
 * The call a statement awaits: `await g(…)`, `const x = await g(…)`,
 * `return await g(…)`. String-literal arguments are read, and `...X` is
 * expanded when X is a module-level string-array constant; anything else
 * becomes UNKNOWN_ARG.
 */
export function awaitedGuard(statement: ts.Statement | undefined, constants: ReadonlyMap<string, string[]> = new Map()): GuardCall | null {
  if (!statement) return null;
  let expression: ts.Expression | undefined;
  if (ts.isExpressionStatement(statement)) expression = statement.expression;
  else if (ts.isVariableStatement(statement)) {
    const declarations = statement.declarationList.declarations;
    if (declarations.length !== 1) return null;
    expression = declarations[0]!.initializer;
  } else if (ts.isReturnStatement(statement)) expression = statement.expression;
  if (!expression) return null;
  while (ts.isParenthesizedExpression(expression)) expression = expression.expression;
  if (!ts.isAwaitExpression(expression)) return null;
  let inner: ts.Expression = expression.expression;
  while (ts.isParenthesizedExpression(inner)) inner = inner.expression;
  if (!ts.isCallExpression(inner)) return null;
  const name = calleeName(inner.expression);
  if (!name) return null;
  const args = inner.arguments.flatMap((a) => {
    if (ts.isStringLiteralLike(a)) return [a.text];
    if (ts.isSpreadElement(a) && ts.isIdentifier(a.expression)) return constants.get(a.expression.text) ?? [UNKNOWN_ARG];
    return [UNKNOWN_ARG];
  });
  return { name, args };
}

/**
 * A guard that admits staff only: requireSuperAdmin(), requireActionRole(…)
 * naming at least one role and only staff roles (never STUDENT) with ADMIN
 * or SUPER_ADMIN among them, or a composite guard the caller has verified
 * starts with such a call.
 */
export function isStaffGuard(call: GuardCall | null, composite: ReadonlySet<string> = new Set()): boolean {
  if (!call) return false;
  if (call.name === "requireSuperAdmin") return true;
  if (composite.has(call.name)) return true;
  if (call.name !== "requireActionRole") return false;
  return (
    call.args.length > 0 &&
    call.args.every((r) => STAFF_ROLES.has(r)) &&
    (call.args.includes("ADMIN") || call.args.includes("SUPER_ADMIN"))
  );
}

export interface ActionExport {
  name: string;
  line: number;
  /** Exported async function whose body is `return runAction(async () => {…})`. */
  wrapped: boolean;
  /** The call the runAction callback's FIRST statement awaits (or the bare function's first statement). */
  firstGuard: GuardCall | null;
  isFunction: boolean;
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return (ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined)?.some((m) => m.kind === kind) ?? false;
}

function analyzeFunctionBody(
  body: ts.ConciseBody | undefined,
  constants: ReadonlyMap<string, string[]>,
): Pick<ActionExport, "wrapped" | "firstGuard"> {
  if (!body || !ts.isBlock(body)) return { wrapped: false, firstGuard: null };
  const first = body.statements[0];
  if (first && ts.isReturnStatement(first) && first.expression) {
    let call = first.expression;
    while (ts.isParenthesizedExpression(call)) call = call.expression;
    if (ts.isCallExpression(call) && calleeName(call.expression) === "runAction") {
      const [callback] = call.arguments;
      if (callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) && ts.isBlock(callback.body)) {
        return { wrapped: true, firstGuard: awaitedGuard(callback.body.statements[0], constants) };
      }
      return { wrapped: true, firstGuard: null };
    }
  }
  return { wrapped: false, firstGuard: awaitedGuard(first, constants) };
}

/** True when the file's first statement is the "use server" directive. */
export function isUseServerFile(source: string, fileName = "module.ts"): boolean {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const first = file.statements[0];
  return !!first && ts.isExpressionStatement(first) && ts.isStringLiteral(first.expression) && first.expression.text === "use server";
}

/** Lines of function-level "use server" directives (inline server actions). */
export function inlineUseServerLines(source: string, fileName = "module.tsx"): number[] {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const lines: number[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isBlock(node) && node.parent && ts.isFunctionLike(node.parent)) {
      const first = node.statements[0];
      if (first && ts.isExpressionStatement(first) && ts.isStringLiteral(first.expression) && first.expression.text === "use server") {
        lines.push(file.getLineAndCharacterOfPosition(first.getStart(file)).line + 1);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return lines;
}

/** Every export of a server-action module, with its runAction guard. */
export function analyzeActionExports(source: string, fileName = "action.ts"): ActionExport[] {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const line = (node: ts.Node) => file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
  const constants = stringArrayConstants(file);
  const out: ActionExport[] = [];
  for (const statement of file.statements) {
    if (ts.isFunctionDeclaration(statement) && hasModifier(statement, ts.SyntaxKind.ExportKeyword)) {
      out.push({ name: statement.name?.text ?? "default", line: line(statement), isFunction: true, ...analyzeFunctionBody(statement.body, constants) });
    } else if (ts.isVariableStatement(statement) && hasModifier(statement, ts.SyntaxKind.ExportKeyword)) {
      for (const d of statement.declarationList.declarations) {
        const name = ts.isIdentifier(d.name) ? d.name.text : "<pattern>";
        const init = d.initializer;
        if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) {
          out.push({ name, line: line(d), isFunction: true, ...analyzeFunctionBody(init.body, constants) });
        } else {
          out.push({ name, line: line(d), isFunction: false, wrapped: false, firstGuard: null });
        }
      }
    } else if (ts.isExportDeclaration(statement) && !statement.isTypeOnly) {
      out.push({ name: "<re-export>", line: line(statement), isFunction: false, wrapped: false, firstGuard: null });
    } else if (ts.isExportAssignment(statement)) {
      out.push({ name: "default", line: line(statement), isFunction: false, wrapped: false, firstGuard: null });
    }
  }
  return out;
}

/** The first statement of an exported function declaration's body, by name. */
export function exportedFunctionFirstGuard(source: string, exportName: string, fileName = "module.ts"): GuardCall | null | undefined {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  for (const statement of file.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name?.text === exportName && hasModifier(statement, ts.SyntaxKind.ExportKeyword)) {
      return awaitedGuard(statement.body?.statements[0], stringArrayConstants(file));
    }
  }
  return undefined;
}

/** Text of each exported function declaration of a module (route handlers). */
export function exportedFunctionBodies(source: string, fileName = "route.ts"): Map<string, string> {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const out = new Map<string, string>();
  for (const statement of file.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name && hasModifier(statement, ts.SyntaxKind.ExportKeyword)) {
      out.set(statement.name.text, statement.body?.getText(file) ?? "");
    } else if (ts.isVariableStatement(statement) && hasModifier(statement, ts.SyntaxKind.ExportKeyword)) {
      for (const d of statement.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && d.initializer && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))) {
          out.set(d.name.text, d.initializer.body.getText(file));
        }
      }
    }
  }
  return out;
}

const STAFF_GUARD_CALL = /\b(?:requireSuperAdmin\s*\(\s*\)|requireActionRole\s*\(([^)]*)\))/g;
const BODY_READ = /\b(?:request|req)\s*\.\s*(?:json|formData|text|arrayBuffer|blob|body)\b|\bspoolRequestBody\s*\(/;
const DB_ACCESS = /\b(?:db|tx)\s*\.\s*[A-Za-z$]/;

/**
 * R7: a route handler body calls a staff-only guard before it reads the
 * request body or touches the database.
 */
export function staffGuardBeforeBody(functionText: string): boolean {
  const { code } = lexSource(functionText);
  let guardAt = -1;
  for (const m of code.matchAll(STAFF_GUARD_CALL)) {
    if (m[0].startsWith("requireSuperAdmin")) {
      guardAt = m.index;
      break;
    }
    const roles = [...(m[1] ?? "").matchAll(/["'`](\w+)["'`]/g)].map((r) => r[1]!);
    if (isStaffGuard({ name: "requireActionRole", args: roles })) {
      guardAt = m.index;
      break;
    }
  }
  if (guardAt === -1) return false;
  const firstUse = [BODY_READ, DB_ACCESS]
    .map((p) => code.search(p))
    .filter((i) => i !== -1)
    .reduce((a, b) => Math.min(a, b), Number.POSITIVE_INFINITY);
  return guardAt < firstUse;
}

/** R8: the module's first statement is `import "server-only"`. */
export function startsWithServerOnly(source: string, fileName = "module.ts"): boolean {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const first = file.statements[0];
  return (
    !!first &&
    ts.isImportDeclaration(first) &&
    !first.importClause &&
    ts.isStringLiteralLike(first.moduleSpecifier) &&
    first.moduleSpecifier.text === "server-only"
  );
}
