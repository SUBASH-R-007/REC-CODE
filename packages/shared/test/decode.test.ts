import { describe, expect, it } from "vitest";
import { parseType, type FunctionSignature } from "../src/harness/signature";
import {
  decodeCanonical,
  hasLoneSurrogate,
  parseValue,
  serializeArgs,
  serializeValue,
  validateFunctionInput,
  validateFunctionTest,
} from "../src/harness/values";
import { generateTwoSumTests, TWO_SUM } from "../src/samples/two-sum";

const canon = (type: string, text: string) => decodeCanonical(parseType(type), text);
const ok = (type: string, text: string) => {
  const r = canon(type, text);
  if (!r.ok) throw new Error(`${type} ${JSON.stringify(text)}: ${r.reason}`);
  return r.canonical;
};

describe("decodeCanonical", () => {
  it.each([
    ["int", " -0 ", "0"],
    ["int", "-2147483648", "-2147483648"],
    ["long", "-9223372036854775808", "-9223372036854775808"],
    ["long", "9007199254740993", "9007199254740993"],
    ["double", "1.0", "1"],
    ["double", "1.0E-9", "1e-9"],
    ["double", "-0.0", "0"],
    ["double", "2.5e+3", "2500"],
    ["bool", "true", "true"],
    ["string", '"a\\/b\\u0041"', '"a/bA"'],
    ["string", '"tab\\there"', '"tab\\there"'],
    ["string", '"\\u0001"', '"\\u0001"'],
    ["char", '"\\u0041"', '"A"'],
    ["list<int>", "[ 1 , 2 ]", "[1,2]"],
    ["list<int>", "[]", "[]"],
    ["matrix<int>", "[[1],[ ],[2,3]]", "[[1],[],[2,3]]"],
    ["pair<long,string>", '[5, "x"]', '[5,"x"]'],
    ["TreeNode", "null", "[]"],
    ["TreeNode", "[null,1]", "[]"],
    ["TreeNode", "[1,null,2,null,null]", "[1,null,2]"],
    ["TreeNode", "[1,2,3,null,null,4,5]", "[1,2,3,null,null,4,5]"],
    ["TreeNode", "[1,null,null,9,9]", "[1]"],
    ["ListNode", "null", "[]"],
    ["ListNode", "[3, 1]", "[3,1]"],
    ["void", "null", "null"],
  ])("%s %s → %s", (type, text, expected) => {
    expect(ok(type, text)).toBe(expected);
  });

  it.each([
    ["int", "2147483648"],
    ["int", "+1"],
    ["int", "1e3"],
    ["int", "1.5"],
    ["int", "01"],
    ["int", "-"],
    ["long", "9223372036854775808"],
    ["double", "NaN"],
    ["double", "Infinity"],
    ["double", "1e999"],
    ["double", ".5"],
    ["bool", "True"],
    ["string", '"unterminated'],
    ["string", '"raw\ttab"'],
    ["string", '"\\x41"'],
    ["string", '"\\ud800"'],
    ["string", "'single'"],
    ["char", '"ab"'],
    ["char", '"é"'],
    ["char", '""'],
    ["list<int>", "[1,]"],
    ["list<int>", "[1 2]"],
    ["list<int>", "[1],"],
    ["list<int>", "null"],
    ["pair<int,int>", "[1]"],
    ["pair<int,int>", "[1,2,3]"],
    ["ListNode", "[1,null]"],
    ["TreeNode", "[1,\"x\"]"],
    ["int", "1 2"],
    ["int", ""],
  ])("rejects %s %j", (type, text) => {
    const r = canon(type, text);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason.length).toBeGreaterThan(0);
      expect(r.offset).toBeGreaterThanOrEqual(0);
    }
  });

  it("round-trips every serializeValue output unchanged (serializeValue writes canonical text)", () => {
    const cases: Array<[string, unknown]> = [
      ["list<int>", [2, -7, 0]],
      ["long", 9_223_372_036_854_775_807n],
      ["double", 0.1 + 0.2],
      ["matrix<string>", [["a\"b", "\n"], []]],
      ["list<pair<int,bool>>", [[1, true]]],
      ["TreeNode", [1, null, 2, 3]],
      ["string", "unicode: café, नमस्ते, 漢字, 🎉"],
    ];
    for (const [type, value] of cases) {
      const wire = serializeValue(parseType(type), value);
      expect(ok(type, wire)).toBe(wire);
    }
  });

  it("is linear on large inputs", () => {
    const big = `[${Array.from({ length: 200_000 }, (_, i) => i - 100_000).join(",")}]`;
    const started = Date.now();
    expect(ok("list<int>", big)).toBe(big);
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

describe("parseValue", () => {
  it("returns longs beyond 2^53 as bigint and safe ones as number", () => {
    expect(parseValue(parseType("long"), "9007199254740993")).toBe(9_007_199_254_740_993n);
    expect(parseValue(parseType("long"), "42")).toBe(42);
  });

  it("returns the canonical level order of a tree", () => {
    expect(parseValue(parseType("TreeNode"), "[1,null,2,null,null]")).toEqual([1, null, 2]);
    expect(parseValue(parseType("TreeNode"), "null")).toEqual([]);
  });
});

describe("hasLoneSurrogate", () => {
  it("detects lone high and low surrogates only", () => {
    expect(hasLoneSurrogate("🎉 ok")).toBe(false);
    expect(hasLoneSurrogate("a\ud800")).toBe(true);
    expect(hasLoneSurrogate("\udc00a")).toBe(true);
    expect(hasLoneSurrogate("\ud83c\udf89\ud83c")).toBe(true);
  });
});

describe("validateFunctionInput (custom Run input)", () => {
  const sig = TWO_SUM.signature;

  it("accepts one line per parameter, whitespace and a missing final newline included", () => {
    expect(validateFunctionInput(sig, "[2,7,11,15]\n9\n")).toEqual([]);
    expect(validateFunctionInput(sig, "[2, 7, 11, 15]\r\n9")).toEqual([]);
    expect(validateFunctionInput(sig, "[2,7]\n9\n\n\n")).toEqual([]);
  });

  it("names the line and parameter of each problem", () => {
    const issues = validateFunctionInput(sig, "[2,7,x]\n9.5\n");
    expect(issues).toHaveLength(2);
    expect(issues[0]).toMatch(/^Line 1 \(nums: list<int>\)/);
    expect(issues[1]).toMatch(/^Line 2 \(target: long\)/);
  });

  it("reports missing and extra lines", () => {
    expect(validateFunctionInput(sig, "[1,2]\n").join()).toMatch(/Line 2 \(target: long\) is missing/);
    expect(validateFunctionInput(sig, "").join()).toMatch(/Line 1 .* is missing/);
    expect(validateFunctionInput(sig, "[1,2]\n3\n4\n").join()).toMatch(/Line 3: the method takes 2 parameters/);
  });

  it("refuses strings that are not well-formed Unicode", () => {
    const s: FunctionSignature = { ...sig, params: [{ name: "s", type: "string" }], returns: "int" };
    expect(validateFunctionInput(s, '"\\ud800"\n')).toHaveLength(1);
    expect(validateFunctionInput(s, '"\\ud83c\\udf89"\n')).toEqual([]);
  });
});

describe("validateFunctionTest (authored tests)", () => {
  const sig = TWO_SUM.signature;

  it("accepts every two-sum test (they are generated canonical)", () => {
    for (const t of generateTwoSumTests()) expect(validateFunctionTest(sig, t.input, t.output)).toEqual([]);
  });

  it("requires canonical input lines and output", () => {
    expect(validateFunctionTest(sig, "[2, 7]\n9\n", "[0,1]\n").join()).toMatch(/Input line 1 \(nums\) is not in canonical form: write "\[2,7\]"/);
    expect(validateFunctionTest(sig, "[2,7]\n9\n", "[0, 1]\n").join()).toMatch(/expected output is not in canonical form/);
    expect(validateFunctionTest(sig, "[2,7]\n9\n", "[0,1]").join()).toMatch(/must end with a newline/);
    expect(validateFunctionTest(sig, "[2,7]\n9", "[0,1]\n").join()).toMatch(/input must end with a newline/);
    expect(validateFunctionTest(sig, "[2,7]\n", "[0,1]\n").join()).toMatch(/1 line; the method takes 2/);
    expect(validateFunctionTest(sig, "[2,7]\n9\n", "[0,1]\n[0,1]\n").join()).toMatch(/single line/);
    expect(validateFunctionTest(sig, "[2,7]\n9\n", '"x"\n').join()).toMatch(/not a valid list<int>/);
  });

  it("checks the mutated parameter's type under IN_PLACE_MUTATION", () => {
    const inPlace: FunctionSignature = {
      className: "Solution",
      methodName: "shift",
      params: [
        { name: "a", type: "list<int>" },
        { name: "k", type: "int" },
      ],
      returns: "void",
      comparator: "IN_PLACE_MUTATION",
      mutatedParam: "a",
    };
    const input = serializeArgs([parseType("list<int>"), parseType("int")], [[1, 2, 3], 1]);
    expect(validateFunctionTest(inPlace, input, "[3,1,2]\n")).toEqual([]);
    expect(validateFunctionTest(inPlace, input, "null\n").join()).toMatch(/not a valid list<int>/);
  });

  it("accepts the canonical input of a method without parameters", () => {
    const none: FunctionSignature = { ...sig, params: [], returns: "int" };
    expect(validateFunctionTest(none, "\n", "1\n")).toEqual([]);
  });
});
