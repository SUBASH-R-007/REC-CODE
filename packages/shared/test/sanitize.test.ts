import { describe, expect, it } from "vitest";
import { LIMITS } from "../src/limits";
import { sanitizeToolOutput, truncateUtf8, utf8Length } from "../src/sanitize";

/** Realistic gcc / CPython output from inside a box. */
const GCC_OUTPUT = [
  "In file included from /opt/toolchains/gcc-13.2.0/include/c++/13.2.0/vector:66,",
  "                 from /opt/toolchains/gcc-13.2.0/include/c++/13.2.0/x86_64-pc-linux-gnu/bits/stdc++.h:89,",
  "                 from /box/main.cpp:1:",
  "/box/main.cpp: In member function 'std::vector<int> Solution::twoSum(std::vector<int>&, long long int)':",
  "/box/main.cpp:7:13: error: 'foo' was not declared in this scope",
  "    7 |             foo();",
  "      |             ^~~",
  "/opt/toolchains/gcc-13.2.0/include/c++/13.2.0/bits/stl_vector.h:1125:7: note: candidate: 'reference operator[](size_type)'",
  "In file included from /usr/include/x86_64-linux-gnu/bits/types.h:1,",
  "/usr/bin/ld: cannot find -lfoo: No such file or directory",
  "collect2: error: ld returned 1 exit status",
  "cwd was /box",
  "(/box/main.cpp)",
  "include path '/home/judge/recx/apps/judge-worker/tmp/x.h'",
  "GNU C++20 (GCC) version 13.2.0 (x86_64-pc-linux-gnu)",
].join("\n");

const PYTHON_OUTPUT = [
  "Traceback (most recent call last):",
  '  File "/box/main.py", line 4, in <module>',
  '  File "/opt/toolchains/cpython-3.12.6/lib/python3.12/json/__init__.py", line 346, in loads',
  "    return _default_decoder.decode(s)",
  "json.decoder.JSONDecodeError: Expecting value: line 1 column 1 (char 0)",
].join("\n");

const HOST_PATH = /(^|[\s'"(=])\/(?:usr|home|var|etc|tmp|opt|root|proc|sys|lib|lib64|bin|srv|mnt)\/[\w.+-]/m;

describe("sanitizeToolOutput", () => {
  it.each([
    ["gcc", GCC_OUTPUT],
    ["python", PYTHON_OUTPUT],
  ])("removes every /box/, /opt/toolchains/ and host absolute path from %s output", (_name, raw) => {
    const clean = sanitizeToolOutput(raw);
    expect(clean).not.toContain("/box/");
    expect(clean).not.toContain("/opt/toolchains/");
    expect(clean).not.toMatch(HOST_PATH);
    expect(clean).not.toContain("/home/judge");
  });

  it("keeps the diagnostic itself readable", () => {
    const clean = sanitizeToolOutput(GCC_OUTPUT);
    expect(clean).toContain("main.cpp:7:13: error: 'foo' was not declared in this scope");
    expect(clean).toContain("<toolchain>/include/c++/13.2.0/bits/stl_vector.h:1125:7");
    expect(clean).toContain("<system>/types.h");
    expect(clean).toContain("    7 |             foo();");
    expect(clean).not.toContain("GNU C++20 (GCC) version 13.2.0");
  });

  it("maps a bare /box to the working directory", () => {
    expect(sanitizeToolOutput("cwd was /box")).toBe("cwd was .");
    expect(sanitizeToolOutput("'/box'")).toBe("'.'");
  });

  it("normalises CRLF and squeezes blank runs", () => {
    expect(sanitizeToolOutput("a\r\n\r\n\r\n\r\nb\rc")).toBe("a\n\nb\nc");
  });

  it("caps output at the compile-output limit by default", () => {
    const clean = sanitizeToolOutput("error: x\n".repeat(10_000));
    expect(utf8Length(clean)).toBeLessThanOrEqual(LIMITS.compile.outputBytes);
    expect(clean.endsWith("(truncated)")).toBe(true);
  });

  it("leaves short output unchanged apart from path rewriting", () => {
    expect(sanitizeToolOutput("main.cpp:1:1: error: x")).toBe("main.cpp:1:1: error: x");
  });
});

describe("truncateUtf8", () => {
  it.each([
    ["2-byte", "é"],
    ["3-byte", "€"],
    ["4-byte", "🎉"],
    ["mixed", "a€🎉é"],
  ])("never splits a %s UTF-8 sequence", (_name, unit) => {
    const text = unit.repeat(500);
    for (let max = 17; max <= 64; max++) {
      const out = truncateUtf8(text, max);
      expect(utf8Length(out), `max=${max}`).toBeLessThanOrEqual(max);
      expect(out, `max=${max}`).not.toContain("�");
      expect(out.endsWith("… (truncated)")).toBe(true);
      // The kept prefix is a prefix of the input made of whole characters.
      const kept = out.slice(0, out.length - "\n… (truncated)".length);
      expect(text.startsWith(kept)).toBe(true);
    }
  });

  it("returns text within the cap unchanged", () => {
    expect(truncateUtf8("héllo", 6)).toBe("héllo");
    expect(truncateUtf8("", 0)).toBe("");
  });

  it("applies the cap through sanitizeToolOutput too", () => {
    const out = sanitizeToolOutput("ø".repeat(1000), 101);
    expect(utf8Length(out)).toBeLessThanOrEqual(101);
    expect(out).not.toContain("�");
  });
});
