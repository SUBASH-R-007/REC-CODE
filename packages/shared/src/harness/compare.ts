import { comparedTypeOf, typeToString, type FunctionComparator, type FunctionSignature, type TypeNode } from "./signature";
import { canonicalOf, decodeValue, type Decoded } from "./values";

/**
 * Structured comparison of FUNCTION-mode output, done by the judge worker
 * for EVERY FUNCTION problem (protocol 3). Both the expected answer and the
 * program's stdout are decoded strictly against the compared type (the
 * return type, or the mutated parameter's under IN_PLACE_MUTATION) and then
 * compared by the problem's comparator:
 *
 *   EXACT              canonical equality (ints and longs exact, strings
 *                      byte-exact — "a b" never equals "a  b")
 *   IN_PLACE_MUTATION  EXACT, on the parameter printed after the call
 *   FLOAT_TOLERANCE    structure exact; each double within the absolute OR
 *                      relative epsilon (floatEpsilon, default 1e-6)
 *   SET_EQUAL          multiset equality, order ignored at every list and
 *                      matrix level; pairs ordered; strings, trees and
 *                      linked lists exact
 *   ROWS_ANY_ORDER     the top-level rows in any order; each row exact
 *   CUSTOM_CHECKER     not compared here: canonicalizeFunctionOutput() turns
 *                      the output into canonical text for the testlib checker
 *
 * Output that does not decode is never accepted: an empty stdout, extra
 * printed lines, NaN, a long out of range or a value of the wrong type are
 * all "malformed-output" (Wrong Answer, with a reason a visible test shows).
 * An expected answer that does not decode is the problem's bug
 * ("malformed-answer"): the worker releases the job permanently.
 */

export const DEFAULT_FLOAT_EPSILON = 1e-6;

export interface FunctionCompareSpec {
  comparator: FunctionComparator;
  /** The compared type. */
  type: TypeNode;
  floatEpsilon: number;
}

export function functionCompareSpec(
  sig: Pick<FunctionSignature, "comparator" | "mutatedParam" | "params" | "returns">,
  floatEpsilon: number | null,
): FunctionCompareSpec {
  return { comparator: sig.comparator, type: comparedTypeOf(sig), floatEpsilon: floatEpsilon ?? DEFAULT_FLOAT_EPSILON };
}

export type FunctionCompareResult =
  | { kind: "equal" }
  | { kind: "different"; reason: string }
  | { kind: "malformed-output"; reason: string }
  | { kind: "malformed-answer"; reason: string };

export const EMPTY_OUTPUT_REASON =
  "Nothing was printed for the result. Return the answer from your method — the judge prints it for you.";
export const EXTRA_OUTPUT_REASON =
  "Standard output must contain only your function's result — remove print statements (debug output may go to standard error).";

type Decode = { ok: true; value: Decoded } | { ok: false; reason: string };

function decodeOutput(type: TypeNode, actual: string): Decode {
  if (actual.trim().length === 0) return { ok: false, reason: EMPTY_OUTPUT_REASON };
  const r = decodeValue(type, actual);
  if (r.ok) return { ok: true, value: r.value };
  const lines = actual.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length > 1 && decodeValue(type, lines[lines.length - 1]!).ok) {
    return { ok: false, reason: EXTRA_OUTPUT_REASON };
  }
  return { ok: false, reason: `The result is not a valid ${typeToString(type)}: ${r.reason} (at character ${r.offset + 1}).` };
}

function close(expected: number, actual: number, epsilon: number): boolean {
  if (expected === actual) return true;
  const diff = Math.abs(expected - actual);
  return diff <= epsilon || diff <= epsilon * Math.abs(expected);
}

function floatMatch(e: Decoded, a: Decoded, epsilon: number): boolean {
  switch (e.t) {
    case "double":
      return a.t === "double" && close(e.value, a.value, epsilon);
    case "atom":
      return a.t === "atom" && e.text === a.text;
    case "pair":
      return a.t === "pair" && floatMatch(e.a, a.a, epsilon) && floatMatch(e.b, a.b, epsilon);
    case "seq": {
      if (a.t !== "seq" || a.items.length !== e.items.length) return false;
      for (let i = 0; i < e.items.length; i++) if (!floatMatch(e.items[i]!, a.items[i]!, epsilon)) return false;
      return true;
    }
  }
}

/** Canonical text with the order of every list / matrix level erased (pairs keep theirs). */
function unordered(d: Decoded): string {
  switch (d.t) {
    case "atom":
    case "double":
      return d.text;
    case "pair":
      return `[${unordered(d.a)},${unordered(d.b)}]`;
    case "seq":
      return `[${d.items.map(unordered).sort().join(",")}]`;
  }
}

/** Canonical text with only the top-level order erased. */
function rowsUnordered(d: Decoded): string {
  if (d.t !== "seq") return canonicalOf(d);
  return `[${d.items.map(canonicalOf).sort().join(",")}]`;
}

const DIFFERENT: Record<Exclude<FunctionComparator, "CUSTOM_CHECKER">, string> = {
  EXACT: "The result differs from the expected answer.",
  IN_PLACE_MUTATION: "After your method returned, the parameter differs from the expected answer.",
  FLOAT_TOLERANCE: "The result differs from the expected answer by more than the allowed tolerance.",
  SET_EQUAL: "The result does not hold the same elements as the expected answer (order does not matter).",
  ROWS_ANY_ORDER: "The result does not hold the same rows as the expected answer (row order does not matter).",
};

/** Compare a program's stdout with the expected answer. Throws for CUSTOM_CHECKER (the checker decides). */
export function compareFunctionOutput(spec: FunctionCompareSpec, expected: string, actual: string): FunctionCompareResult {
  if (spec.comparator === "CUSTOM_CHECKER") {
    throw new Error("CUSTOM_CHECKER output is judged by the problem's checker, not compared here.");
  }
  const answer = decodeValue(spec.type, expected);
  if (!answer.ok) {
    return {
      kind: "malformed-answer",
      reason: `The expected answer is not a valid ${typeToString(spec.type)}: ${answer.reason} (at character ${answer.offset + 1}).`,
    };
  }
  const output = decodeOutput(spec.type, actual);
  if (!output.ok) return { kind: "malformed-output", reason: output.reason };

  let equal: boolean;
  switch (spec.comparator) {
    case "EXACT":
    case "IN_PLACE_MUTATION":
      equal = answer.canonical === canonicalOf(output.value);
      break;
    case "FLOAT_TOLERANCE":
      equal = floatMatch(answer.value, output.value, spec.floatEpsilon);
      break;
    case "SET_EQUAL":
      equal = unordered(answer.value) === unordered(output.value);
      break;
    case "ROWS_ANY_ORDER":
      equal = rowsUnordered(answer.value) === rowsUnordered(output.value);
      break;
  }
  return equal ? { kind: "equal" } : { kind: "different", reason: DIFFERENT[spec.comparator] };
}

/**
 * CUSTOM_CHECKER: the program's stdout as one canonical line for the checker,
 * or why it cannot be judged at all (Wrong Answer without running the checker).
 */
export function canonicalizeFunctionOutput(
  spec: FunctionCompareSpec,
  actual: string,
): { ok: true; text: string } | { ok: false; reason: string } {
  const output = decodeOutput(spec.type, actual);
  return output.ok ? { ok: true, text: canonicalOf(output.value) } : { ok: false, reason: output.reason };
}
