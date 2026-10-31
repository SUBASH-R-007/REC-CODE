import { describe, expect, it } from "vitest";
import { LIMITS, type CheckerSpec } from "@recx/shared";
import { InfraError } from "../src/errors";
import {
  CHECKER_ARGV,
  CHECKER_PARTIAL_BASE,
  assertCheckerToolchainsPresent,
  checkerCacheKey,
  checkerCompileArgv,
  checkerMessage,
  checkerToolchainIds,
  interpretChecker,
} from "../src/judge/checker";
import { checkerLimits } from "../src/judge/limits";
import { buildIsolateArgv } from "../src/sandbox/isolate";
import type { IsolateMeta } from "../src/sandbox/types";
import { OK_META } from "./support/fake-sandbox";
import { blob } from "./support/jobs";

const exit = (code: number): IsolateMeta => ({ ...OK_META, status: code === 0 ? null : "RE", exitCode: code });

const spec = (source = "int main(){}", testlibId = "testlib-0.9.41"): CheckerSpec => ({
  source: blob(source).ref,
  language: "cpp20",
  testlibId,
});

describe("interpretChecker — testlib exit codes", () => {
  it("0 → AC, 1 → WA, 2 (presentation error) → WA", () => {
    expect(interpretChecker(exit(0), "ok 3 numbers")).toEqual({ kind: "verdict", verdict: "AC", fraction: 1, report: "ok 3 numbers" });
    expect(interpretChecker(exit(1), "wrong answer 2nd numbers differ")).toMatchObject({ kind: "verdict", verdict: "WA", fraction: 0 });
    expect(interpretChecker(exit(2), "wrong output format Unexpected end of file")).toMatchObject({ verdict: "WA", fraction: 0 });
  });

  it("3 (FAIL) is never a WA: it is a checker failure carrying the first line of its report", () => {
    expect(interpretChecker(exit(3), "\nFAIL answer is not a permutation\nmore detail\n")).toEqual({
      kind: "fail",
      reason: "checker FAIL: FAIL answer is not a permutation",
    });
    expect(interpretChecker(exit(3), "")).toEqual({ kind: "fail", reason: "checker FAIL: (no message)" });
  });

  it("16 + n → n/100 of the points; n = 100 → AC; n = 0 → WA", () => {
    expect(CHECKER_PARTIAL_BASE).toBe(16);
    expect(interpretChecker(exit(16), "partially correct (0)")).toMatchObject({ verdict: "WA", fraction: 0 });
    expect(interpretChecker(exit(17), "")).toMatchObject({ verdict: "PARTIAL", fraction: 0.01 });
    expect(interpretChecker(exit(66), "")).toMatchObject({ verdict: "PARTIAL", fraction: 0.5 });
    expect(interpretChecker(exit(115), "")).toMatchObject({ verdict: "PARTIAL", fraction: 0.99 });
    expect(interpretChecker(exit(116), "")).toMatchObject({ verdict: "AC", fraction: 1 });
    for (let code = 17; code <= 115; code++) {
      const d = interpretChecker(exit(code), "");
      expect(d.kind === "verdict" && d.verdict === "PARTIAL" && d.fraction === (code - 16) / 100).toBe(true);
    }
  });

  it.each([4, 5, 7, 8, 15, 117, 200, 255])("exit %i (incl. testlib _points = 7) → checker FAIL", (code) => {
    const d = interpretChecker(exit(code), "points 7.5");
    expect(d.kind).toBe("fail");
    expect(d.kind === "fail" && d.reason).toMatch(new RegExp(`^checker FAIL \\(unsupported exit code ${code}\\): points 7\\.5$`));
  });

  it("the checker's own limits, a crash, or a missing exit code → checker FAIL", () => {
    expect(interpretChecker({ ...OK_META, status: "TO", exitCode: null }, "").kind).toBe("fail");
    expect(interpretChecker({ ...OK_META, status: "SG", exitCode: null, exitSignal: 11 }, "")).toEqual({
      kind: "fail",
      reason: "checker FAIL: the checker was killed by SIGSEGV",
    });
    expect(interpretChecker({ ...OK_META, status: "SG", exitCode: null, exitSignal: 9, cgOomKilled: true }, "")).toMatchObject({
      kind: "fail",
      reason: expect.stringMatching(/memory limit/),
    });
    expect(interpretChecker({ ...OK_META, status: "RE", exitCode: null }, "").kind).toBe("fail");
  });

  it("isolate XX in the checker box is a retryable infrastructure failure, not a checker bug", () => {
    expect(interpretChecker({ ...OK_META, status: "XX", message: "clone failed" }, "")).toMatchObject({ kind: "infra" });
  });

  it("caps the reason line and the test message", () => {
    const long = "x".repeat(3000);
    const fail = interpretChecker(exit(3), long);
    expect(fail.kind === "fail" && fail.reason.length).toBeLessThanOrEqual(500);
    expect(checkerMessage(long)!.length).toBeLessThanOrEqual(512);
    expect(checkerMessage("   \n")).toBeUndefined();
  });
});

describe("checker compile and run command lines", () => {
  it("compiles with gcc-13.2.0, the job's testlib directory on the include path, and _pc(n) pinned to 16 + n", () => {
    const argv = checkerCompileArgv({ testlibId: "testlib-0.9.41" });
    expect(argv[0]).toBe("/opt/toolchains/gcc-13.2.0/bin/g++");
    expect(argv).toEqual(expect.arrayContaining(["-std=c++20", "-O2", "-static", "-DPC_BASE_EXIT_CODE=16"]));
    expect(argv.slice(argv.indexOf("-I"), argv.indexOf("-I") + 2)).toEqual(["-I", "/opt/toolchains/testlib-0.9.41"]);
    expect(argv.slice(-3)).toEqual(["-o", "checker", "checker.cpp"]);
    expect(checkerToolchainIds({ testlibId: "testlib-0.9.41" })).toEqual(["gcc-13.2.0", "testlib-0.9.41"]);
  });

  it("the compile box binds exactly gcc and testlib, read-only", () => {
    const argv = buildIsolateArgv({
      action: "run",
      boxId: 100,
      metaFile: "/tmp/m/box.meta",
      syntheticEtc: "/var/lib/recjudge/etc",
      toolchainIds: checkerToolchainIds({ testlibId: "testlib-0.9.41" }),
      env: { PATH: "/opt/toolchains/gcc-13.2.0/bin:/usr/bin:/bin" },
      limits: checkerLimits(),
      stdin: null,
      stdout: "compile.stdout",
      stderr: "compile.stderr",
      argv: checkerCompileArgv({ testlibId: "testlib-0.9.41" }),
    });
    expect(argv.filter((a) => a.startsWith("--dir=/opt/toolchains"))).toEqual([
      "--dir=/opt/toolchains/gcc-13.2.0",
      "--dir=/opt/toolchains/testlib-0.9.41",
    ]);
  });

  it("the checker box binds no toolchain and runs ./checker input.txt output.txt answer.txt under LIMITS.checker", () => {
    const argv = buildIsolateArgv({
      action: "run",
      boxId: 200,
      metaFile: "/tmp/m/box.meta",
      syntheticEtc: "/var/lib/recjudge/etc",
      toolchainIds: [],
      env: { PATH: "/usr/bin:/bin" },
      limits: checkerLimits(),
      stdin: null,
      stdout: "checker.stdout",
      stderr: "checker.stderr",
      argv: [...CHECKER_ARGV],
    });
    expect(argv.some((a) => a.startsWith("--dir=/opt/toolchains"))).toBe(false);
    expect(argv.join(" ")).not.toMatch(/share-net|full-env|--mem=/);
    expect(argv).toContain(`--time=${LIMITS.checker.cpuSec.toFixed(3)}`);
    expect(argv).toContain(`--wall-time=${LIMITS.checker.wallSec}`);
    expect(argv).toContain(`--cg-mem=${LIMITS.checker.memoryKb}`);
    expect(argv).toContain("--processes=1");
    expect(argv.slice(argv.indexOf("--run") + 2)).toEqual(["./checker", "input.txt", "output.txt", "answer.txt"]);
  });

  it("the cache key follows the source, the testlib version and nothing else", () => {
    expect(checkerCacheKey(spec())).toBe(checkerCacheKey(spec()));
    expect(checkerCacheKey(spec())).toMatch(/^[0-9a-f]{64}$/);
    expect(checkerCacheKey(spec("int main(){return 0;}"))).not.toBe(checkerCacheKey(spec()));
    expect(checkerCacheKey(spec(undefined, "testlib-0.9.42"))).not.toBe(checkerCacheKey(spec()));
  });
});

describe("assertCheckerToolchainsPresent", () => {
  const present = new Set(["/opt/toolchains/gcc-13.2.0", "/opt/toolchains/gcc-13.2.0/bin/g++", "/opt/toolchains/testlib-0.9.41/testlib.h"]);

  it("passes when gcc and testlib.h are installed", () => {
    expect(() => assertCheckerToolchainsPresent({ testlibId: "testlib-0.9.41" }, (p) => present.has(p))).not.toThrow();
  });

  it("a missing testlib is a retryable infrastructure failure on THIS node", () => {
    let error: unknown;
    try {
      assertCheckerToolchainsPresent({ testlibId: "testlib-0.9.42" }, (p) => present.has(p));
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(InfraError);
    expect((error as InfraError).permanent).toBe(false);
    expect((error as Error).message).toMatch(/^testlib toolchain missing on this node/);
  });

  it("a missing compiler is retryable too", () => {
    expect(() => assertCheckerToolchainsPresent({ testlibId: "testlib-0.9.41" }, () => false)).toThrow(/not installed on this node/);
  });
});
