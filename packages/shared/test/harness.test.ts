import { describe, expect, it } from "vitest";
import { buildHarness, harnessFamily, HarnessUnsupportedError, remapDiagnostics, supportsFunctionMode } from "../src/harness";
import { TWO_SUM, TWO_SUM_REFERENCE, TWO_SUM_STARTER } from "../src/samples/two-sum";

const sig = TWO_SUM.signature;
const cppUser = TWO_SUM_REFERENCE.cpp20![0]!.source;
const pyUser = TWO_SUM_REFERENCE.py312![0]!.source;

function programLine(source: string, n: number): string {
  return source.split("\n")[n - 1] ?? "";
}

describe("buildHarness", () => {
  it.each([
    ["cpp20", cppUser, "solution.cpp"],
    ["py312", pyUser, "solution.py"],
  ] as const)("places %s user code verbatim at userStartLine", (language, user, displayName) => {
    const build = buildHarness(language, sig, user);
    const userLines = user.replace(/\n$/, "").split("\n");
    expect(build.displayName).toBe(displayName);
    expect(build.userLineCount).toBe(userLines.length);
    userLines.forEach((text, i) => {
      expect(programLine(build.source, build.userStartLine + i)).toBe(text);
    });
    // Nothing of the student's code precedes userStartLine.
    expect(build.source.split("\n").slice(0, build.userStartLine - 1).join("\n")).not.toContain("class Solution");
  });

  it("normalises CRLF and a missing final newline without shifting lines", () => {
    const crlf = cppUser.replace(/\n/g, "\r\n").replace(/\r\n$/, "");
    const a = buildHarness("cpp20", sig, crlf);
    const b = buildHarness("cpp20", sig, cppUser);
    expect(a.source).toBe(b.source);
    expect(a.userStartLine).toBe(b.userStartLine);
    expect(a.userLineCount).toBe(b.userLineCount);
  });

  it("generates a C++ driver that reads both parameters and writes the result", () => {
    const { source } = buildHarness("cpp20", sig, cppUser);
    expect(source).toContain("int main()");
    expect(source).toContain("vector<int> a0{};");
    expect(source).toContain("long long a1{};");
    expect(source).toContain("sol.twoSum(a0, a1)");
  });

  it("generates a Python driver that reads both parameters and writes JSON", () => {
    const { source } = buildHarness("py312", sig, pyUser);
    expect(source).toContain("_a0 = json.loads(_lines[0])");
    expect(source).toContain("_a1 = json.loads(_lines[1])");
    expect(source).toContain("_r = Solution().twoSum(_a0, _a1)");
    expect(source.trimEnd().endsWith("_recx_main()")).toBe(true);
  });

  it("accepts the shipped starter code", () => {
    for (const language of ["cpp20", "py312"] as const) {
      const starter = TWO_SUM_STARTER[language]!;
      const build = buildHarness(language, sig, starter);
      expect(programLine(build.source, build.userStartLine)).toBe(starter.split("\n")[0]);
    }
  });

  it("refuses languages without a FUNCTION harness", () => {
    expect(supportsFunctionMode("cpp20")).toBe(true);
    expect(supportsFunctionMode("py312")).toBe(true);
    expect(supportsFunctionMode("java21")).toBe(true);
    expect(supportsFunctionMode("c17")).toBe(false);
    expect(() => harnessFamily("go123")).toThrow(HarnessUnsupportedError);
    expect(() => buildHarness("node22", sig, "")).toThrow(HarnessUnsupportedError);
    expect(() => buildHarness("c17", sig, "")).toThrow(HarnessUnsupportedError);
    expect(() => buildHarness("kotlin20", sig, "")).toThrow(HarnessUnsupportedError);
  });
});

describe("remapDiagnostics (C++)", () => {
  const build = buildHarness("cpp20", sig, cppUser);
  const start = build.userStartLine;
  const afterUser = start + build.userLineCount + 3; // a line inside the generated driver

  it("maps a gcc diagnostic on user line 3 to solution.cpp:3:5", () => {
    const out = remapDiagnostics(`main.cpp:${start + 2}:5: error: 'foo' was not declared in this scope`, build, "main.cpp");
    expect(out).toBe("solution.cpp:3:5: error: 'foo' was not declared in this scope");
  });

  it("maps line-only locations and the file banner", () => {
    const out = remapDiagnostics(
      [`main.cpp: In member function 'std::vector<int> Solution::twoSum(std::vector<int>&, long long int)':`, `main.cpp:${start}: note: here`].join("\n"),
      build,
      "main.cpp",
    );
    expect(out.split("\n")).toEqual([
      "solution.cpp: In member function 'std::vector<int> Solution::twoSum(std::vector<int>&, long long int)':",
      "solution.cpp:1: note: here",
    ]);
  });

  it("labels locations inside generated code instead of showing their line", () => {
    const out = remapDiagnostics(`main.cpp:${afterUser}:12: error: no matching function for call`, build, "main.cpp");
    expect(out).toBe("[generated driver code]: error: no matching function for call");
    expect(out).not.toMatch(/main\.cpp|solution\.cpp|\d/);
  });

  it("labels prelude locations too", () => {
    const out = remapDiagnostics(`main.cpp:1:1: warning: something in the prelude`, build, "main.cpp");
    expect(out).toBe("[generated driver code]: warning: something in the prelude");
  });

  it("renumbers gcc source excerpts and drops excerpts of generated code", () => {
    const n = String(start + 2);
    const g = String(afterUser);
    const raw = [
      `main.cpp:${n}:5: error: expected ';' before 'return'`,
      `    ${n} |     int x = 1`,
      `      ${" ".repeat(n.length - 1)}|          ^`,
      `main.cpp:${g}:3: note: in generated code`,
      `  ${g} |     recx_harness::write(cout, result);`,
    ].join("\n");
    const lines = remapDiagnostics(raw, build, "main.cpp").split("\n");
    expect(lines[0]).toBe("solution.cpp:3:5: error: expected ';' before 'return'");
    expect(lines[1]).toBe(`    ${"3".padStart(n.length)} |     int x = 1`);
    expect(lines).not.toContain(`  ${g} |     recx_harness::write(cout, result);`);
    expect(lines.some((l) => l.includes("recx_harness::write"))).toBe(false);
    // A note located in generated code is dropped with its excerpt.
    expect(lines.some((l) => l.includes("in generated code"))).toBe(false);
    expect(lines).toHaveLength(3);
  });

  it("leaves unrelated text alone", () => {
    const text = "collect2: error: ld returned 1 exit status";
    expect(remapDiagnostics(text, build, "main.cpp")).toBe(text);
  });
});

describe("remapDiagnostics (Python)", () => {
  const build = buildHarness("py312", sig, pyUser);
  const start = build.userStartLine;
  const driverLine = start + build.userLineCount + 5;

  it("maps user frames to solution.py and drops harness frames with their source lines", () => {
    const traceback = [
      "Traceback (most recent call last):",
      `  File "main.py", line ${driverLine + 20}, in <module>`,
      "    _recx_main()",
      `  File "main.py", line ${driverLine}, in _recx_main`,
      "    _r = Solution().twoSum(_a0, _a1)",
      `  File "main.py", line ${start + 4}, in twoSum`,
      "    j = seen.get(target - x)",
      "TypeError: unsupported operand type(s) for -: 'str' and 'int'",
    ].join("\n");
    expect(remapDiagnostics(traceback, build, "main.py").split("\n")).toEqual([
      "Traceback (most recent call last):",
      '  File "solution.py", line 5, in twoSum',
      "    j = seen.get(target - x)",
      "TypeError: unsupported operand type(s) for -: 'str' and 'int'",
    ]);
  });

  it("maps frames that carry the /box/ prefix", () => {
    const out = remapDiagnostics(`  File "/box/main.py", line ${start + 1}, in twoSum`, build, "main.py");
    expect(out).toBe('  File "solution.py", line 2, in twoSum');
  });

  it("maps a SyntaxError location from the compile step", () => {
    const raw = [`  File "main.py", line ${start + 2}`, "    seen = {", "           ^", "SyntaxError: '{' was never closed"].join("\n");
    expect(remapDiagnostics(raw, build, "main.py").split("\n")).toEqual([
      '  File "solution.py", line 3',
      "    seen = {",
      "           ^",
      "SyntaxError: '{' was never closed",
    ]);
  });
});
