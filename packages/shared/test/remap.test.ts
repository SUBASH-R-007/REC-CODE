import { describe, expect, it } from "vitest";
import {
  buildHarness,
  diagnosticHints,
  GENERATED_CODE_HINT,
  MAIN_HINT,
  PUBLIC_CLASS_HINT,
  remapDiagnostics,
  renderDiagnostics,
  STDIN_HINT,
  UNCLOSED_HINT,
  type HarnessBuild,
} from "../src/harness";
import { TWO_SUM, TWO_SUM_REFERENCE } from "../src/samples/two-sum";

const sig = TWO_SUM.signature;
const cpp = buildHarness("cpp20", sig, TWO_SUM_REFERENCE.cpp20![0]!.source);
const py = buildHarness("py312", sig, TWO_SUM_REFERENCE.py312![0]!.source);
const javaUser = [
  "class Solution {",
  "    public int[] twoSum(int[] nums, long target) {",
  "        java.util.HashMap<Long, Integer> seen = new java.util.HashMap<>();",
  "        for (int i = 0; i < nums.length; i++) {",
  "            Integer j = seen.get(target - nums[i]);",
  "            if (j != null) return new int[] {j, i};",
  "            seen.putIfAbsent((long) nums[i], i);",
  "        }",
  "        return new int[0];",
  "    }",
  "}",
  "",
].join("\n");
const java = buildHarness("java21", sig, javaUser);

/** Program line of the student's line n, and a line inside the generated driver. */
const at = (b: HarnessBuild, n: number) => b.userStartLine + n - 1;
const driverLine = (b: HarnessBuild, k = 5) => b.userStartLine + b.userLineCount + k;

/** Every line number a student could read in remapped output. */
function shownLineNumbers(text: string, b: HarnessBuild): number[] {
  const out: number[] = [];
  const display = b.displayName.replace(".", "\\.");
  const patterns = [
    new RegExp(`${display}:(\\d+)`, "g"),
    new RegExp(`File "${display}", line (\\d+)`, "g"),
    new RegExp(`\\(${display}, line (\\d+)\\)`, "g"),
    /^\s*(\d+) \|/gm,
    /\bon line (\d+)/g,
  ];
  for (const re of patterns) for (const m of text.matchAll(re)) out.push(Number(m[1]));
  return out;
}

function expectInRange(text: string, b: HarnessBuild) {
  for (const n of shownLineNumbers(text, b)) {
    expect(n, `line ${n} in:\n${text}`).toBeGreaterThanOrEqual(1);
    expect(n, `line ${n} in:\n${text}`).toBeLessThanOrEqual(b.userLineCount);
  }
  // No other file's line number survives, and the generated program never shows.
  const foreign = [...text.matchAll(/([\w./<>+-]+\.(?:h|hpp|tcc|cpp|cc|java|py|c)):(\d+)/g)].filter((m) => !m[1]!.endsWith(b.displayName));
  expect(foreign.map((m) => m[0])).toEqual([]);
  expect(text).not.toMatch(/\bmain\.cpp\b|\bMain\.java\b|\bmain\.py\b/);
  expect(text).not.toMatch(/recx_harness|_recx_|RecxIn|RecxOut/);
}

describe("gcc", () => {
  const raw = [
    "In file included from /opt/toolchains/gcc-13.2.0/include/c++/13.2.0/vector:66,",
    "                 from main.cpp:1:",
    "main.cpp: In member function 'std::vector<int> Solution::twoSum(std::vector<int>&, long long int)':",
    `main.cpp:${at(cpp, 3)}:13: error: 'foo' was not declared in this scope`,
    `    ${at(cpp, 3)} |             foo();`,
    "      |             ^~~",
    "/opt/toolchains/gcc-13.2.0/include/c++/13.2.0/bits/stl_vector.h:1125:7: note: candidate: 'reference operator[](size_type)'",
    " 1125 |       operator[](size_type __n) _GLIBCXX_NOEXCEPT",
    "      |       ^~~~~~~~",
    "main.cpp: In function 'int main()':",
    `main.cpp:${driverLine(cpp)}:27: error: 'class Solution' has no member named 'twoSum'; did you mean 'twoSums'?`,
    `  ${driverLine(cpp)} |     auto result = sol.twoSum(a0, a1);`,
    "      |                           ^~~~~~",
    `main.cpp:${driverLine(cpp, 2)}:5: note: in generated code`,
    "main.cpp: In instantiation of 'void recx_harness::write(std::ostream&, const std::vector<_Tp>&) [with T = Foo]':",
    `main.cpp:${driverLine(cpp, 3)}:24:   required from here`,
    "compilation terminated.",
  ].join("\n");
  const out = remapDiagnostics(raw, cpp, "main.cpp");

  it("maps student locations and excerpts, labels the driver, drops include chains and generated notes", () => {
    expect(out.split("\n")).toEqual([
      "solution.cpp: In member function 'std::vector<int> Solution::twoSum(std::vector<int>&, long long int)':",
      "solution.cpp:3:13: error: 'foo' was not declared in this scope",
      `    ${"3".padStart(String(at(cpp, 3)).length)} |             foo();`,
      "      |             ^~~",
      "/opt/toolchains/gcc-13.2.0/include/c++/13.2.0/bits/stl_vector.h: note: candidate: 'reference operator[](size_type)'",
      "In the judge's code that calls your function:",
      "[generated driver code]: error: 'class Solution' has no member named 'twoSum'; did you mean 'twoSums'?",
      "compilation terminated.",
    ]);
    expectInRange(out, cpp);
  });

  it("adds the generated-code hint once", () => {
    expect(diagnosticHints(out)).toEqual([GENERATED_CODE_HINT]);
  });

  it("hints at main() and at unclosed braces", () => {
    const dup = remapDiagnostics(`main.cpp:${at(cpp, 2)}:5: error: redefinition of 'int main()'`, cpp, "main.cpp");
    expect(diagnosticHints(dup)).toContain(MAIN_HINT);
    const eof = remapDiagnostics(`main.cpp:${driverLine(cpp, 40)}:1: error: expected '}' at end of input`, cpp, "main.cpp");
    expect(diagnosticHints(eof)).toEqual([GENERATED_CODE_HINT, UNCLOSED_HINT]);
  });

  it("renders sanitised output with the hints after it, within the cap", () => {
    const text = renderDiagnostics(raw, cpp, "main.cpp", 8 * 1024);
    expect(text).not.toContain("/opt/toolchains/");
    expect(text.endsWith(GENERATED_CODE_HINT)).toBe(true);
    const tiny = renderDiagnostics(raw, cpp, "main.cpp", 600);
    expect(new TextEncoder().encode(tiny).byteLength).toBeLessThanOrEqual(600);
    expect(tiny).toContain(GENERATED_CODE_HINT);
  });
});

describe("CPython", () => {
  it("maps user frames, drops harness frames with their source and caret lines, strips library line numbers", () => {
    const raw = [
      "Traceback (most recent call last):",
      `  File "main.py", line ${driverLine(py, 30)}, in <module>`,
      "    _recx_main()",
      `  File "main.py", line ${driverLine(py, 25)}, in _recx_main`,
      "    _r = Solution().twoSum(_a0, _a1)",
      "         ^^^^^^^^^^^^^^^^^^^^^^^^^^^",
      `  File "main.py", line ${at(py, 4)}, in twoSum`,
      "    j = seen.get(target - x)",
      "                 ~~~~~~~^~~",
      '  File "/opt/toolchains/cpython-3.12.6/lib/python3.12/json/__init__.py", line 346, in loads',
      "    return _default_decoder.decode(s)",
      "TypeError: unsupported operand type(s) for -: 'str' and 'int'",
    ].join("\n");
    const out = remapDiagnostics(raw, py, "main.py");
    expect(out.split("\n")).toEqual([
      "Traceback (most recent call last):",
      '  File "solution.py", line 4, in twoSum',
      "    j = seen.get(target - x)",
      "                 ~~~~~~~^~~",
      '  File "/opt/toolchains/cpython-3.12.6/lib/python3.12/json/__init__.py", in loads',
      "    return _default_decoder.decode(s)",
      "TypeError: unsupported operand type(s) for -: 'str' and 'int'",
    ]);
    expectInRange(out, py);
  });

  it("drops the compile-check frame and maps a syntax error", () => {
    const raw = [
      "Traceback (most recent call last):",
      '  File "<string>", line 1, in <module>',
      `  File "main.py", line ${at(py, 2)}`,
      "    def twoSum(self, nums, target)",
      "                                  ^",
      "SyntaxError: expected ':'",
    ].join("\n");
    expect(remapDiagnostics(raw, py, "main.py").split("\n")).toEqual([
      "Traceback (most recent call last):",
      '  File "solution.py", line 2',
      "    def twoSum(self, nums, target)",
      "                                  ^",
      "SyntaxError: expected ':'",
    ]);
  });

  it("points an unfinished method (empty body) at the end of the student's code", () => {
    const raw = [
      `  File "main.py", line ${driverLine(py, 1)}`,
      "    def _recx_out(v):",
      "    ^^^",
      `IndentationError: expected an indented block after function definition on line ${at(py, 2)}`,
    ].join("\n");
    const out = remapDiagnostics(raw, py, "main.py");
    expect(out.split("\n")).toEqual([
      '  File "solution.py", after your last line',
      "IndentationError: expected an indented block after function definition on line 2",
    ]);
    expect(diagnosticHints(out)).toContain(UNCLOSED_HINT);
    expectInRange(out, py);
  });

  it("labels an error raised in the harness itself (a misnamed method) and hints at the signature", () => {
    const raw = [
      "Traceback (most recent call last):",
      `  File "main.py", line ${driverLine(py, 30)}, in <module>`,
      "    _recx_main()",
      `  File "main.py", line ${driverLine(py, 25)}, in _recx_main`,
      "    _r = Solution().twoSum(_a0, _a1)",
      "         ^^^^^^^^^^^^^^^^^",
      "AttributeError: 'Solution' object has no attribute 'twoSum'. Did you mean: 'two_sum'?",
    ].join("\n");
    const out = remapDiagnostics(raw, py, "main.py");
    expect(out.split("\n")).toEqual([
      "Traceback (most recent call last):",
      "  [generated driver code]",
      "AttributeError: 'Solution' object has no attribute 'twoSum'. Did you mean: 'two_sum'?",
    ]);
    expect(diagnosticHints(out)).toEqual([GENERATED_CODE_HINT]);
  });

  it("does not blame the judge's code for an error inside the student's method", () => {
    const raw = [
      "Traceback (most recent call last):",
      `  File "main.py", line ${driverLine(py, 25)}, in _recx_main`,
      "    _r = Solution().twoSum(_a0, _a1)",
      `  File "main.py", line ${at(py, 3)}, in twoSum`,
      "    for i, x in enumerate(nums[5]):",
      "IndexError: list index out of range",
    ].join("\n");
    const out = remapDiagnostics(raw, py, "main.py");
    expect(out).not.toContain("[generated driver code]");
    expect(diagnosticHints(out)).toEqual([]);
  });

  it("hints when the student's code read standard input", () => {
    expect(diagnosticHints(remapDiagnostics("harness: missing input lines", py, "main.py"))).toEqual([STDIN_HINT]);
  });
});

describe("javac and JVM traces", () => {
  it("maps javac errors, drops generated source and caret lines, rewrites the location", () => {
    const raw = [
      `Main.java:${at(java, 5)}: error: cannot find symbol`,
      "            Integer j = seen.get(target - numz[i]);",
      "                                          ^",
      "  symbol:   variable numz",
      "  location: class Solution",
      `Main.java:${driverLine(java, 20)}: error: incompatible types: int[] cannot be converted to long[]`,
      "        long[] result = sol.twoSum(a0, a1);",
      "                                  ^",
      `Main.java:${driverLine(java, 21)}: error: cannot find symbol`,
      "        sol.twoSum(a0);",
      "           ^",
      "  symbol:   method twoSum(int[])",
      "  location: class Main",
      "Note: Main.java uses unchecked or unsafe operations.",
      "3 errors",
    ].join("\n");
    const out = remapDiagnostics(raw, java, "Main.java");
    expect(out.split("\n")).toEqual([
      "Solution.java:5: error: cannot find symbol",
      "            Integer j = seen.get(target - numz[i]);",
      "                                          ^",
      "  symbol:   variable numz",
      "  location: class Solution",
      "[generated driver code]: error: incompatible types: int[] cannot be converted to long[]",
      "[generated driver code]: error: cannot find symbol",
      "  symbol:   method twoSum(int[])",
      "  location: the judge's code that calls your function",
      "Note: Solution.java uses unchecked or unsafe operations.",
      "3 errors",
    ]);
    expectInRange(out, java);
    expect(diagnosticHints(out)).toEqual([GENERATED_CODE_HINT]);
  });

  it("maps JVM stack frames, drops generated frames and strips JDK line numbers", () => {
    const raw = [
      'Exception in thread "main" java.lang.ArrayIndexOutOfBoundsException: Index 5 out of bounds for length 5',
      `\tat Solution.twoSum(Main.java:${at(java, 5)})`,
      "\tat java.base/java.util.HashMap.get(HashMap.java:556)",
      `\tat Main.main(Main.java:${driverLine(java, 30)})`,
      `\tat RecxIn.fail(Main.java:${driverLine(java, 3)})`,
      "\tat java.base/jdk.internal.reflect.DirectMethodHandleAccessor.invoke(Native Method)",
    ].join("\n");
    const out = remapDiagnostics(raw, java, "Main.java");
    expect(out.split("\n")).toEqual([
      'Exception in thread "main" java.lang.ArrayIndexOutOfBoundsException: Index 5 out of bounds for length 5',
      "\tat Solution.twoSum(Solution.java:5)",
      "\tat java.base/java.util.HashMap.get(HashMap.java)",
      "\tat java.base/jdk.internal.reflect.DirectMethodHandleAccessor.invoke(Native Method)",
    ]);
    expectInRange(out, java);
  });

  it("hints at a public class Solution and at redefined judge classes", () => {
    const pub = remapDiagnostics(`Main.java:${at(java, 1)}: error: class Solution is public, should be declared in a file named Solution.java`, java, "Main.java");
    expect(diagnosticHints(pub)).toEqual([PUBLIC_CLASS_HINT]);
    const dup = remapDiagnostics(`Main.java:${driverLine(java, 2)}: error: duplicate class: ListNode`, java, "Main.java");
    expect(diagnosticHints(dup)).toContain("Hint: the judge already defines ListNode; remove your own definition.");
  });
});

describe("property: no output line ever shows a line number outside 1..userLineCount", () => {
  // Deterministic pseudo-random program lines across prelude, student code and driver.
  let seed = 7;
  const next = () => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    return seed;
  };
  const lineOf = (b: HarnessBuild) => 1 + (next() % (b.source.split("\n").length + 20));

  const templates: Record<string, (b: HarnessBuild) => string> = {
    cpp: (b) => {
      const n = lineOf(b);
      const kind = ["error", "warning", "note"][next() % 3];
      return [
        `main.cpp:${n}:${1 + (next() % 30)}: ${kind}: something about line ${n}`,
        `  ${n} |     some code`,
        "      |     ^~~~",
        `main.cpp:${lineOf(b)}:3:   required from here`,
        `/opt/toolchains/gcc-13.2.0/include/c++/13.2.0/bits/stl_algo.h:${lineOf(b)}:5: note: candidate`,
        ` ${lineOf(b)} |   template code`,
        `In file included from main.cpp:${lineOf(b)}:`,
        `note: declared at main.cpp:${lineOf(b)}:9`,
      ].join("\n");
    },
    python: (b) =>
      [
        `  File "main.py", line ${lineOf(b)}, in f`,
        "    code()",
        "    ^^^^^^",
        `  File "/box/main.py", line ${lineOf(b)}`,
        "    x = (",
        `  File "/opt/toolchains/cpython-3.12.6/lib/python3.12/heapq.py", line ${lineOf(b)}, in heappush`,
        `IndentationError: unexpected indent (main.py, line ${lineOf(b)})`,
        `SyntaxError: something after 'if' statement on line ${lineOf(b)}`,
      ].join("\n"),
    java: (b) =>
      [
        `Main.java:${lineOf(b)}: error: something`,
        "        code();",
        "        ^",
        `\tat Solution.f(Main.java:${lineOf(b)})`,
        `\tat java.base/java.util.ArrayList.get(ArrayList.java:${lineOf(b)})`,
        `\tat Main.main(Main.java:${lineOf(b)})`,
      ].join("\n"),
  };

  const builds: Array<[HarnessBuild, string]> = [
    [cpp, "main.cpp"],
    [buildHarness("cpp17", sig, "class Solution {\npublic:\n};\n"), "main.cpp"],
    [py, "main.py"],
    [buildHarness("pypy310", sig, "class Solution:\n    pass\n"), "main.py"],
    [java, "Main.java"],
    [buildHarness("java21", sig, "class Solution {}\n"), "Main.java"],
  ];

  it.each(builds.map(([b, f]) => [b.displayName, b.family, b, f] as const))("%s (%s)", (_name, family, b, file) => {
    for (let i = 0; i < 300; i++) {
      const raw = templates[family]!(b);
      expectInRange(renderDiagnostics(raw, b, file, 8 * 1024), b);
    }
  });
});

/**
 * Ported from PR #1 (the Phase 4 adversarial review), whose fixes to this
 * file were never merged. Both cases are about the same failure: a student
 * leaves something open, the generated driver is swallowed into it, and the
 * compiler then reports the judge's own code at them.
 */
describe("CPython: a string left open", () => {
  it("maps CPython's \"(detected at line N)\", and never shows a driver line there", () => {
    const inside = [
      `  File "main.py", line ${at(py, 3)}`,
      "    s = 'abc",
      "        ^",
      `SyntaxError: unterminated string literal (detected at line ${at(py, 3)})`,
    ].join("\n");
    expect(remapDiagnostics(inside, py, "main.py").split("\n")).toEqual([
      '  File "solution.py", line 3',
      "    s = 'abc",
      "        ^",
      "SyntaxError: unterminated string literal (detected at line 3)",
    ]);
    // An unclosed triple-quoted string is only detected in the generated driver.
    const after = [
      `  File "main.py", line ${at(py, 3)}`,
      '    s = """abc',
      "        ^",
      `SyntaxError: unterminated triple-quoted string literal (detected at line ${driverLine(py, 18)})`,
    ].join("\n");
    const out = remapDiagnostics(after, py, "main.py");
    expect(out.split("\n").at(-1)).toBe("SyntaxError: unterminated triple-quoted string literal (detected after your last line)");
    expectInRange(out, py);
  });
});

describe("gcc: a scope left open", () => {
  // Real g++ 13 output for the two-sum reference with its closing "};"
  // removed: the driver lands inside class Solution and fails in a cascade.
  const unclosedUser = TWO_SUM_REFERENCE.cpp20![0]!.source.replace(/\};\s*$/, "\n");
  const unclosed = buildHarness("cpp20", sig, unclosedUser);
  const raw = "main.cpp:16:1: error: expected unqualified-id before 'namespace'\n   16 | namespace recx_harness {\n      | ^~~~~~~~~\nmain.cpp:122:1: error: expected unqualified-id before 'namespace'\n  122 | namespace recx_harness {\n      | ^~~~~~~~~\nmain.cpp:148:2: error: expected '}' at end of input\n  148 | }\n      |  ^\nmain.cpp:3:16: note: to match this '{'\n    3 | class Solution {\n      |                ^\nmain.cpp: In member function 'int Solution::main()':\nmain.cpp:140:98: error: 'recx_harness' has not been declared\n  140 |     { if (!getline(cin, line)) { fprintf(stderr, \"harness: missing input line 1\\n\"); return 3; } recx_harness::In in(line); recx_harness::parse(in, a0); }\n      |                                                                                                  ^~~~~~~~~~~~\nmain.cpp:140:125: error: 'recx_harness' has not been declared\n  140 |     { if (!getline(cin, line)) { fprintf(stderr, \"harness: missing input line 1\\n\"); return 3; } recx_harness::In in(line); recx_harness::parse(in, a0); }\n      |                                                                                                                             ^~~~~~~~~~~~\nmain.cpp:140:145: error: 'in' was not declared in this scope; did you mean 'yn'?\n  140 |     { if (!getline(cin, line)) { fprintf(stderr, \"harness: missing input line 1\\n\"); return 3; } recx_harness::In in(line); recx_harness::parse(in, a0); }\n      |                                                                                                                                                 ^~\n      |                                                                                                                                                 yn\nmain.cpp:142:98: error: 'recx_harness' has not been declared\n  142 |     { if (!getline(cin, line)) { fprintf(stderr, \"harness: missing input line 2\\n\"); return 3; } recx_harness::In in(line); recx_harness::parse(in, a1); }\n      |                                                                                                  ^~~~~~~~~~~~\nmain.cpp:142:125: error: 'recx_harness' has not been declared\n  142 |     { if (!getline(cin, line)) { fprintf(stderr, \"harness: missing input line 2\\n\"); return 3; } recx_harness::In in(line); recx_harness::parse(in, a1); }\n      |                                                                                                                             ^~~~~~~~~~~~\nmain.cpp:142:145: error: 'in' was not declared in this scope; did you mean 'yn'?\n  142 |     { if (!getline(cin, line)) { fprintf(stderr, \"harness: missing input line 2\\n\"); return 3; } recx_harness::In in(line); recx_harness::parse(in, a1); }\n      |                                                                                                                                                 ^~\n      |                                                                                                                                                 yn\nmain.cpp:145:5: error: 'recx_harness' has not been declared\n  145 |     recx_harness::write(cout, result);\n      |     ^~~~~~~~~~~~\nmain.cpp: At global scope:\nmain.cpp:148:2: error: expected unqualified-id at end of input\n  148 | }\n      |  ^";

  it("keeps only the missing-brace error and the student's own note", () => {
    expect(unclosed.userStartLine).toBe(3);
    const out = remapDiagnostics(raw, unclosed, "main.cpp");
    expect(out.split("\n")).toEqual([
      "[generated driver code]: error: expected '}' at end of input",
      "solution.cpp:1:16: note: to match this '{'",
      "    1 | class Solution {",
      "      |                ^",
    ]);
    expect(diagnosticHints(out)).toContain(UNCLOSED_HINT);
    expectInRange(out, unclosed);
  });

  it("never shows the bare harness namespace or the driver's member-function banner", () => {
    const out = remapDiagnostics(raw, unclosed, "main.cpp");
    expect(out).not.toMatch(/recx_harness|Solution::main|'in' was not declared/);
  });
});
