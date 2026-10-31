import { comparedTypeOf, parseType, typeToString, type FunctionSignature, type TypeNode } from "./signature";

/**
 * Canonical (de)serialisation of FUNCTION-mode values.
 *
 * The wire form is one JSON value per line (LeetCode style: trees in level
 * order with nulls). The CANONICAL form of a value is the compact text
 * serializeValue() writes: no whitespace, integers without sign or leading
 * zeros beyond JSON's, doubles as JSON.stringify writes them, strings escaped
 * exactly like JSON.stringify, trees rebuilt and re-serialised in level order
 * with trailing nulls trimmed, and a null tree or linked list written [].
 *
 * decodeCanonical() is a type-directed parser (no generic JSON tree, so the
 * nesting depth is bounded by the type and the cost is linear). The judge
 * decodes both the expected answer and the program's output with it and
 * compares the results structurally (./compare.ts), so harness differences
 * between languages — "1.0" vs "1", a null tree printed as null — never
 * decide a verdict, while every int and long is checked exactly (BigInt).
 */
export type Value =
  | number
  | bigint
  | boolean
  | string
  | null
  | Value[]
  | { __tree: (number | null)[] }
  | { __list: number[] };

export class ValueError extends Error {}

const INT32_MIN = -(2 ** 31);
const INT32_MAX = 2 ** 31 - 1;
const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;

/**
 * True when the string has a lone UTF-16 surrogate (is not well-formed
 * Unicode). A loop rather than String#isWellFormed (ES2024; tsconfig lib is
 * ES2023) or a lookbehind regex (unsupported by older Safari).
 */
export function hasLoneSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0xd800 || c > 0xdfff) continue;
    if (c <= 0xdbff) {
      const next = s.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        i++;
        continue;
      }
    }
    return true;
  }
  return false;
}

/** Serialise a value of the given type to its single-line wire form. */
export function serializeValue(type: TypeNode, value: unknown): string {
  switch (type.kind) {
    case "int": {
      if (typeof value !== "number" || !Number.isInteger(value) || value < INT32_MIN || value > INT32_MAX) {
        throw new ValueError(`Expected a 32-bit int, got ${String(value)}.`);
      }
      return String(value);
    }
    case "long": {
      if (typeof value === "bigint") {
        if (value < INT64_MIN || value > INT64_MAX) throw new ValueError(`Expected a 64-bit integer, got ${value}.`);
        return value.toString();
      }
      if (typeof value !== "number" || !Number.isSafeInteger(value)) {
        throw new ValueError(`Expected a 64-bit integer, got ${String(value)}.`);
      }
      return String(value);
    }
    case "double": {
      if (typeof value !== "number" || !Number.isFinite(value)) throw new ValueError("Expected a finite double.");
      return JSON.stringify(value);
    }
    case "bool":
      if (typeof value !== "boolean") throw new ValueError("Expected a boolean.");
      return value ? "true" : "false";
    case "char":
      // C++ char is a byte, so a char is exactly one ASCII character.
      if (typeof value !== "string" || value.length !== 1 || value.charCodeAt(0) > 0x7f) {
        throw new ValueError("Expected a single ASCII character.");
      }
      return JSON.stringify(value);
    case "string":
      if (typeof value !== "string") throw new ValueError("Expected a string.");
      return JSON.stringify(value);
    case "void":
      return "null";
    case "list":
    case "matrix": {
      if (!Array.isArray(value)) throw new ValueError(`Expected an array for ${type.kind}.`);
      const inner: TypeNode = type.kind === "matrix" ? { kind: "list", of: type.of } : type.of;
      return `[${value.map((v) => serializeValue(inner, v)).join(",")}]`;
    }
    case "pair": {
      if (!Array.isArray(value) || value.length !== 2) throw new ValueError("Expected a 2-element array for pair.");
      return `[${serializeValue(type.a, value[0])},${serializeValue(type.b, value[1])}]`;
    }
    case "TreeNode":
    case "ListNode": {
      if (!Array.isArray(value)) throw new ValueError(`Expected a level-order array for ${type.kind}.`);
      if (type.kind === "ListNode" && value.some((v) => v === null)) throw new ValueError("A linked list holds no nulls.");
      return `[${value.map((v) => (v === null ? "null" : serializeValue({ kind: "int" }, v))).join(",")}]`;
    }
  }
}

// ── The decoder ─────────────────────────────────────────────────────────

/**
 * A decoded value, as the comparators see it. Ints, longs, bools, strings,
 * chars, trees and linked lists are atoms compared by their canonical text;
 * doubles keep their number; lists, matrices and pairs keep their items.
 */
export type Decoded =
  | { t: "atom"; text: string }
  | { t: "double"; value: number; text: string }
  | { t: "seq"; items: Decoded[] }
  | { t: "pair"; a: Decoded; b: Decoded };

export type DecodeResult = { ok: true; canonical: string } | { ok: false; reason: string; offset: number };
export type DecodedResult = { ok: true; value: Decoded; canonical: string } | { ok: false; reason: string; offset: number };

class DecodeFailure extends Error {
  constructor(
    readonly reason: string,
    readonly offset: number,
  ) {
    super(reason);
  }
}

const INTEGER = /-?(?:0|[1-9][0-9]*)/y;
const NUMBER = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;

class Decoder {
  pos = 0;
  constructor(private readonly s: string) {}

  fail(reason: string): never {
    throw new DecodeFailure(reason, this.pos);
  }

  ws(): void {
    const s = this.s;
    let p = this.pos;
    for (;;) {
      const c = s.charCodeAt(p);
      if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) p++;
      else break;
    }
    this.pos = p;
  }

  peek(): string {
    this.ws();
    return this.s[this.pos] ?? "";
  }

  expect(ch: string, what: string): void {
    this.ws();
    if (this.s[this.pos] !== ch) this.fail(`expected ${what}`);
    this.pos++;
  }

  literal(word: string): boolean {
    this.ws();
    if (this.s.startsWith(word, this.pos)) {
      this.pos += word.length;
      return true;
    }
    return false;
  }

  integer(kind: "int" | "long"): string {
    this.ws();
    INTEGER.lastIndex = this.pos;
    const m = INTEGER.exec(this.s);
    if (!m) this.fail(kind === "int" ? "expected an integer" : "expected an integer");
    const after = this.s.charCodeAt(this.pos + m[0].length);
    // "1.5", "1e3" and "12a" are not integers.
    if (after === 0x2e || after === 0x65 || after === 0x45 || (after >= 0x30 && after <= 0x39)) {
      this.fail("expected an integer (no decimal point or exponent)");
    }
    const text = m[0];
    const range = kind === "int" ? "32-bit int" : "64-bit long";
    // A sign and 19 digits is the longest int64 (no leading zeros allowed).
    // Anything longer is out of range: say so without BigInt, which would
    // spend seconds on a multi-megabyte token printed by student code.
    if (text.length > 20) this.fail(`${text.slice(0, 24)}… is outside the ${range} range`);
    let canonical: string;
    if (text.length <= 15) {
      const n = Number(text);
      if (kind === "int" && (n < INT32_MIN || n > INT32_MAX)) this.fail(`${text} is outside the ${range} range`);
      canonical = String(n === 0 ? 0 : n);
    } else {
      const n = BigInt(text);
      const [lo, hi] = kind === "int" ? [BigInt(INT32_MIN), BigInt(INT32_MAX)] : [INT64_MIN, INT64_MAX];
      if (n < lo || n > hi) this.fail(`${text} is outside the ${range} range`);
      canonical = n.toString();
    }
    this.pos += text.length;
    return canonical;
  }

  real(): { value: number; text: string } {
    this.ws();
    NUMBER.lastIndex = this.pos;
    const m = NUMBER.exec(this.s);
    if (!m) this.fail("expected a number");
    const value = Number(m[0]);
    if (!Number.isFinite(value)) this.fail(`${m[0].slice(0, 40)} is not a finite double`);
    this.pos += m[0].length;
    return { value, text: JSON.stringify(value) };
  }

  string(): string {
    this.ws();
    const s = this.s;
    if (s[this.pos] !== '"') this.fail('expected a string ("…")');
    let p = this.pos + 1;
    let out = "";
    let chunk = p;
    for (;;) {
      if (p >= s.length) {
        this.pos = p;
        this.fail("unterminated string");
      }
      const c = s.charCodeAt(p);
      if (c === 0x22) break;
      if (c < 0x20) {
        this.pos = p;
        this.fail("a control character must be escaped inside a string");
      }
      if (c !== 0x5c) {
        p++;
        continue;
      }
      out += s.slice(chunk, p);
      const e = s[p + 1];
      switch (e) {
        case '"':
          out += '"';
          break;
        case "\\":
          out += "\\";
          break;
        case "/":
          out += "/";
          break;
        case "b":
          out += "\b";
          break;
        case "f":
          out += "\f";
          break;
        case "n":
          out += "\n";
          break;
        case "r":
          out += "\r";
          break;
        case "t":
          out += "\t";
          break;
        case "u": {
          const hex = s.slice(p + 2, p + 6);
          if (!/^[0-9A-Fa-f]{4}$/.test(hex)) {
            this.pos = p;
            this.fail("bad \\u escape");
          }
          out += String.fromCharCode(parseInt(hex, 16));
          p += 4;
          break;
        }
        default:
          this.pos = p;
          this.fail("bad escape in a string");
      }
      p += 2;
      chunk = p;
    }
    out += s.slice(chunk, p);
    if (hasLoneSurrogate(out)) {
      this.fail("the string is not well-formed Unicode (a lone surrogate)");
    }
    this.pos = p + 1;
    return out;
  }

  /** `[` item (`,` item)* `]`, or `[]`. */
  items<T>(item: () => T): T[] {
    this.expect("[", "'['");
    const out: T[] = [];
    if (this.peek() === "]") {
      this.pos++;
      return out;
    }
    for (;;) {
      out.push(item());
      const next = this.peek();
      if (next === ",") {
        this.pos++;
        continue;
      }
      if (next === "]") {
        this.pos++;
        return out;
      }
      this.fail("expected ',' or ']'");
    }
  }

  value(type: TypeNode): Decoded {
    switch (type.kind) {
      case "int":
      case "long":
        return { t: "atom", text: this.integer(type.kind) };
      case "double": {
        const { value, text } = this.real();
        return { t: "double", value, text };
      }
      case "bool":
        if (this.literal("true")) return { t: "atom", text: "true" };
        if (this.literal("false")) return { t: "atom", text: "false" };
        return this.fail("expected true or false");
      case "char": {
        const start = this.pos;
        const v = this.string();
        if (v.length !== 1 || v.charCodeAt(0) > 0x7f) {
          this.pos = start;
          this.fail("expected a single ASCII character");
        }
        return { t: "atom", text: JSON.stringify(v) };
      }
      case "string":
        return { t: "atom", text: JSON.stringify(this.string()) };
      case "void":
        if (this.literal("null")) return { t: "atom", text: "null" };
        return this.fail("expected null");
      case "list":
        return { t: "seq", items: this.items(() => this.value(type.of)) };
      case "matrix":
        return { t: "seq", items: this.items(() => ({ t: "seq", items: this.items(() => this.value(type.of)) }) as Decoded) };
      case "pair": {
        this.expect("[", "'[' (a pair is [first,second])");
        const a = this.value(type.a);
        this.expect(",", "',' between the two parts of a pair");
        const b = this.value(type.b);
        this.expect("]", "']' after the two parts of a pair");
        return { t: "pair", a, b };
      }
      case "ListNode": {
        if (this.literal("null")) return { t: "atom", text: "[]" };
        const vals = this.items(() => this.integer("int"));
        return { t: "atom", text: `[${vals.join(",")}]` };
      }
      case "TreeNode": {
        if (this.literal("null")) return { t: "atom", text: "[]" };
        const vals = this.items(() => (this.literal("null") ? null : this.integer("int")));
        return { t: "atom", text: canonicalTree(vals) };
      }
    }
  }
}

/**
 * The canonical level order of the tree a level-order list describes, built
 * exactly as every harness builds it (entries past the last node's children
 * are ignored, a null root is the empty tree) and written back with trailing
 * nulls trimmed.
 */
function canonicalTree(vals: readonly (string | null)[]): string {
  if (vals.length === 0 || vals[0] === null) return "[]";
  const val: string[] = [vals[0]!];
  const left: number[] = [-1];
  const right: number[] = [-1];
  const queue: number[] = [0];
  let head = 0;
  let i = 1;
  const attach = (side: number[], parent: number) => {
    const v = vals[i++];
    if (v === null || v === undefined) return;
    const id = val.length;
    val.push(v);
    left.push(-1);
    right.push(-1);
    side[parent] = id;
    queue.push(id);
  };
  while (head < queue.length && i < vals.length) {
    const cur = queue[head++]!;
    if (i < vals.length) attach(left, cur);
    if (i < vals.length) attach(right, cur);
  }
  const out: string[] = [];
  const q: number[] = [0];
  for (let k = 0; k < q.length; k++) {
    const n = q[k]!;
    if (n === -1) {
      out.push("null");
      continue;
    }
    out.push(val[n]!);
    q.push(left[n]!, right[n]!);
  }
  while (out.length > 0 && out[out.length - 1] === "null") out.pop();
  return `[${out.join(",")}]`;
}

/** The canonical text of a decoded value. */
export function canonicalOf(d: Decoded): string {
  switch (d.t) {
    case "atom":
    case "double":
      return d.text;
    case "seq":
      return `[${d.items.map(canonicalOf).join(",")}]`;
    case "pair":
      return `[${canonicalOf(d.a)},${canonicalOf(d.b)}]`;
  }
}

/** Decode one value of `type` from `text` (surrounding JSON whitespace allowed, nothing else). */
export function decodeValue(type: TypeNode, text: string): DecodedResult {
  const d = new Decoder(text);
  try {
    const value = d.value(type);
    d.ws();
    if (d.pos !== text.length) d.fail("unexpected text after the value");
    return { ok: true, value, canonical: canonicalOf(value) };
  } catch (error) {
    if (error instanceof DecodeFailure) return { ok: false, reason: error.reason, offset: error.offset };
    throw error;
  }
}

/** Decode `text` as `type` and return its canonical form. */
export function decodeCanonical(type: TypeNode, text: string): DecodeResult {
  const r = decodeValue(type, text);
  return r.ok ? { ok: true, canonical: r.canonical } : r;
}

/** Parse a wire-form line back into a JS value (used by tests and tools). Longs beyond 2^53 come back as bigint. */
export function parseValue(type: TypeNode, text: string): unknown {
  const r = decodeValue(type, text);
  if (!r.ok) throw new ValueError(`Not a valid ${typeToString(type)}: ${r.reason} (at character ${r.offset + 1}).`);
  return toJs(type, r.value);
}

function toJs(type: TypeNode, d: Decoded): unknown {
  switch (type.kind) {
    case "int":
      return Number((d as { text: string }).text);
    case "long": {
      const text = (d as { text: string }).text;
      const n = Number(text);
      return Number.isSafeInteger(n) ? n : BigInt(text);
    }
    case "double":
      return (d as { value: number }).value;
    case "bool":
      return (d as { text: string }).text === "true";
    case "char":
    case "string":
      return JSON.parse((d as { text: string }).text) as string;
    case "void":
      return null;
    case "list":
      return (d as { items: Decoded[] }).items.map((x) => toJs(type.of, x));
    case "matrix":
      return (d as { items: Decoded[] }).items.map((row) => (row as { items: Decoded[] }).items.map((x) => toJs(type.of, x)));
    case "pair": {
      const p = d as { a: Decoded; b: Decoded };
      return [toJs(type.a, p.a), toJs(type.b, p.b)];
    }
    case "TreeNode":
    case "ListNode":
      return JSON.parse((d as { text: string }).text) as unknown;
  }
}

/** Build the stdin text for one FUNCTION-mode test: one line per parameter. */
export function serializeArgs(types: TypeNode[], args: unknown[]): string {
  if (types.length !== args.length) throw new ValueError("Argument count does not match the signature.");
  return types.map((t, i) => serializeValue(t, args[i])).join("\n") + "\n";
}

// ── Validation of authored tests and custom input ───────────────────────

const MAX_ISSUES = 8;

function excerpt(text: string): string {
  const flat = text.length > 60 ? `${text.slice(0, 57)}…` : text;
  return JSON.stringify(flat);
}

/** The input split into lines: one trailing newline ends the last line rather than starting another. */
function inputLines(input: string): string[] {
  if (input.length === 0) return [];
  const body = input.endsWith("\n") ? input.slice(0, -1) : input;
  return body.split("\n");
}

/**
 * Custom input for the Run button of a FUNCTION problem: one line per
 * parameter, each a valid value of its type (whitespace allowed). Returns
 * the problems, each naming the line and the parameter; empty = valid.
 * Every harness reads exactly what this accepts, the same way.
 */
export function validateFunctionInput(sig: FunctionSignature, input: string): string[] {
  const issues: string[] = [];
  const lines = inputLines(input);
  sig.params.forEach((p, i) => {
    const type = parseType(p.type);
    const label = `Line ${i + 1} (${p.name}: ${typeToString(type)})`;
    const line = lines[i];
    if (line === undefined) {
      issues.push(`${label} is missing: write one line per parameter, in order.`);
      return;
    }
    const r = decodeCanonical(type, line);
    if (!r.ok) issues.push(`${label}: ${r.reason} at character ${r.offset + 1}.`);
  });
  for (let k = sig.params.length; k < lines.length; k++) {
    if (lines[k]!.trim() !== "") {
      issues.push(
        `Line ${k + 1}: the method takes ${sig.params.length} parameter${sig.params.length === 1 ? "" : "s"}, one per line — remove the extra lines.`,
      );
      break;
    }
  }
  return issues.slice(0, MAX_ISSUES);
}

/**
 * An authored FUNCTION test: the input must be exactly one CANONICAL line per
 * parameter (each ending in a newline) and the output exactly one canonical
 * value of the compared type (the return type, or the mutated parameter's
 * type for IN_PLACE_MUTATION) and a newline. Strings must be well-formed
 * Unicode. Empty = valid.
 */
export function validateFunctionTest(sig: FunctionSignature, input: string, output: string): string[] {
  const issues: string[] = [];
  if (!input.endsWith("\n")) issues.push("The input must end with a newline.");
  const lines = inputLines(input);
  if (lines.length !== sig.params.length && !(sig.params.length === 0 && input === "\n")) {
    issues.push(`The input has ${lines.length} line${lines.length === 1 ? "" : "s"}; the method takes ${sig.params.length} parameter${sig.params.length === 1 ? "" : "s"}.`);
  }
  sig.params.forEach((p, i) => {
    const line = lines[i];
    if (line === undefined) return;
    const type = parseType(p.type);
    const r = decodeCanonical(type, line);
    if (!r.ok) {
      issues.push(`Input line ${i + 1} (${p.name}: ${typeToString(type)}): ${r.reason} at character ${r.offset + 1}.`);
    } else if (r.canonical !== line) {
      issues.push(`Input line ${i + 1} (${p.name}) is not in canonical form: write ${excerpt(r.canonical)}.`);
    }
  });

  const compared = comparedTypeOf(sig);
  if (!output.endsWith("\n")) issues.push("The expected output must end with a newline.");
  const body = output.endsWith("\n") ? output.slice(0, -1) : output;
  if (body.includes("\n")) {
    issues.push("The expected output must be a single line.");
  } else {
    const r = decodeCanonical(compared, body);
    if (!r.ok) {
      issues.push(`The expected output is not a valid ${typeToString(compared)}: ${r.reason} at character ${r.offset + 1}.`);
    } else if (r.canonical !== body) {
      issues.push(`The expected output is not in canonical form: write ${excerpt(r.canonical)}.`);
    } else {
      const lengthIssue = inPlaceLengthIssue(sig, lines, body);
      if (lengthIssue) issues.push(lengthIssue);
    }
  }
  return issues.slice(0, MAX_ISSUES);
}

/** Element kinds Java spells as a fixed-length array (java.ts `spelled`: list<leaf> is S[], matrix<leaf> is S[][]). */
const JAVA_ARRAY_ELEMENT = new Set(["int", "long", "double", "bool", "char", "string", "TreeNode", "ListNode"]);

/**
 * IN_PLACE_MUTATION of a list<leaf> or matrix<leaf>: Java receives a
 * fixed-length array, so a method cannot change its (outer) length, while
 * C++ and Python can. A test whose expected value has another length than
 * the input could never be passed in Java — which is a problem to catch
 * while the test is being authored, not when a student's correct solution
 * fails in one language only.
 */
function inPlaceLengthIssue(sig: FunctionSignature, lines: readonly string[], expected: string): string | null {
  if (sig.comparator !== "IN_PLACE_MUTATION" || sig.mutatedParam === null) return null;
  const index = sig.params.findIndex((p) => p.name === sig.mutatedParam);
  if (index < 0 || lines[index] === undefined) return null;
  const type = parseType(sig.params[index]!.type);
  if ((type.kind !== "list" && type.kind !== "matrix") || !JAVA_ARRAY_ELEMENT.has(type.of.kind)) return null;
  try {
    const before = JSON.parse(lines[index]!) as unknown;
    const after = JSON.parse(expected) as unknown;
    if (!Array.isArray(before) || !Array.isArray(after) || before.length === after.length) return null;
    return `The expected ${sig.mutatedParam} has ${after.length} element${after.length === 1 ? "" : "s"} but the input has ${before.length}: an in-place ${typeToString(type)} keeps its length (Java passes a fixed-length array).`;
  } catch {
    return null;
  }
}
