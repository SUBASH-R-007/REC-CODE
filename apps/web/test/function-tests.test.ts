import { describe, expect, it } from "vitest";
import { functionTestIssues } from "@/lib/authoring/function-tests";

/**
 * FUNCTION tests entered through the test editor (and re-checked at
 * publish) must be exactly canonical, as a bulk import requires: forms the
 * C++ reader accepts but Python or Java reject are refused.
 */

const version = {
  ioMode: "FUNCTION",
  functionSignature: {
    className: "Solution",
    methodName: "echo",
    params: [{ name: "x", type: "int" }],
    returns: "int",
    comparator: "EXACT",
    mutatedParam: null,
  },
};
const test = (input: string, output: string, label = "Test 0") => ({
  label,
  input: Buffer.from(input, "utf8"),
  output: Buffer.from(output, "utf8"),
});

describe("functionTestIssues", () => {
  it("accepts a canonical test", () => {
    expect(functionTestIssues(version, [test("9\n", "9\n")])).toEqual([]);
  });

  it.each([
    ["leading zeros", "009\n"],
    ["a plus sign", "+9\n"],
    ["a decimal point for an int", "9.0\n"],
    ["trailing text", "9 trailing\n"],
  ])("refuses %s in the input", (_name, input) => {
    const issues = functionTestIssues(version, [test(input, "9\n", "New test 1")]);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0]).toMatch(/^New test 1: /);
  });

  it("refuses bytes that are not UTF-8", () => {
    expect(functionTestIssues(version, [{ label: "Test 2", input: Buffer.from([0xff, 0x0a]), output: Buffer.from("9\n") }])).toEqual([
      "Test 2: a FUNCTION test is UTF-8 text.",
    ]);
  });

  it("checks nothing for a STDIN revision, and reports an invalid signature once", () => {
    expect(functionTestIssues({ ioMode: "STDIN", functionSignature: null }, [test("009\n", "x\n")])).toEqual([]);
    expect(functionTestIssues({ ioMode: "FUNCTION", functionSignature: { bad: true } }, [test("9\n", "9\n")])).toHaveLength(1);
  });

  it("stops at the limit", () => {
    const many = Array.from({ length: 30 }, (_, i) => test("009\n", "9\n", `Test ${i}`));
    expect(functionTestIssues(version, many, 5)).toHaveLength(5);
  });
});
