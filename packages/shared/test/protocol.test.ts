import { describe, expect, it } from "vitest";
import { LANGUAGE_CATALOG, LANGUAGE_KEYS, TOOLCHAIN_ID_PATTERN, TOOLCHAIN_ROOT, toolchainDirs } from "../src/languages";
import {
  claimRefusalSchema,
  JUDGE_LANES,
  JUDGE_PROTOCOL_VERSION,
  judgeJobSpecSchema,
  languageRuntimeSchema,
  progressChannel,
  progressEventSchema,
  QUEUE_NAME,
  resultRequestSchema,
} from "../src/protocol";
import { TWO_SUM } from "../src/samples/two-sum";

const sha = (c: string) => c.repeat(64);

function jobSpec(overrides: Record<string, unknown> = {}) {
  return {
    protocolVersion: JUDGE_PROTOCOL_VERSION,
    kind: "submission",
    id: "sub_1",
    lane: "PRACTICE",
    claimToken: "x".repeat(32),
    attempt: 1,
    language: LANGUAGE_CATALOG.cpp20,
    source: "int main() {}",
    ioMode: "FUNCTION",
    functionSignature: TWO_SUM.signature,
    compareMode: "EXACT",
    floatEpsilon: null,
    scoringMode: "ICPC",
    stopOnFirstFailure: true,
    timeLimitMs: 1000,
    memoryLimitKb: 262_144,
    tests: [
      {
        index: 0,
        isSample: true,
        input: { sha256: sha("a"), sizeBytes: 12 },
        output: { sha256: sha("b"), sizeBytes: 6 },
        points: null,
        subtask: null,
      },
    ],
    ...overrides,
  };
}

describe("judge protocol", () => {
  it("has a positive integer protocol version", () => {
    expect(Number.isInteger(JUDGE_PROTOCOL_VERSION)).toBe(true);
    expect(JUDGE_PROTOCOL_VERSION).toBeGreaterThan(0);
  });

  it("accepts a well-formed job spec and defaults inlineBlobs", () => {
    const parsed = judgeJobSpecSchema.parse(jobSpec());
    expect(parsed.inlineBlobs).toEqual({});
  });

  it("rejects a job spec from another protocol version", () => {
    expect(judgeJobSpecSchema.safeParse(jobSpec({ protocolVersion: JUDGE_PROTOCOL_VERSION + 1 })).success).toBe(false);
  });

  it("rejects limits outside the limits table", () => {
    expect(judgeJobSpecSchema.safeParse(jobSpec({ timeLimitMs: 100 })).success).toBe(false);
    expect(judgeJobSpecSchema.safeParse(jobSpec({ timeLimitMs: 20_000 })).success).toBe(false);
    expect(judgeJobSpecSchema.safeParse(jobSpec({ memoryLimitKb: 4 * 1024 * 1024 })).success).toBe(false);
  });

  it("rejects malformed blob hashes and short claim tokens", () => {
    const tests = [{ ...jobSpec().tests[0]!, input: { sha256: "ABC", sizeBytes: 1 } }];
    expect(judgeJobSpecSchema.safeParse(jobSpec({ tests })).success).toBe(false);
    expect(judgeJobSpecSchema.safeParse(jobSpec({ claimToken: "short" })).success).toBe(false);
  });

  it("rejects an unknown verdict in a result", () => {
    const result = {
      protocolVersion: JUDGE_PROTOCOL_VERSION,
      kind: "submission",
      id: "sub_1",
      claimToken: "x".repeat(32),
      verdict: "PE",
      compile: null,
      tests: [],
      passedCases: 0,
      totalCases: 0,
      maxTimeMs: 0,
      maxMemoryKb: 0,
      firstFailedIndex: null,
      score: null,
      maxScore: null,
      cpuMs: 0,
      judgeNodeId: "node-1",
      calibrationScore: null,
    };
    expect(resultRequestSchema.safeParse(result).success).toBe(false);
    expect(resultRequestSchema.safeParse({ ...result, verdict: "AC" }).success).toBe(true);
  });

  it("parses claim refusals", () => {
    expect(claimRefusalSchema.parse({ refused: true, reason: "LEASED_ELSEWHERE" }).reason).toBe("LEASED_ELSEWHERE");
    expect(claimRefusalSchema.safeParse({ refused: true, reason: "BUSY" }).success).toBe(false);
  });

  it("names progress channels per job and validates progress events", () => {
    expect(progressChannel("submission", "abc")).toBe("recx:submission:abc");
    expect(progressChannel("run", "abc")).toBe("recx:run:abc");
    expect(progressEventSchema.parse({ type: "test", i: 0, v: "AC", done: 1, total: 14 }).type).toBe("test");
    expect(progressEventSchema.parse({ type: "final" }).type).toBe("final");
    expect(progressEventSchema.safeParse({ type: "state", state: "DONE" }).success).toBe(false);
  });

  it("uses BullMQ-safe queue names for every lane", () => {
    for (const lane of JUDGE_LANES) expect(QUEUE_NAME[lane]).toMatch(/^judge-[a-z]+$/);
  });
});

describe("language catalog", () => {
  it.each(LANGUAGE_KEYS.map((k) => [k]))("%s is a valid runtime pinned under /opt/toolchains", (key) => {
    const rt = LANGUAGE_CATALOG[key];
    expect(languageRuntimeSchema.safeParse(rt).success).toBe(true);
    expect(rt.key).toBe(key);
    for (const id of [rt.toolchainId, ...rt.extraToolchainIds]) expect(id).toMatch(TOOLCHAIN_ID_PATTERN);
    for (const dir of toolchainDirs(rt)) expect(dir.startsWith(`${TOOLCHAIN_ROOT}/`)).toBe(true);
    // Every executable is a pinned toolchain binary or the program built in the box.
    for (const argv of [rt.compile?.argv ?? [], rt.run.argv]) {
      const exe = argv[0];
      if (exe === undefined) continue;
      expect(exe === "./main" || exe.startsWith(`${TOOLCHAIN_ROOT}/`), exe).toBe(true);
    }
  });

  it("ships C++20 and Python 3.12 enabled by default", () => {
    expect(LANGUAGE_CATALOG.cpp20.enabledByDefault).toBe(true);
    expect(LANGUAGE_CATALOG.py312.enabledByDefault).toBe(true);
  });

  it("rejects toolchain ids that could traverse paths", () => {
    for (const bad of ["../etc", "gcc/13", "gcc-13.2.0/../../x", "GCC-13", "gcc"]) {
      expect(TOOLCHAIN_ID_PATTERN.test(bad), bad).toBe(false);
    }
  });
});
