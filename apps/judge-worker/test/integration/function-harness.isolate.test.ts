import { existsSync, mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  LANGUAGE_CATALOG,
  TESTLIB_ID,
  TOOLCHAIN_ROOT,
  toolchainDirs,
  type FunctionSignature,
  type LanguageKey,
  type ResultRequest,
} from "@recx/shared";
import {
  checkerTemplate,
  containsDouble,
  cppType,
  EXTRA_OUTPUT_REASON,
  javaType,
  parseType,
  serializeValue,
  type FunctionComparator,
} from "@recx/shared/harness";
import { BlobCache } from "../../src/cache";
import { CompileCache } from "../../src/compile-cache";
import { IsolateDriver } from "../../src/drivers/isolate";
import { createLogger } from "../../src/logger";
import { processJob, type ProcessorDeps } from "../../src/processor";
import { MemoryPublisher } from "../../src/publisher";
import { SlotPool } from "../../src/slots";
import { FakeJudgeApi } from "../support/fake-api";
import { buildJob, type TestCaseInput } from "../support/jobs";

/**
 * The FUNCTION harness on REAL isolate and the pinned toolchains, per
 * harness language (cpp20, py312, java21 always; cpp17 and pypy310 when
 * installed):
 *
 *   - an identity method echo(x: T) -> T for every kind of the type grammar,
 *     with edge values (INT_MIN, LONG_MAX, escapes, unicode, empty
 *     containers, [1,null,2], empty trees and lists) — every language must
 *     read and write each value exactly as the canonical serialisation;
 *   - one fixture per comparator, IN_PLACE_MUTATION (void) included, and a
 *     CUSTOM_CHECKER problem whose checker is built from checkerTemplate();
 *   - malformed output (extra prints) is WA, never a false AC.
 *
 * Box base 80 (run 80, compile 180, checker 280): clear of the live worker
 * (0–7, 100–107, 200–207, 900+) and of the other isolate suites.
 */

const enabled = process.platform === "linux" && process.env.RECX_ISOLATE_INTEGRATION === "1";
const BOX_BASE = Number(process.env.RECX_HARNESS_BOX_BASE ?? 80);
const installed = (language: LanguageKey) => toolchainDirs(LANGUAGE_CATALOG[language]).every((d) => existsSync(d));

const REQUIRED: LanguageKey[] = ["cpp20", "py312", "java21"];
const OPTIONAL: LanguageKey[] = ["cpp17", "pypy310"];
const LANGUAGES: LanguageKey[] = [...REQUIRED, ...OPTIONAL.filter((l) => !enabled || installed(l))];

/** Canonical edge values per type: each becomes one test of echo(x: T) -> T. */
const ECHO: Array<[type: string, values: unknown[]]> = [
  ["int", [0, -1, -2147483648, 2147483647]],
  ["long", [0, -9_223_372_036_854_775_808n, 9_223_372_036_854_775_807n, 9_007_199_254_740_993n]],
  ["double", [0, -1.5, 1e-9, 123456.789, 1.7976931348623157e308]],
  ["bool", [true, false]],
  ["char", ["a", '"', "\\", " ", "~", "\u0001"]],
  [
    "string",
    ["", "hello world", 'quote " and back\\slash', "tab\tnew\nline\rcr", "unicode: café, नमस्ते, 漢字, 🎉", "nul\u0000x", "\u007f </script>"],
  ],
  ["list<int>", [[], [1, -2, 3], [2147483647, -2147483648]]],
  ["list<long>", [[], [9_223_372_036_854_775_807n, -1]]],
  ["list<double>", [[], [0.5, -2.25, 1e10]]],
  ["list<bool>", [[], [true, false, true]]],
  ["list<char>", [[], ["x", "y", "\\"]]],
  ["list<string>", [[], ["", "a b", "🎉"]]],
  ["matrix<int>", [[], [[]], [[1, 2], [], [3]]]],
  ["matrix<char>", [[["#", "."], [".", "#"]]]],
  ["matrix<string>", [[["a", ""], ["c"]]]],
  ["pair<int,string>", [[1, "one"], [-5, ""]]],
  ["pair<long,double>", [[-9_223_372_036_854_775_808n, 0.25]]],
  ["list<pair<int,int>>", [[], [[1, 2], [3, 4]]]],
  ["list<list<int>>", [[], [[1], [], [2, 3]]]],
  ["pair<list<int>,string>", [[[1, 2], "x"], [[], ""]]],
  ["list<matrix<int>>", [[[[1]], [[2, 3], [4]]]]],
  ["TreeNode", [[], [1], [1, null, 2], [1, 2, 3, null, 4, null, 5], [-1, -2]]],
  ["ListNode", [[], [1], [3, 2, 1]]],
  ["list<TreeNode>", [[[1, null, 2], [], [5]]]],
];

function echoSignature(type: string): FunctionSignature {
  return {
    className: "Solution",
    methodName: "echo",
    params: [{ name: "x", type }],
    returns: type,
    comparator: containsDouble(parseType(type)) ? "FLOAT_TOLERANCE" : "EXACT",
    mutatedParam: null,
  };
}

function echoSource(language: LanguageKey, type: string): string {
  const t = parseType(type);
  switch (LANGUAGE_CATALOG[language].editorLanguage) {
    case "cpp":
      return `class Solution {\npublic:\n    ${cppType(t)} echo(${cppType(t)} x) {\n        return x;\n    }\n};\n`;
    case "python":
      return "class Solution:\n    def echo(self, x):\n        return x\n";
    default:
      return `class Solution {\n    public ${javaType(t)} echo(${javaType(t)} x) {\n        return x;\n    }\n}\n`;
  }
}

/** Per-language sources for the comparator fixtures. */
interface Fixture {
  name: string;
  signature: FunctionSignature;
  cases: TestCaseInput[];
  sources: Record<"cpp" | "python" | "java", string>;
  checker?: string;
  /** Expected verdict of every language's source (default AC). */
  expected?: "AC" | "WA";
}

const sig = (methodName: string, params: [string, string][], returns: string, comparator: FunctionComparator, mutatedParam: string | null = null): FunctionSignature => ({
  className: "Solution",
  methodName,
  params: params.map(([name, type]) => ({ name, type })),
  returns,
  comparator,
  mutatedParam,
});

const PAIR_SUM = sig("anyPair", [["n", "int"]], "pair<int,int>", "CUSTOM_CHECKER");
const PAIR_SUM_CHECKER = checkerTemplate(PAIR_SUM).replace(
  'return "the checker has not been written yet";',
  'if (candidate.first < 0 || candidate.second < 0) return "a part is negative";\n' +
    '    if ((long long)candidate.first + candidate.second != n) return "the parts do not add up to n";\n' +
    '    return "";',
);

const FIXTURES: Fixture[] = [
  {
    name: "SET_EQUAL: any order of the right elements",
    signature: sig("evens", [["nums", "list<int>"]], "list<int>", "SET_EQUAL"),
    cases: [
      { input: "[1,2,3,4,6]\n", output: "[2,4,6]\n", isSample: true },
      { input: "[8,8,1]\n", output: "[8,8]\n" },
    ],
    sources: {
      cpp: "class Solution {\npublic:\n    vector<int> evens(vector<int>& nums) {\n        vector<int> out;\n        for (int x : nums) if (x % 2 == 0) out.insert(out.begin(), x);\n        return out;\n    }\n};\n",
      python: "class Solution:\n    def evens(self, nums):\n        return sorted((x for x in nums if x % 2 == 0), reverse=True)\n",
      java: "class Solution {\n    public int[] evens(int[] nums) {\n        return Arrays.stream(nums).filter(x -> x % 2 == 0).boxed().sorted(Comparator.reverseOrder()).mapToInt(Integer::intValue).toArray();\n    }\n}\n",
    },
  },
  {
    name: "ROWS_ANY_ORDER: rows in any order",
    signature: sig("pairsOf", [["n", "int"]], "list<list<int>>", "ROWS_ANY_ORDER"),
    cases: [{ input: "3\n", output: "[[1,2],[1,3],[2,3]]\n", isSample: true }],
    sources: {
      cpp: "class Solution {\npublic:\n    vector<vector<int>> pairsOf(int n) {\n        vector<vector<int>> out;\n        for (int b = n; b >= 1; --b) for (int a = b - 1; a >= 1; --a) out.push_back({a, b});\n        return out;\n    }\n};\n",
      python: "class Solution:\n    def pairsOf(self, n):\n        return [[a, b] for b in range(n, 0, -1) for a in range(1, b)]\n",
      java: "class Solution {\n    public List<List<Integer>> pairsOf(int n) {\n        List<List<Integer>> out = new ArrayList<>();\n        for (int b = n; b >= 1; b--) for (int a = 1; a < b; a++) out.add(List.of(a, b));\n        return out;\n    }\n}\n",
    },
  },
  {
    name: "FLOAT_TOLERANCE: within 1e-6",
    signature: sig("third", [["x", "double"]], "double", "FLOAT_TOLERANCE"),
    cases: [{ input: "1\n", output: "0.3333333333333333\n", isSample: true }, { input: "3\n", output: "1\n" }],
    sources: {
      cpp: "class Solution {\npublic:\n    double third(double x) { return x / 3.0 + 1e-9; }\n};\n",
      python: "class Solution:\n    def third(self, x):\n        return x / 3\n",
      java: "class Solution {\n    public double third(double x) { return x / 3; }\n}\n",
    },
  },
  {
    name: "IN_PLACE_MUTATION: a list changed in place (void)",
    signature: sig("bump", [["a", "list<int>"], ["by", "int"]], "void", "IN_PLACE_MUTATION", "a"),
    cases: [{ input: "[1,2,3]\n10\n", output: "[11,12,13]\n", isSample: true }, { input: "[]\n1\n", output: "[]\n" }],
    sources: {
      cpp: "class Solution {\npublic:\n    void bump(vector<int>& a, int by) { for (int& x : a) x += by; }\n};\n",
      python: "class Solution:\n    def bump(self, a, by):\n        for i in range(len(a)):\n            a[i] += by\n",
      java: "class Solution {\n    public void bump(int[] a, int by) { for (int i = 0; i < a.length; i++) a[i] += by; }\n}\n",
    },
  },
  {
    name: "IN_PLACE_MUTATION: a tree mirrored in place",
    signature: sig("mirror", [["root", "TreeNode"]], "void", "IN_PLACE_MUTATION", "root"),
    cases: [{ input: "[1,2,3,4]\n", output: "[1,3,2,null,null,null,4]\n", isSample: true }, { input: "[]\n", output: "[]\n" }],
    sources: {
      cpp: "class Solution {\npublic:\n    void mirror(TreeNode* root) {\n        if (!root) return;\n        swap(root->left, root->right);\n        mirror(root->left);\n        mirror(root->right);\n    }\n};\n",
      python: "class Solution:\n    def mirror(self, root):\n        if root is None:\n            return\n        root.left, root.right = root.right, root.left\n        self.mirror(root.left)\n        self.mirror(root.right)\n",
      java: "class Solution {\n    public void mirror(TreeNode root) {\n        if (root == null) return;\n        TreeNode t = root.left; root.left = root.right; root.right = t;\n        mirror(root.left); mirror(root.right);\n    }\n}\n",
    },
  },
  {
    name: "CUSTOM_CHECKER: different valid answers, checker from checkerTemplate()",
    signature: PAIR_SUM,
    checker: PAIR_SUM_CHECKER,
    cases: [{ input: "10\n", output: "[5,5]\n", isSample: true }, { input: "0\n", output: "[0,0]\n" }, { input: "7\n", output: "[3,4]\n" }],
    sources: {
      cpp: "class Solution {\npublic:\n    pair<int, int> anyPair(int n) { return {0, n}; }\n};\n",
      python: "class Solution:\n    def anyPair(self, n):\n        return (n, 0)\n",
      java: "class Solution {\n    public Pair<Integer, Integer> anyPair(int n) { return new Pair<>(n / 2, n - n / 2); }\n}\n",
    },
  },
  {
    name: "CUSTOM_CHECKER: a wrong answer is WA from the checker",
    signature: PAIR_SUM,
    checker: PAIR_SUM_CHECKER,
    cases: [{ input: "10\n", output: "[5,5]\n", isSample: true }],
    sources: {
      cpp: "class Solution {\npublic:\n    pair<int, int> anyPair(int n) { return {1, n}; }\n};\n",
      python: "class Solution:\n    def anyPair(self, n):\n        return (-1, n + 1)\n",
      java: "class Solution {\n    public Pair<Integer, Integer> anyPair(int n) { return new Pair<>(n, n); }\n}\n",
    },
    expected: "WA",
  },
  {
    name: "extra printed output is WA, never AC",
    signature: sig("twice", [["x", "int"]], "int", "EXACT"),
    cases: [{ input: "21\n", output: "42\n", isSample: true }],
    sources: {
      cpp: 'class Solution {\npublic:\n    int twice(int x) { cout << "debug " << x << "\\n"; return 2 * x; }\n};\n',
      python: "class Solution:\n    def twice(self, x):\n        print('debug', x)\n        return 2 * x\n",
      java: 'class Solution {\n    public int twice(int x) { System.out.println("debug " + x); return 2 * x; }\n}\n',
    },
    expected: "WA",
  },
];

describe.skipIf(!enabled)("FUNCTION harness on real isolate", () => {
  let deps: ProcessorDeps;
  let api: FakeJudgeApi;

  beforeAll(async () => {
    const logger = createLogger({ level: process.env.LOG_LEVEL ?? "warn", nodeId: "harness" });
    api = new FakeJudgeApi();
    const compileCache = new CompileCache({ dir: mkdtempSync(path.join(os.tmpdir(), "recjudge-harness-cc-")), logger });
    const driver = await IsolateDriver.create({
      isolateBin: process.env.RECX_ISOLATE_BIN ?? "isolate",
      boxBase: BOX_BASE,
      syntheticEtc: process.env.RECX_SYNTHETIC_ETC ?? "/var/lib/recjudge/etc",
      logger,
      compileCache,
    });
    deps = {
      api,
      driver,
      cache: new BlobCache({ dir: mkdtempSync(path.join(os.tmpdir(), "recjudge-harness-blobs-")), maxBytes: 256 * 1024 * 1024, logger }),
      publisher: new MemoryPublisher(),
      slots: new SlotPool(1),
      logger,
      nodeId: "harness",
    };
    console.log(`[harness] box base ${BOX_BASE}; languages ${LANGUAGES.join(", ")}`);
  }, 120_000);

  async function judge(job: ReturnType<typeof buildJob>, label: string): Promise<ResultRequest> {
    api.add(job.spec, job.blobs);
    const outcome = await processJob({ kind: job.spec.kind, id: job.spec.id }, deps);
    const release = api.releases.find((r) => r.id === job.spec.id);
    expect(outcome.outcome, `${label}: ${release?.reason ?? ""}`).toBe("posted");
    const result = api.results.find((r) => r.id === job.spec.id)!;
    if (result.compile && !result.compile.ok) console.log(`[harness] ${label} compile output:\n${result.compile.output}`);
    const failing = result.tests.filter((t) => t.v !== "AC");
    console.log(
      `[harness] ${label}: ${result.verdict} ${result.passedCases}/${result.totalCases}` +
        (failing.length ? ` failing ${failing.map((t) => `#${t.i} ${t.v}${t.message ? ` (${t.message})` : ""}${t.stdout ? ` stdout=${JSON.stringify(t.stdout.slice(0, 120))}` : ""}${t.stderr ? ` stderr=${JSON.stringify(t.stderr.slice(0, 300))}` : ""}`).join("; ")}` : ""),
    );
    return result;
  }

  it("has the required harness languages (missing = FAIL)", () => {
    for (const language of REQUIRED) expect(installed(language), `${language} toolchain missing`).toBe(true);
    expect(existsSync(`${TOOLCHAIN_ROOT}/${TESTLIB_ID}/testlib.h`)).toBe(true);
  });

  describe.each(LANGUAGES.map((l) => [l] as const))("%s", (language) => {
    it.each(ECHO.map(([type, values]) => [type, values] as const))("echo(x: %s) returns every edge value unchanged", async (type, values) => {
      const t = parseType(type);
      const cases = values.map((v, i): TestCaseInput => {
        const wire = serializeValue(t, v);
        return { input: `${wire}\n`, output: `${wire}\n`, isSample: i === 0 };
      });
      const job = buildJob({
        language,
        source: echoSource(language, type),
        ioMode: "FUNCTION",
        functionSignature: echoSignature(type),
        compareMode: "TOKEN",
        scoringMode: "PER_TEST",
        stopOnFirstFailure: false,
        timeLimitMs: 5_000,
        cases,
      });
      const result = await judge(job, `${language} echo ${type}`);
      expect(result.verdict).toBe("AC");
      expect(result.passedCases).toBe(values.length);
    });

    it.each(FIXTURES.map((f) => [f.name, f] as const))("%s", async (_name, fixture) => {
      const family = LANGUAGE_CATALOG[language].editorLanguage as "cpp" | "python" | "java";
      const job = buildJob({
        language,
        source: fixture.sources[family],
        ioMode: "FUNCTION",
        functionSignature: fixture.signature,
        compareMode: fixture.checker ? "CHECKER" : "TOKEN",
        scoringMode: "PER_TEST",
        stopOnFirstFailure: false,
        timeLimitMs: 5_000,
        cases: fixture.cases,
        ...(fixture.checker ? { checkerSource: fixture.checker, testlibId: TESTLIB_ID } : {}),
      });
      const result = await judge(job, `${language} ${fixture.name}`);
      if ((fixture.expected ?? "AC") === "AC") {
        expect(result.verdict).toBe("AC");
        expect(result.passedCases).toBe(fixture.cases.length);
      } else {
        expect(result.verdict).toBe("WA");
        if (fixture.name.startsWith("extra printed")) expect(result.tests[0]!.message).toBe(EXTRA_OUTPUT_REASON);
      }
    });
  });
});
