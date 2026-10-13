import ts from "typescript";

/**
 * Static analysis of server-action files with the TypeScript compiler API
 * (a real parse, not a regex). Shared by tests/repo/action-guards.test.ts
 * and apps/web/test/capabilities.test.ts (imported there by relative path).
 *
 * For every exported function of a "use server" module it records whether
 * the function is async, whether its body is `return runAction(async () =>
 * { … }, "<name>")`, and the name of the guard the FIRST statement of that
 * callback awaits (`const x = await requireSuperAdmin();`, `await
 * requireActionUser();`, `const { a } = await requireAdminScopeAction();`).
 * A function that is not wrapped in runAction reports the guard awaited by
 * its own first statement instead.
 */

export interface AnalyzedExport {
  name: string;
  kind: "function" | "other";
  isAsync: boolean;
  /** The body is exactly `return runAction(async () => { … }, …)` as its first statement. */
  wrapped: boolean;
  /** The string literal passed as runAction's second argument, if any. */
  runActionName: string | null;
  /** Callee awaited by the first statement (inside runAction when wrapped). */
  firstGuard: string | null;
  /** The first statement's guard call with its role arguments resolved (see guardCallOf). */
  guard: GuardCall | null;
  line: number;
}

/**
 * A guard call and its arguments as written: each string literal, each
 * `...NAME` spread of a top-level `const NAME = ["A", "B"] as const` in the
 * same file, expanded. An argument that is neither is `null` (unresolvable),
 * so a role check never guesses.
 */
export interface GuardCall {
  name: string;
  args: Array<string | null>;
}

export interface AnalyzedFile {
  useServer: boolean;
  exports: AnalyzedExport[];
}

function hasExportModifier(node: ts.Node): boolean {
  return (ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined)?.some(
    (m) => m.kind === ts.SyntaxKind.ExportKeyword,
  ) ?? false;
}

function hasAsyncModifier(node: ts.Node): boolean {
  return (ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined)?.some(
    (m) => m.kind === ts.SyntaxKind.AsyncKeyword,
  ) ?? false;
}

function calleeName(expression: ts.Expression): string | null {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  return null;
}

/** The call awaited by a statement: `await g()`, `const x = await g()`, `return await g()`. */
function awaitedCallExpression(statement: ts.Statement | undefined): ts.CallExpression | null {
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
  return ts.isCallExpression(inner) ? inner : null;
}

/** The function awaited by a statement: `await g()`, `const x = await g()`, `return await g()`. */
export function awaitedCall(statement: ts.Statement | undefined): string | null {
  const call = awaitedCallExpression(statement);
  return call ? calleeName(call.expression) : null;
}

/** Top-level `const NAME = ["A", "B"]` (optionally `as const`) string-array constants of a file. */
export function stringArrayConstants(file: ts.SourceFile): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const statement of file.statements) {
    if (!ts.isVariableStatement(statement) || !(statement.declarationList.flags & ts.NodeFlags.Const)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
      let init: ts.Expression = declaration.initializer;
      while (ts.isAsExpression(init) || ts.isSatisfiesExpression(init) || ts.isParenthesizedExpression(init)) {
        init = init.expression;
      }
      if (!ts.isArrayLiteralExpression(init)) continue;
      if (!init.elements.every((e) => ts.isStringLiteralLike(e))) continue;
      out.set(declaration.name.text, init.elements.map((e) => (e as ts.StringLiteralLike).text));
    }
  }
  return out;
}

function guardCallFrom(call: ts.CallExpression, constants: ReadonlyMap<string, string[]>): GuardCall | null {
  const name = calleeName(call.expression);
  if (!name) return null;
  const args: Array<string | null> = [];
  for (const arg of call.arguments) {
    if (ts.isStringLiteralLike(arg)) args.push(arg.text);
    else if (ts.isSpreadElement(arg) && ts.isIdentifier(arg.expression) && constants.has(arg.expression.text)) {
      args.push(...constants.get(arg.expression.text)!);
    } else args.push(null);
  }
  return { name, args };
}

/**
 * The guard call a statement makes: `await g(…)`, `const x = await g(…)`,
 * `return await g(…)` or `return g(…)` (a composite guard delegating).
 */
export function guardCallOf(
  statement: ts.Statement | undefined,
  constants: ReadonlyMap<string, string[]> = new Map(),
): GuardCall | null {
  if (!statement) return null;
  const awaited = awaitedCallExpression(statement);
  if (awaited) return guardCallFrom(awaited, constants);
  if (ts.isReturnStatement(statement) && statement.expression) {
    let expression: ts.Expression = statement.expression;
    while (ts.isParenthesizedExpression(expression)) expression = expression.expression;
    if (ts.isCallExpression(expression)) return guardCallFrom(expression, constants);
  }
  return null;
}

type BodyAnalysis = Pick<AnalyzedExport, "wrapped" | "runActionName" | "firstGuard" | "guard">;

function analyzeBody(body: ts.Block | undefined, constants: ReadonlyMap<string, string[]>): BodyAnalysis {
  const first = body?.statements[0];
  if (first && ts.isReturnStatement(first) && first.expression) {
    let call = first.expression;
    while (ts.isParenthesizedExpression(call)) call = call.expression;
    if (ts.isCallExpression(call) && calleeName(call.expression) === "runAction") {
      const [callback, label] = call.arguments;
      const runActionName = label && ts.isStringLiteralLike(label) ? label.text : null;
      if (
        callback &&
        (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) &&
        hasAsyncModifier(callback) &&
        ts.isBlock(callback.body)
      ) {
        const statement = callback.body.statements[0];
        const firstGuard = awaitedCall(statement);
        return { wrapped: true, runActionName, firstGuard, guard: firstGuard ? guardCallOf(statement, constants) : null };
      }
      return { wrapped: true, runActionName, firstGuard: null, guard: null };
    }
  }
  const firstGuard = awaitedCall(first);
  return { wrapped: false, runActionName: null, firstGuard, guard: firstGuard ? guardCallOf(first, constants) : null };
}

const NOT_A_FUNCTION = {
  kind: "other",
  isAsync: false,
  wrapped: false,
  runActionName: null,
  firstGuard: null,
  guard: null,
} as const;

export function analyzeActionSource(source: string, fileName = "action.ts"): AnalyzedFile {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const constants = stringArrayConstants(file);
  const firstStatement = file.statements[0];
  const useServer =
    !!firstStatement &&
    ts.isExpressionStatement(firstStatement) &&
    ts.isStringLiteral(firstStatement.expression) &&
    firstStatement.expression.text === "use server";
  const exports: AnalyzedExport[] = [];
  const line = (node: ts.Node) => file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;

  for (const statement of file.statements) {
    if (ts.isFunctionDeclaration(statement) && hasExportModifier(statement) && statement.name) {
      exports.push({
        name: statement.name.text,
        kind: "function",
        isAsync: hasAsyncModifier(statement),
        ...analyzeBody(statement.body, constants),
        line: line(statement),
      });
    } else if (ts.isVariableStatement(statement) && hasExportModifier(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        const init = declaration.initializer;
        const name = ts.isIdentifier(declaration.name) ? declaration.name.text : "<pattern>";
        if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) {
          exports.push({
            name,
            kind: "function",
            isAsync: hasAsyncModifier(init),
            ...(ts.isBlock(init.body)
              ? analyzeBody(init.body, constants)
              : { wrapped: false, runActionName: null, firstGuard: null, guard: null }),
            line: line(declaration),
          });
        } else {
          exports.push({ name, ...NOT_A_FUNCTION, line: line(declaration) });
        }
      }
    } else if (ts.isExportDeclaration(statement) && !statement.isTypeOnly) {
      // `export { x }` / `export * from`: re-exports hide the guard; flag them.
      exports.push({ name: "<re-export>", ...NOT_A_FUNCTION, line: line(statement) });
    } else if (ts.isExportAssignment(statement)) {
      exports.push({ name: "default", ...NOT_A_FUNCTION, line: line(statement) });
    }
  }
  return { useServer, exports };
}

function exportedFunction(file: ts.SourceFile, name: string): ts.FunctionDeclaration | null {
  for (const statement of file.statements) {
    if (!ts.isFunctionDeclaration(statement) || !hasExportModifier(statement)) continue;
    const isDefault = (ts.getModifiers(statement) ?? []).some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);
    if (name === "default" ? isDefault : statement.name?.text === name) return statement;
  }
  return null;
}

function parseModule(source: string, fileName: string): ts.SourceFile {
  const kind = /\.tsx$/.test(fileName) ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  return ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, kind);
}

/**
 * The guard call made by the FIRST statement of an exported function
 * declaration of a module (`name` is the export's name, or "default" for
 * `export default function`). Used for pages and layouts, whose first
 * statement must be the guard. Null when the function is missing or its
 * first statement calls nothing.
 */
export function firstStatementGuard(source: string, fileName: string, name: string): GuardCall | null {
  const file = parseModule(source, fileName);
  const fn = exportedFunction(file, name);
  return fn ? guardCallOf(fn.body?.statements[0], stringArrayConstants(file)) : null;
}

/**
 * The first call, in source order, to one of `guards` anywhere inside an
 * exported function declaration (a route handler wraps its guard in
 * try/catch, after a same-origin check). Pair it with guardBeforeDb().
 */
export function firstGuardCallIn(
  source: string,
  fileName: string,
  name: string,
  guards: ReadonlySet<string>,
): GuardCall | null {
  const file = parseModule(source, fileName);
  const fn = exportedFunction(file, name);
  if (!fn?.body) return null;
  const constants = stringArrayConstants(file);
  let found: GuardCall | null = null;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isCallExpression(node)) {
      const callee = calleeName(node.expression);
      if (callee && guards.has(callee)) {
        found = guardCallFrom(node, constants);
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(fn.body);
  return found;
}

/**
 * Which roles a guard call admits, derived from the guard modules' SOURCE:
 *
 *   - base guards: `requireActionUser()` / `requireUser()` admit every role
 *     (any signed-in user); `requireActionRole(...roles)` /
 *     `requirePageRole(...roles)` admit exactly their literal arguments;
 *   - any other guard is a composite: an exported function of one of the
 *     definition sources whose FIRST statement is another guard call
 *     (`return requireActionRole("SUPER_ADMIN")`, `const user = await
 *     requirePageRole("ADMIN", "SUPER_ADMIN")`), resolved recursively.
 *
 * Returns the sorted role list, or null when it cannot be resolved (an
 * unknown guard, a non-literal argument, a composite that forwards its own
 * parameters). Null never equals a declared role set.
 */
export function createGuardRoleResolver(
  allRoles: readonly string[],
  definitions: ReadonlyArray<{ source: string; fileName: string }>,
): (call: GuardCall | null) => string[] | null {
  const everyone = new Set(["requireActionUser", "requireUser"]);
  const byArgs = new Set(["requireActionRole", "requirePageRole"]);
  const composites = new Map<string, GuardCall | null>();
  for (const { source, fileName } of definitions) {
    const file = parseModule(source, fileName);
    const constants = stringArrayConstants(file);
    for (const statement of file.statements) {
      if (ts.isFunctionDeclaration(statement) && hasExportModifier(statement) && statement.name) {
        composites.set(statement.name.text, guardCallOf(statement.body?.statements[0], constants));
      }
    }
  }
  const resolve = (call: GuardCall | null, depth: number): string[] | null => {
    if (!call || depth > 8) return null;
    if (everyone.has(call.name)) return call.args.length === 0 ? [...allRoles].sort() : null;
    if (byArgs.has(call.name)) {
      if (call.args.length === 0 || call.args.some((a) => a === null || !allRoles.includes(a))) return null;
      return [...new Set(call.args as string[])].sort();
    }
    if (!composites.has(call.name) || call.args.length > 0) return null;
    return resolve(composites.get(call.name) ?? null, depth + 1);
  };
  return (call) => resolve(call, 0);
}

/**
 * Exported functions of a route module (`export async function GET(…)`)
 * and whether `requireSuperAdmin(` (or another guard) is called before the
 * first database access (`db.` / `tx.`) in that function's text.
 */
export function guardBeforeDb(functionText: string, guard: string): boolean {
  const code = functionText.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
  const guardAt = code.indexOf(`${guard}(`);
  if (guardAt === -1) return false;
  const dbAt = code.search(/\b(?:db|tx)\s*\.\s*[A-Za-z$]/);
  return dbAt === -1 || guardAt < dbAt;
}

/** The source text of each exported function declaration in a module. */
export function exportedFunctionTexts(source: string, fileName = "module.ts"): Map<string, string> {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const out = new Map<string, string>();
  for (const statement of file.statements) {
    if (ts.isFunctionDeclaration(statement) && hasExportModifier(statement) && statement.name) {
      out.set(statement.name.text, statement.getText(file));
    }
  }
  return out;
}

/** The source text of one exported function declaration ("default" for `export default function`), .ts or .tsx. */
export function exportedFunctionText(source: string, fileName: string, name: string): string | null {
  const file = parseModule(source, fileName);
  return exportedFunction(file, name)?.getText(file) ?? null;
}
