import { z } from "zod";

/**
 * FUNCTION-mode type grammar (closed):
 *   int | long | double | bool | char | string | list<T> | matrix<T>
 *   | pair<A,B> | TreeNode | ListNode | void
 *
 * Values are serialised LeetCode-style, one parameter per input line, as
 * JSON (trees in level order with nulls). The harness templates that read
 * and write this format live in this directory — in the repository, never in
 * the database — so a harness bug is fixed by a deploy and a rejudge.
 */
export type TypeNode =
  | { kind: "int" }
  | { kind: "long" }
  | { kind: "double" }
  | { kind: "bool" }
  | { kind: "char" }
  | { kind: "string" }
  | { kind: "void" }
  | { kind: "TreeNode" }
  | { kind: "ListNode" }
  | { kind: "list"; of: TypeNode }
  | { kind: "matrix"; of: TypeNode }
  | { kind: "pair"; a: TypeNode; b: TypeNode };

const SCALARS = ["int", "long", "double", "bool", "char", "string", "void", "TreeNode", "ListNode"] as const;

export class TypeParseError extends Error {}

/** Parse a type expression such as "list<pair<int,string>>". */
export function parseType(source: string): TypeNode {
  const text = source.replace(/\s+/g, "");
  let pos = 0;

  function ident(): string {
    const m = /^[A-Za-z]+/.exec(text.slice(pos));
    if (!m) throw new TypeParseError(`Expected a type name at position ${pos} in "${source}".`);
    pos += m[0].length;
    return m[0];
  }
  function expect(ch: string) {
    if (text[pos] !== ch) throw new TypeParseError(`Expected "${ch}" at position ${pos} in "${source}".`);
    pos += 1;
  }
  function node(): TypeNode {
    const name = ident();
    if ((SCALARS as readonly string[]).includes(name)) {
      return { kind: name as (typeof SCALARS)[number] } as TypeNode;
    }
    if (name === "list" || name === "matrix") {
      expect("<");
      const of = node();
      expect(">");
      if (of.kind === "void") throw new TypeParseError(`${name}<void> is not a type.`);
      return { kind: name, of };
    }
    if (name === "pair") {
      expect("<");
      const a = node();
      expect(",");
      const b = node();
      expect(">");
      if (a.kind === "void" || b.kind === "void") throw new TypeParseError("pair<…void…> is not a type.");
      return { kind: "pair", a, b };
    }
    throw new TypeParseError(`Unknown type "${name}" in "${source}".`);
  }

  const result = node();
  if (pos !== text.length) throw new TypeParseError(`Unexpected trailing text in "${source}".`);
  return result;
}

export function typeToString(t: TypeNode): string {
  switch (t.kind) {
    case "list":
    case "matrix":
      return `${t.kind}<${typeToString(t.of)}>`;
    case "pair":
      return `pair<${typeToString(t.a)},${typeToString(t.b)}>`;
    default:
      return t.kind;
  }
}

function isValidType(s: string) {
  try {
    parseType(s);
    return true;
  } catch {
    return false;
  }
}

const identifier = z
  .string()
  .max(64, "Names are at most 64 characters.")
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "Must be a valid identifier.");

export const FUNCTION_COMPARATORS = [
  "EXACT",
  "FLOAT_TOLERANCE",
  "SET_EQUAL",
  "ROWS_ANY_ORDER",
  "IN_PLACE_MUTATION",
  "CUSTOM_CHECKER",
] as const;
export type FunctionComparator = (typeof FUNCTION_COMPARATORS)[number];

/** Parameter kinds a method can change in place so that the caller sees it, in C++, Python and Java alike. */
export const IN_PLACE_PARAM_KINDS = ["list", "matrix", "TreeNode", "ListNode"] as const;

/**
 * Names a parameter or the method may not use: the keywords of every harness
 * language (C++, Python, Java), the names the harness itself declares, and a
 * few C library macros that would break the generated C++.
 */
export const RESERVED_IDENTIFIERS: ReadonlySet<string> = new Set([
  // C++
  "alignas", "alignof", "and", "and_eq", "asm", "auto", "bitand", "bitor", "bool", "break", "case", "catch",
  "char", "char8_t", "char16_t", "char32_t", "class", "compl", "concept", "const", "consteval", "constexpr",
  "constinit", "const_cast", "continue", "co_await", "co_return", "co_yield", "decltype", "default", "delete",
  "do", "double", "dynamic_cast", "else", "enum", "explicit", "export", "extern", "false", "final", "float",
  "for", "friend", "goto", "if", "import", "inline", "int", "long", "module", "mutable", "namespace", "new",
  "noexcept", "not", "not_eq", "nullptr", "operator", "or", "or_eq", "override", "private", "protected",
  "public", "register", "reinterpret_cast", "requires", "return", "short", "signed", "sizeof", "static",
  "static_assert", "static_cast", "struct", "switch", "template", "this", "thread_local", "throw", "true",
  "try", "typedef", "typeid", "typename", "union", "unsigned", "using", "virtual", "void", "volatile",
  "wchar_t", "while", "xor", "xor_eq", "NULL", "EOF", "errno",
  // Python
  "False", "None", "True", "as", "assert", "async", "await", "def", "del", "elif", "except", "finally",
  "from", "global", "in", "is", "lambda", "nonlocal", "pass", "raise", "with", "yield", "self",
  // Java
  "abstract", "boolean", "byte", "extends", "implements", "instanceof", "interface", "native", "package",
  "strictfp", "super", "synchronized", "throws", "transient", "var", "record", "sealed", "permits", "yield",
  "_",
  // The harness's own names
  "main", "Main", "Solution", "ListNode", "TreeNode", "Pair", "RecxIn", "RecxOut",
]);

/** java.lang.Object methods a Solution method must not hide or clash with. */
const RESERVED_METHOD_NAMES: ReadonlySet<string> = new Set([
  "equals", "hashCode", "toString", "getClass", "notify", "notifyAll", "wait", "clone", "finalize",
]);

/** Reserved: a listed name, a C++ reserved spelling (__x, _X) or the harness prefix recx. */
export function isReservedIdentifier(name: string): boolean {
  return RESERVED_IDENTIFIERS.has(name) || /^__|^_[A-Z]/.test(name) || /^_?recx/i.test(name);
}

/** True when a double appears anywhere in the type. */
export function containsDouble(t: TypeNode): boolean {
  switch (t.kind) {
    case "double":
      return true;
    case "list":
    case "matrix":
      return containsDouble(t.of);
    case "pair":
      return containsDouble(t.a) || containsDouble(t.b);
    default:
      return false;
  }
}

/** The type the comparator compares: the mutated parameter's under IN_PLACE_MUTATION, else the return type. */
export function comparedTypeOf(sig: Pick<FunctionSignature, "comparator" | "mutatedParam" | "params" | "returns">): TypeNode {
  if (sig.comparator === "IN_PLACE_MUTATION") {
    const param = sig.params.find((p) => p.name === sig.mutatedParam);
    if (param) return parseType(param.type);
  }
  return parseType(sig.returns);
}

/**
 * The ProblemVersion.compareMode a FUNCTION version must carry: CHECKER for
 * CUSTOM_CHECKER (the checker runs in its own box), otherwise TOKEN by
 * convention — the judge compares FUNCTION output structurally and ignores
 * it. Enforced by the publish gate and a CHECK constraint.
 */
export function functionCompareMode(comparator: FunctionComparator): "CHECKER" | "TOKEN" {
  return comparator === "CUSTOM_CHECKER" ? "CHECKER" : "TOKEN";
}

/** Plain-language comparator copy: `student` for the workspace, `author` for authoring and /judge. */
export const FUNCTION_COMPARATOR_DESCRIPTIONS: Readonly<
  Record<FunctionComparator, { label: string; student: string; author: string }>
> = {
  EXACT: {
    label: "Exact match",
    student: "Your return value must match the expected answer exactly: same values, same order.",
    author: "Structural equality after a strict, type-directed decode. Not allowed when the compared type contains a double.",
  },
  FLOAT_TOLERANCE: {
    label: "Within a tolerance",
    student:
      "Decimal numbers are accepted within a small absolute or relative error (the problem states it, 10⁻⁶ by default); everything else must match exactly.",
    author:
      "Structure must match exactly; double values match within the absolute or relative epsilon (floatEpsilon, default 1e-6). The compared type must contain a double.",
  },
  SET_EQUAL: {
    label: "Any order",
    student: "The order of the elements does not matter — at any depth — but every element must be there, as many times as expected.",
    author:
      "Multiset equality with order ignored at every list and matrix level; pairs keep their order; strings, trees and linked lists compare exactly. The compared type must be a list or a matrix, without doubles.",
  },
  ROWS_ANY_ORDER: {
    label: "Rows in any order",
    student: "The rows may come in any order, but each row must match exactly, in its own order.",
    author:
      "Top-level order ignored (a multiset of rows); each row compared exactly. The compared type must be a matrix, or a list of lists or pairs, without doubles.",
  },
  IN_PLACE_MUTATION: {
    label: "Changed in place",
    student: "Your method returns nothing: the judge prints the parameter it names after your method returns, so change it in place.",
    author:
      "The method returns void; the named parameter (a list, matrix, TreeNode or ListNode) is compared exactly after the call. A parameter reassigned inside the method is invisible to the caller.",
  },
  CUSTOM_CHECKER: {
    label: "Any correct answer",
    student: "Several answers can be correct: a checker program accepts any valid one.",
    author:
      "The output is decoded strictly (malformed output is Wrong Answer without running the checker), re-serialised canonically and judged by the version's testlib checker. compareMode must be CHECKER.",
  },
};

/** Why a comparator cannot judge a compared type, or null when it can. */
export function comparatorTypeIssue(sig: Pick<FunctionSignature, "comparator" | "mutatedParam" | "params" | "returns">): string | null {
  const returns = parseType(sig.returns);
  const t = comparedTypeOf(sig);
  const name = typeToString(t);
  switch (sig.comparator) {
    case "EXACT":
      return containsDouble(t)
        ? `EXACT cannot compare ${name}: it contains a double. Use FLOAT_TOLERANCE or CUSTOM_CHECKER.`
        : null;
    case "FLOAT_TOLERANCE":
      return containsDouble(t) ? null : `FLOAT_TOLERANCE needs a double in the compared type; ${name} has none. Use EXACT.`;
    case "SET_EQUAL":
      if (t.kind !== "list" && t.kind !== "matrix") return `SET_EQUAL compares a list or a matrix, not ${name}.`;
      return containsDouble(t) ? `SET_EQUAL cannot compare ${name}: it contains a double.` : null;
    case "ROWS_ANY_ORDER": {
      const rows = t.kind === "matrix" || (t.kind === "list" && (t.of.kind === "list" || t.of.kind === "pair"));
      if (!rows) return `ROWS_ANY_ORDER compares a matrix or a list of lists or pairs, not ${name}.`;
      return containsDouble(t) ? `ROWS_ANY_ORDER cannot compare ${name}: it contains a double.` : null;
    }
    case "IN_PLACE_MUTATION":
      if (returns.kind !== "void") return "IN_PLACE_MUTATION needs a void method: the judge prints the parameter, not a return value.";
      if (!(IN_PLACE_PARAM_KINDS as readonly string[]).includes(t.kind)) {
        return `IN_PLACE_MUTATION needs a list, matrix, TreeNode or ListNode parameter; ${name} cannot be changed in place in every language.`;
      }
      return containsDouble(t) ? `IN_PLACE_MUTATION cannot compare ${name}: it contains a double.` : null;
    case "CUSTOM_CHECKER":
      return null;
  }
}

export const functionSignatureSchema = z
  .object({
    className: z.literal("Solution"),
    methodName: identifier,
    params: z
      .array(
        z.object({
          name: identifier,
          type: z.string().max(200).refine(isValidType, "Unknown parameter type."),
        }),
      )
      .max(8),
    returns: z.string().max(200).refine(isValidType, "Unknown return type."),
    /** A problem cannot publish without a declared comparator. */
    comparator: z.enum(FUNCTION_COMPARATORS),
    /** IN_PLACE_MUTATION: which parameter to print after the call. */
    mutatedParam: identifier.nullable().default(null),
  })
  .superRefine((sig, ctx) => {
    const issue = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message });
    if (isReservedIdentifier(sig.methodName) || RESERVED_METHOD_NAMES.has(sig.methodName)) {
      issue(`The method cannot be named "${sig.methodName}": the name is reserved.`);
    }
    const seen = new Set<string>();
    for (const p of sig.params) {
      if (seen.has(p.name)) issue(`Parameter "${p.name}" is declared twice.`);
      seen.add(p.name);
      if (isReservedIdentifier(p.name)) issue(`A parameter cannot be named "${p.name}": the name is reserved.`);
    }
    // zod still runs superRefine after a field-level refine failed; the
    // field issue is already recorded, so bail out instead of throwing.
    if (!isValidType(sig.returns) || sig.params.some((p) => !isValidType(p.type))) return;
    for (const p of sig.params) {
      if (parseType(p.type).kind === "void") issue(`Parameter ${p.name} cannot be void.`);
    }
    if (sig.comparator === "IN_PLACE_MUTATION") {
      if (!sig.mutatedParam || !sig.params.some((p) => p.name === sig.mutatedParam)) {
        issue("IN_PLACE_MUTATION needs mutatedParam naming one of the parameters.");
        return;
      }
    } else {
      if (sig.mutatedParam !== null) issue("mutatedParam is only used by the IN_PLACE_MUTATION comparator; set it to null.");
      if (parseType(sig.returns).kind === "void") {
        issue("A void method needs the IN_PLACE_MUTATION comparator.");
        return;
      }
    }
    const fit = comparatorTypeIssue(sig);
    if (fit) issue(fit);
  });

export type FunctionSignature = z.infer<typeof functionSignatureSchema>;
