import { describe, expect, it } from "vitest";
import { JUDGE_LANES, JUDGE_OFFLINE_AFTER_MS, LIMITS } from "@recx/shared";
import {
  ageMs,
  calibrationDeviation,
  depthFromCounts,
  emptyWindow,
  fleetCalibrationMedian,
  formatAge,
  formatDurationMs,
  formatRate,
  formatSignedRate,
  hardeningState,
  isCalibrationOutlier,
  isHeartbeatStale,
  laneTotals,
  latencyKindFor,
  p50,
  p95,
  percentile,
  planNodeTransition,
  rate,
  selfCheckState,
  summariseLanes,
  type LaneWindowStats,
  type NodeHealthInput,
} from "@/lib/judge/metrics";

describe("percentile (percentile_cont semantics)", () => {
  it("interpolates linearly between closest ranks", () => {
    // SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY x) FROM unnest('{1,2,3,4}'::int[]) x → 2.5
    expect(p50([4, 1, 3, 2])).toBe(2.5);
    expect(p50([1, 2, 3])).toBe(2);
    // percentile_cont(0.95) over 1..20 = 1 + 0.95 × 19 = 19.05
    expect(p95(Array.from({ length: 20 }, (_, k) => k + 1))).toBeCloseTo(19.05, 10);
    // over 1..100: 1 + 0.95 × 99 = 95.05
    expect(p95(Array.from({ length: 100 }, (_, k) => k + 1))).toBeCloseTo(95.05, 10);
    expect(percentile([10, 20], 0)).toBe(10);
    expect(percentile([10, 20], 1)).toBe(20);
    expect(percentile([10, 20], 0.25)).toBe(12.5);
  });

  it("handles one value, no values and non-finite values", () => {
    expect(p50([7])).toBe(7);
    expect(p95([7])).toBe(7);
    expect(p50([])).toBeNull();
    expect(p95([Number.NaN, Number.POSITIVE_INFINITY])).toBeNull();
    expect(p50([3, Number.NaN, 1])).toBe(2);
  });

  it("does not mutate its input and rejects p outside [0, 1]", () => {
    const xs = [3, 1, 2];
    p50(xs);
    expect(xs).toEqual([3, 1, 2]);
    expect(() => percentile(xs, 1.5)).toThrow(RangeError);
    expect(() => percentile(xs, -0.1)).toThrow(RangeError);
    expect(() => percentile(xs, Number.NaN)).toThrow(RangeError);
  });

  it("rate divides only when there is something to divide by", () => {
    expect(rate(1, 4)).toBe(0.25);
    expect(rate(0, 0)).toBeNull();
  });
});

describe("lanes", () => {
  it("counts prioritized and paused jobs as waiting (every judge job has a priority)", () => {
    // The shape BullMQ 5 returns for getJobCounts("waiting", "prioritized", "active", "delayed").
    expect(depthFromCounts({ waiting: 2, prioritized: 40, active: 6, delayed: 1, paused: 3, completed: 900 })).toEqual({
      waiting: 45,
      active: 6,
      delayed: 1,
    });
    expect(depthFromCounts({})).toEqual({ waiting: 0, active: 0, delayed: 0 });
    expect(depthFromCounts({ waiting: -1, active: Number.NaN })).toEqual({ waiting: 0, active: 0, delayed: 0 });
  });

  it("every lane reports queue wait (runs and validations record startedAt too)", () => {
    for (const lane of JUDGE_LANES) expect(latencyKindFor(lane)).toBe("wait");
  });

  it("summarises every lane in order, zero-filling quiet lanes", () => {
    const practice: LaneWindowStats = {
      lane: "PRACTICE",
      latencyKind: "wait",
      queued: 120,
      finished: 100,
      internalErrors: 2,
      p50Ms: 300,
      p95Ms: 2_400,
    };
    const lanes = summariseLanes(
      { PRACTICE: { waiting: 5, active: 8, delayed: 1 }, RUN: { waiting: 0, active: 2, delayed: 0 } },
      [practice],
    );
    expect(lanes.map((l) => l.lane)).toEqual([...JUDGE_LANES]);
    const p = lanes.find((l) => l.lane === "PRACTICE")!;
    expect(p).toMatchObject({ queued: 120, finished: 100, backlog: 6, ieRate: 0.02, p95Ms: 2_400 });
    const contest = lanes.find((l) => l.lane === "CONTEST")!;
    expect(contest).toEqual({ ...emptyWindow("CONTEST"), depth: null, backlog: null, ieRate: null });

    const totals = laneTotals(lanes);
    // CONTEST has no depth entry → the fleet backlog is unknown, not under-counted.
    expect(totals.backlog).toBeNull();
    expect(totals).toMatchObject({ queued: 120, finished: 100, internalErrors: 2, ieRate: 0.02 });
  });

  it("totals are known only when every lane's depth is", () => {
    const all = Object.fromEntries(JUDGE_LANES.map((l) => [l, { waiting: 1, active: 2, delayed: 1 }]));
    const totals = laneTotals(summariseLanes(all, []));
    expect(totals.backlog).toBe(JUDGE_LANES.length * 2);
    expect(totals.active).toBe(JUDGE_LANES.length * 2);
    expect(totals.ieRate).toBeNull();
    expect(laneTotals(summariseLanes(null, [])).backlog).toBeNull();
  });
});

describe("node health", () => {
  const now = new Date("2026-10-10T10:00:00Z");
  const node = (fields: Partial<NodeHealthInput>): NodeHealthInput => ({
    status: "ONLINE",
    lastHeartbeatAt: now,
    calibrationScore: 100,
    lastSelfCheckAt: now,
    selfCheckOk: true,
    ...fields,
  });

  it("fleet median is over ONLINE nodes with a usable score", () => {
    const fleet = [
      node({ calibrationScore: 90 }),
      node({ calibrationScore: 100 }),
      node({ calibrationScore: 130 }),
      node({ calibrationScore: 10, status: "OFFLINE" }),
      node({ calibrationScore: 500, status: "QUARANTINED" }),
      node({ calibrationScore: null }),
      node({ calibrationScore: 0 }),
    ];
    expect(fleetCalibrationMedian(fleet)).toBe(100);
    expect(fleetCalibrationMedian([])).toBeNull();
  });

  it("deviation is signed and relative; > 10 % is an outlier", () => {
    expect(calibrationDeviation(108, 100)).toBeCloseTo(0.08, 10);
    expect(calibrationDeviation(85, 100)).toBeCloseTo(-0.15, 10);
    expect(calibrationDeviation(null, 100)).toBeNull();
    expect(calibrationDeviation(100, null)).toBeNull();
    expect(calibrationDeviation(100, 0)).toBeNull();
    expect(LIMITS.calibration.maxDeviation).toBe(0.1);
    expect(isCalibrationOutlier(0.1)).toBe(false);
    expect(isCalibrationOutlier(0.1001)).toBe(true);
    expect(isCalibrationOutlier(-0.15)).toBe(true);
    expect(isCalibrationOutlier(null)).toBe(false);
  });

  it("heartbeat is stale after JUDGE_OFFLINE_AFTER_MS or when never seen", () => {
    expect(isHeartbeatStale(new Date(now.getTime() - JUDGE_OFFLINE_AFTER_MS), now)).toBe(false);
    expect(isHeartbeatStale(new Date(now.getTime() - JUDGE_OFFLINE_AFTER_MS - 1), now)).toBe(true);
    expect(isHeartbeatStale(null, now)).toBe(true);
    expect(ageMs(null, now)).toBeNull();
    // A node clock ahead of ours never yields a negative age.
    expect(ageMs(new Date(now.getTime() + 5_000), now)).toBe(0);
  });

  it("self-check: failed beats stale; stale after 6.5 h", () => {
    const at = (ms: number) => new Date(now.getTime() - ms);
    expect(selfCheckState(true, at(0), now)).toBe("ok");
    expect(selfCheckState(true, at(LIMITS.selfCheck.staleAfterMs), now)).toBe("ok");
    expect(selfCheckState(true, at(LIMITS.selfCheck.staleAfterMs + 1), now)).toBe("stale");
    expect(selfCheckState(false, at(LIMITS.selfCheck.staleAfterMs + 1), now)).toBe("failed");
    expect(selfCheckState(null, null, now)).toBe("unknown");
    expect(selfCheckState(true, null, now)).toBe("unknown");
    expect(hardeningState(true)).toBe("ok");
    expect(hardeningState(false)).toBe("failed");
    expect(hardeningState(null)).toBe("unknown");
  });
});

describe("admin node transitions", () => {
  const healthy = { selfCheckOk: true, hostHardened: true, heartbeatStale: false };

  it("drain: ONLINE or OFFLINE → DRAINING", () => {
    expect(planNodeTransition("ONLINE", "drain", healthy)).toEqual({ ok: true, to: "DRAINING" });
    expect(planNodeTransition("OFFLINE", "drain", healthy)).toEqual({ ok: true, to: "DRAINING" });
    expect(planNodeTransition("DRAINING", "drain", healthy).ok).toBe(false);
    expect(planNodeTransition("QUARANTINED", "drain", healthy).ok).toBe(false);
  });

  it("quarantine: anything but QUARANTINED", () => {
    for (const s of ["ONLINE", "DRAINING", "OFFLINE"] as const) {
      expect(planNodeTransition(s, "quarantine", healthy)).toEqual({ ok: true, to: "QUARANTINED" });
    }
    expect(planNodeTransition("QUARANTINED", "quarantine", healthy).ok).toBe(false);
  });

  it("return to ONLINE: never for OFFLINE nodes (they return by heartbeat)", () => {
    expect(planNodeTransition("DRAINING", "online", healthy)).toEqual({ ok: true, to: "ONLINE" });
    expect(planNodeTransition("QUARANTINED", "online", healthy)).toEqual({ ok: true, to: "ONLINE" });
    const offline = planNodeTransition("OFFLINE", "online", healthy);
    expect(offline.ok || offline.reason).toMatch(/heartbeat/);
    expect(planNodeTransition("ONLINE", "online", healthy).ok).toBe(false);
  });

  it("return to ONLINE is refused after a failed self-check or hardening check", () => {
    const sc = planNodeTransition("QUARANTINED", "online", { ...healthy, selfCheckOk: false });
    expect(sc.ok || sc.reason).toMatch(/self-check failed/);
    const hard = planNodeTransition("QUARANTINED", "online", { ...healthy, hostHardened: false });
    expect(hard.ok || hard.reason).toMatch(/hardening/);
    // The development override lets an unhardened (WSL2) node back in.
    expect(planNodeTransition("QUARANTINED", "online", { ...healthy, hostHardened: false }, true)).toEqual({
      ok: true,
      to: "ONLINE",
    });
    // Unknown (not yet reported) does not block.
    expect(planNodeTransition("DRAINING", "online", { selfCheckOk: null, hostHardened: null, heartbeatStale: false }).ok).toBe(
      true,
    );
  });

  it("a node that is not heartbeating returns as OFFLINE", () => {
    expect(planNodeTransition("DRAINING", "online", { ...healthy, heartbeatStale: true })).toEqual({
      ok: true,
      to: "OFFLINE",
    });
  });
});

describe("formatting", () => {
  it("durations", () => {
    expect(formatDurationMs(null)).toBe("—");
    expect(formatDurationMs(850.4)).toBe("850 ms");
    expect(formatDurationMs(1_234)).toBe("1.2 s");
    expect(formatDurationMs(12_345)).toBe("12 s");
    expect(formatDurationMs(125_000)).toBe("2 min 5 s");
    expect(formatDurationMs(120_000)).toBe("2 min");
    expect(formatDurationMs(3 * 3_600_000 + 10 * 60_000)).toBe("3 h 10 min");
    expect(formatDurationMs(-5)).toBe("0 ms");
  });

  it("ages", () => {
    expect(formatAge(null)).toBe("never");
    expect(formatAge(4_900)).toBe("4 s");
    expect(formatAge(12 * 60_000)).toBe("12 min");
    expect(formatAge(3 * 3_600_000)).toBe("3 h");
    expect(formatAge(2 * 86_400_000)).toBe("2 d");
  });

  it("rates", () => {
    expect(formatRate(0.125)).toBe("12.5%");
    expect(formatRate(0.07)).toBe("7%");
    expect(formatRate(1)).toBe("100%");
    expect(formatRate(0.1, 0)).toBe("10%");
    expect(formatRate(null)).toBe("—");
    expect(formatSignedRate(0.083)).toBe("+8.3%");
    expect(formatSignedRate(-0.02)).toBe("−2.0%");
    expect(formatSignedRate(0)).toBe("0.0%");
    expect(formatSignedRate(null)).toBe("—");
  });
});
