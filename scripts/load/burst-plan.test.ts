import { describe, expect, it } from "vitest";
import {
  BURST_LANES,
  DEFAULT_MIX,
  UsageError,
  arrivalOffsetMs,
  assertSafeTarget,
  burstMarker,
  fleetRunReserve,
  laneCounts,
  laneReports,
  newRunId,
  parseBurstArgs,
  parseMix,
  percentile,
  planBurst,
  practiceStarvation,
  withBurstMarker,
  type BurstFixtures,
  type JobOutcome,
} from "./burst-plan";

const FIXTURES: BurstFixtures = {
  students: [
    { id: "u3", collegeId: "2116231001003" },
    { id: "u1", collegeId: "2116231001001" },
    { id: "u2", collegeId: "2116231001002" },
  ],
  candidates: [
    {
      problemId: "p1",
      slug: "two-sum",
      versionId: "v1",
      language: "cpp20",
      languageConfigId: "lc-cpp",
      source: "class Solution {};\n",
      totalCases: 14,
      sampleCount: 2,
    },
    {
      problemId: "p1",
      slug: "two-sum",
      versionId: "v1",
      language: "py312",
      languageConfigId: "lc-py",
      source: "class Solution:\n    pass\n",
      totalCases: 14,
      sampleCount: 2,
    },
  ],
};

const RUN_ID = "20261010T081500-a1b2c3";

describe("options", () => {
  it("defaults: 200 jobs, 15/15/45/25, spread over 60 s", () => {
    const o = parseBurstArgs([]);
    expect(o.count).toBe(200);
    expect(o.mix).toEqual(DEFAULT_MIX);
    expect(o.arrival).toEqual({ kind: "uniform", spreadMs: 60_000 });
    expect(o.dryRun).toBe(false);
    expect(o.languages).toBeNull();
  });

  it("parses values in both spellings, flags and the instantaneous burst", () => {
    const o = parseBurstArgs(["--count", "50", "--mix=practice=60,run=40", "--instant", "--languages", "cpp20, py312", "--dry-run"]);
    expect(o.count).toBe(50);
    expect(o.mix).toEqual({ ASSESSMENT: 0, CONTEST: 0, PRACTICE: 60, RUN: 40, REJUDGE: 0 });
    expect(o.arrival).toEqual({ kind: "instant" });
    expect(o.languages).toEqual(["cpp20", "py312"]);
    expect(o.dryRun).toBe(true);
  });

  it("accepts lists the way PowerShell passes an unquoted a,b,c (space-separated)", () => {
    const o = parseBurstArgs(["--mix", "practice=50 run=30 contest=20", "--languages", "cpp20 py312"]);
    expect(o.mix).toEqual({ ASSESSMENT: 0, CONTEST: 20, PRACTICE: 50, RUN: 30, REJUDGE: 0 });
    expect(o.languages).toEqual(["cpp20", "py312"]);
  });

  it("rejects bad input with a usage error", () => {
    expect(() => parseBurstArgs(["--count", "0"])).toThrow(UsageError);
    expect(() => parseBurstArgs(["--bogus", "1"])).toThrow(/unknown option/);
    expect(() => parseBurstArgs(["--count"])).toThrow(/needs a value/);
    expect(() => parseBurstArgs(["--dry-run=yes"])).toThrow(/takes no value/);
    expect(() => parseBurstArgs(["--cleanup", "not-a-run-id"])).toThrow(UsageError);
    expect(() => parseMix("practice=50,run=40")).toThrow(/total 100/);
    expect(() => parseMix("homework=100")).toThrow(/unknown lane/);
  });
});

describe("target safety", () => {
  const local = "postgresql://recx:x@localhost:5433/recx";
  it("accepts only local Postgres and Redis outside production", () => {
    expect(assertSafeTarget({ DATABASE_URL: local, REDIS_URL: "redis://127.0.0.1:6379" })).toEqual({
      databaseUrl: local,
      redisUrl: "redis://127.0.0.1:6379",
    });
    expect(() => assertSafeTarget({ DATABASE_URL: local, NODE_ENV: "production" })).toThrow(/production/);
    expect(() => assertSafeTarget({ DATABASE_URL: "postgresql://recx:x@db.example.edu:5432/recx" })).toThrow(/not this machine/);
    expect(() => assertSafeTarget({ DATABASE_URL: local, REDIS_URL: "redis://10.0.0.5:6379" })).toThrow(/REDIS_URL/);
    expect(() => assertSafeTarget({})).toThrow(/DATABASE_URL/);
  });

  it("never echoes a URL (they carry credentials)", () => {
    try {
      assertSafeTarget({ DATABASE_URL: "postgresql://recx:secret-pw@db.example.edu:5432/recx" });
    } catch (error) {
      expect((error as Error).message).not.toContain("secret-pw");
    }
  });
});

describe("the plan", () => {
  it("splits counts exactly by largest remainder", () => {
    expect(laneCounts(200, DEFAULT_MIX)).toEqual({ ASSESSMENT: 30, CONTEST: 30, PRACTICE: 90, RUN: 50, REJUDGE: 0 });
    expect(laneCounts(7, DEFAULT_MIX)).toEqual({ ASSESSMENT: 1, CONTEST: 1, PRACTICE: 3, RUN: 2, REJUDGE: 0 });
    for (const n of [1, 3, 13, 199, 1001]) {
      const counts = laneCounts(n, DEFAULT_MIX);
      expect(BURST_LANES.reduce((s, l) => s + counts[l], 0)).toBe(n);
      expect(counts.REJUDGE).toBe(0);
    }
  });

  it("spreads arrivals uniformly, or all at once", () => {
    expect([0, 1, 2, 3].map((i) => arrivalOffsetMs(i, 4, { kind: "uniform", spreadMs: 60_000 }))).toEqual([0, 15_000, 30_000, 45_000]);
    expect(arrivalOffsetMs(3, 4, { kind: "instant" })).toBe(0);
  });

  it("generates the default 200-job burst: lanes, kinds, origins, users, markers, offsets", () => {
    const plan = planBurst({ count: 200, mix: DEFAULT_MIX, arrival: { kind: "uniform", spreadMs: 60_000 }, seed: 1 }, FIXTURES, RUN_ID);
    expect(plan).toHaveLength(200);
    const byLane = (lane: string) => plan.filter((j) => j.lane === lane);
    expect(byLane("ASSESSMENT")).toHaveLength(30);
    expect(byLane("CONTEST")).toHaveLength(30);
    expect(byLane("PRACTICE")).toHaveLength(90);
    expect(byLane("RUN")).toHaveLength(50);
    for (const job of plan) {
      expect(job.kind).toBe(job.lane === "RUN" ? "run" : "submission");
      expect(job.origin).toBe(job.lane === "RUN" ? null : job.lane);
      expect(job.source).toContain(`${burstMarker(RUN_ID)} #${job.seq}`);
      expect(job.source.startsWith(job.candidate.source.trimEnd())).toBe(true);
      expect(job.offsetMs).toBeGreaterThanOrEqual(0);
      expect(job.offsetMs).toBeLessThan(60_000);
    }
    // Arrival order, users round-robin in roll-number order, lanes interleaved (not 30 assessments first).
    expect(plan.map((j) => j.offsetMs)).toEqual([...plan.map((j) => j.offsetMs)].sort((a, b) => a - b));
    expect(plan.slice(0, 3).map((j) => j.userId)).toEqual(["u1", "u2", "u3"]);
    expect(new Set(plan.slice(0, 20).map((j) => j.lane)).size).toBeGreaterThan(2);
    // Both languages are used, each with its own comment syntax.
    expect(plan.some((j) => j.candidate.language === "py312" && j.source.includes(`# ${burstMarker(RUN_ID)}`))).toBe(true);
    expect(plan.some((j) => j.candidate.language === "cpp20" && j.source.includes(`// ${burstMarker(RUN_ID)}`))).toBe(true);
  });

  it("is deterministic for a seed and differs across seeds", () => {
    const opts = { count: 40, mix: DEFAULT_MIX, arrival: { kind: "instant" } as const };
    const a = planBurst({ ...opts, seed: 7 }, FIXTURES, RUN_ID);
    const b = planBurst({ ...opts, seed: 7 }, FIXTURES, RUN_ID);
    const c = planBurst({ ...opts, seed: 8 }, FIXTURES, RUN_ID);
    expect(a).toEqual(b);
    expect(a.map((j) => j.lane)).not.toEqual(c.map((j) => j.lane));
  });

  it("refuses a plan it cannot honour", () => {
    const opts = { count: 10, mix: DEFAULT_MIX, arrival: { kind: "instant" } as const, seed: 1 };
    expect(() => planBurst(opts, { ...FIXTURES, students: [] }, RUN_ID)).toThrow(/students/);
    expect(() => planBurst(opts, { ...FIXTURES, candidates: [] }, RUN_ID)).toThrow(/model solution/);
    const noSamples = { ...FIXTURES, candidates: FIXTURES.candidates.map((c) => ({ ...c, sampleCount: 0 })) };
    expect(() => planBurst(opts, noSamples, RUN_ID)).toThrow(/sample tests/);
  });

  it("marks sources harmlessly at the end", () => {
    expect(withBurstMarker("int main(){}\n\n", "cpp20", RUN_ID, 4)).toBe(`int main(){}\n// recx-burst:${RUN_ID} #4\n`);
    expect(withBurstMarker("print(1)", "pypy310", RUN_ID, 0)).toBe(`print(1)\n# recx-burst:${RUN_ID} #0\n`);
    expect(newRunId(new Date("2026-10-10T08:15:00.123Z"), "a1b2c3")).toBe(RUN_ID);
  });
});

describe("statistics", () => {
  it("nearest-rank percentiles", () => {
    const values = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(values, 50)).toBe(50);
    expect(percentile(values, 95)).toBe(95);
    expect(percentile(values, 100)).toBe(100);
    expect(percentile([7], 95)).toBe(7);
    expect(percentile([], 50)).toBeNull();
  });

  it("per-lane waits, service, end-to-end, verdicts and IE", () => {
    const outcomes: JobOutcome[] = [
      { seq: 0, lane: "PRACTICE", queuedAt: 0, startedAt: 100, judgedAt: 1_100, verdict: "AC", status: "DONE" },
      { seq: 1, lane: "PRACTICE", queuedAt: 0, startedAt: 300, judgedAt: 2_300, verdict: "AC", status: "DONE" },
      { seq: 2, lane: "PRACTICE", queuedAt: 0, startedAt: 500, judgedAt: 900, verdict: "IE", status: "INTERNAL_ERROR" },
      { seq: 3, lane: "RUN", queuedAt: 1_000, startedAt: null, judgedAt: null, verdict: null, status: "QUEUED" },
    ];
    const reports = laneReports(outcomes);
    expect(reports.map((r) => r.lane)).toEqual(["RUN", "PRACTICE"]); // JUDGE_LANES order, empty lanes omitted
    const practice = reports.find((r) => r.lane === "PRACTICE");
    const run = reports.find((r) => r.lane === "RUN");
    expect(practice).toMatchObject({ lane: "PRACTICE", count: 3, finished: 3, internalErrors: 1, verdicts: { AC: 2, IE: 1 } });
    expect(practice!.waitMs).toMatchObject({ p50: 300, p95: 500, max: 500 });
    expect(practice!.serviceMs.mean).toBeCloseTo((1_000 + 2_000 + 400) / 3);
    expect(practice!.endToEndMs.p95).toBe(2_300);
    expect(run).toMatchObject({ lane: "RUN", count: 1, finished: 0, verdicts: {} });
    expect(run!.waitMs.p50).toBeNull();
  });

  it("RUN's fleet reservation follows the allocator's small-node rule", () => {
    expect(fleetRunReserve([1])).toBe(0);
    expect(fleetRunReserve([2])).toBe(1);
    expect(fleetRunReserve([5, 5])).toBe(4);
  });

  it("finds PRACTICE starvation only when a usable slot sat idle", () => {
    // 2 slots, no RUN reservation. Practice job P waits 0..10 s; the only other
    // job holds one slot 0..20 s, so one slot is idle for P's whole wait.
    const starved: JobOutcome[] = [
      { seq: 0, lane: "CONTEST", queuedAt: 0, startedAt: 0, judgedAt: 20_000, verdict: "AC", status: "DONE" },
      { seq: 1, lane: "PRACTICE", queuedAt: 0, startedAt: 10_000, judgedAt: 11_000, verdict: "AC", status: "DONE" },
    ];
    const s = practiceStarvation(starved, { slots: 2, runReserved: 0 }, 5_000, 20_000);
    expect(s.maxWaitWhileUsableSlotFreeMs).toBe(10_000);
    expect(s.starved).toBe(true);

    // Same timeline on ONE slot: P waited, but no slot was free — busy, not starved.
    const busy = practiceStarvation(starved, { slots: 1, runReserved: 0 }, 5_000, 20_000);
    expect(busy.maxWaitWhileAnySlotFreeMs).toBe(0);
    expect(busy.starved).toBe(false);

    // Two slots, but one is RUN's hard reservation: idle for "any", unusable for practice.
    const reserved = practiceStarvation(starved, { slots: 2, runReserved: 1 }, 5_000, 20_000);
    expect(reserved.maxWaitWhileAnySlotFreeMs).toBe(10_000);
    expect(reserved.maxWaitWhileUsableSlotFreeMs).toBe(0);
    expect(reserved.starved).toBe(false);
  });

  it("counts a never-started practice job as waiting until the end", () => {
    const outcomes: JobOutcome[] = [
      { seq: 0, lane: "PRACTICE", queuedAt: 1_000, startedAt: null, judgedAt: null, verdict: null, status: "QUEUED" },
    ];
    const s = practiceStarvation(outcomes, { slots: 4, runReserved: 2 }, 5_000, 9_000);
    expect(s.maxWaitWhileUsableSlotFreeMs).toBe(8_000);
    expect(s.starved).toBe(true);
  });
});
