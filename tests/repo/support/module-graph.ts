import path from "node:path";
import ts from "typescript";

/**
 * A static import graph over repository files, built with the TypeScript
 * compiler API (a real parse, not a regex), for the repository fences that
 * reason about "what can this entry point load" (tests/repo/student-exposure.test.ts).
 *
 * Edges are value imports only: `import type …`, `export type … from` and
 * imports whose every named binding is `type`-qualified are skipped, because
 * the compiler erases them and they load nothing at runtime. Side-effect
 * imports, re-exports, `import()` and `require()` with a literal specifier
 * all count. `import("x")` in a type position (`typeof import("x")`) is a
 * type and is skipped.
 *
 * Specifiers are resolved against an alias table (e.g. "@/" → "apps/web/src/")
 * and relative paths, trying the usual source extensions and index files.
 * Bare package specifiers are external and produce no edge.
 */

export interface ImportEdge {
  specifier: string;
  line: number;
  /** Erased by the compiler: loads nothing at runtime. */
  typeOnly: boolean;
}

export const RESOLVE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"] as const;

function scriptKind(fileName: string): ts.ScriptKind {
  if (fileName.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (fileName.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (/\.[cm]?js$/.test(fileName)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function namedBindingsAllTypes(bindings: ts.NamedImportBindings | ts.NamedExportBindings | undefined): boolean {
  if (!bindings) return false;
  if (ts.isNamedImports(bindings) || ts.isNamedExports(bindings)) {
    return bindings.elements.length > 0 && bindings.elements.every((e) => e.isTypeOnly);
  }
  return false; // namespace import / export * as ns
}

/** Every module reference in a source file, with whether it is erased at compile time. */
export function importEdges(source: string, fileName = "module.ts"): ImportEdge[] {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, scriptKind(fileName));
  const edges: ImportEdge[] = [];
  const line = (node: ts.Node) => file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;

  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
      const clause = node.importClause;
      const typeOnly =
        !!clause && (clause.isTypeOnly || (!clause.name && namedBindingsAllTypes(clause.namedBindings)));
      edges.push({ specifier: node.moduleSpecifier.text, line: line(node), typeOnly });
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
      const typeOnly = node.isTypeOnly || namedBindingsAllTypes(node.exportClause);
      edges.push({ specifier: node.moduleSpecifier.text, line: line(node), typeOnly });
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      ts.isStringLiteralLike(node.moduleReference.expression)
    ) {
      edges.push({ specifier: node.moduleReference.expression.text, line: line(node), typeOnly: node.isTypeOnly });
    } else if (ts.isCallExpression(node)) {
      const [arg] = node.arguments;
      const isImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire =
        (ts.isIdentifier(node.expression) && node.expression.text === "require") ||
        (ts.isPropertyAccessExpression(node.expression) &&
          ts.isIdentifier(node.expression.expression) &&
          node.expression.expression.text === "require" &&
          node.expression.name.text === "resolve");
      if ((isImport || isRequire) && arg && ts.isStringLiteralLike(arg)) {
        edges.push({ specifier: arg.text, line: line(node), typeOnly: false });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return edges;
}

export interface ResolveOptions {
  /** Specifier prefix → repo-relative directory prefix, e.g. { "@/": "apps/web/src/" }. */
  aliases: Readonly<Record<string, string>>;
  /** Repo-relative files that exist (posix separators). */
  files: ReadonlySet<string>;
}

/**
 * The repo-relative file a specifier refers to, or null for a bare package
 * specifier. Returns `undefined` when an aliased or relative specifier does
 * not resolve to any known file (a broken or unusual import — callers treat
 * it as a finding so the graph is never silently incomplete).
 */
export function resolveSpecifier(fromRel: string, specifier: string, options: ResolveOptions): string | null | undefined {
  let base: string | null = null;
  for (const [prefix, dir] of Object.entries(options.aliases)) {
    if (specifier.startsWith(prefix)) {
      base = `${dir}${specifier.slice(prefix.length)}`;
      break;
    }
  }
  if (base === null) {
    if (!specifier.startsWith("./") && !specifier.startsWith("../") && specifier !== "." && specifier !== "..") return null;
    base = path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), specifier));
  }
  base = base.replace(/\/+$/, "");
  const candidates = [
    base,
    ...RESOLVE_EXTENSIONS.map((ext) => `${base}${ext}`),
    // "./x.js" written for a .ts source (ESM-style specifiers)
    ...(/\.[cm]?js$/.test(base) ? RESOLVE_EXTENSIONS.map((ext) => base!.replace(/\.[cm]?js$/, ext)) : []),
    ...RESOLVE_EXTENSIONS.map((ext) => `${base}/index${ext}`),
  ];
  for (const candidate of candidates) if (options.files.has(candidate)) return candidate;
  return undefined;
}

export interface GraphEdge {
  target: string;
  specifier: string;
  line: number;
}

export interface UnresolvedImport {
  from: string;
  specifier: string;
  line: number;
}

/**
 * Lazily built import graph. `read(rel)` supplies file contents (tests pass
 * an in-memory map for self-tests, the real fence reads the checkout).
 */
export class ModuleGraph {
  private readonly cache = new Map<string, GraphEdge[]>();
  readonly unresolved: UnresolvedImport[] = [];

  constructor(
    private readonly options: ResolveOptions,
    private readonly read: (rel: string) => string,
  ) {}

  /** Value-import edges of one file (type-only imports and packages excluded). */
  edges(rel: string): GraphEdge[] {
    const cached = this.cache.get(rel);
    if (cached) return cached;
    const out: GraphEdge[] = [];
    const isCode = RESOLVE_EXTENSIONS.some((ext) => rel.endsWith(ext));
    if (isCode) {
      for (const edge of importEdges(this.read(rel), rel)) {
        if (edge.typeOnly) continue;
        const target = resolveSpecifier(rel, edge.specifier, this.options);
        if (target === null) continue;
        if (target === undefined) {
          this.unresolved.push({ from: rel, specifier: edge.specifier, line: edge.line });
          continue;
        }
        out.push({ target, specifier: edge.specifier, line: edge.line });
      }
    }
    this.cache.set(rel, out);
    return out;
  }

  /**
   * Every file reachable from `entry` (entry included), mapped to the file
   * that first imported it on a shortest path (null for the entry itself).
   */
  closure(entry: string): Map<string, string | null> {
    const parent = new Map<string, string | null>([[entry, null]]);
    const queue = [entry];
    for (let i = 0; i < queue.length; i++) {
      const rel = queue[i]!;
      for (const edge of this.edges(rel)) {
        if (parent.has(edge.target)) continue;
        parent.set(edge.target, rel);
        queue.push(edge.target);
      }
    }
    return parent;
  }

  /** The import chain entry → … → target, from a closure() result. */
  static chain(closure: Map<string, string | null>, target: string): string[] {
    const chain: string[] = [];
    let at: string | null | undefined = target;
    while (at) {
      chain.unshift(at);
      at = closure.get(at);
    }
    return chain;
  }
}
