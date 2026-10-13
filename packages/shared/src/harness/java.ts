import { inPlaceNote, nodeNotes, usesKind } from "./cpp";
import { parseType, typeToString, type FunctionSignature, type TypeNode } from "./signature";

/**
 * The Java 21 FUNCTION harness. The program is one compilation unit,
 * Main.java:
 *
 *   lines 1-5   five import lines (java.util.*, java.util.function.*,
 *               java.util.stream.*, java.io.*, java.math.*) and nothing else,
 *               so the student's own import lines stay legal;
 *   line 6…     the student's code, verbatim (class Solution, not public);
 *   after it    ListNode / TreeNode / Pair (only when the signature uses
 *               them), a small JSON reader (RecxIn) and writer (RecxOut),
 *               and `public class Main` with one typed reader rN and writer
 *               wN per distinct type, and main().
 *
 * The driver spells every library type fully qualified (java.util.List…),
 * so a student's `import java.awt.*;` cannot make a name ambiguous. It calls
 * the method through a typed local (`int[] result = sol.twoSum(a0, a1);`),
 * so a wrong return type is a compile error that remapDiagnostics() labels
 * as the judge's code plus a hint. A null TreeNode / ListNode is written as
 * []; any other null as null, which the comparator rejects.
 */

const SCALAR_KINDS = new Set(["int", "long", "double", "bool", "char", "string"]);
const NODE_KINDS = new Set(["TreeNode", "ListNode"]);
const isScalar = (t: TypeNode) => SCALAR_KINDS.has(t.kind);
const isLeaf = (t: TypeNode) => SCALAR_KINDS.has(t.kind) || NODE_KINDS.has(t.kind);

const PRIMITIVE: Record<string, string> = {
  int: "int",
  long: "long",
  double: "double",
  bool: "boolean",
  char: "char",
  string: "String",
  void: "void",
  TreeNode: "TreeNode",
  ListNode: "ListNode",
};
const BOXED: Record<string, string> = {
  int: "Integer",
  long: "Long",
  double: "Double",
  bool: "Boolean",
  char: "Character",
  string: "String",
  TreeNode: "TreeNode",
  ListNode: "ListNode",
};

/** The Java type inside generics: everything boxed, lists as List. */
function boxed(t: TypeNode, q: string): string {
  switch (t.kind) {
    case "list":
      return `${q}List<${boxed(t.of, q)}>`;
    case "matrix":
      return `${q}List<${q}List<${boxed(t.of, q)}>>`;
    case "pair":
      return `Pair<${boxed(t.a, q)}, ${boxed(t.b, q)}>`;
    default:
      return BOXED[t.kind]!;
  }
}

function spelled(t: TypeNode, q: string): string {
  switch (t.kind) {
    case "list":
      return isLeaf(t.of) ? `${PRIMITIVE[t.of.kind]}[]` : `${q}List<${boxed(t.of, q)}>`;
    case "matrix":
      return isLeaf(t.of) ? `${PRIMITIVE[t.of.kind]}[][]` : `${q}List<${q}List<${boxed(t.of, q)}>>`;
    case "pair":
      return `Pair<${boxed(t.a, q)}, ${boxed(t.b, q)}>`;
    default:
      return PRIMITIVE[t.kind]!;
  }
}

/**
 * Java spelling of a grammar type, as a student writes it: int → int,
 * long → long, bool → boolean, string → String; list<S> → S[] and
 * matrix<S> → S[][] for a scalar or node S; any other list → List<…>;
 * pair<A,B> → Pair<A,B> (boxed). Inside generics everything is boxed.
 */
export function javaType(t: TypeNode): string {
  return spelled(t, "");
}

const J = "java.util.";

/** Lines placed before the student's code: exactly five import lines. */
export function javaPrelude(_sig: FunctionSignature): string {
  return ["import java.util.*;", "import java.util.function.*;", "import java.util.stream.*;", "import java.io.*;", "import java.math.*;"].join("\n") + "\n";
}

const LIST_NODE_CLASS = `class ListNode {
    int val;
    ListNode next;
    ListNode() {}
    ListNode(int val) { this.val = val; }
    ListNode(int val, ListNode next) { this.val = val; this.next = next; }
}`;
const TREE_NODE_CLASS = `class TreeNode {
    int val;
    TreeNode left;
    TreeNode right;
    TreeNode() {}
    TreeNode(int val) { this.val = val; }
    TreeNode(int val, TreeNode left, TreeNode right) { this.val = val; this.left = left; this.right = right; }
}`;
const PAIR_RECORD = "record Pair<A, B>(A first, B second) {}";

const RECX_IN = String.raw`final class RecxIn {
    private final String s; private int p;
    RecxIn(String s) { this.s = s; }
    static RuntimeException fail(String what) {
        System.err.println("harness: malformed input (" + what + ")");
        System.exit(3);
        return new IllegalStateException(what);
    }
    void ws() { while (p < s.length()) { char c = s.charAt(p); if (c == ' ' || c == '\t' || c == '\r' || c == '\n') p++; else break; } }
    boolean peek(char c) { ws(); return p < s.length() && s.charAt(p) == c; }
    void expect(char c) { ws(); if (p >= s.length() || s.charAt(p) != c) throw fail("unexpected character"); p++; }
    boolean tryNull() { ws(); if (s.startsWith("null", p)) { p += 4; return true; } return false; }
    void end() { ws(); if (p != s.length()) throw fail("unexpected text after the value"); }
    long integer() {
        ws(); int st = p;
        if (p < s.length() && (s.charAt(p) == '-' || s.charAt(p) == '+')) p++;
        while (p < s.length() && s.charAt(p) >= '0' && s.charAt(p) <= '9') p++;
        if (st == p) throw fail("expected integer");
        try { return Long.parseLong(s.substring(st, p)); } catch (NumberFormatException e) { throw fail("expected integer"); }
    }
    double real() {
        ws(); int st = p;
        while (p < s.length() && "0123456789+-.eE".indexOf(s.charAt(p)) >= 0) p++;
        if (st == p) throw fail("expected number");
        try { return Double.parseDouble(s.substring(st, p)); } catch (NumberFormatException e) { throw fail("expected number"); }
    }
    boolean bool() {
        ws();
        if (s.startsWith("true", p)) { p += 4; return true; }
        if (s.startsWith("false", p)) { p += 5; return false; }
        throw fail("expected bool");
    }
    String str() {
        expect('"'); StringBuilder out = new StringBuilder();
        while (p < s.length() && s.charAt(p) != '"') {
            char c = s.charAt(p++);
            if (c != '\\') { out.append(c); continue; }
            if (p >= s.length()) throw fail("bad escape");
            char e = s.charAt(p++);
            switch (e) {
                case 'n' -> out.append('\n');
                case 't' -> out.append('\t');
                case 'r' -> out.append('\r');
                case 'b' -> out.append('\b');
                case 'f' -> out.append('\f');
                case '/' -> out.append('/');
                case '\\' -> out.append('\\');
                case '"' -> out.append('"');
                case 'u' -> {
                    if (p + 4 > s.length()) throw fail("bad escape");
                    try { out.append((char) Integer.parseInt(s.substring(p, p + 4), 16)); } catch (NumberFormatException x) { throw fail("bad escape"); }
                    p += 4;
                }
                default -> throw fail("bad escape");
            }
        }
        expect('"'); return out.toString();
    }
}`;

const RECX_OUT = String.raw`final class RecxOut {
    final StringBuilder b = new StringBuilder();
    void raw(String t) { b.append(t); }
    void integer(long v) { b.append(v); }
    void real(double v) { b.append(Double.toString(v)); }
    void bool(boolean v) { b.append(v ? "true" : "false"); }
    void str(String v) {
        b.append('"');
        for (int i = 0; i < v.length(); i++) {
            char c = v.charAt(i);
            switch (c) {
                case '"' -> b.append("\\\"");
                case '\\' -> b.append("\\\\");
                case '\n' -> b.append("\\n");
                case '\t' -> b.append("\\t");
                case '\r' -> b.append("\\r");
                case '\b' -> b.append("\\b");
                case '\f' -> b.append("\\f");
                default -> { if (c < 0x20) b.append(String.format("\\u%04x", (int) c)); else b.append(c); }
            }
        }
        b.append('"');
    }
}`;

/** Generates the typed readers and writers of Main, one per distinct (type, context). */
class Codegen {
  readonly methods: string[] = [];
  private readonly readers = new Map<string, string>();
  private readonly writers = new Map<string, string>();

  /** `boxedCtx`: the value lives inside generics (Integer, List…). */
  javaOf(t: TypeNode, boxedCtx: boolean): string {
    return boxedCtx ? boxed(t, J) : spelled(t, J);
  }

  reader(t: TypeNode, boxedCtx: boolean): string {
    // Scalars and nodes read the same in both contexts (autoboxing).
    const ctx = boxedCtx && !isLeaf(t);
    const key = `${typeToString(t)}|${ctx}`;
    const known = this.readers.get(key);
    if (known) return known;
    const name = `r${this.readers.size}`;
    this.readers.set(key, name);
    const type = this.javaOf(t, ctx);
    this.methods.push(`    static ${type} ${name}(RecxIn in) {\n${this.readBody(t, ctx)}\n    }`);
    return name;
  }

  private loop(element: string, add: string): string {
    return [
      "        in.expect('[');",
      "        if (in.peek(']')) { in.expect(']'); } else {",
      "            while (true) {",
      `                ${element}`,
      `                ${add}`,
      "                if (in.peek(',')) { in.expect(','); continue; }",
      "                in.expect(']'); break;",
      "            }",
      "        }",
    ].join("\n");
  }

  private readBody(t: TypeNode, boxedCtx: boolean): string {
    switch (t.kind) {
      case "int":
        return "        return (int) in.integer();";
      case "long":
        return "        return in.integer();";
      case "double":
        return "        return in.real();";
      case "bool":
        return "        return in.bool();";
      case "char":
        return "        String t = in.str(); return t.isEmpty() ? '\\0' : t.charAt(0);";
      case "string":
        return "        return in.str();";
      case "void":
        return "        in.tryNull(); return;";
      case "ListNode":
        return [
          "        if (in.tryNull()) return null;",
          "        ListNode dummy = new ListNode(); ListNode tail = dummy;",
          this.loop("long v = in.integer();", "tail.next = new ListNode((int) v); tail = tail.next;"),
          "        return dummy.next;",
        ].join("\n");
      case "TreeNode":
        return [
          "        if (in.tryNull()) return null;",
          `        ${J}ArrayList<Integer> vals = new ${J}ArrayList<>();`,
          this.loop("Integer v = in.tryNull() ? null : (int) in.integer();", "vals.add(v);"),
          "        if (vals.isEmpty() || vals.get(0) == null) return null;",
          `        TreeNode root = new TreeNode(vals.get(0)); ${J}ArrayList<TreeNode> q = new ${J}ArrayList<>(); q.add(root); int head = 0; int i = 1;`,
          "        while (head < q.size() && i < vals.size()) {",
          "            TreeNode cur = q.get(head++);",
          "            if (i < vals.size() && vals.get(i) != null) { cur.left = new TreeNode(vals.get(i)); q.add(cur.left); } i++;",
          "            if (i < vals.size() && vals.get(i) != null) { cur.right = new TreeNode(vals.get(i)); q.add(cur.right); } i++;",
          "        }",
          "        return root;",
        ].join("\n");
      case "pair": {
        const ra = this.reader(t.a, true);
        const rb = this.reader(t.b, true);
        return [
          "        in.expect('[');",
          `        ${boxed(t.a, J)} a = ${ra}(in);`,
          "        in.expect(',');",
          `        ${boxed(t.b, J)} b = ${rb}(in);`,
          "        in.expect(']');",
          "        return new Pair<>(a, b);",
        ].join("\n");
      }
      case "list":
      case "matrix": {
        const element: TypeNode = t.kind === "matrix" ? { kind: "list", of: t.of } : t.of;
        if (!boxedCtx && isLeaf(t.of)) {
          // An array: S[] (list) or S[][] (matrix, rows read as S[]).
          const elementType = spelled(element, J);
          const read = this.reader(element, false);
          const arrayNew = t.kind === "matrix" ? `new ${PRIMITIVE[t.of.kind]}[16][]` : `new ${PRIMITIVE[t.of.kind]}[16]`;
          return [
            `        ${elementType}[] a = ${arrayNew}; int n = 0;`,
            this.loop(`${elementType} v = ${read}(in);`, `if (n == a.length) a = ${J}Arrays.copyOf(a, n * 2); a[n++] = v;`),
            `        return ${J}Arrays.copyOf(a, n);`,
          ].join("\n");
        }
        const read = this.reader(element, true);
        return [
          `        ${boxed(t, J)} a = new ${J}ArrayList<>();`,
          this.loop(`${boxed(element, J)} v = ${read}(in);`, "a.add(v);"),
          "        return a;",
        ].join("\n");
      }
    }
  }

  writer(t: TypeNode, boxedCtx: boolean): string {
    // A boxed scalar may be null: it gets its own writer.
    const ctx = boxedCtx && (isScalar(t) || !isLeaf(t));
    const key = `${typeToString(t)}|${ctx}`;
    const known = this.writers.get(key);
    if (known) return known;
    const name = `w${this.writers.size}`;
    this.writers.set(key, name);
    const type = this.javaOf(t, ctx);
    this.methods.push(`    static void ${name}(RecxOut o, ${type} v) {\n${this.writeBody(t, ctx)}\n    }`);
    return name;
  }

  private writeBody(t: TypeNode, boxedCtx: boolean): string {
    const nullable = boxedCtx || !isScalar(t) || t.kind === "string";
    const guard = nullable && !NODE_KINDS.has(t.kind) ? '        if (v == null) { o.raw("null"); return; }\n' : "";
    switch (t.kind) {
      case "int":
      case "long":
        return `${guard}        o.integer(v);`;
      case "double":
        return `${guard}        o.real(v);`;
      case "bool":
        return `${guard}        o.bool(v);`;
      case "char":
        return `${guard}        o.str(String.valueOf(v));`;
      case "string":
        return `${guard}        o.str(v);`;
      case "void":
        return '        o.raw("null");';
      case "ListNode":
        return [
          '        o.raw("["); int guard = 0;',
          '        for (ListNode n = v; n != null && guard < 2000000; n = n.next, guard++) { if (guard > 0) o.raw(","); o.integer(n.val); }',
          '        o.raw("]");',
        ].join("\n");
      case "TreeNode":
        return [
          `        ${J}ArrayList<TreeNode> q = new ${J}ArrayList<>(); q.add(v); ${J}ArrayList<String> out = new ${J}ArrayList<>();`,
          "        for (int k = 0; k < q.size() && out.size() < 4000000; k++) {",
          '            TreeNode n = q.get(k); if (n == null) { out.add("null"); continue; }',
          "            out.add(Integer.toString(n.val)); q.add(n.left); q.add(n.right);",
          "        }",
          '        while (!out.isEmpty() && out.get(out.size() - 1).equals("null")) out.remove(out.size() - 1);',
          '        o.raw("["); o.raw(String.join(",", out)); o.raw("]");',
        ].join("\n");
      case "pair": {
        const wa = this.writer(t.a, true);
        const wb = this.writer(t.b, true);
        return `${guard}        o.raw("["); ${wa}(o, v.first()); o.raw(","); ${wb}(o, v.second()); o.raw("]");`;
      }
      case "list":
      case "matrix": {
        const element: TypeNode = t.kind === "matrix" ? { kind: "list", of: t.of } : t.of;
        if (!boxedCtx && isLeaf(t.of)) {
          const w = this.writer(element, false);
          return `${guard}        o.raw("["); for (int i = 0; i < v.length; i++) { if (i > 0) o.raw(","); ${w}(o, v[i]); } o.raw("]");`;
        }
        const w = this.writer(element, true);
        return `${guard}        o.raw("["); boolean first = true; for (${boxed(element, J)} x : v) { if (!first) o.raw(","); first = false; ${w}(o, x); } o.raw("]");`;
      }
    }
  }
}

function usesPair(sig: FunctionSignature): boolean {
  return [sig.returns, ...sig.params.map((p) => p.type)].some((s) => /\bpair\b/.test(s));
}

/** Lines placed after the student's code: node classes, Pair, the JSON reader / writer and Main. */
export function javaDriver(sig: FunctionSignature): string {
  const gen = new Codegen();
  const params = sig.params.map((p) => parseType(p.type));
  const ret = parseType(sig.returns);

  const lines: string[] = ["    public static void main(String[] args) throws Exception {"];
  lines.push(
    "        String text = new String(System.in.readAllBytes(), java.nio.charset.StandardCharsets.UTF_8);",
    '        if (text.endsWith("\\n")) text = text.substring(0, text.length() - 1);',
    '        String[] lines = text.isEmpty() ? new String[0] : text.split("\\n", -1);',
  );
  params.forEach((t, i) => {
    const read = gen.reader(t, false);
    lines.push(
      `        if (lines.length < ${i + 1}) { System.err.println("harness: missing input line ${i + 1}"); System.exit(3); }`,
      `        RecxIn in${i} = new RecxIn(lines[${i}]); ${gen.javaOf(t, false)} a${i} = ${read}(in${i}); in${i}.end();`,
    );
  });
  const args = params.map((_, i) => `a${i}`).join(", ");
  lines.push("        Solution sol = new Solution();", "        RecxOut out = new RecxOut();");
  if (sig.comparator === "IN_PLACE_MUTATION") {
    const idx = sig.params.findIndex((p) => p.name === sig.mutatedParam);
    lines.push(`        sol.${sig.methodName}(${args});`, `        ${gen.writer(params[idx]!, false)}(out, a${idx});`);
  } else if (ret.kind === "void") {
    lines.push(`        sol.${sig.methodName}(${args});`, '        out.raw("null");');
  } else {
    lines.push(`        ${gen.javaOf(ret, false)} result = sol.${sig.methodName}(${args});`, `        ${gen.writer(ret, false)}(out, result);`);
  }
  lines.push(
    "        out.b.append('\\n');",
    "        byte[] bytes = out.b.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8);",
    "        System.out.write(bytes, 0, bytes.length);",
    "        System.out.flush();",
    "    }",
  );

  const parts: string[] = [""];
  if (usesKind(sig, "ListNode")) parts.push(LIST_NODE_CLASS);
  if (usesKind(sig, "TreeNode")) parts.push(TREE_NODE_CLASS);
  if (usesPair(sig)) parts.push(PAIR_RECORD);
  parts.push(RECX_IN, RECX_OUT, ["public class Main {", ...gen.methods, ...lines, "}", ""].join("\n"));
  return parts.join("\n");
}

/** Starter-code method stub (class Solution is not public: it shares Main.java). */
export function javaStub(sig: FunctionSignature): string {
  const params = sig.params.map((p) => `${javaType(parseType(p.type))} ${p.name}`).join(", ");
  const notes = nodeNotes(sig, "//");
  if (usesPair(sig)) notes.push("// The judge defines record Pair<A, B>(A first, B second): new Pair<>(a, b), p.first(), p.second().");
  const note = inPlaceNote(sig, "//");
  return [
    ...notes,
    "class Solution {",
    `    public ${javaType(parseType(sig.returns))} ${sig.methodName}(${params}) {`,
    note ? `        ${note}` : "        ",
    "    }",
    "}",
    "",
  ].join("\n");
}
