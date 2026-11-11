import { describe, expect, it } from "vitest";
import { PermanentJudgeError } from "../src/errors";
import { UnsupportedCompareModeError, compareOutputs, isBuiltinCompareMode, parseNumericToken } from "../src/judge/compare";

const b = (s: string) => Buffer.from(s, "utf8");

describe("TOKEN (default)", () => {
  it.each([
    ["1 2 3\n", "1 2 3\n", true],
    ["1 2 3\n", "1  2\t3", true],
    ["1 2 3\n", "\n\n1\n2\n3\n\n", true],
    ["1 2 3\r\n", "1 2 3\n", true],
    ["[0,1]\n", "[0,1]", true],
    ["", "   \n", true],
    ["1 2 3", "1 2", false],
    ["1 2", "1 2 3", false],
    ["1 2 3", "1 2 4", false],
    ["abc", "ABC", false],
    ["12", "1 2", false],
    ["1.0", "1", false],
  ])("%j vs %j → %s", (expected, actual, equal) => {
    expect(compareOutputs("TOKEN", b(expected), b(actual))).toBe(equal);
  });

  it("handles large outputs without building token arrays", () => {
    const expected = Buffer.from("7 ".repeat(1_000_000));
    const actual = Buffer.from("7\n".repeat(1_000_000));
    expect(compareOutputs("TOKEN", expected, actual)).toBe(true);
  });
});

describe("EXACT", () => {
  it("is byte equality", () => {
    expect(compareOutputs("EXACT", b("a b\n"), b("a b\n"))).toBe(true);
    expect(compareOutputs("EXACT", b("a b\n"), b("a b"))).toBe(false);
    expect(compareOutputs("EXACT", b("a b\n"), b("a  b\n"))).toBe(false);
    expect(compareOutputs("EXACT", b("a\n"), b("a\r\n"))).toBe(false);
  });
});

describe("FLOAT", () => {
  it.each([
    ["3.14159265", "3.1415927", true], // within 1e-6 absolute
    ["0.1 0.2", "0.1000004 0.2", true],
    ["1000000", "1000000.5", true], // relative: 0.5 ≤ 1e-6 × 1e6
    ["1000000", "1000002", false],
    ["1.5", "1.6", false],
    ["1e-9", "0", true],
    ["2.5E3", "2500", true],
    ["YES 1.0", "YES 1.0000001", true],
    ["YES 1.0", "yes 1.0", false], // non-numeric tokens are exact
    ["1.0", "abc", false],
    ["abc", "1.0", false],
    ["1 2", "1", false],
  ])("%j vs %j → %s", (expected, actual, equal) => {
    expect(compareOutputs("FLOAT", b(expected), b(actual))).toBe(equal);
  });

  it("honours the problem's epsilon", () => {
    expect(compareOutputs("FLOAT", b("1.0"), b("1.01"), { floatEpsilon: 0.05 })).toBe(true);
    expect(compareOutputs("FLOAT", b("1.0"), b("1.01"), { floatEpsilon: 1e-3 })).toBe(false);
  });

  it("does not treat NaN / inf spellings as numbers", () => {
    expect(parseNumericToken("nan")).toBeNull();
    expect(parseNumericToken("inf")).toBeNull();
    expect(parseNumericToken("-.5")).toBe(-0.5);
  });
});

describe("modes that are not built-in comparisons", () => {
  it.each(["CHECKER", "INTERACTIVE"] as const)("%s is refused as a permanent failure", (mode) => {
    expect(() => compareOutputs(mode, b("1"), b("1"))).toThrow(UnsupportedCompareModeError);
    expect(() => compareOutputs(mode, b("1"), b("1"))).toThrow(PermanentJudgeError);
    expect(isBuiltinCompareMode(mode)).toBe(false);
  });

  it("TOKEN, EXACT and FLOAT are built in", () => {
    expect((["TOKEN", "EXACT", "FLOAT"] as const).every(isBuiltinCompareMode)).toBe(true);
  });
});
