import { describe, expect, it } from "vitest";
import { asMap, packageFiles } from "./support/zip";

/**
 * parseProblemPackage: one problem directory of an import, every issue
 * collected with the file it is about, and a canonical hash that ignores
 * formatting and file order.
 */
const { parseProblemPackage, packageSha256 } = await import("@/lib/authoring/import/package");

const parse = (files: Record<string, string | Buffer>, entry = "loud-echo") => parseProblemPackage(entry, asMap(files));

function errorsOf(files: Record<string, string | Buffer>) {
  const r = parse(files);
  return r.ok ? [] : r.errors.map((e) => `${e.path}: ${e.message}`);
}

describe("parseProblemPackage", () => {
  it("parses a complete package", () => {
    const r = parse(packageFiles("loud-echo", 101));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.pkg.meta.slug).toBe("loud-echo");
    expect(r.pkg.tests.map((t) => [t.index, t.isSample])).toEqual([
      [0, true],
      [1, false],
    ]);
    expect(r.pkg.solutions.map((s) => [s.language, s.expected])).toEqual([
      ["cpp20", "AC"],
      ["py312", "WA"],
    ]);
    expect(r.pkg.starters).toEqual([{ language: "py312", code: "word = input()\n" }]);
    expect(r.pkg.hints).toEqual(["Look at each character."]);
    expect(r.packageSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("collects several issues at once, each with its file", () => {
    const meta = JSON.parse(packageFiles("loud-echo", 101)["meta.json"] as string) as Record<string, unknown>;
    delete meta.compareMode;
    const errors = errorsOf({
      ...packageFiles("loud-echo", 101, { "testcases/001.out": null, "statement.md": Buffer.from([0xff, 0xfe, 0x41]) }),
      "meta.json": JSON.stringify(meta),
    });
    expect(errors.some((e) => e.startsWith("meta.json: compareMode: compareMode is required"))).toBe(true);
    expect(errors.some((e) => e.startsWith("testcases/001.out: The expected output of test 1 is missing"))).toBe(true);
    expect(errors.some((e) => e.startsWith("statement.md: This file is not UTF-8"))).toBe(true);
  });

  it("refuses an unpaired test, a gap and a badly named test file", () => {
    expect(errorsOf(packageFiles("loud-echo", 101, { "testcases/002.in": "x\n" })).join("\n")).toMatch(/expected output of test 2 is missing/);
    expect(errorsOf(packageFiles("loud-echo", 101, { "testcases/003.in": "x\n", "testcases/003.out": "X\n" })).join("\n")).toMatch(/without gaps/);
    expect(errorsOf(packageFiles("loud-echo", 101, { "testcases/2.in": "x\n" })).join("\n")).toMatch(/three digits/);
  });

  it("refuses a sample students could not see (over 64 KB)", () => {
    const big = "a".repeat(65 * 1024) + "\n";
    expect(errorsOf(packageFiles("loud-echo", 101, { "testcases/000.in": big })).join("\n")).toMatch(/Sample test 0 must be UTF-8 text of at most 64 KB/);
    // The same size is fine for a hidden test.
    expect(parse(packageFiles("loud-echo", 101, { "testcases/001.in": big })).ok).toBe(true);
  });

  it("refuses a missing solution file, a missing statement and over-long hints", () => {
    const errors = errorsOf(packageFiles("loud-echo", 101, { "solutions/model.cpp": null, "statement.md": null, "hints/1.md": "h".repeat(9000) }));
    expect(errors.some((e) => e.startsWith("solutions/model.cpp: This file is missing"))).toBe(true);
    expect(errors.some((e) => e.startsWith("statement.md: This file is missing"))).toBe(true);
    expect(errors.some((e) => e.startsWith("hints/1.md:"))).toBe(true);
  });

  it("checks FUNCTION tests against the signature", () => {
    const meta = JSON.parse(packageFiles("sum-it", 102)["meta.json"] as string) as Record<string, unknown>;
    Object.assign(meta, {
      slug: "sum-it",
      ioMode: "FUNCTION",
      functionSignature: {
        className: "Solution",
        methodName: "total",
        params: [{ name: "nums", type: "list<int>" }],
        returns: "int",
        comparator: "EXACT",
        mutatedParam: null,
      },
      starters: {},
    });
    const files = {
      ...packageFiles("sum-it", 102, { "starters/main.py": null }),
      "meta.json": JSON.stringify(meta),
      "testcases/000.in": "[1,2,3]\n",
      "testcases/000.out": "6\n",
      "testcases/001.in": "[1, 2]\n",
      "testcases/001.out": "3\n",
    };
    const errors = errorsOf(files).join("\n");
    expect(errors).toMatch(/testcases\/001\.in: Test 1: .*canonical/);
    expect(errors).not.toMatch(/Test 0:/);
  });

  it("warns about stray files and a slug that differs from the directory", () => {
    const r = parseProblemPackage("other-dir", asMap({ ...packageFiles("loud-echo", 101), "notes.txt": "x" }));
    expect(r.ok).toBe(true);
    const warnings = r.warnings.map((w) => `${w.path}: ${w.message}`).join("\n");
    expect(warnings).toMatch(/notes\.txt: Not part of the package format/);
    expect(warnings).toMatch(/differs from the directory name/);
  });

  it("hashes canonically: formatting and file order do not matter, content does", () => {
    const files = packageFiles("loud-echo", 101);
    const a = parse(files);
    const meta = JSON.parse(files["meta.json"] as string) as Record<string, unknown>;
    const reordered = Object.fromEntries(Object.entries(files).reverse());
    const b = parse({ ...reordered, "meta.json": JSON.stringify(meta) });
    const c = parse({ ...files, "testcases/001.out": "DIFFERENT\n" });
    expect(a.ok && b.ok && c.ok).toBe(true);
    if (!a.ok || !b.ok || !c.ok) return;
    expect(b.packageSha256).toBe(a.packageSha256);
    expect(c.packageSha256).not.toBe(a.packageSha256);
    expect(packageSha256(a.pkg.meta, asMap(files))).toBe(a.packageSha256);
  });
});
