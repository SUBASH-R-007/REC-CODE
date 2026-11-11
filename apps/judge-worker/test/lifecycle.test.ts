import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { JUDGE_PROTOCOL_VERSION, heartbeatRequestSchema, type JudgeNodeStatus } from "@recx/shared";
import { ProtocolMismatchError } from "../src/errors";
import { HeartbeatLoop, emptyHealth, heartbeatBody } from "../src/heartbeat";
import { silentLogger } from "../src/logger";
import { SlotPool } from "../src/slots";
import { WORKER_VERSION } from "../src/version";
import { FakeJudgeApi } from "./support/fake-api";

describe("SlotPool", () => {
  it("hands out the lowest free slot and queues when all are busy", async () => {
    const pool = new SlotPool(2);
    expect(await pool.acquire()).toBe(0);
    expect(await pool.acquire()).toBe(1);
    expect(pool.busy).toBe(2);
    const waiting = pool.acquire();
    pool.release(1);
    expect(await waiting).toBe(1);
    pool.release(0);
    pool.release(1);
    expect(pool.busy).toBe(0);
  });

  it("refuses to release a slot that is not held", () => {
    const pool = new SlotPool(1);
    expect(() => pool.release(0)).toThrow();
    expect(() => new SlotPool(0)).toThrow();
  });
});

describe("heartbeat", () => {
  it("builds a body the protocol schema accepts", () => {
    const body = heartbeatBody({ driver: "isolate", version: "2.7", languages: ["py312"] }, { size: 2, busy: 1 }, emptyHealth());
    expect(heartbeatRequestSchema.parse(body)).toMatchObject({
      protocolVersion: JUDGE_PROTOCOL_VERSION,
      slots: 2,
      busySlots: 1,
      workerVersion: WORKER_VERSION,
      calibratedAt: null,
      hostHardening: null,
      startupMs: {},
    });
  });

  it("reports the server's status and stops on a protocol mismatch", async () => {
    const api = new FakeJudgeApi();
    const statuses: JudgeNodeStatus[] = [];
    const fatal: Error[] = [];
    const loop = new HeartbeatLoop({
      api,
      info: { driver: "mock", version: "mock", languages: ["cpp20"] },
      slots: new SlotPool(1),
      logger: silentLogger(),
      onStatus: (s) => statuses.push(s),
      onFatal: (e) => fatal.push(e),
    });
    await loop.beat();
    expect(statuses).toEqual(["ONLINE"]);
    expect(api.heartbeats[0]).toMatchObject({ driver: "mock", languages: ["cpp20"] });

    api.heartbeat = async () => {
      throw new ProtocolMismatchError("heartbeat");
    };
    await loop.beat();
    expect(fatal).toHaveLength(1);
  });

  it("WORKER_VERSION matches package.json", () => {
    const pkg = JSON.parse(readFileSync(path.resolve(import.meta.dirname, "..", "package.json"), "utf8")) as { version: string };
    expect(WORKER_VERSION).toBe(pkg.version);
  });
});
