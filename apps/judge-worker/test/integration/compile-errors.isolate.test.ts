import { existsSync, mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { LANGUAGE_CATALOG, toolchainDirs, type LanguageKey, type ResultRequest } from "@recx/shared";
import { GENERATED_CODE_HINT } from "@recx/shared/harness";
import { BlobCache } from "../../src/cache";
import { IsolateDriver } from "../../src/drivers/isolate";
import { createLogger } from "../../src/logger";
import { processJob, type ProcessorDeps } from "../../src/processor";
import { MemoryPublisher } from "../../src/publisher";
import { SlotPool } from "../../src/slots";
import { FakeJudgeApi } from "../support/fake-api";
import { twoSumJob } from "../support/jobs";

/**
 * Compile-error and runtime-trace remapping on the REAL compilers and
 * interpreters (gcc, CPython, javac and the JVM; PyPy when installed), for
 * the two-sum signature:
 *
 *   - an error on the student's line 3 is reported at solution.cpp:3,
 *     solution.py", line 3 or Solution.java:3;
 *   - a signature mismatch (a misnamed method) is reported as
 *     [generated driver code] with the hint to check the signature;
 *   - the output never names the generated program (main.cpp, Main.java,
 *     main.py) or the harness's internals (recx_harness, _recx_, RecxIn), and
 *     never shows a line number above the student's own line count.
 *
 * Box base 90 (run 90, compile 190, checker 290): clear of the live worker
 * and of the other isolate suites.
 */

const enabled = process.platform === "linux" && process.env.RECX_ISOLATE_INTEGRATION === "1";
const BOX_BASE = Number(process.env.RECX_COMPILE_ERRORS_BOX_BASE ?? 90);
const installed = (language: LanguageKey) => toolchainDirs(LANGUAGE_CATALOG[language]).every((d) => existsSync(d));
const REQUIRED: LanguageKey[] = ["cpp20", "py312", "java21"];
const LANGUAGES: LanguageKey[] = [...REQUIRED, ...(["cpp17", "pypy310"] as LanguageKey[]).filter((l) => !enabled || installed(l))];

type Family = "cpp" | "python" | "java";
const familyOf = (language: LanguageKey): Family => LANGUAGE_CATALOG[language].editorLanguage as Family;

/** An error on the student's line 3 (and nothing else wrong). */
const LINE_3_ERROR: Record<Family, { source: string; location: RegExp }> = {
  cpp: {
    source: [
      "class Solution {",
      "public:",
      "    vector<int> twoSum(vector<int>& nums, long long target) { return undeclaredHelper(nums, target); }",
      "};",
      "",
    ].join("\n"),
    location: /^solution\.cpp:3:\d+: error: 'undeclaredHelper' was not declared in this scope/m,
  },
  python: {
    source: ["class Solution:", "    def twoSum(self, nums, target):", "        return [0, 1", ""].join("\n"),
    location: /File "solution\.py", line 3/,
  },
  java: {
    source: ["class Solution {", "    public int[] twoSum(int[] nums, long target) {", "        return undeclaredHelper;", "    }", "}", ""].join("\n"),
    location: /^Solution\.java:3: error: cannot find symbol/m,
  },
};

/** The method is misnamed: the judge's call site cannot find it. */
const MISNAMED: Record<Family, string> = {
  cpp: "class Solution {\npublic:\n    vector<int> twoSums(vector<int>& nums, long long target) { return {0, 1}; }\n};\n",
  python: "class Solution:\n    def twoSums(self, nums, target):\n        return [0, 1]\n",
  java: "class Solution {\n    public int[] twoSums(int[] nums, long target) { return new int[] {0, 1}; }\n}\n",
};

function expectClean(text: string, userLineCount: number) {
  expect(text).not.toMatch(/\bmain\.cpp\b|\bMain\.java\b|\bmain\.py\b/);
  expect(text).not.toMatch(/recx_harness|_recx_|RecxIn|RecxOut/);
  expect(text).not.toContain("/box/");
  expect(text).not.toContain("/opt/toolchains/");
  const shown = [
    ...[...text.matchAll(/(?:solution\.cpp|Solution\.java):(\d+)/g)].map((m) => Number(m[1])),
    ...[...text.matchAll(/File "solution\.py", line (\d+)/g)].map((m) => Number(m[1])),
    ...[...text.matchAll(/^\s*(\d+) \|/gm)].map((m) => Number(m[1])),
  ];
  for (const n of shown) {
    expect(n, text).toBeGreaterThanOrEqual(1);
    expect(n, text).toBeLessThanOrEqual(userLineCount);
  }
}

const lineCount = (source: string) => source.replace(/\n$/, "").split("\n").length;

describe.skipIf(!enabled)("compile-error remapping on the real toolchains", () => {
  let deps: ProcessorDeps;
  let api: FakeJudgeApi;

  beforeAll(async () => {
    const logger = createLogger({ level: process.env.LOG_LEVEL ?? "warn", nodeId: "compile-errors" });
    api = new FakeJudgeApi();
    const driver = await IsolateDriver.create({
      isolateBin: process.env.RECX_ISOLATE_BIN ?? "isolate",
      boxBase: BOX_BASE,
      syntheticEtc: process.env.RECX_SYNTHETIC_ETC ?? "/var/lib/recjudge/etc",
      logger,
    });
    deps = {
      api,
      driver,
      cache: new BlobCache({ dir: mkdtempSync(path.join(os.tmpdir(), "recjudge-ce-blobs-")), maxBytes: 256 * 1024 * 1024, logger }),
      publisher: new MemoryPublisher(),
      slots: new SlotPool(1),
      logger,
      nodeId: "compile-errors",
    };
    console.log(`[compile-errors] box base ${BOX_BASE}; languages ${LANGUAGES.join(", ")}`);
  }, 120_000);

  async function judge(language: LanguageKey, source: string): Promise<{ result: ResultRequest; text: string }> {
    const job = twoSumJob(language, source, { stopOnFirstFailure: true });
    api.add(job.spec, job.blobs);
    const outcome = await processJob({ kind: job.spec.kind, id: job.spec.id }, deps);
    expect(outcome.outcome).toBe("posted");
    const result = api.results.find((r) => r.id === job.spec.id)!;
    // A compile error shows the compiler's output; a runtime error the sample test's stderr.
    const text = result.compile && !result.compile.ok ? result.compile.output : (result.tests[0]?.stderr ?? "");
    console.log(`[compile-errors] ${language}: ${result.verdict}\n${text}\n`);
    return { result, text };
  }

  it("has the required toolchains (missing = FAIL)", () => {
    for (const language of REQUIRED) expect(installed(language), language).toBe(true);
  });

  describe.each(LANGUAGES.map((l) => [l] as const))("%s", (language) => {
    const family = familyOf(language);

    it("reports an error on the student's line 3 at line 3 of the student's file", async () => {
      const { source, location } = LINE_3_ERROR[family];
      const { result, text } = await judge(language, source);
      // PyPy has no compile step: the SyntaxError surfaces when the sample test runs.
      expect(result.verdict).toBe(LANGUAGE_CATALOG[language].compile ? "CE" : "RE");
      expect(text).toMatch(location);
      expectClean(text, lineCount(source));
    });

    it("reports a misnamed method as the judge's code, with the signature hint", async () => {
      const { result, text } = await judge(language, MISNAMED[family]);
      expect(["CE", "RE"]).toContain(result.verdict);
      expect(text).toContain("[generated driver code]");
      expect(text).toContain(GENERATED_CODE_HINT);
      expectClean(text, lineCount(MISNAMED[family]));
    });
  });
});
