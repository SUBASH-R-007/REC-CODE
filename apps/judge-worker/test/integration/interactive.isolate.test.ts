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
 * Interactive problems on REAL isolate boxes (Phase 12l), through the
 * worker's whole job path: two boxes running at the same time, the
 * conversation relayed between them, and the interactor's exit code
 * deciding the verdict.
 *
 * This is the suite the phase exists for. Everything else about interactive
 * judging can be unit-tested; whether two sandboxed programs can actually
 * talk to each other — and whether the worker notices when they stop — can
 * only be found out here.
 *
 * Box base 60 (run 60, compile 160, checker 260): clear of the dev worker
 * (0/100/200), the two-sum suite (40) and the judging suite (50).
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
const BOX_BASE = Number(process.env.RECX_INTERACTIVE_BOX_BASE ?? 60);

// ── The problem: guess the number ───────────────────────────────────────
//
// The input file holds the secret and the query budget. The solution prints
// a guess per line and reads "lower", "higher" or "correct"; it must find
// the secret within the budget.

const INTERACTOR = `#include "testlib.h"
#include <string>

// Phase 12l integration: guess the number.
//   input:  <secret> <queries allowed>
//   reads:  one integer per line from the contestant
//   writes: "lower" / "higher" / "correct"
int main(int argc, char* argv[]) {
    registerInteraction(argc, argv);
    int secret = inf.readInt();
    int budget = inf.readInt();
    for (int asked = 1; asked <= budget; asked++) {
        int guess = ouf.readInt(1, 1000000000, "guess");
        if (guess == secret) {
            std::cout << "correct" << std::endl;
            tout << guess << std::endl;
            quitf(_ok, "found %d after %d queries", secret, asked);
        }
        std::cout << (guess > secret ? "lower" : "higher") << std::endl;
    }
    quitf(_wa, "did not find %d within %d queries", secret, budget);
}
`;

/** An interactor that is itself broken: never the student's wrong answer. */
const BROKEN_INTERACTOR = `#include "testlib.h"
int main(int argc, char* argv[]) {
    registerInteraction(argc, argv);
    quitf(_fail, "the jury data for this test is inconsistent");
}
`;

const BINARY_SEARCH = `#include <bits/stdc++.h>
int main() {
    long long lo = 1, hi = 1000000000;
    while (lo <= hi) {
        long long mid = (lo + hi) / 2;
        std::cout << mid << std::endl;          // endl flushes
        std::string reply;
        if (!(std::cin >> reply)) return 0;
        if (reply == "correct") return 0;
        if (reply == "lower") hi = mid - 1; else lo = mid + 1;
    }
    return 0;
}
`;

/** Correct, and one query at a time from 1: finds it, far too slowly. */
const LINEAR = `#include <bits/stdc++.h>
int main() {
    for (long long guess = 1;; guess++) {
        std::cout << guess << std::endl;
        std::string reply;
        if (!(std::cin >> reply)) return 0;
        if (reply == "correct") return 0;
    }
}
`;

/**
 * Asks once and never flushes: both programs end up waiting.
 *
 * C stdio on purpose. `std::cin` is TIED to `std::cout`, so in C++ a read
 * flushes the pending write and the classic mistake does not reproduce —
 * the first integration run proved that by returning WA for a C++ version
 * of this program, which had asked its question after all. `printf` and
 * `scanf` share no such courtesy, and that is the deadlock students hit.
 */
const NO_FLUSH = `#include <cstdio>
int main() {
    printf("500000000\\n");                      // buffered; nothing is sent
    char reply[32];
    if (scanf("%31s", reply) != 1) return 0;    // waits for a reply that cannot come
    return 0;
}
`;

/** Prints without ever reading: the output cap, not a deadlock. */
const FLOOD = `#include <bits/stdc++.h>
int main() {
    for (long long i = 0;; i++) std::cout << "1\\n";
}
`;

const CRASH = `#include <bits/stdc++.h>
int main() {
    std::cout << 1 << std::endl;
    int* p = nullptr;
    *p = 1;                                     // SIGSEGV, mid-conversation
    return 0;
}
`;

describe.skipIf(!enabled || !ready)("interactive problems on real isolate", () => {
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
      // The interactor compiles once and is then served from here, which
      // is also how a real node pays for it: once per node per hour.
      compileCache: new CompileCache({
        dir: mkdtempSync(path.join(os.tmpdir(), "recjudge-interactive-compile-")),
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
    console.log(`[integration] interactive: testlib ${TESTLIB_ID}, boxes ${BOX_BASE}/${BOX_BASE + 100}/${BOX_BASE + 200}`);
  });

  function job(source: string, options: { interactor?: string; cases?: { input: string; isSample?: boolean }[] } = {}): BuiltJob {
    return buildJob({
      language: "cpp20",
      source,
      interactorSource: options.interactor ?? INTERACTOR,
      testlibId: TESTLIB_ID!,
      timeLimitMs: 2000,
      cases: (options.cases ?? [{ input: "42 40\n", isSample: true }]).map((c) => ({
        input: c.input,
        // An interactive case has no expected output.
        output: "",
        isSample: c.isSample ?? false,
      })),
    });
  }

  async function judge(source: string, options?: Parameters<typeof job>[1]): Promise<ResultRequest> {
    const built = job(source, options);
    api.add(built.spec, built.blobs);
    const started = Date.now();
    const outcome = await processJob({ kind: built.spec.kind, id: built.spec.id }, deps);
    const result = api.results.find((r) => r.id === built.spec.id);
    console.log(
      `[integration] interactive ${outcome.outcome}: ${result?.verdict ?? "-"} ` +
        `${result?.passedCases ?? "-"}/${result?.totalCases ?? "-"} wall=${Date.now() - started}ms` +
        (outcome.outcome === "released" ? ` released: ${api.releases.at(-1)?.reason ?? ""}` : ""),
    );
    if (!result) throw new Error(`no result posted (${outcome.outcome}: ${api.releases.at(-1)?.reason ?? ""})`);
    return result;
  }

  it("a binary search finds the number → AC, and the conversation is shown", async () => {
    const result = await judge(BINARY_SEARCH);
    expect(result.verdict).toBe("AC");
    expect(result.passedCases).toBe(1);
    // The interactor's own report reaches a visible case.
    expect(result.tests[0]!.message).toMatch(/found 42 after \d+ queries/);
    // The transcript: the worker was relaying, so it recorded both sides.
    const transcript = result.tests[0]!.stdout ?? "";
    console.log(`[integration] transcript:\n${transcript}`);
    expect(transcript).toMatch(/^> \d+/m);
    expect(transcript).toMatch(/^< (lower|higher|correct)/m);
    expect(transcript).toContain("< correct");
  });

  it("a linear search runs out of queries → WA, in the interactor's words", async () => {
    const result = await judge(LINEAR, { cases: [{ input: "999999 40\n", isSample: true }] });
    expect(result.verdict).toBe("WA");
    expect(result.tests[0]!.message).toMatch(/did not find 999999 within 40 queries/);
  });

  it("a missing flush deadlocks → TLE, with the sentence that says why", async () => {
    const result = await judge(NO_FLUSH);
    expect(result.verdict).toBe("TLE");
    expect(result.tests[0]!.message).toContain("flush");
    // The deadline, not the time limit: 2 s of silence on a 2 s limit.
    expect(result.maxTimeMs).toBeLessThan(2000);
  });

  it("a program that only prints → OLE", async () => {
    const result = await judge(FLOOD);
    expect(result.verdict).toBe("OLE");
  });

  it("a crash mid-conversation → RE", async () => {
    const result = await judge(CRASH);
    expect(result.verdict).toBe("RE");
  });

  it("the interactor's CPU is not the student's", async () => {
    const result = await judge(BINARY_SEARCH);
    // Two boxes, two meta files: what is reported is the solution's own CPU
    // time, which for thirty lines of binary search is a few milliseconds.
    expect(result.maxTimeMs).toBeLessThan(500);
    expect(result.cpuMs).toBeLessThan(500);
  });

  it("hides the conversation of a hidden case", async () => {
    const result = await judge(BINARY_SEARCH, {
      cases: [
        { input: "42 40\n", isSample: true },
        { input: "777 40\n", isSample: false },
      ],
    });
    expect(result.verdict).toBe("AC");
    expect(result.passedCases).toBe(2);
    const hidden = result.tests.find((t) => t.i === 1)!;
    expect(hidden.stdout).toBeUndefined();
    expect(hidden.stderr).toBeUndefined();
    // Nothing about the hidden secret, not even the interactor's praise.
    expect(hidden.message).toBeUndefined();
    expect(JSON.stringify(hidden)).not.toContain("777");
  });

  it("an interactor that reports FAIL releases the job and never fails the student", async () => {
    const built = job(BINARY_SEARCH, { interactor: BROKEN_INTERACTOR });
    api.add(built.spec, built.blobs);
    const outcome = await processJob({ kind: built.spec.kind, id: built.spec.id }, deps);
    expect(outcome.outcome).toBe("released");
    const release = api.releases.find((r) => r.id === built.spec.id);
    expect(release?.permanent).toBe(true);
    expect(release?.reason).toContain("interactor");
    expect(api.results.find((r) => r.id === built.spec.id)).toBeUndefined();
  });

  it("judges two cases in a row without leaking a box", async () => {
    // A fresh interactor box per case: the second case must not see the
    // first one's input file or its answers.
    const result = await judge(BINARY_SEARCH, {
      cases: [
        { input: "1 40\n", isSample: true },
        { input: "1000000000 40\n", isSample: true },
      ],
    });
    expect(result.verdict).toBe("AC");
    expect(result.passedCases).toBe(2);
  });
});
