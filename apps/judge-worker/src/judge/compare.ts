import type { CompareMode } from "@recx/shared";
import { DEFAULT_FLOAT_EPSILON } from "@recx/shared/harness";
import { PermanentJudgeError } from "../errors";

/**
 * Built-in output comparison, done in the worker — expected output never
 * enters a box. Works on raw bytes so a 64 MB output is compared without
 * building token arrays.
 *
 *   TOKEN (default) whitespace-insensitive equality of the token sequence
 *   EXACT           byte equality
 *   FLOAT           tokens; a numeric expected token matches a numeric actual
 *                   token within the absolute OR relative epsilon (default
 *                   1e-6); non-numeric tokens must match exactly
 *
 * FUNCTION problems never come here: their output is decoded and compared
 * structurally (@recx/shared/harness compare.ts, see run-job.ts).
 *
 * CHECKER is not a built-in comparison: the problem's own testlib checker
 * decides, in the checker box (src/judge/checker.ts). INTERACTIVE is not
 * available on this judge; src/judge/plan.ts refuses such a job permanently
 * before any box is created.
 */

/** Single-sourced with the FUNCTION comparators' FLOAT_TOLERANCE default. */
export { DEFAULT_FLOAT_EPSILON };

export type BuiltinCompareMode = "TOKEN" | "EXACT" | "FLOAT";

export class UnsupportedCompareModeError extends PermanentJudgeError {
  override readonly name: string = "UnsupportedCompareModeError";

  constructor(mode: string) {
    super(`${mode} comparison is not a built-in comparison of this judge.`);
  }
}

export function isBuiltinCompareMode(mode: CompareMode): mode is BuiltinCompareMode {
  return mode === "TOKEN" || mode === "EXACT" || mode === "FLOAT";
}

export function assertBuiltinCompareMode(mode: CompareMode): asserts mode is BuiltinCompareMode {
  if (!isBuiltinCompareMode(mode)) throw new UnsupportedCompareModeError(mode);
}

export function compareOutputs(
  mode: CompareMode,
  expected: Buffer,
  actual: Buffer,
  options: { floatEpsilon?: number | null } = {},
): boolean {
  assertBuiltinCompareMode(mode);
  switch (mode) {
    case "EXACT":
      return expected.equals(actual);
    case "TOKEN":
      return compareTokens(expected, actual, (e, a) => e.equals(a));
    case "FLOAT": {
      const epsilon = options.floatEpsilon ?? DEFAULT_FLOAT_EPSILON;
      return compareTokens(expected, actual, (e, a) => floatTokenEqual(e, a, epsilon));
    }
  }
}

function isSpace(byte: number): boolean {
  // space, \t, \n, \v, \f, \r
  return byte === 0x20 || (byte >= 0x09 && byte <= 0x0d);
}

/** Walk both buffers token by token; equal iff same count and every pair matches. */
function compareTokens(expected: Buffer, actual: Buffer, equal: (e: Buffer, a: Buffer) => boolean): boolean {
  let ei = 0;
  let ai = 0;
  for (;;) {
    while (ei < expected.length && isSpace(expected[ei]!)) ei++;
    while (ai < actual.length && isSpace(actual[ai]!)) ai++;
    const eDone = ei >= expected.length;
    const aDone = ai >= actual.length;
    if (eDone || aDone) return eDone && aDone;

    const eStart = ei;
    const aStart = ai;
    while (ei < expected.length && !isSpace(expected[ei]!)) ei++;
    while (ai < actual.length && !isSpace(actual[ai]!)) ai++;
    if (!equal(expected.subarray(eStart, ei), actual.subarray(aStart, ai))) return false;
  }
}

const NUMERIC = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

export function parseNumericToken(token: string): number | null {
  if (token.length > 400 || !NUMERIC.test(token)) return null;
  const value = Number(token);
  return Number.isNaN(value) ? null : value;
}

function floatTokenEqual(expectedToken: Buffer, actualToken: Buffer, epsilon: number): boolean {
  if (expectedToken.equals(actualToken)) return true;
  const expected = parseNumericToken(expectedToken.toString("latin1"));
  if (expected === null) return false; // non-numeric tokens compare exactly
  const actual = parseNumericToken(actualToken.toString("latin1"));
  if (actual === null) return false;
  if (!Number.isFinite(expected) || !Number.isFinite(actual)) return expected === actual;
  const diff = Math.abs(expected - actual);
  return diff <= epsilon || diff <= epsilon * Math.abs(expected);
}
