import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JUDGE_PROTOCOL_VERSION, resultRequestSchema, type JudgeJobSpec } from "@recx/shared";
import { BlobCache } from "../src/cache";
import { MockJudgeDriver } from "../src/drivers/mock";
import type { JudgeDriver, JudgeIO, JudgeOutcome } from "../src/drivers/types";
import { InfraError, PermanentJudgeError, ProtocolMismatchError } from "../src/errors";
import { silentLogger } from "../src/logger";
import { processJob, type ProcessorDeps } from "../src/processor";
import { MemoryPublisher } from "../src/publisher";
import { SlotPool } from "../src/slots";
import { FakeJudgeApi } from "./support/fake-api";
import { blob, buildJob } from "./support/jobs";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function cacheDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "recjudge-proc-"));
  dirs.push(dir);
  return dir;
}

const WA_OUTCOME: JudgeOutcome = {
  verdict: "WA",
  compile: { ok: true, output: "", timeMs: 120, cached: false, resourceExceeded: false },
  tests: [
    { i: 0, v: "AC", ms: 3, kb: 1000 },
    { i: 1, v: "WA", ms: 4, kb: 1100 },
  ],
  passedCases: 1,
  totalCases: 2,
  maxTimeMs: 4,
  maxMemoryKb: 1100,
  firstFailedIndex: 1,
  score: 0,
  maxScore: 1,
  subtasks: [],
  cpuMs: 7,
};

/** A driver that reads every test's input through io.blobs, then answers with a fixed outcome or error. */
class ScriptedDriver implements JudgeDriver {
  readonly name = "mock" as const;
  judged: { spec: JudgeJobSpec; slot: number }[] = [];
  constructor(private readonly answer: () => Promise<JudgeOutcome>) {}
  async info() {
    return { driver: "mock" as const, version: "test", languages: [] };
  }
  async judge(spec: JudgeJobSpec, io: JudgeIO): Promise<JudgeOutcome> {
    this.judged.push({ spec, slot: io.slot });
    for (const t of spec.tests) await io.blobs.get(t.input);
    io.progress({ type: "state", state: "RUNNING" });
    return this.answer();
  }
}

function setup(answer: () => Promise<JudgeOutcome>) {
  const api = new FakeJudgeApi();
  const job = buildJob({
    cases: [
      { input: "1\n", output: "1\n", isSample: true },
      { input: "2\n", output: "2\n" },
    ],
  });
  api.add(job.spec, job.blobs);
  const driver = new ScriptedDriver(answer);
  const publisher = new MemoryPublisher();
  const slots = new SlotPool(2);
  const deps: ProcessorDeps = {
    api,
    driver,
    cache: new BlobCache({ dir: cacheDir(), maxBytes: 1024 * 1024 }),
    publisher,
    slots,
    logger: silentLogger(),
    nodeId: "judge-test-01",
  };
  return { api, job, driver, publisher, slots, deps, data: { kind: job.spec.kind, id: job.spec.id } };
}

describe("processJob", () => {
  it("posts a deterministic verdict and never throws for it", async () => {
    const { api, deps, data, slots, publisher, job } = setup(async () => WA_OUTCOME);
    await expect(processJob(data, deps)).resolves.toEqual({ outcome: "posted", verdict: "WA" });
    expect(api.results).toHaveLength(1);
    expect(api.results[0]).toMatchObject({
      kind: "submission",
      id: job.spec.id,
      claimToken: job.spec.claimToken,
      verdict: "WA",
      judgeNodeId: "judge-test-01",
      calibrationScore: null,
      firstFailedIndex: 1,
    });
    expect(api.releases).toHaveLength(0);
    expect(slots.busy).toBe(0);
    expect(publisher.events[0]).toEqual({ channel: `recx:submission:${job.spec.id}`, event: { type: "state", state: "RUNNING" } });
  });

  it("fetches blobs through the sha256-verified cache, once per blob", async () => {
    const { api, deps, data } = setup(async () => WA_OUTCOME);
    await processJob(data, deps);
    await processJob(data, deps);
    expect(api.blobFetches).toHaveLength(2); // two inputs, second job served from the cache
  });

  it("treats a claim refusal as job done", async () => {
    const { api, deps, driver } = setup(async () => WA_OUTCOME);
    await expect(processJob({ kind: "submission", id: "not-there" }, deps)).resolves.toEqual({
      outcome: "refused",
      reason: "NOT_FOUND",
    });
    expect(driver.judged).toHaveLength(0);
    expect(api.results).toHaveLength(0);
  });

  it("treats a 409 stale result as fine", async () => {
    const { api, deps, data } = setup(async () => WA_OUTCOME);
    api.staleResults = true;
    await expect(processJob(data, deps)).resolves.toEqual({ outcome: "stale", verdict: "WA" });
  });

  it("posts protocol v2 fields (maxScore, subtasks, cpuMs) and the node's calibration score", async () => {
    const { api, deps, data } = setup(async () => WA_OUTCOME);
    await processJob(data, { ...deps, calibrationScore: () => 1.04 });
    const posted = api.results[0]!;
    expect(resultRequestSchema.safeParse(posted).success).toBe(true);
    expect(posted).toMatchObject({ protocolVersion: JUDGE_PROTOCOL_VERSION, maxScore: 1, subtasks: [], cpuMs: 7, calibrationScore: 1.04 });
  });

  it("releases the lease (permanent:false) and rethrows on a retryable infrastructure failure", async () => {
    const { api, deps, data, slots, job } = setup(async () => {
      throw new InfraError("isolate --init of box 0 failed");
    });
    await expect(processJob(data, deps)).rejects.toBeInstanceOf(InfraError);
    expect(api.releases).toEqual([
      expect.objectContaining({
        id: job.spec.id,
        claimToken: job.spec.claimToken,
        reason: "isolate --init of box 0 failed",
        permanent: false,
      }),
    ]);
    expect(api.results).toHaveLength(0);
    expect(slots.busy).toBe(0);
  });

  it("a failure no node can fix is released permanent:true and the job completes (no BullMQ retry)", async () => {
    const { api, deps, data, slots } = setup(async () => {
      throw new PermanentJudgeError("checker FAIL: answer file has 3 numbers, expected 4");
    });
    await expect(processJob(data, deps)).resolves.toEqual({
      outcome: "released",
      reason: "checker FAIL: answer file has 3 numbers, expected 4",
    });
    expect(api.releases).toEqual([
      expect.objectContaining({ reason: "checker FAIL: answer file has 3 numbers, expected 4", permanent: true }),
    ]);
    expect(api.results).toHaveLength(0);
    expect(slots.busy).toBe(0);
  });

  it("an INTERACTIVE job is released permanently before anything is judged (mock driver, real planning)", async () => {
    const { api, deps } = setup(async () => WA_OUTCOME);
    const job = buildJob({ compareMode: "INTERACTIVE", cases: [{ input: "1\n", output: "1\n" }] });
    api.add(job.spec, job.blobs);
    const outcome = await processJob(
      { kind: "submission", id: job.spec.id },
      { ...deps, driver: new MockJudgeDriver({ write: () => {} }) },
    );
    expect(outcome).toMatchObject({ outcome: "released" });
    expect(api.releases[0]).toMatchObject({ permanent: true });
    expect(api.releases[0]!.reason).toMatch(/INTERACTIVE/);
  });

  it("validation jobs are judged like submissions but publish no progress", async () => {
    const { api, deps, publisher } = setup(async () => WA_OUTCOME);
    const job = buildJob({
      kind: "validation",
      cases: [
        { input: "1\n", output: "1\n", isSample: true },
        { input: "2\n", output: "2\n" },
      ],
    });
    api.add(job.spec, job.blobs);
    const outcome = await processJob(
      { kind: "validation", id: job.spec.id },
      { ...deps, driver: new MockJudgeDriver({ write: () => {} }) },
    );
    expect(outcome).toEqual({ outcome: "posted", verdict: "AC" });
    expect(publisher.events).toEqual([]);
    const posted = api.results[0]!;
    expect(posted).toMatchObject({ kind: "validation", verdict: "AC", score: 1, maxScore: 1 });
    // Per-test CPU ms is reported for every test (the measurement validation exists for).
    expect(posted.tests.map((t) => t.ms)).toEqual([7, 7]);
    expect(posted.cpuMs).toBe(14);
  });

  it("uses a slot the caller already holds and leaves it held", async () => {
    const { deps, data, slots, driver } = setup(async () => WA_OUTCOME);
    const held = await slots.acquire();
    await processJob(data, deps, { slot: held });
    expect(driver.judged[0]!.slot).toBe(held);
    expect(slots.busy).toBe(1);
    slots.release(held);
  });

  it("wraps an unexpected error as InfraError (released, retried)", async () => {
    const { api, deps, data } = setup(async () => {
      throw new TypeError("cannot read properties of undefined");
    });
    await expect(processJob(data, deps)).rejects.toThrow(/unexpected worker error/);
    expect(api.releases).toHaveLength(1);
    expect(api.releases[0]!.permanent).toBe(false);
  });

  it("releases and rethrows when the result cannot be posted", async () => {
    const { api, deps, data } = setup(async () => WA_OUTCOME);
    api.failResultPosts = true;
    await expect(processJob(data, deps)).rejects.toBeInstanceOf(InfraError);
    expect(api.releases[0]!.reason).toMatch(/^result post failed/);
  });

  it("a sha256 mismatch on a fetched blob is an infrastructure failure", async () => {
    const { api, deps, data, job } = setup(async () => WA_OUTCOME);
    const first = job.spec.tests[0]!.input.sha256;
    api.blobs.set(first, Buffer.from("2\n")); // same size, different bytes
    await expect(processJob(data, deps)).rejects.toThrow(/sha256 mismatch/);
    expect(api.releases).toHaveLength(1);
  });

  it("verifies inline blobs (custom-run stdin) instead of fetching them", async () => {
    const { api, deps } = setup(async () => WA_OUTCOME);
    const stdin = blob("7 8\n");
    const run = buildJob({ kind: "run", cases: [{ input: "7 8\n", output: null }], inlineBlobs: { [stdin.ref.sha256]: "7 8\n" } });
    api.add(run.spec, new Map());
    await expect(processJob({ kind: "run", id: run.spec.id }, deps)).resolves.toMatchObject({ outcome: "posted" });
    expect(api.blobFetches).toHaveLength(0);

    const tampered = buildJob({ kind: "run", cases: [{ input: "7 8\n", output: null }], inlineBlobs: { [stdin.ref.sha256]: "7 9\n" } });
    api.add(tampered.spec, new Map());
    await expect(processJob({ kind: "run", id: tampered.spec.id }, deps)).rejects.toThrow(/sha256 mismatch/);
  });

  it("drops an invalid payload without claiming", async () => {
    const { deps, driver } = setup(async () => WA_OUTCOME);
    await expect(processJob({ kind: "nope", id: "" }, deps)).resolves.toEqual({ outcome: "invalid" });
    expect(driver.judged).toHaveLength(0);
  });

  it("propagates a protocol mismatch without releasing (the node must stop)", async () => {
    const { api, deps, data } = setup(async () => WA_OUTCOME);
    api.claim = async () => {
      throw new ProtocolMismatchError("claim");
    };
    await expect(processJob(data, deps)).rejects.toBeInstanceOf(ProtocolMismatchError);
    expect(api.releases).toHaveLength(0);
  });

  it("gives concurrent jobs distinct slots", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const { api, deps, driver, job } = setup(async () => {
      await gate;
      return WA_OUTCOME;
    });
    const second = buildJob({ cases: [{ input: "1\n", output: "1\n" }] });
    api.add(second.spec, second.blobs);
    const a = processJob({ kind: "submission", id: job.spec.id }, deps);
    const b = processJob({ kind: "submission", id: second.spec.id }, deps);
    await new Promise((r) => setTimeout(r, 50));
    release();
    await Promise.all([a, b]);
    expect(driver.judged.map((j) => j.slot).sort()).toEqual([0, 1]);
  });
});
