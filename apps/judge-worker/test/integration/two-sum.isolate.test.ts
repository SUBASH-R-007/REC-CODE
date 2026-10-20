import { existsSync, mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { LANGUAGE_CATALOG, type ResultRequest } from "@recx/shared";
import { TWO_SUM_REFERENCE } from "@recx/shared/samples/two-sum";
import { BlobCache } from "../../src/cache";
import { IsolateDriver } from "../../src/drivers/isolate";
import { createLogger } from "../../src/logger";
import { processJob, type ProcessorDeps } from "../../src/processor";
import { MemoryPublisher } from "../../src/publisher";
import { SlotPool } from "../../src/slots";
import { FakeJudgeApi } from "../support/fake-api";
import { twoSumJob } from "../support/jobs";

/**
 * End to end through the worker's real job path (claim → fetch blobs into the
 * sha256-verified cache → IsolateDriver → post result) against REAL isolate
 * boxes and the pinned toolchains. The app host is an in-memory fake serving
 * the two-sum seed problem and the catalog runtimes.
 *
 *   cd ~/recx/apps/judge-worker && RECX_ISOLATE_INTEGRATION=1 \
 *     RECX_CACHE_DIR=/tmp/recjudge-cache npx vitest run --config vitest.integration.config.ts
 */

const enabled = process.platform === "linux" && process.env.RECX_ISOLATE_INTEGRATION === "1";
const hasGcc = existsSync("/opt/toolchains/gcc-13.2.0/bin/g++");
const hasPython = existsSync("/opt/toolchains/cpython-3.12.6/bin/python3");
/** Clear of a dev worker's default boxes (0, 100, 200). */
const BOX_BASE = Number(process.env.RECX_BOX_BASE ?? 40);

const reference = (language: "cpp20" | "py312", expected: "AC" | "WA") => {
  const found = TWO_SUM_REFERENCE[language]?.find((r) => r.expected === expected);
  if (!found) throw new Error(`no ${expected} reference for ${language}`);
  return found.source;
};

describe.skipIf(!enabled)("two-sum on real isolate", () => {
  let deps: ProcessorDeps;
  let api: FakeJudgeApi;
  let publisher: MemoryPublisher;

  beforeAll(async () => {
    const logger = createLogger({ level: process.env.LOG_LEVEL ?? "warn", nodeId: "integration" });
    api = new FakeJudgeApi();
    publisher = new MemoryPublisher();
    const driver = await IsolateDriver.create({
      isolateBin: process.env.RECX_ISOLATE_BIN ?? "isolate",
      boxBase: BOX_BASE,
      syntheticEtc: process.env.RECX_SYNTHETIC_ETC ?? "/var/lib/recjudge/etc",
      logger,
    });
    const cacheDir = process.env.RECX_CACHE_DIR ?? mkdtempSync(path.join(os.tmpdir(), "recjudge-cache-"));
    deps = {
      api,
      driver,
      cache: new BlobCache({ dir: cacheDir, maxBytes: 512 * 1024 * 1024, logger }),
      publisher,
      slots: new SlotPool(1),
      logger,
      nodeId: "integration",
    };
    const info = await driver.info();
    console.log(`[integration] isolate ${info.version}; languages on this host: ${info.languages.join(", ")}`);
    if (!hasGcc) console.warn("[integration] /opt/toolchains/gcc-13.2.0/bin/g++ missing — C++ cases are SKIPPED");
  });

  async function judge(language: "cpp20" | "py312", source: string): Promise<ResultRequest> {
    const job = twoSumJob(language, source);
    expect(job.spec.language).toEqual(LANGUAGE_CATALOG[language]);
    api.add(job.spec, job.blobs);
    const started = Date.now();
    const outcome = await processJob({ kind: job.spec.kind, id: job.spec.id }, deps);
    expect(outcome.outcome).toBe("posted");
    const result = api.results.find((r) => r.id === job.spec.id);
    if (!result) throw new Error("no result posted");
    console.log(
      `[integration] ${language}: ${result.verdict} ${result.passedCases}/${result.totalCases}` +
        ` maxTime=${result.maxTimeMs}ms maxMem=${result.maxMemoryKb}KB firstFailed=${result.firstFailedIndex}` +
        ` compile=${result.compile ? `${result.compile.ok ? "ok" : "CE"} ${result.compile.timeMs}ms` : "none"}` +
        ` wall=${Date.now() - started}ms`,
    );
    if (result.compile && !result.compile.ok) console.log(`[integration] ${language} compile output:\n${result.compile.output}`);
    return result;
  }

  function expectNoHiddenOutput(result: ResultRequest) {
    for (const t of result.tests) {
      if (t.i >= 2) {
        expect(t.stdout, `hidden test ${t.i} must carry no stdout`).toBeUndefined();
        expect(t.stderr, `hidden test ${t.i} must carry no stderr`).toBeUndefined();
      }
    }
  }

  it.skipIf(!hasPython)("py312 reference → AC 14/14", async () => {
    const result = await judge("py312", reference("py312", "AC"));
    expect(result.verdict).toBe("AC");
    expect(result.passedCases).toBe(14);
    expect(result.totalCases).toBe(14);
    expect(result.tests.every((t) => t.v === "AC")).toBe(true);
    expect(result.tests[0]!.stdout).toBe("[0,1]\n");
    expectNoHiddenOutput(result);
  });

  it.skipIf(!hasPython)("py312 syntax error → CE pointing at solution.py", async () => {
    const result = await judge("py312", "class Solution:\n    def twoSum(self, nums, target)\n        return []\n");
    expect(result.verdict).toBe("CE");
    const output = result.compile!.output;
    console.log(`[integration] py312 CE output:\n${output}`);
    expect(output).toMatch(/solution\.py", line 2/);
    expect(output).not.toContain("/box/");
    expect(output).not.toContain("/opt/toolchains/");
  });

  it.skipIf(!hasPython)("py312 MemoryError / OOM → MLE", async () => {
    const result = await judge(
      "py312",
      "class Solution:\n    def twoSum(self, nums, target):\n        x = bytearray(1 << 30)\n        return [0, 1]\n",
    );
    expect(result.verdict).toBe("MLE");
    expect(result.firstFailedIndex).toBe(0);
  });

  it.skipIf(!hasPython)("py312 infinite loop → TLE", async () => {
    const result = await judge("py312", "class Solution:\n    def twoSum(self, nums, target):\n        while True: pass\n");
    expect(result.verdict).toBe("TLE");
    expect(result.tests[0]!.ms).toBeGreaterThanOrEqual(1000);
    expect(result.tests.slice(1).every((t) => t.v === "SKIPPED")).toBe(true);
  });

  it.skipIf(!hasPython)("py312 runaway output → OLE", async () => {
    const result = await judge(
      "py312",
      "import sys\nclass Solution:\n    def twoSum(self, nums, target):\n        while True: sys.stdout.write('9' * 65536)\n",
    );
    expect(result.verdict).toBe("OLE");
  });

  it.skipIf(!hasPython)("py312 slow runaway output → OLE from the supervisor's early trip (not a wall-clock TLE)", async () => {
    // 64 KB every 50 ms: never hits --fsize or the CPU limit; without the
    // early trip this would run into the 5 s wall clock. The trip point for
    // test 0 is 2 × 6 bytes + 1 MB, reached after ~1 s.
    const source = [
      "import sys, time",
      "class Solution:",
      "    def twoSum(self, nums, target):",
      "        while True:",
      "            sys.stdout.write('9' * 65536)",
      "            sys.stdout.flush()",
      "            time.sleep(0.05)",
      "",
    ].join("\n");
    const started = Date.now();
    const result = await judge("py312", source);
    expect(result.verdict).toBe("OLE");
    expect(result.tests[0]).toMatchObject({ v: "OLE", message: "Output exceeded the limit." });
    expect(Date.now() - started).toBeLessThan(4_000);
  });

  it.skipIf(!hasPython)("py312 cannot fork (processes = 1 for native languages)", async () => {
    const source = "import os\nclass Solution:\n    def twoSum(self, nums, target):\n        os.fork()\n        return [0, 1]\n";
    const result = await judge("py312", source);
    expect(result.verdict).toBe("RE");
    expect(result.tests[0]!.stderr).toMatch(/BlockingIOError|Resource temporarily unavailable/);
  });

  it.skipIf(!hasPython)("py312 sees only the box filesystem and a 3-line synthetic /etc", async () => {
    const source = [
      "import os, sys",
      "class Solution:",
      "    def twoSum(self, nums, target):",
      "        sys.stderr.write('ROOT=' + ','.join(sorted(os.listdir('/'))) + '\\n')",
      "        sys.stderr.write('PIDS=' + ','.join(p for p in os.listdir('/proc') if p.isdigit()) + '\\n')",
      "        sys.stderr.write('UID=%d CWD=%s\\n' % (os.getuid(), os.getcwd()))",
      "        return [len(open('/etc/passwd').read().splitlines()), len(os.listdir('/etc'))]",
      "",
    ].join("\n");
    const result = await judge("py312", source);
    const t0 = result.tests[0]!;
    console.log(`[integration] box view: ${t0.stderr?.replace(/\n/g, " | ")}`);
    expect(t0.stdout).toBe("[3,1]\n"); // passwd has 3 lines; /etc holds nothing else
    const root = /ROOT=(.*)/.exec(t0.stderr ?? "")?.[1]?.split(",") ?? [];
    for (const hidden of ["home", "root", "var", "tmp", "mnt", "srv", "run", "sys"]) expect(root).not.toContain(hidden);
    expect(root).toEqual(expect.arrayContaining(["box", "usr", "proc", "dev", "etc", "opt"]));
    // Its own pid namespace: only the box's processes are visible.
    const pids = /PIDS=(.*)/.exec(t0.stderr ?? "")?.[1]?.split(",").filter(Boolean) ?? [];
    expect(pids.length).toBeLessThanOrEqual(2);
    // Runs as the slot's own uid. "/box" itself is rewritten to "." by the stderr sanitiser.
    expect(t0.stderr).toMatch(new RegExp(`UID=${60000 + BOX_BASE} CWD=\\.$`, "m"));
    expect(t0.stderr).not.toContain("/box");
  });

  it.skipIf(!hasPython)("py312 cannot reach the network", async () => {
    const source = [
      "import socket",
      "class Solution:",
      "    def twoSum(self, nums, target):",
      "        s = socket.socket()",
      "        s.settimeout(2)",
      "        s.connect(('1.1.1.1', 80))",
      "        return [0, 1]",
      "",
    ].join("\n");
    const result = await judge("py312", source);
    expect(result.verdict).toBe("RE");
    expect(result.tests[0]!.stderr).toMatch(/Network is unreachable|OSError/);
  });

  it.skipIf(!hasGcc)("cpp20 reference → AC 14/14", async () => {
    const result = await judge("cpp20", reference("cpp20", "AC"));
    expect(result.verdict).toBe("AC");
    expect(result.passedCases).toBe(14);
    expect(result.totalCases).toBe(14);
    expect(result.compile).toMatchObject({ ok: true, resourceExceeded: false });
    expectNoHiddenOutput(result);
  });

  it.skipIf(!hasGcc)("cpp20 deliberately-WA reference → WA at test 0, the rest SKIPPED", async () => {
    const result = await judge("cpp20", reference("cpp20", "WA"));
    expect(result.verdict).toBe("WA");
    expect(result.firstFailedIndex).toBe(0);
    expect(result.tests[0]!.v).toBe("WA");
    expect(result.tests.slice(1).every((t) => t.v === "SKIPPED")).toBe(true);
    expect(result.tests[0]!.stdout).toBe("[1,0]\n");
  });

  it.skipIf(!hasGcc)("cpp20 syntax error → CE on solution.cpp with the student's own line number", async () => {
    // gcc reports a missing ';' at the NEXT token, so the student's line 5 here.
    const source = [
      "class Solution {",
      "public:",
      "    vector<int> twoSum(vector<int>& nums, long long target) {",
      "        int count = 0",
      "        return {};",
      "    }",
      "};",
      "",
    ].join("\n");
    const result = await judge("cpp20", source);
    expect(result.verdict).toBe("CE");
    expect(result.tests).toEqual([]);
    const output = result.compile!.output;
    expect(output).toMatch(/^solution\.cpp:5:9: error: expected ',' or ';' before 'return'$/m);
    expect(output).toMatch(/^ {4}5 \| {9}return \{\};$/m);
    expect(output).not.toContain("/box/");
    expect(output).not.toContain("/opt/toolchains/");
    expect(output).not.toMatch(/\bmain\.cpp\b/);
  });

  it.skipIf(!hasGcc)("cpp20 undeclared name → CE on the student's own line 4", async () => {
    const source = [
      "class Solution {",
      "public:",
      "    vector<int> twoSum(vector<int>& nums, long long target) {",
      "        return undeclaredHelper(nums, target);",
      "    }",
      "};",
      "",
    ].join("\n");
    const result = await judge("cpp20", source);
    expect(result.verdict).toBe("CE");
    const output = result.compile!.output;
    expect(output).toMatch(/^solution\.cpp:4:16: error: 'undeclaredHelper' was not declared in this scope$/m);
    expect(output).not.toContain("/box/");
    expect(output).not.toContain("/opt/toolchains/");
  });

  it.skipIf(!hasGcc)("cpp20 out-of-bounds write → RE (SIGSEGV), deep recursion within the stack limit → AC", async () => {
    const crash = await judge(
      "cpp20",
      [
        "class Solution {",
        "public:",
        "    vector<int> twoSum(vector<int>& nums, long long target) {",
        // A volatile pointer, so -O2 cannot turn the store into a trap (SIGILL).
        "        int* volatile p = nullptr;",
        "        *p = 1;",
        "        return {0, 1};",
        "    }",
        "};",
        "",
      ].join("\n"),
    );
    expect(crash.verdict).toBe("RE");
    expect(crash.tests[0]).toMatchObject({ v: "RE", signal: "SIGSEGV" });

    // ~1e6 frames of recursion: needs far more than the 8 MB default stack (--stack = memory limit).
    const deep = await judge(
      "cpp20",
      [
        "static int depth(int n) { volatile char pad[64]; pad[0] = (char)n; return n == 0 ? pad[0] : depth(n - 1) + (pad[0] & 0); }",
        "class Solution {",
        "public:",
        "    vector<int> twoSum(vector<int>& nums, long long target) {",
        "        depth(1000000);",
        "        unordered_map<long long, int> seen;",
        "        for (int i = 0; i < (int)nums.size(); ++i) {",
        "            auto it = seen.find(target - nums[i]);",
        "            if (it != seen.end()) return {it->second, i};",
        "            seen.emplace(nums[i], i);",
        "        }",
        "        return {};",
        "    }",
        "};",
        "",
      ].join("\n"),
    );
    expect(deep.verdict).toBe("AC");
  });

  it("published live progress for every judged job", () => {
    expect(publisher.events.some((e) => e.event.type === "state")).toBe(true);
  });
});
