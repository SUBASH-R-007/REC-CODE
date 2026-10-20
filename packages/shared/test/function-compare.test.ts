import { describe, expect, it } from "vitest";
import {
  canonicalizeFunctionOutput,
  compareFunctionOutput,
  DEFAULT_FLOAT_EPSILON,
  EMPTY_OUTPUT_REASON,
  EXTRA_OUTPUT_REASON,
  functionCompareSpec,
  type FunctionCompareSpec,
} from "../src/harness/compare";
import { comparatorIssues, type ComparatorDeclaration } from "../src/harness/declaration";
import { parseType, type FunctionComparator } from "../src/harness/signature";
import { TWO_SUM } from "../src/samples/two-sum";

const spec = (comparator: FunctionComparator, type: string, floatEpsilon = DEFAULT_FLOAT_EPSILON): FunctionCompareSpec => ({
  comparator,
  type: parseType(type),
  floatEpsilon,
});
const kind = (s: FunctionCompareSpec, expected: string, actual: string) => compareFunctionOutput(s, expected, actual).kind;

describe("compareFunctionOutput — EXACT", () => {
  const str = spec("EXACT", "string");

  it("regression: whitespace inside a string is significant (no false AC)", () => {
    expect(kind(str, '"a b"\n', '"a  b"\n')).toBe("different");
    expect(kind(str, '"a b"\n', '"a b"\n')).toBe("equal");
  });

  it("compares longs exactly beyond 2^53", () => {
    const long = spec("EXACT", "long");
    expect(kind(long, "9007199254740993\n", "9007199254740992\n")).toBe("different");
    expect(kind(long, "9223372036854775807\n", "9223372036854775807\n")).toBe("equal");
    expect(kind(long, "1\n", "9223372036854775808\n")).toBe("malformed-output");
  });

  it("ignores JSON whitespace between tokens and around the value", () => {
    const list = spec("EXACT", "list<int>");
    expect(kind(list, "[0,1]\n", "[0, 1]\n")).toBe("equal");
    expect(kind(list, "[0,1]\n", "  [ 0 ,\t1 ]  \r\n")).toBe("equal");
    expect(kind(list, "[0,1]\n", "[1,0]\n")).toBe("different");
  });

  it("decodes escapes before comparing strings", () => {
    expect(kind(str, '"é"\n', '"\\u00e9"\n')).toBe("equal");
    expect(kind(str, '"🎉"\n', '"\\ud83c\\udf89"\n')).toBe("equal");
    expect(kind(str, '"a/b"\n', '"a\\/b"\n')).toBe("equal");
  });

  it("treats a null TreeNode or ListNode as [] and trims trailing tree nulls", () => {
    const tree = spec("EXACT", "TreeNode");
    expect(kind(tree, "[]\n", "null\n")).toBe("equal");
    expect(kind(tree, "[1,null,2]\n", "[1,null,2,null,null]\n")).toBe("equal");
    expect(kind(tree, "[1]\n", "[1,null,null,7]\n")).toBe("equal"); // entries past the last node are ignored
    expect(kind(spec("EXACT", "ListNode"), "[]\n", "null\n")).toBe("equal");
    expect(kind(spec("EXACT", "ListNode"), "[1,2]\n", "[1,null]\n")).toBe("malformed-output");
  });

  it("rejects NaN, Infinity, wrong types and out-of-range ints as malformed output", () => {
    const int = spec("EXACT", "int");
    expect(kind(int, "1\n", "2147483648\n")).toBe("malformed-output");
    expect(kind(int, "1\n", "1.0\n")).toBe("malformed-output");
    expect(kind(int, "1\n", "true\n")).toBe("malformed-output");
    expect(kind(int, "1\n", "01\n")).toBe("malformed-output");
    expect(kind(spec("FLOAT_TOLERANCE", "double"), "1\n", "NaN\n")).toBe("malformed-output");
    expect(kind(spec("FLOAT_TOLERANCE", "double"), "1\n", "Infinity\n")).toBe("malformed-output");
    expect(kind(spec("FLOAT_TOLERANCE", "double"), "1\n", "1e400\n")).toBe("malformed-output");
  });

  it("says why output is malformed: nothing printed, extra printed lines, wrong type", () => {
    const list = spec("EXACT", "list<int>");
    expect(compareFunctionOutput(list, "[0,1]\n", "")).toEqual({ kind: "malformed-output", reason: EMPTY_OUTPUT_REASON });
    expect(compareFunctionOutput(list, "[0,1]\n", "  \n")).toEqual({ kind: "malformed-output", reason: EMPTY_OUTPUT_REASON });
    expect(compareFunctionOutput(list, "[0,1]\n", "debug 7\n[0,1]\n")).toEqual({ kind: "malformed-output", reason: EXTRA_OUTPUT_REASON });
    const wrong = compareFunctionOutput(list, "[0,1]\n", '"0,1"\n');
    expect(wrong.kind).toBe("malformed-output");
    expect(wrong.kind === "malformed-output" && wrong.reason).toMatch(/is not a valid list<int>/);
  });

  it("reports an expected answer that does not decode as malformed-answer (the problem's bug)", () => {
    expect(kind(spec("EXACT", "list<int>"), "[0,1\n", "[0,1]\n")).toBe("malformed-answer");
    expect(kind(spec("EXACT", "int"), "x\n", "1\n")).toBe("malformed-answer");
  });

  it("chars are single ASCII characters", () => {
    const char = spec("EXACT", "char");
    expect(kind(char, '"a"\n', '"a"\n')).toBe("equal");
    expect(kind(char, '"a"\n', '"ab"\n')).toBe("malformed-output");
    expect(kind(char, '"a"\n', '"é"\n')).toBe("malformed-output");
  });

  it("matrices, pairs and booleans compare structurally", () => {
    expect(kind(spec("EXACT", "matrix<int>"), "[[1,2],[]]\n", "[[1,2],[]]\n")).toBe("equal");
    expect(kind(spec("EXACT", "matrix<int>"), "[[1,2],[]]\n", "[[1,2]]\n")).toBe("different");
    expect(kind(spec("EXACT", "pair<int,string>"), '[1,"x"]\n', '[1, "x"]\n')).toBe("equal");
    expect(kind(spec("EXACT", "pair<int,string>"), '[1,"x"]\n', '[1,"x",2]\n')).toBe("malformed-output");
    expect(kind(spec("EXACT", "list<bool>"), "[true,false]\n", "[true,false]\n")).toBe("equal");
  });
});

describe("compareFunctionOutput — FLOAT_TOLERANCE", () => {
  it("matches doubles within the absolute or relative epsilon, whatever the spelling", () => {
    const d = spec("FLOAT_TOLERANCE", "double");
    expect(kind(d, "1\n", "1.0\n")).toBe("equal");
    expect(kind(d, "0.1\n", "1.0E-1\n")).toBe("equal");
    expect(kind(d, "0.5\n", "0.5000005\n")).toBe("equal");
    expect(kind(d, "0.5\n", "0.50001\n")).toBe("different");
    expect(kind(d, "1000000\n", "1000000.5\n")).toBe("equal"); // relative
  });

  it("keeps the structure and every non-double exact", () => {
    const p = spec("FLOAT_TOLERANCE", "list<pair<string,double>>");
    expect(kind(p, '[["a",1.5]]\n', '[["a",1.5000001]]\n')).toBe("equal");
    expect(kind(p, '[["a",1.5]]\n', '[["b",1.5]]\n')).toBe("different");
    expect(kind(p, '[["a",1.5]]\n', "[]\n")).toBe("different");
  });

  it("uses the version's epsilon", () => {
    expect(kind(spec("FLOAT_TOLERANCE", "double", 0.1), "1\n", "1.05\n")).toBe("equal");
    expect(kind(spec("FLOAT_TOLERANCE", "double", 1e-9), "1\n", "1.000001\n")).toBe("different");
  });
});

describe("compareFunctionOutput — SET_EQUAL and ROWS_ANY_ORDER", () => {
  it("SET_EQUAL ignores order at every level but keeps multiplicity and pair order", () => {
    const list = spec("SET_EQUAL", "list<int>");
    expect(kind(list, "[1,2,3]\n", "[3,1,2]\n")).toBe("equal");
    expect(kind(list, "[1,1,2]\n", "[1,2,2]\n")).toBe("different");
    const m = spec("SET_EQUAL", "matrix<int>");
    expect(kind(m, "[[1,2],[3]]\n", "[[3],[2,1]]\n")).toBe("equal");
    const pairs = spec("SET_EQUAL", "list<pair<int,int>>");
    expect(kind(pairs, "[[1,2],[3,4]]\n", "[[3,4],[1,2]]\n")).toBe("equal");
    expect(kind(pairs, "[[1,2]]\n", "[[2,1]]\n")).toBe("different");
    const strings = spec("SET_EQUAL", "list<string>");
    expect(kind(strings, '["ab","c"]\n', '["c","ab"]\n')).toBe("equal");
    expect(kind(strings, '["ab","c"]\n', '["c","ba"]\n')).toBe("different");
  });

  it("ROWS_ANY_ORDER ignores only the row order", () => {
    const m = spec("ROWS_ANY_ORDER", "matrix<int>");
    expect(kind(m, "[[1,2],[3,4]]\n", "[[3,4],[1,2]]\n")).toBe("equal");
    expect(kind(m, "[[1,2],[3,4]]\n", "[[4,3],[1,2]]\n")).toBe("different");
    expect(kind(m, "[[1,2],[1,2]]\n", "[[1,2]]\n")).toBe("different");
  });
});

describe("compareFunctionOutput — IN_PLACE_MUTATION and CUSTOM_CHECKER", () => {
  it("IN_PLACE_MUTATION compares the printed parameter exactly", () => {
    const s = spec("IN_PLACE_MUTATION", "list<int>");
    expect(kind(s, "[3,1,2]\n", "[3,1,2]\n")).toBe("equal");
    expect(kind(s, "[3,1,2]\n", "[1,2,3]\n")).toBe("different");
  });

  it("CUSTOM_CHECKER is never compared here; its output is canonicalised for the checker", () => {
    const s = spec("CUSTOM_CHECKER", "pair<int,int>");
    expect(() => compareFunctionOutput(s, "[0,1]\n", "[0,1]\n")).toThrow();
    expect(canonicalizeFunctionOutput(s, " [ 0 , 1 ] \n")).toEqual({ ok: true, text: "[0,1]" });
    expect(canonicalizeFunctionOutput(spec("CUSTOM_CHECKER", "double"), "1.0E-1\n")).toEqual({ ok: true, text: "0.1" });
    expect(canonicalizeFunctionOutput(spec("CUSTOM_CHECKER", "TreeNode"), "null\n")).toEqual({ ok: true, text: "[]" });
    expect(canonicalizeFunctionOutput(s, "")).toEqual({ ok: false, reason: EMPTY_OUTPUT_REASON });
    expect(canonicalizeFunctionOutput(s, "hello\n[0,1]\n")).toEqual({ ok: false, reason: EXTRA_OUTPUT_REASON });
  });
});

describe("functionCompareSpec", () => {
  it("compares the return type, or the mutated parameter's type", () => {
    expect(functionCompareSpec(TWO_SUM.signature, null)).toEqual({
      comparator: "EXACT",
      type: parseType("list<int>"),
      floatEpsilon: DEFAULT_FLOAT_EPSILON,
    });
    const inPlace = functionCompareSpec(
      { comparator: "IN_PLACE_MUTATION", params: [{ name: "grid", type: "matrix<int>" }], returns: "void", mutatedParam: "grid" },
      0.5,
    );
    expect(inPlace).toEqual({ comparator: "IN_PLACE_MUTATION", type: parseType("matrix<int>"), floatEpsilon: 0.5 });
  });
});

describe("comparatorIssues (the publish gate)", () => {
  const fn = (patch: Partial<ComparatorDeclaration> & { sig?: Record<string, unknown> }): ComparatorDeclaration => ({
    ioMode: "FUNCTION",
    compareMode: "TOKEN",
    functionSignature: { ...TWO_SUM.signature, ...(patch.sig ?? {}) },
    floatEpsilon: null,
    checkerSha256: null,
    testlibId: null,
    ...patch,
  });

  it("accepts the published seeds' EXACT + TOKEN declaration", () => {
    expect(comparatorIssues(fn({}))).toEqual([]);
  });

  it("refuses a FUNCTION version without a signature or without a comparator", () => {
    expect(comparatorIssues(fn({ functionSignature: null })).join()).toMatch(/must declare/);
    const { comparator: _drop, ...noComparator } = TWO_SUM.signature;
    expect(comparatorIssues(fn({ functionSignature: noComparator })).join()).toMatch(/does not declare a comparator/);
  });

  it("refuses an invalid signature", () => {
    expect(comparatorIssues(fn({ sig: { returns: "double" } })).join()).toMatch(/signature is invalid/);
  });

  it("holds the CHECKER mirror both ways", () => {
    expect(comparatorIssues(fn({ compareMode: "CHECKER", checkerSha256: "a".repeat(64), testlibId: "testlib-0.9.41" })).join()).toMatch(
      /CHECKER goes only with the CUSTOM_CHECKER/,
    );
    const custom = { sig: { comparator: "CUSTOM_CHECKER" } };
    expect(comparatorIssues(fn({ ...custom, compareMode: "TOKEN" })).join()).toMatch(/needs compare mode CHECKER/);
    expect(comparatorIssues(fn({ ...custom, compareMode: "CHECKER" })).join()).toMatch(/needs a checker/);
    expect(comparatorIssues(fn({ ...custom, compareMode: "CHECKER", checkerSha256: "a".repeat(64), testlibId: "testlib-0.9.41" }))).toEqual([]);
  });

  it("bounds the float tolerance to (0, 1]", () => {
    const float = { sig: { comparator: "FLOAT_TOLERANCE", returns: "double" } };
    expect(comparatorIssues(fn({ ...float, floatEpsilon: null }))).toEqual([]);
    expect(comparatorIssues(fn({ ...float, floatEpsilon: 1e-9 }))).toEqual([]);
    expect(comparatorIssues(fn({ ...float, floatEpsilon: 0 })).join()).toMatch(/greater than 0/);
    expect(comparatorIssues(fn({ ...float, floatEpsilon: 2 })).join()).toMatch(/at most 1/);
  });

  it("STDIN: INTERACTIVE is unavailable and CHECKER needs a checker", () => {
    const stdin = { ioMode: "STDIN" as const, functionSignature: null };
    expect(comparatorIssues(fn({ ...stdin, compareMode: "TOKEN" }))).toEqual([]);
    expect(comparatorIssues(fn({ ...stdin, compareMode: "INTERACTIVE" })).join()).toMatch(/Interactive/);
    expect(comparatorIssues(fn({ ...stdin, compareMode: "CHECKER" })).join()).toMatch(/needs a checker/);
    expect(comparatorIssues(fn({ ...stdin, compareMode: "FLOAT", floatEpsilon: -1 })).join()).toMatch(/greater than 0/);
  });
});
