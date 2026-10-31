import { describe, expect, it } from "vitest";
import type { ProgressEvent } from "@recx/shared";
import { MOCK_BANNER, MockJudgeDriver, parseMockMarker } from "../src/drivers/mock";
import type { JudgeIO } from "../src/drivers/types";
import { InfraError, PermanentJudgeError } from "../src/errors";
import { silentLogger } from "../src/logger";
import { buildJob, type BuiltJob } from "./support/jobs";

const CASES = [
  { input: "1\n", output: "one\n", isSample: true },
  { input: "2\n", output: "two\n" },
  { input: "3\n", output: "three\n" },
  { input: "4\n", output: "four\n" },
];

function io(job: BuiltJob, events: ProgressEvent[] = []): JudgeIO {
  return {
    slot: 0,
    blobs: { get: async (ref) => job.blobs.get(ref.sha256)! },
    progress: (e) => events.push(e),
    logger: silentLogger(),
  };
}

describe("MockJudgeDriver", () => {
  it("prints the banner on every job", async () => {
    const out: string[] = [];
    const driver = new MockJudgeDriver({ write: (t) => out.push(t) });
    const job = buildJob({ cases: CASES });
    await driver.judge(job.spec, io(job));
    await driver.judge(job.spec, io(job));
    expect(out).toHaveLength(2);
    for (const text of out) expect(text).toContain("MOCK JUDGE — NO CODE IS EXECUTED — VERDICTS ARE FAKE");
    expect(MOCK_BANNER.split("\n").length).toBeGreaterThan(3);
  });

  it("is AC on every test with fixed fake times when there is no marker", async () => {
    const driver = new MockJudgeDriver({ write: () => {} });
    const job = buildJob({ cases: CASES });
    const a = await driver.judge(job.spec, io(job));
    const b = await driver.judge(job.spec, io(job));
    expect(a).toEqual(b);
    expect(a.verdict).toBe("AC");
    expect(a.tests.every((t) => t.v === "AC" && t.ms === 7 && t.kb === 4096)).toBe(true);
    expect(a.tests[0]!.stdout).toBe("one\n"); // sample echoes the expected output
    expect(a.tests[1]).not.toHaveProperty("stdout");
  });

  it("RECX_MOCK:WA@2 fails test 2 and skips the rest under ICPC", async () => {
    const driver = new MockJudgeDriver({ write: () => {} });
    const job = buildJob({ cases: CASES, source: "int main(){} // RECX_MOCK:WA@2" });
    const events: ProgressEvent[] = [];
    const outcome = await driver.judge(job.spec, io(job, events));
    expect(outcome.verdict).toBe("WA");
    expect(outcome.firstFailedIndex).toBe(2);
    expect(outcome.tests.map((t) => t.v)).toEqual(["AC", "AC", "WA", "SKIPPED"]);
    expect(events.filter((e) => e.type === "test")).toHaveLength(3);
  });

  it("RECX_MOCK:TLE@0 reports the time limit as the fake time", async () => {
    const driver = new MockJudgeDriver({ write: () => {} });
    const job = buildJob({ cases: CASES, source: "# RECX_MOCK:TLE@0", language: "py312", timeLimitMs: 2000 });
    const outcome = await driver.judge(job.spec, io(job));
    expect(outcome.verdict).toBe("TLE");
    expect(outcome.tests[0]).toMatchObject({ v: "TLE", ms: 2000 });
  });

  it("RECX_MOCK:CE fabricates a compile error with no tests", async () => {
    const driver = new MockJudgeDriver({ write: () => {} });
    const job = buildJob({ cases: CASES, source: "// RECX_MOCK:CE" });
    const outcome = await driver.judge(job.spec, io(job));
    expect(outcome).toMatchObject({ verdict: "CE", tests: [], score: 0 });
    expect(outcome.compile!.output).toMatch(/MOCK JUDGE/);
  });

  it("RECX_MOCK:IE simulates an infrastructure failure", async () => {
    const driver = new MockJudgeDriver({ write: () => {} });
    const job = buildJob({ cases: CASES, source: "// RECX_MOCK:IE" });
    await expect(driver.judge(job.spec, io(job))).rejects.toBeInstanceOf(InfraError);
  });

  it("RECX_MOCK:PARTIAL@1 earns half of test 1's points under PER_TEST", async () => {
    const driver = new MockJudgeDriver({ write: () => {} });
    const cases = CASES.map((c, i) => ({ ...c, points: [10, 20, 30, 40][i]! }));
    const job = buildJob({ cases, scoringMode: "PER_TEST", source: "// RECX_MOCK:PARTIAL@1" });
    const outcome = await driver.judge(job.spec, io(job));
    expect(outcome).toMatchObject({ verdict: "PARTIAL", score: 90, maxScore: 100, cpuMs: 28 });
    expect(outcome.tests[1]!.v).toBe("PARTIAL");
  });

  it("scores subtasks exactly like a real node (dependencies, SKIPPED, progress events)", async () => {
    const driver = new MockJudgeDriver({ write: () => {} });
    const cases = CASES.map((c, i) => ({ ...c, subtask: [0, 0, 1, 2][i]! }));
    const job = buildJob({
      cases,
      scoringMode: "SUBTASK",
      source: "// RECX_MOCK:WA@1",
      subtasks: [
        { index: 0, points: 25, aggregation: "MIN", dependsOn: [] },
        { index: 1, points: 25, aggregation: "MIN", dependsOn: [0] },
        { index: 2, points: 50, aggregation: "MIN", dependsOn: [] },
      ],
    });
    const events: ProgressEvent[] = [];
    const outcome = await driver.judge(job.spec, io(job, events));
    expect(outcome).toMatchObject({ verdict: "PARTIAL", score: 50, maxScore: 100 });
    expect(outcome.subtasks.map((s) => s.verdict)).toEqual(["WA", "SKIPPED", "AC"]);
    expect(outcome.tests.map((t) => t.v)).toEqual(["AC", "WA", "SKIPPED", "AC"]);
    expect(events.filter((e) => e.type === "subtask")).toHaveLength(3);
  });

  it("refuses, permanently, what no real node could judge", async () => {
    const driver = new MockJudgeDriver({ write: () => {} });
    const job = buildJob({ cases: CASES, compareMode: "INTERACTIVE" });
    await expect(driver.judge(job.spec, io(job))).rejects.toBeInstanceOf(PermanentJudgeError);
  });

  it("parses markers", () => {
    expect(parseMockMarker("x RECX_MOCK:MLE@12 y")).toEqual({ kind: "test", verdict: "MLE", index: 12 });
    expect(parseMockMarker("RECX_MOCK:PARTIAL@2")).toEqual({ kind: "test", verdict: "PARTIAL", index: 2 });
    expect(parseMockMarker("RECX_MOCK:CE")).toEqual({ kind: "CE" });
    expect(parseMockMarker("RECX_MOCK:AC@1")).toBeNull();
    expect(parseMockMarker("plain code")).toBeNull();
  });

  it("reports the catalog's default languages", async () => {
    const info = await new MockJudgeDriver({ write: () => {} }).info();
    expect(info).toMatchObject({ driver: "mock", version: "mock" });
    expect(info.languages).toEqual(expect.arrayContaining(["cpp20", "py312"]));
  });
});
