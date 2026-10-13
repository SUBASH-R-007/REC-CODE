import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { resultRequestSchema, type JudgeJobSpec, type ResultRequest } from "@recx/shared";
import { BlobCache } from "../../src/cache";
import { CompileCache } from "../../src/compile-cache";
import { IsolateDriver } from "../../src/drivers/isolate";
import { createLogger } from "../../src/logger";
import { processJob, type ProcessOutcome, type ProcessorDeps } from "../../src/processor";
import { MemoryPublisher } from "../../src/publisher";
import { SlotPool } from "../../src/slots";
import { FakeJudgeApi } from "../support/fake-api";
import { buildJob, type BuiltJob, type TestCaseInput } from "../support/jobs";

/**
 * Phase 2 judging on REAL isolate boxes and the pinned toolchains, through
 * the worker's job path (claim → blobs → IsolateDriver → result / release):
 *
 *   - CHECKER: an original testlib checker for a problem with many correct
 *     answers (any derangement of 1..n) accepts two different valid outputs
 *     and rejects an invalid one; testlib partial credit (_pc) maps to
 *     PARTIAL points; a checker that reports FAIL (the jury answer is wrong)
 *     releases the job permanently.
 *   - SUBTASK: MIN / SUM_FRACTION subtasks with a dependency give PARTIAL
 *     with the exact score, and the skipped subtask's tests never run.
 *   - Compile cache: Submit after Run of the same code compiles once.
 *
 * Box base 50 (run 50, compile 150, checker 250): clear of a dev worker's
 * boxes and of the two-sum suite (40).
 *
 *   cd ~/recx/apps/judge-worker && RECX_ISOLATE_INTEGRATION=1 \
 *     RECX_CACHE_DIR=/tmp/recjudge-cache npx vitest run --config vitest.integration.config.ts
 */

const enabled = process.platform === "linux" && process.env.RECX_ISOLATE_INTEGRATION === "1";
const hasGcc = existsSync("/opt/toolchains/gcc-13.2.0/bin/g++");
const hasPython = existsSync("/opt/toolchains/cpython-3.12.6/bin/python3");
const TESTLIB_ID = (() => {
  try {
    return readdirSync("/opt/toolchains")
      .filter((d) => /^testlib-[0-9]/.test(d) && existsSync(`/opt/toolchains/${d}/testlib.h`))
      .sort()
      .at(-1);
  } catch {
    return undefined;
  }
})();
const hasTestlib = hasGcc && TESTLIB_ID !== undefined;
const BOX_BASE = Number(process.env.RECX_JUDGING_BOX_BASE ?? 50);

// ── The derangement problem (CHECKER) ───────────────────────────────────
// Given n ≥ 2, print any permutation p of 1..n with p_i ≠ i for every i.

/** Original testlib checker: accepts any derangement; FAILs if the jury's own answer is not one. */
const DERANGEMENT_CHECKER = `#include "testlib.h"
#include <vector>

// Accepts any derangement of 1..n (a permutation with p_i != i for all i).
// The jury answer is validated too: a bad answer file is a checker FAIL,
// never the contestant's wrong answer.
int main(int argc, char* argv[]) {
    registerTestlibCmd(argc, argv);
    int n = inf.readInt();
    std::vector<bool> seen(n + 1, false);
    for (int i = 1; i <= n; i++) {
        int v = ans.readInt(1, n, "jury p_i");
        if (v == i || seen[v]) quitf(_fail, "jury answer is not a derangement at position %d", i);
        seen[v] = true;
    }
    std::fill(seen.begin(), seen.end(), false);
    for (int i = 1; i <= n; i++) {
        int v = ouf.readInt(1, n, "p_i");
        if (seen[v]) quitf(_wa, "value %d appears twice", v);
        if (v == i) quitf(_wa, "position %d is fixed", i);
        seen[v] = true;
    }
    quitf(_ok, "n = %d, a valid derangement", n);
}
`;

/** Partial credit: a derangement earns everything, any other permutation half (testlib _pc(50)). */
const DERANGEMENT_PARTIAL_CHECKER = `#include "testlib.h"
#include <vector>

int main(int argc, char* argv[]) {
    registerTestlibCmd(argc, argv);
    int n = inf.readInt();
    std::vector<bool> seen(n + 1, false);
    int fixed = 0;
    for (int i = 1; i <= n; i++) {
        int v = ouf.readInt(1, n, "p_i");
        if (seen[v]) quitf(_wa, "value %d appears twice", v);
        seen[v] = true;
        if (v == i) fixed++;
    }
    if (fixed > 0) quitf(_pc(50), "a permutation with %d fixed points", fixed);
    quitf(_ok, "a valid derangement");
}
`;

const shiftLeft = (n: number) => `${Array.from({ length: n }, (_, i) => ((i + 1) % n) + 1).join(" ")}\n`;

function derangementCases(answer: (n: number) => string = shiftLeft): TestCaseInput[] {
  return [3, 2, 5, 10, 17].map((n, i) => ({ input: `${n}\n`, output: answer(n), isSample: i === 0 }));
}

/** p_i = i + 1, p_n = 1. */
const CPP_SHIFT_LEFT = `#include <cstdio>
int main() {
    int n;
    if (std::scanf("%d", &n) != 1) return 1;
    for (int i = 1; i <= n; i++) std::printf("%d%c", i == n ? 1 : i + 1, i == n ? '\\n' : ' ');
}
`;
/** p_1 = n, p_i = i - 1: a different valid answer. */
const PY_SHIFT_RIGHT = "n = int(input())\nprint(' '.join(str(n if i == 1 else i - 1) for i in range(1, n + 1)))\n";
/** The identity: a permutation, but every position is fixed. */
const PY_IDENTITY = "n = int(input())\nprint(' '.join(str(i) for i in range(1, n + 1)))\n";

// ── The list-sum problem (SUBTASK) ──────────────────────────────────────
// Read n, then n integers; print their sum.

const SUM_LL = `#include <cstdio>
int main() {
    int n; long long s = 0, x;
    if (std::scanf("%d", &n) != 1) return 1;
    while (n-- > 0 && std::scanf("%lld", &x) == 1) s += x;
    std::printf("%lld\\n", s);
}
`;
/** 32-bit wrap-around: right for small sums, wrong once the sum leaves int range. */
const SUM_INT32 = `#include <cstdio>
int main() {
    int n, x; unsigned s = 0;
    if (std::scanf("%d", &n) != 1) return 1;
    while (n-- > 0 && std::scanf("%d", &x) == 1) s += (unsigned)x;
    std::printf("%d\\n", (int)s);
}
`;

const SUM_CASES: TestCaseInput[] = [
  // subtask 0 — small values
  { input: "3\n1 2 3\n", output: "6\n", subtask: 0, isSample: true },
  { input: "1\n5\n", output: "5\n", subtask: 0 },
  // subtask 1 — sums beyond 32 bits (depends on 0)
  { input: "2\n2000000000 2000000000\n", output: "4000000000\n", subtask: 1 },
  { input: "3\n1500000000 1500000000 5\n", output: "3000000005\n", subtask: 1 },
  // subtask 2 — mixed, SUM_FRACTION
  { input: "1\n7\n", output: "7\n", subtask: 2 },
  { input: "2\n2147483647 1\n", output: "2147483648\n", subtask: 2 },
  { input: "2\n-5 5\n", output: "0\n", subtask: 2 },
  { input: "1\n-2000000000\n", output: "-2000000000\n", subtask: 2 },
  // subtask 3 — depends on 1
  { input: "1\n1\n", output: "1\n", subtask: 3 },
];
const SUM_SUBTASKS: JudgeJobSpec["subtasks"] = [
  { index: 0, points: 20, aggregation: "MIN", dependsOn: [] },
  { index: 1, points: 30, aggregation: "MIN", dependsOn: [0] },
  { index: 2, points: 40, aggregation: "SUM_FRACTION", dependsOn: [] },
  { index: 3, points: 10, aggregation: "MIN", dependsOn: [1] },
];

describe.skipIf(!enabled)("Phase 2 judging on real isolate", () => {
  let deps: ProcessorDeps;
  let api: FakeJudgeApi;
  let publisher: MemoryPublisher;
  let compileCache: CompileCache;

  beforeAll(async () => {
    const logger = createLogger({ level: process.env.LOG_LEVEL ?? "warn", nodeId: "integration-judging" });
    api = new FakeJudgeApi();
    publisher = new MemoryPublisher();
    // A fresh compile cache: the first compile of every program here must be a miss.
    compileCache = new CompileCache({ dir: mkdtempSync(path.join(os.tmpdir(), "recjudge-compiled-")), logger });
    const driver = await IsolateDriver.create({
      isolateBin: process.env.RECX_ISOLATE_BIN ?? "isolate",
      boxBase: BOX_BASE,
      syntheticEtc: process.env.RECX_SYNTHETIC_ETC ?? "/var/lib/recjudge/etc",
      logger,
      compileCache,
    });
    const cacheDir = process.env.RECX_CACHE_DIR ?? mkdtempSync(path.join(os.tmpdir(), "recjudge-cache-"));
    deps = {
      api,
      driver,
      cache: new BlobCache({ dir: cacheDir, maxBytes: 512 * 1024 * 1024, logger }),
      publisher,
      slots: new SlotPool(1),
      logger,
      nodeId: "integration-judging",
    };
    console.log(`[judging] box base ${BOX_BASE}; testlib: ${TESTLIB_ID ?? "MISSING"}; compile cache ${compileCache.dir}`);
    if (!TESTLIB_ID) {
      console.warn("[judging] no /opt/toolchains/testlib-*/testlib.h on this host — CHECKER cases are SKIPPED (infra/judge/toolchains/install-testlib.sh)");
    }
  });

  async function processThrough(job: BuiltJob): Promise<{ outcome: ProcessOutcome; result: ResultRequest | undefined }> {
    api.add(job.spec, job.blobs);
    const started = Date.now();
    const outcome = await processJob({ kind: job.spec.kind, id: job.spec.id }, deps);
    const result = api.results.find((r) => r.id === job.spec.id);
    if (result) {
      expect(resultRequestSchema.safeParse(result).success).toBe(true);
      console.log(
        `[judging] ${job.spec.kind} ${job.spec.language.key} ${job.spec.compareMode}/${job.spec.scoringMode}: ${result.verdict}` +
          ` score=${result.score}/${result.maxScore} tests=${result.tests.map((t) => t.v).join(",")}` +
          ` compile=${result.compile ? `${result.compile.ok ? "ok" : "CE"} ${result.compile.timeMs}ms cached=${result.compile.cached}` : "none"}` +
          ` cpu=${result.cpuMs}ms wall=${Date.now() - started}ms`,
      );
    } else {
      console.log(`[judging] ${job.spec.kind} ${job.spec.id}: ${JSON.stringify(outcome)}`);
    }
    return { outcome, result };
  }

  async function judged(job: BuiltJob): Promise<ResultRequest> {
    const { outcome, result } = await processThrough(job);
    expect(outcome.outcome).toBe("posted");
    if (!result) throw new Error("no result posted");
    return result;
  }

  const checkerJob = (source: string, language: "cpp20" | "py312", extra: Partial<Parameters<typeof buildJob>[0]> = {}) =>
    buildJob({
      language,
      source,
      cases: derangementCases(),
      checkerSource: DERANGEMENT_CHECKER,
      testlibId: TESTLIB_ID ?? "testlib-0.9.41",
      ...extra,
    });

  it.skipIf(!hasTestlib)("CHECKER: a C++ shift-left derangement → AC on every test", async () => {
    const result = await judged(checkerJob(CPP_SHIFT_LEFT, "cpp20"));
    expect(result.verdict).toBe("AC");
    expect(result.tests.every((t) => t.v === "AC")).toBe(true);
    // The sample carries the checker's report; hidden tests carry nothing about their output.
    expect(result.tests[0]!.message).toMatch(/ok n = 3, a valid derangement/);
    for (const t of result.tests.slice(1)) {
      expect(t.message).toBeUndefined();
      expect(t.stdout).toBeUndefined();
    }
  });

  it.skipIf(!hasTestlib || !hasPython)("CHECKER: a different valid output (Python shift-right) → AC; the checker binary came from the cache", async () => {
    const before = compileCache.count;
    const result = await judged(checkerJob(PY_SHIFT_RIGHT, "py312"));
    expect(result.verdict).toBe("AC");
    expect(result.tests[0]!.stdout).toBe("3 1 2\n"); // not the jury's "2 3 1"
    // Only the Python program was added: the checker was already cached.
    expect(compileCache.count).toBe(before + 1);
  });

  it.skipIf(!hasTestlib || !hasPython)("CHECKER: the identity permutation → WA on the first test", async () => {
    const result = await judged(checkerJob(PY_IDENTITY, "py312"));
    expect(result.verdict).toBe("WA");
    expect(result.firstFailedIndex).toBe(0);
    expect(result.tests[0]!.message).toMatch(/position 1 is fixed/);
    expect(result.tests.slice(1).every((t) => t.v === "SKIPPED")).toBe(true);
  });

  it.skipIf(!hasTestlib || !hasPython)("CHECKER: testlib partial credit (_pc(50)) → PARTIAL, half the points", async () => {
    const cases = derangementCases().map((c, i) => ({ ...c, points: [10, 10, 20, 20, 40][i]! }));
    const result = await judged(
      buildJob({
        language: "py312",
        source: PY_IDENTITY,
        cases,
        checkerSource: DERANGEMENT_PARTIAL_CHECKER,
        testlibId: TESTLIB_ID ?? "testlib-0.9.41",
        scoringMode: "PER_TEST",
      }),
    );
    expect(result.tests.every((t) => t.v === "PARTIAL")).toBe(true);
    expect(result).toMatchObject({ verdict: "PARTIAL", score: 50, maxScore: 100 });
  });

  it.skipIf(!hasTestlib)("CHECKER: a checker that reports FAIL (bad jury answer) releases the job permanently", async () => {
    // The jury's answer for every test is the identity — not a derangement.
    const job = checkerJob(CPP_SHIFT_LEFT, "cpp20", {
      cases: derangementCases((n) => `${Array.from({ length: n }, (_, i) => i + 1).join(" ")}\n`),
    });
    const { outcome, result } = await processThrough(job);
    expect(result).toBeUndefined();
    expect(outcome.outcome).toBe("released");
    const release = api.releases.find((r) => r.id === job.spec.id);
    expect(release).toMatchObject({ permanent: true });
    expect(release!.reason).toMatch(/^checker FAIL: .*jury answer is not a derangement at position 1/);
  });

  it.skipIf(!hasTestlib)("CHECKER: a checker that does not compile releases the job permanently", async () => {
    const job = buildJob({
      source: CPP_SHIFT_LEFT,
      cases: derangementCases(),
      checkerSource: '#include "testlib.h"\nint main(int argc, char* argv[]) { registerTestlibCmd(argc, argv); quitf(_ok, "x") }\n',
      testlibId: TESTLIB_ID ?? "testlib-0.9.41",
    });
    const { outcome } = await processThrough(job);
    expect(outcome.outcome).toBe("released");
    const release = api.releases.find((r) => r.id === job.spec.id)!;
    expect(release.permanent).toBe(true);
    expect(release.reason).toMatch(/^checker does not compile: .*error/);
    expect(release.reason).not.toContain("/box/");
  });

  it.skipIf(!hasGcc)("SUBTASK: a 32-bit sum earns subtask 0 and 3 of 4 SUM_FRACTION tests; its dependants are SKIPPED → PARTIAL 50", async () => {
    const result = await judged(
      buildJob({ source: SUM_INT32, cases: SUM_CASES, scoringMode: "SUBTASK", subtasks: SUM_SUBTASKS }),
    );
    expect(result.subtasks).toEqual([
      { index: 0, earned: 20, max: 20, verdict: "AC" },
      { index: 1, earned: 0, max: 30, verdict: "WA" },
      { index: 2, earned: 30, max: 40, verdict: "PARTIAL" },
      { index: 3, earned: 0, max: 10, verdict: "SKIPPED" },
    ]);
    expect(result).toMatchObject({ verdict: "PARTIAL", score: 50, maxScore: 100, firstFailedIndex: 2 });
    expect(result.tests.map((t) => t.v)).toEqual(["AC", "AC", "WA", "SKIPPED", "AC", "WA", "AC", "AC", "SKIPPED"]);
    // The skipped tests never ran: no time, and the CPU charged is the sum of the tests that did.
    expect(result.tests.filter((t) => t.v === "SKIPPED").every((t) => t.ms === 0 && t.kb === 0)).toBe(true);
    expect(result.cpuMs).toBe(result.tests.reduce((s, t) => s + t.ms, 0));
    const subtaskEvents = publisher.events.filter((e) => e.channel === `recx:submission:${result.id}` && e.event.type === "subtask");
    expect(subtaskEvents.map((e) => e.event)).toEqual([
      { type: "subtask", index: 0, v: "AC" },
      { type: "subtask", index: 1, v: "WA" },
      { type: "subtask", index: 2, v: "PARTIAL" },
      { type: "subtask", index: 3, v: "SKIPPED" },
    ]);
  });

  it.skipIf(!hasGcc)("Submit after Run of the same code: the second compile is served from the compile cache", async () => {
    // A source no other case compiles, so the Run is a guaranteed miss.
    const source = `${SUM_LL}// submit-after-run ${Date.now()}\n`;
    const run = await judged(
      buildJob({ kind: "run", source, cases: SUM_CASES.filter((c) => c.isSample), stopOnFirstFailure: false }),
    );
    expect(run.verdict).toBe("AC");
    expect(run.compile).toMatchObject({ ok: true, cached: false });
    expect(run.score).toBeNull();

    const submit = await judged(buildJob({ source, cases: SUM_CASES, scoringMode: "SUBTASK", subtasks: SUM_SUBTASKS }));
    expect(submit.compile).toMatchObject({ ok: true, cached: true, timeMs: run.compile!.timeMs });
    expect(submit).toMatchObject({ verdict: "AC", score: 100, maxScore: 100 });
    expect(submit.subtasks.every((s) => s.verdict === "AC")).toBe(true);
  });

  it.skipIf(!hasPython)("validation jobs publish no progress and report every test's CPU time", async () => {
    const before = publisher.events.length;
    const result = await judged(
      buildJob({ kind: "validation", language: "py312", source: "n = int(input())\nprint(sum(map(int, input().split())))\n", cases: SUM_CASES, stopOnFirstFailure: false }),
    );
    expect(result.verdict).toBe("AC");
    expect(result.tests).toHaveLength(SUM_CASES.length);
    expect(result.tests.every((t) => t.v === "AC" && t.ms >= 0)).toBe(true);
    expect(publisher.events.length).toBe(before);
  });
});
