import { describe, expect, it } from "vitest";
import { JUDGE_PROTOCOL_VERSION, heartbeatRequestSchema, type HeartbeatResponse, type JudgeLane } from "@recx/shared";
import { HeartbeatLoop, emptyHealth, heartbeatBody, type NodeHealth } from "../src/heartbeat";
import { silentLogger } from "../src/logger";
import { SlotPool } from "../src/slots";
import { FakeJudgeApi } from "./support/fake-api";

const INFO = { driver: "isolate" as const, version: "2.7", languages: ["cpp20" as const, "py312" as const] };

describe("heartbeatBody — v2 fields", () => {
  it("carries calibration, self-check, host hardening and startup credit", () => {
    const health: NodeHealth = {
      calibrationScore: 1_234_567,
      calibratedAt: "2026-10-10T00:00:00.000Z",
      selfCheck: { ok: true, at: "2026-10-10T00:00:00.000Z", failures: [] },
      hostHardening: { ok: false, failures: ["kernel.io_uring_disabled: expected 2, found 0"] },
      startupMs: { cpp20: 3, py312: 21 },
    };
    const body = heartbeatBody(INFO, { size: 4, busy: 2 }, health);
    const parsed = heartbeatRequestSchema.parse(body);
    expect(parsed).toMatchObject({
      protocolVersion: JUDGE_PROTOCOL_VERSION,
      slots: 4,
      busySlots: 2,
      calibrationScore: 1_234_567,
      calibratedAt: "2026-10-10T00:00:00.000Z",
      startupMs: { cpp20: 3, py312: 21 },
    });
    expect(parsed.selfCheck?.ok).toBe(true);
    expect(parsed.hostHardening?.ok).toBe(false);
  });

  it("an empty-health body is schema-valid with null health and no startup credit", () => {
    const parsed = heartbeatRequestSchema.parse(heartbeatBody(INFO, { size: 1, busy: 0 }, emptyHealth()));
    expect(parsed.calibrationScore).toBeNull();
    expect(parsed.selfCheck).toBeNull();
    expect(parsed.hostHardening).toBeNull();
    expect(parsed.startupMs).toEqual({});
  });
});

describe("HeartbeatLoop — v2 response", () => {
  it("delivers the granted lanes to onResponse and reads health fresh on every beat", async () => {
    const api = new FakeJudgeApi();
    const health: NodeHealth = emptyHealth();
    const responses: HeartbeatResponse[] = [];
    const loop = new HeartbeatLoop({
      api,
      info: INFO,
      slots: new SlotPool(2),
      logger: silentLogger(),
      health: () => health,
      onStatus: () => undefined,
      onResponse: (r) => responses.push(r),
      onFatal: () => undefined,
    });

    // First beat: the web grants only RUN + PRACTICE (sensitive lanes withheld).
    api.heartbeatResponse = () => ({ status: "ONLINE", serverTime: "t", lanes: ["RUN", "PRACTICE"] as JudgeLane[], laneRestrictions: ["self-check stale"] });
    await loop.beat();
    expect(responses.at(-1)?.lanes).toEqual(["RUN", "PRACTICE"]);
    expect(api.heartbeats.at(-1)?.calibrationScore).toBeNull();

    // Health improves; the web now grants every lane. The body reflects the new score.
    health.calibrationScore = 999;
    health.selfCheck = { ok: true, at: "t", failures: [] };
    api.heartbeatResponse = () => ({ status: "ONLINE", serverTime: "t", lanes: ["ASSESSMENT", "CONTEST", "RUN", "PRACTICE", "REJUDGE"], laneRestrictions: [] });
    await loop.beat();
    expect(responses.at(-1)?.lanes).toContain("ASSESSMENT");
    expect(api.heartbeats.at(-1)?.calibrationScore).toBe(999);
  });
});
