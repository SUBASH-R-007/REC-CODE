import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { ResultRequest } from "@recx/shared";
import { BlobCache } from "../../src/cache";
import { CompileCache } from "../../src/compile-cache";
import { IsolateDriver } from "../../src/drivers/isolate";
import { createLogger } from "../../src/logger";
import { processJob, type ProcessorDeps } from "../../src/processor";
import { MemoryPublisher } from "../../src/publisher";
import { SlotPool } from "../../src/slots";
import { FakeJudgeApi } from "../support/fake-api";
import { buildJob, type BuiltJob } from "../support/jobs";

/**
 * Output-only problems on a REAL isolate node (Phase 12n), through the
 * worker's whole job path.
 *
 * Two things can only be found out here. That a CHECKER answer-problem
 * really does compile and run the author's checker against the student's
 * TEXT — the one program an output-only problem involves — and that a
 * plain text comparison creates no box at all on a node that could have
 * created one.
 *
 * Box base 70 (run 70, compile 170, checker 270): clear of the dev worker
 * (0/100/200), two-sum (40), judging (50) and interactive (60).
 *
 *   cd ~/recx/apps/judge-worker && RECX_ISOLATE_INTEGRATION=1 \
 *     RECX_CACHE_DIR=/tmp/recjudge-cache npx vitest run --config vitest.integration.config.ts
 */

const enabled = process.platform === "linux" && process.env.RECX_ISOLATE_INTEGRATION === "1";
const hasGcc = existsSync("/opt/toolchains/gcc-13.2.0/bin/g++");
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
const ready = hasGcc && TESTLIB_ID !== undefined;
const BOX_BASE = Number(process.env.RECX_ANSWER_BOX_BASE ?? 70);

// ── The problem ─────────────────────────────────────────────────────────
//
// "Here are ten numbers. Submit their sum, and then as many of the ten
// doubled as you can." The checker gives one point per correct doubled
// number after the sum, which is what makes partial credit real.

const DATA = "10\n3 1 4 1 5 9 2 6 5 3\n";
const BEST = "39\n6 2 8 2 10 18 4 12 10 6\n";

const CHECKER = `#include "testlib.h"
#include <vector>

// Phase 12n integration: the sum, then as many doubled values as possible.
//   input:  n, then n values
//   answer: the sum, then the n doubled values
//   output: the student's answer — the sum, then 0..n doubled values
int main(int argc, char* argv[]) {
    registerTestlibCmd(argc, argv);
    int n = inf.readInt();
    std::vector<int> values(n);
    for (int i = 0; i < n; i++) values[i] = inf.readInt();
    long long sum = 0;
    for (int v : values) sum += v;

    long long given = ouf.readLong();
    if (given != sum) quitf(_wa, "the sum is %lld, not %lld", sum, given);

    int correct = 0;
    for (int i = 0; i < n; i++) {
        if (ouf.seekEof()) break;
        long long doubled = ouf.readLong();
        if (doubled != 2LL * values[i]) quitf(_wa, "value %d doubled is %lld, not %lld", i + 1, 2LL * values[i], doubled);
        correct++;
    }
    if (correct == n) quitf(_ok, "the sum and all %d doubled values", n);
    // _pc(n) is the platform's partial-credit convention: exit code 16 + n.
    quitf(_pc(correct * 10), "the sum and %d of %d doubled values", correct, n);
}
`;

describe.skipIf(!enabled || !ready)("output-only problems on real isolate", () => {
  let deps: ProcessorDeps;
  let api: FakeJudgeApi;

  beforeAll(async () => {
    const logger = createLogger({ level: process.env.LOG_LEVEL ?? "warn", nodeId: "integration" });
    api = new FakeJudgeApi();
    const driver = await IsolateDriver.create({
      isolateBin: process.env.RECX_ISOLATE_BIN ?? "isolate",
      boxBase: BOX_BASE,
      syntheticEtc: process.env.RECX_SYNTHETIC_ETC ?? "/var/lib/recjudge/etc",
      logger,
      compileCache: new CompileCache({
        dir: mkdtempSync(path.join(os.tmpdir(), "recjudge-answer-compile-")),
        logger,
      }),
    });
    deps = {
      api,
      driver,
      cache: new BlobCache({
        dir: process.env.RECX_CACHE_DIR ?? mkdtempSync(path.join(os.tmpdir(), "recjudge-cache-")),
        maxBytes: 512 * 1024 * 1024,
        logger,
      }),
      publisher: new MemoryPublisher(),
      slots: new SlotPool(1),
      logger,
      nodeId: "integration",
    };
    console.log(`[integration] answer: testlib ${TESTLIB_ID}, boxes ${BOX_BASE}/${BOX_BASE + 100}/${BOX_BASE + 200}`);
  });

  function job(answer: string, options: { checked?: boolean; expected?: string } = {}): BuiltJob {
    return buildJob({
      answer: true,
      source: answer,
      ...(options.checked === false ? {} : { checkerSource: CHECKER }),
      testlibId: TESTLIB_ID!,
      /**
       * PER_TEST, because the checker awards part marks and ICPC has no
       * partial credit — under ICPC the 3-of-10 answer below comes back WA,
       * which is what this suite found about the first spec builder.
       */
      scoringMode: options.checked === false ? "ICPC" : "PER_TEST",
      cases: [{ input: DATA, output: options.expected ?? BEST, isSample: true, points: 100 }],
    });
  }

  async function judge(answer: string, options?: Parameters<typeof job>[1]): Promise<ResultRequest> {
    const built = job(answer, options);
    api.add(built.spec, built.blobs);
    const started = Date.now();
    const outcome = await processJob({ kind: built.spec.kind, id: built.spec.id }, deps);
    const result = api.results.find((r) => r.id === built.spec.id);
    console.log(
      `[integration] answer ${outcome.outcome}: ${result?.verdict ?? "-"} ` +
        `score=${result?.score ?? "-"}/${result?.maxScore ?? "-"} wall=${Date.now() - started}ms` +
        (outcome.outcome === "released" ? ` released: ${api.releases.at(-1)?.reason ?? ""}` : ""),
    );
    if (!result) throw new Error(`no result posted (${outcome.outcome}: ${api.releases.at(-1)?.reason ?? ""})`);
    return result;
  }

  it("the best answer, judged by the author's checker → AC", async () => {
    const result = await judge(BEST);
    expect(result.verdict).toBe("AC");
    expect(result.tests[0]!.message).toMatch(/the sum and all 10 doubled values/);
    // Nothing of the student's ran: no time, no memory, no compile.
    expect(result.tests[0]!.ms).toBe(0);
    expect(result.tests[0]!.kb).toBe(0);
    expect(result.compile).toBeNull();
  });

  it("a partial answer → PARTIAL, with the checker's score", async () => {
    const result = await judge("39\n6 2 8\n");
    expect(result.verdict).toBe("PARTIAL");
    expect(result.tests[0]!.message).toMatch(/the sum and 3 of 10 doubled values/);
    expect(result.score ?? 0).toBeGreaterThan(0);
    expect(result.score ?? 0).toBeLessThan(result.maxScore ?? 0);
  });

  it("a wrong sum → WA, in the checker's own words", async () => {
    const result = await judge("40\n6 2 8 2 10 18 4 12 10 6\n");
    expect(result.verdict).toBe("WA");
    expect(result.tests[0]!.message).toMatch(/the sum is 39, not 40/);
  });

  it("an empty answer → WA rather than an internal error", async () => {
    const result = await judge("\n");
    expect(result.verdict).toBe("WA");
  });

  it("a plain text comparison needs no box at all, even on a node that has them", async () => {
    const result = await judge(BEST, { checked: false });
    expect(result.verdict).toBe("AC");
    expect(result.compile).toBeNull();
    // The whitespace rule of TOKEN, end to end on a real node.
    const spaced = await judge(`  39\n\n6 2 8 2 10 18 4 12 10 6  \n`, { checked: false });
    expect(spaced.verdict).toBe("AC");
    const wrong = await judge("38\n", { checked: false });
    expect(wrong.verdict).toBe("WA");
  });

  it("the student's own answer comes back with the result", async () => {
    const result = await judge("39\n6 2 8\n");
    expect(result.tests[0]!.stdout).toBe("39\n6 2 8\n");
  });
});
