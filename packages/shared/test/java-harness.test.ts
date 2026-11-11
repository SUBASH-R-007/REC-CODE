import { describe, expect, it } from "vitest";
import { buildHarness, javaType, starterStub, starterStubs } from "../src/harness";
import { parseType, type FunctionSignature } from "../src/harness/signature";
import { TWO_SUM } from "../src/samples/two-sum";

const sig = TWO_SUM.signature;
const user = TWO_SUM_JAVA();

function TWO_SUM_JAVA(): string {
  return [
    "class Solution {",
    "    public int[] twoSum(int[] nums, long target) {",
    "        return new int[] {0, 1};",
    "    }",
    "}",
    "",
  ].join("\n");
}

const make = (patch: Partial<FunctionSignature>): FunctionSignature => ({ ...sig, ...patch });

describe("javaType", () => {
  it.each([
    ["int", "int"],
    ["long", "long"],
    ["double", "double"],
    ["bool", "boolean"],
    ["char", "char"],
    ["string", "String"],
    ["void", "void"],
    ["TreeNode", "TreeNode"],
    ["ListNode", "ListNode"],
    ["list<int>", "int[]"],
    ["list<string>", "String[]"],
    ["list<TreeNode>", "TreeNode[]"],
    ["matrix<char>", "char[][]"],
    ["matrix<bool>", "boolean[][]"],
    ["list<list<int>>", "List<List<Integer>>"],
    ["list<pair<int,long>>", "List<Pair<Integer, Long>>"],
    ["pair<string,list<double>>", "Pair<String, List<Double>>"],
    ["matrix<pair<int,int>>", "List<List<Pair<Integer, Integer>>>"],
    ["list<matrix<int>>", "List<List<List<Integer>>>"],
  ])("%s → %s", (type, java) => {
    expect(javaType(parseType(type))).toBe(java);
  });
});

describe("buildHarness (java21)", () => {
  const build = buildHarness("java21", sig, user);
  const lines = build.source.split("\n");

  it("starts the student's code on line 6, after exactly five import lines", () => {
    expect(build.userStartLine).toBe(6);
    expect(build.displayName).toBe("Solution.java");
    expect(build.family).toBe("java");
    expect(lines.slice(0, 5).every((l) => /^import java\.[a-z.]+\.\*;$/.test(l))).toBe(true);
    expect(lines[5]).toBe("class Solution {");
    expect(build.userLineCount).toBe(5);
  });

  it("calls the method through a typed local and writes UTF-8 bytes", () => {
    expect(build.source).toContain("int[] result = sol.twoSum(a0, a1);");
    expect(build.source).toContain("public class Main {");
    expect(build.source).toContain("System.in.readAllBytes()");
    expect(build.source).toContain("System.out.write(bytes, 0, bytes.length);");
  });

  it("spells library types fully qualified in the driver", () => {
    const driver = lines.slice(build.userStartLine - 1 + build.userLineCount).join("\n");
    expect(driver).not.toMatch(/(?<![.\w])(?:List|ArrayList|Arrays|Deque)</);
    expect(driver).not.toMatch(/(?<![.\w])Arrays\./);
  });

  it("never contains a Java unicode escape (\\u is processed before lexing)", () => {
    for (const s of [sig, make({ params: [{ name: "s", type: "string" }], returns: "string" })]) {
      const src = buildHarness("java21", s, user).source;
      // A backslash-u is only safe when the backslash is itself escaped.
      expect(src).not.toMatch(/(?<!\\)(?:\\\\)*\\u/);
    }
  });

  it("defines ListNode, TreeNode and Pair only when the signature uses them", () => {
    expect(build.source).not.toMatch(/class ListNode|class TreeNode|record Pair/);
    const nodes = buildHarness("java21", make({ params: [{ name: "root", type: "TreeNode" }, { name: "head", type: "ListNode" }], returns: "pair<int,int>" }), user);
    expect(nodes.source).toContain("class ListNode {");
    expect(nodes.source).toContain("class TreeNode {");
    expect(nodes.source).toContain("record Pair<A, B>(A first, B second) {}");
  });

  it("prints the mutated parameter for IN_PLACE_MUTATION", () => {
    const inPlace = make({
      methodName: "rotate",
      params: [
        { name: "grid", type: "matrix<int>" },
        { name: "k", type: "int" },
      ],
      returns: "void",
      comparator: "IN_PLACE_MUTATION",
      mutatedParam: "grid",
    });
    const source = buildHarness("java21", inPlace, user).source;
    expect(source).toContain("sol.rotate(a0, a1);");
    expect(source).toMatch(/w\d+\(out, a0\);/);
  });

  it("generates one reader per distinct type and context", () => {
    const deep = make({ params: [{ name: "a", type: "list<list<int>>" }, { name: "b", type: "list<int>" }], returns: "list<pair<int,string>>" });
    const src = buildHarness("java21", deep, user).source;
    expect(src).toContain("static java.util.List<java.util.List<Integer>> r0(RecxIn in)");
    expect(src).toMatch(/static int\[\] r\d+\(RecxIn in\)/);
    expect(src).toMatch(/java\.util\.List<Pair<Integer, String>> result = sol\.twoSum\(a0, a1\);/);
  });
});

describe("starter stubs", () => {
  it("writes a non-public class Solution with a public method for Java", () => {
    expect(starterStub("java21", sig)).toBe(
      ["class Solution {", "    public int[] twoSum(int[] nums, long target) {", "        ", "    }", "}", ""].join("\n"),
    );
  });

  it("adds the node and Pair notes, and the in-place reminder, in every language", () => {
    const s = make({
      methodName: "fold",
      params: [{ name: "head", type: "ListNode" }],
      returns: "void",
      comparator: "IN_PLACE_MUTATION",
      mutatedParam: "head",
    });
    const stubs = starterStubs(s);
    expect(Object.keys(stubs).sort()).toEqual(["cpp17", "cpp20", "java21", "py312", "pypy310"]);
    for (const stub of Object.values(stubs)) {
      expect(stub).toMatch(/The judge defines ListNode \(val, next\) — do not redefine it\./);
      expect(stub).toMatch(/Do not return anything: change `head` in place\./);
    }
    expect(starterStub("java21", make({ returns: "pair<int,int>" }))).toMatch(/record Pair<A, B>/);
  });

  it("leaves the existing seeds' C++ and Python stubs unchanged", () => {
    expect(starterStub("cpp20", sig)).toBe(
      ["class Solution {", "public:", "    vector<int> twoSum(vector<int>& nums, long long target) {", "        ", "    }", "};", ""].join("\n"),
    );
    expect(starterStub("py312", sig)).toBe(
      ["class Solution:", "    def twoSum(self, nums: List[int], target: int) -> List[int]:", "        ", ""].join("\n"),
    );
  });
});
