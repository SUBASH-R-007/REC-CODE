import { describe, expect, it } from "vitest";
import { parseType, type FunctionSignature } from "../src/harness/signature";
import { decodeValue, parseValue, serializeArgs, serializeValue, validateFunctionTest, ValueError } from "../src/harness/values";

const t = parseType;

describe("serializeValue / parseValue round trips", () => {
  const cases: Array<[type: string, value: unknown, wire: string]> = [
    ["int", 0, "0"],
    ["int", -42, "-42"],
    ["int", 2 ** 31 - 1, "2147483647"],
    ["int", -(2 ** 31), "-2147483648"],
    ["long", 2_000_000_000, "2000000000"],
    ["long", -9_007_199_254_740_991, "-9007199254740991"],
    ["double", 1.5, "1.5"],
    ["double", -0.001, "-0.001"],
    ["double", 1e-9, "1e-9"],
    ["bool", true, "true"],
    ["bool", false, "false"],
    ["char", "a", '"a"'],
    ["char", '"', '"\\""'],
    ["string", "", '""'],
    ["string", "hello world", '"hello world"'],
    ["void", null, "null"],
    ["list<int>", [], "[]"],
    ["list<int>", [2, 7, 11, 15], "[2,7,11,15]"],
    ["list<string>", ["a", "b c"], '["a","b c"]'],
    ["list<bool>", [true, false], "[true,false]"],
    ["list<double>", [0.5, 2.25], "[0.5,2.25]"],
    ["matrix<int>", [[1, 2], [3, 4], []], "[[1,2],[3,4],[]]"],
    ["matrix<char>", [["x", "o"], ["o", "x"]], '[["x","o"],["o","x"]]'],
    ["pair<int,string>", [1, "one"], '[1,"one"]'],
    ["list<pair<int,long>>", [[1, 2], [3, 4]], "[[1,2],[3,4]]"],
    ["list<list<int>>", [[1], [2, 3]], "[[1],[2,3]]"],
    ["TreeNode", [1, null, 2, 3], "[1,null,2,3]"],
    ["TreeNode", [], "[]"],
    ["ListNode", [1, 2, 3], "[1,2,3]"],
    ["ListNode", [], "[]"],
  ];

  it.each(cases)("%s %j ⇄ %s", (type, value, wire) => {
    expect(serializeValue(t(type), value)).toBe(wire);
    expect(parseValue(t(type), wire)).toEqual(value);
  });

  it("serialises a long given as a bigint", () => {
    expect(serializeValue(t("long"), 9_223_372_036_854_775_807n)).toBe("9223372036854775807");
    expect(serializeValue(t("long"), -5n)).toBe("-5");
  });

  it("writes every value on a single line", () => {
    const wire = serializeValue(t("list<string>"), ["a\nb", "c\r\nd"]);
    expect(wire).not.toMatch(/[\r\n]/);
  });
});

describe("int and long range checks", () => {
  it.each([2 ** 31, -(2 ** 31) - 1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])("rejects int %s", (v) => {
    expect(() => serializeValue(t("int"), v)).toThrow(ValueError);
  });

  it.each(["1", null, true, 1n])("rejects a non-number int (%s)", (v) => {
    expect(() => serializeValue(t("int"), v)).toThrow(ValueError);
  });

  it("rejects a long outside the safe-integer range unless given as a bigint", () => {
    expect(() => serializeValue(t("long"), 2 ** 53)).toThrow(ValueError);
    expect(() => serializeValue(t("long"), 0.5)).toThrow(ValueError);
    expect(serializeValue(t("long"), Number.MAX_SAFE_INTEGER)).toBe("9007199254740991");
  });

  it("checks ints inside containers and trees", () => {
    expect(() => serializeValue(t("list<int>"), [1, 2 ** 31])).toThrow(ValueError);
    expect(() => serializeValue(t("TreeNode"), [1, 2 ** 31])).toThrow(ValueError);
    expect(() => serializeValue(t("ListNode"), [1, "2"])).toThrow(ValueError);
  });
});

describe("string escaping matches JSON.stringify", () => {
  const samples = [
    'quote " inside',
    "back\\slash",
    "new\nline",
    "tab\tand\rreturn",
    "\b\f",
    "\u0000\u0001\u001f",
    "unicode: café, नमस्ते, 漢字",
    "emoji: 🎉",
    "</script>",
  ];

  it.each(samples)("escapes %j exactly like JSON.stringify", (s) => {
    expect(serializeValue(t("string"), s)).toBe(JSON.stringify(s));
    expect(parseValue(t("string"), serializeValue(t("string"), s))).toBe(s);
  });

  it("writes a lone surrogate like JSON.stringify, but never decodes one (not well-formed Unicode)", () => {
    const s = "lone surrogate \ud800";
    expect(serializeValue(t("string"), s)).toBe(JSON.stringify(s));
    expect(() => parseValue(t("string"), serializeValue(t("string"), s))).toThrow(ValueError);
  });

  it("escapes strings nested in containers the same way", () => {
    const value = [["a\"b", "c\\d"], ["\n"]];
    expect(serializeValue(t("matrix<string>"), value)).toBe(JSON.stringify(value));
  });

  it("accepts exactly one ASCII character for char (C++ char is a byte)", () => {
    expect(serializeValue(t("char"), "a")).toBe('"a"');
    expect(serializeValue(t("char"), "\u007f")).toBe(JSON.stringify("\u007f"));
    expect(() => serializeValue(t("char"), "🎉")).toThrow(ValueError);
    expect(() => serializeValue(t("char"), "é")).toThrow(ValueError);
    expect(() => serializeValue(t("char"), "ab")).toThrow(ValueError);
    expect(() => serializeValue(t("char"), "")).toThrow(ValueError);
  });
});

describe("type mismatches", () => {
  it.each([
    ["double", Number.NaN],
    ["double", Number.POSITIVE_INFINITY],
    ["double", "1.5"],
    ["bool", 1],
    ["string", 5],
    ["list<int>", "1,2"],
    ["matrix<int>", [1, 2]],
    ["pair<int,int>", [1]],
    ["pair<int,int>", [1, 2, 3]],
    ["TreeNode", { val: 1 }],
  ])("serializeValue(%s, %j) throws ValueError", (type, value) => {
    expect(() => serializeValue(t(type), value)).toThrow(ValueError);
  });

  it.each([
    ["int", '"1"'],
    ["bool", "1"],
    ["string", "1"],
    ["list<int>", "{}"],
    ["pair<int,int>", "[1]"],
    ["TreeNode", "1"],
  ])("parseValue(%s, %s) throws ValueError", (type, wire) => {
    expect(() => parseValue(t(type), wire)).toThrow(ValueError);
  });
});

describe("serializeArgs", () => {
  it("writes one line per parameter, newline-terminated", () => {
    const types = [t("list<int>"), t("long")];
    expect(serializeArgs(types, [[2, 7, 11, 15], 9])).toBe("[2,7,11,15]\n9\n");
  });

  it("rejects an argument count that does not match the signature", () => {
    expect(() => serializeArgs([t("int")], [1, 2])).toThrow(ValueError);
    expect(() => serializeArgs([t("int"), t("int")], [1])).toThrow(ValueError);
  });
});

/**
 * Ported from PR #1 (the Phase 4 adversarial review), whose fixes to this
 * file were never merged.
 */
describe("decoding refuses an overlong integer without reading all of it", () => {
  it("fails fast on a four-million-digit token, and still takes the longest valid long", () => {
    const huge = "9".repeat(4_000_000);
    const started = Date.now();
    const r = decodeValue(t("list<long>"), `[${huge}]`);
    expect(Date.now() - started).toBeLessThan(200);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/^9{24}… is outside the 64-bit long range$/);
    expect(decodeValue(t("long"), "-9223372036854775808")).toMatchObject({ ok: true, canonical: "-9223372036854775808" });
    expect(decodeValue(t("long"), "9223372036854775808").ok).toBe(false);
  });
});

describe("validateFunctionTest: in-place arrays keep their length (Java)", () => {
  const sig = (type: string): FunctionSignature => ({
    className: "Solution",
    methodName: "f",
    params: [{ name: "nums", type }],
    returns: "void",
    comparator: "IN_PLACE_MUTATION",
    mutatedParam: "nums",
  });

  it("refuses an expected list<int> of another length", () => {
    expect(validateFunctionTest(sig("list<int>"), "[1,2,3]\n", "[2,3,1]\n")).toEqual([]);
    const issues = validateFunctionTest(sig("list<int>"), "[1,2,2,3]\n", "[1,2,3]\n");
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatch(/has 3 elements but the input has 4/);
  });

  it("checks only the outer length of a matrix<leaf>, and not list<list<…>> (an ArrayList in Java)", () => {
    expect(validateFunctionTest(sig("matrix<int>"), "[[1,2],[3]]\n", "[[1],[2,3]]\n")).toEqual([]);
    expect(validateFunctionTest(sig("matrix<int>"), "[[1,2],[3]]\n", "[[1,2]]\n")).toHaveLength(1);
    expect(validateFunctionTest(sig("list<list<int>>"), "[[1],[2]]\n", "[[1]]\n")).toEqual([]);
  });
});
