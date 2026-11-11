import { describe, expect, it, vi } from "vitest";
import { usageDay, usageDayKey, usageIncrement, recordJudgeUsage, USAGE_TIME_ZONE } from "@/lib/judge/usage";

describe("usage day (Asia/Kolkata, UTC+05:30)", () => {
  it("is the Kolkata calendar day", () => {
    expect(USAGE_TIME_ZONE).toBe("Asia/Kolkata");
    expect(usageDayKey(new Date("2026-10-10T06:00:00.000Z"))).toBe("2026-10-10");
  });

  it("rolls over at 18:30 UTC (midnight IST), not at UTC midnight", () => {
    expect(usageDayKey(new Date("2026-10-09T18:29:59.999Z"))).toBe("2026-10-09");
    expect(usageDayKey(new Date("2026-10-09T18:30:00.000Z"))).toBe("2026-10-10");
    // 23:59 UTC on the 9th is already 05:29 IST on the 10th.
    expect(usageDayKey(new Date("2026-10-09T23:59:00.000Z"))).toBe("2026-10-10");
    // 00:00 UTC on the 10th is 05:30 IST on the 10th.
    expect(usageDayKey(new Date("2026-10-10T00:00:00.000Z"))).toBe("2026-10-10");
  });

  it("crosses month and year boundaries", () => {
    expect(usageDayKey(new Date("2026-10-31T18:29:59.000Z"))).toBe("2026-10-31");
    expect(usageDayKey(new Date("2026-10-31T18:30:00.000Z"))).toBe("2026-11-01");
    expect(usageDayKey(new Date("2026-12-31T18:30:00.000Z"))).toBe("2027-01-01");
    expect(usageDayKey(new Date("2028-02-28T18:30:00.000Z"))).toBe("2028-02-29");
  });

  it("returns UTC midnight of that day for the @db.Date column", () => {
    expect(usageDay(new Date("2026-10-09T18:30:00.000Z")).toISOString()).toBe("2026-10-10T00:00:00.000Z");
    expect(usageDay(new Date("2026-10-09T18:29:59.999Z")).toISOString()).toBe("2026-10-09T00:00:00.000Z");
  });

  it("does not depend on the process time zone", () => {
    const original = process.env.TZ;
    try {
      process.env.TZ = "America/Los_Angeles";
      expect(usageDayKey(new Date("2026-10-09T18:30:00.000Z"))).toBe("2026-10-10");
    } finally {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    }
  });

  it("rejects an invalid date", () => {
    expect(() => usageDayKey(new Date("not a date"))).toThrow(RangeError);
  });
});

describe("usage increments", () => {
  it("counts a submission and its CPU", () => {
    expect(usageIncrement("submission", 1234)).toEqual({ submissions: 1, runs: 0, cpuMs: 1234 });
  });

  it("counts a run and its CPU", () => {
    expect(usageIncrement("run", 87)).toEqual({ submissions: 0, runs: 1, cpuMs: 87 });
  });

  it("charges a contest or assessment submission's CPU but not the practice count", () => {
    expect(usageIncrement("submission", 500, false)).toEqual({ submissions: 0, runs: 0, cpuMs: 500 });
  });

  it("never charges negative, fractional or non-finite CPU", () => {
    expect(usageIncrement("run", -5).cpuMs).toBe(0);
    expect(usageIncrement("run", 12.6).cpuMs).toBe(13);
    expect(usageIncrement("run", Number.NaN).cpuMs).toBe(0);
  });

  it("upserts the Kolkata day atomically", async () => {
    const executeRaw = vi.fn().mockResolvedValue(1);
    const tx = { $executeRaw: executeRaw } as unknown as Parameters<typeof recordJudgeUsage>[0];
    await recordJudgeUsage(tx, {
      userId: "user-1",
      kind: "submission",
      cpuMs: 420,
      at: new Date("2026-10-09T18:30:00.000Z"),
    });
    expect(executeRaw).toHaveBeenCalledTimes(1);
    const [strings, ...values] = executeRaw.mock.calls[0] as [TemplateStringsArray, ...unknown[]];
    const sql = strings.join("?");
    expect(sql).toMatch(/INSERT INTO "UserJudgeUsage"/);
    expect(sql).toMatch(/ON CONFLICT \("userId", "day"\) DO UPDATE/);
    expect(values).toEqual(["user-1", "2026-10-10", 1, 0, 420n]);
  });
});
