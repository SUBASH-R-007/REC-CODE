import { describe, expect, it, vi } from "vitest";
import type { DbTx } from "@recx/db";
import { LIMITS } from "@recx/shared";
import {
  activeOverride,
  defaultCaps,
  effectiveCaps,
  evaluateRunCaps,
  evaluateSubmitCaps,
  freeingRunOffset,
  istDay,
  istDayStart,
  loadCaps,
  loadRunUsage,
  loadSubmitUsage,
  nextIstMidnight,
  parseIstLocalDateTime,
  type CapOverride,
  type JudgeCaps,
} from "@/lib/judge/caps";

const caps: JudgeCaps = defaultCaps();
const NOW = new Date("2026-10-10T10:00:00Z"); // 15:30 IST

describe("defaults", () => {
  it("are LIMITS.userCaps", () => {
    expect(caps).toEqual(LIMITS.userCaps);
    expect(caps).toEqual({
      inFlightSubmissions: 2,
      inFlightRuns: 1,
      practicePerDay: 300,
      runsPerHour: 60,
      cpuMinutesPerDay: 20,
    });
  });

  it("returns a fresh copy (the frozen table is never handed out)", () => {
    const a = defaultCaps();
    a.practicePerDay = 1;
    expect(defaultCaps().practicePerDay).toBe(300);
  });
});

describe("the Asia/Kolkata day", () => {
  it("is the IST calendar date at 00:00 UTC (the UserJudgeUsage.day key)", () => {
    expect(istDay(NOW).toISOString()).toBe("2026-10-10T00:00:00.000Z");
    // 18:29:59 UTC is 23:59:59 IST — still the 10th.
    expect(istDay(new Date("2026-10-10T18:29:59Z")).toISOString()).toBe("2026-10-10T00:00:00.000Z");
    // 18:30 UTC is midnight IST — the 11th.
    expect(istDay(new Date("2026-10-10T18:30:00Z")).toISOString()).toBe("2026-10-11T00:00:00.000Z");
    // 00:15 IST on the 10th is still the 9th in UTC.
    expect(istDay(new Date("2026-10-09T18:45:00Z")).toISOString()).toBe("2026-10-10T00:00:00.000Z");
  });

  it("starts and resets at midnight IST", () => {
    expect(istDayStart(NOW).toISOString()).toBe("2026-10-09T18:30:00.000Z");
    expect(nextIstMidnight(NOW).toISOString()).toBe("2026-10-10T18:30:00.000Z");
  });

  it("parses a datetime-local value as IST", () => {
    expect(parseIstLocalDateTime("2026-10-12T18:00")?.toISOString()).toBe("2026-10-12T12:30:00.000Z");
    expect(parseIstLocalDateTime(" 2026-01-01T00:00 ")?.toISOString()).toBe("2025-12-31T18:30:00.000Z");
    for (const bad of ["", "2026-10-12", "2026-02-31T10:00", "2026-10-12T24:00", "12/10/2026 18:00", "2026-10-12T18:00Z"]) {
      expect(parseIstLocalDateTime(bad)).toBeNull();
    }
  });
});

describe("overrides", () => {
  const o = (createdAt: string, fields: Partial<CapOverride> = {}): CapOverride => ({
    practicePerDay: null,
    runsPerHour: null,
    cpuMinutesPerDay: null,
    expiresAt: null,
    createdAt: new Date(createdAt),
    ...fields,
  });

  it("the latest unexpired override is active", () => {
    const older = o("2026-10-01T00:00:00Z", { practicePerDay: 500 });
    const newer = o("2026-10-05T00:00:00Z", { cpuMinutesPerDay: 60 });
    expect(activeOverride([older, newer], NOW)).toBe(newer);
    expect(activeOverride([newer, older], NOW)).toBe(newer);
  });

  it("an expired override is ignored, falling back to an older active one", () => {
    const permanent = o("2026-10-01T00:00:00Z", { practicePerDay: 500 });
    const expired = o("2026-10-05T00:00:00Z", { practicePerDay: 900, expiresAt: new Date("2026-10-09T00:00:00Z") });
    expect(activeOverride([permanent, expired], NOW)).toBe(permanent);
    expect(activeOverride([expired], NOW)).toBeNull();
    // Expiry is exclusive: at the instant of expiry it no longer applies.
    expect(activeOverride([o("2026-10-01T00:00:00Z", { expiresAt: NOW })], NOW)).toBeNull();
  });

  it("replaces only the caps it sets; in-flight caps are never overridden", () => {
    expect(effectiveCaps(null)).toEqual(caps);
    expect(effectiveCaps({ practicePerDay: 1000, runsPerHour: null, cpuMinutesPerDay: 45 })).toEqual({
      ...caps,
      practicePerDay: 1000,
      cpuMinutesPerDay: 45,
    });
    expect(effectiveCaps({ practicePerDay: null, runsPerHour: null, cpuMinutesPerDay: null })).toEqual(caps);
  });
});

describe("evaluateSubmitCaps", () => {
  const usage = { inFlight: 0, practiceToday: 0, cpuMsToday: 0 };

  it("allows a submission under every cap", () => {
    expect(evaluateSubmitCaps(caps, usage)).toEqual({ ok: true });
    expect(evaluateSubmitCaps(caps, { inFlight: 1, practiceToday: 299, cpuMsToday: 20 * 60_000 - 1 })).toEqual({
      ok: true,
    });
  });

  it("refuses the 301st practice submission of the IST day", () => {
    const d = evaluateSubmitCaps(caps, { ...usage, practiceToday: 300 });
    expect(d).toEqual({
      ok: false,
      cap: "practicePerDay",
      message: "You have made today's 300 practice submissions. The limit resets at midnight IST.",
    });
  });

  it("refuses once 20 CPU-minutes are used, with the exact message", () => {
    const d = evaluateSubmitCaps(caps, { ...usage, cpuMsToday: 20 * 60_000 });
    expect(d).toEqual({
      ok: false,
      cap: "cpuMinutesPerDay",
      message: "You have used today's 20 CPU-minutes of judging. It resets at midnight IST.",
    });
  });

  it("refuses a third submission in flight", () => {
    const d = evaluateSubmitCaps(caps, { ...usage, inFlight: 2 });
    expect(d.ok).toBe(false);
    if (!d.ok) {
      expect(d.cap).toBe("inFlightSubmissions");
      expect(d.message).toBe(
        "You already have 2 submissions being judged. Wait for one to finish, then submit again.",
      );
    }
  });

  it("reports a lasting limit before the momentary in-flight one", () => {
    const d = evaluateSubmitCaps(caps, { inFlight: 2, practiceToday: 300, cpuMsToday: 30 * 60_000 });
    expect(d.ok || d.cap).toBe("practicePerDay");
    const cpu = evaluateSubmitCaps(caps, { inFlight: 2, practiceToday: 0, cpuMsToday: 30 * 60_000 });
    expect(cpu.ok || cpu.cap).toBe("cpuMinutesPerDay");
  });

  it("applies an override and uses singular wording for a cap of 1", () => {
    const tight = effectiveCaps({ practicePerDay: 1, runsPerHour: 1, cpuMinutesPerDay: 1 });
    const practice = evaluateSubmitCaps(tight, { ...usage, practiceToday: 1 });
    expect(practice.ok || practice.message).toBe(
      "You have made today's 1 practice submission. The limit resets at midnight IST.",
    );
    const cpu = evaluateSubmitCaps(tight, { ...usage, cpuMsToday: 60_000 });
    expect(cpu.ok || cpu.message).toBe("You have used today's 1 CPU-minute of judging. It resets at midnight IST.");
    const generous = effectiveCaps({ practicePerDay: 1000, runsPerHour: null, cpuMinutesPerDay: 120 });
    expect(evaluateSubmitCaps(generous, { inFlight: 0, practiceToday: 999, cpuMsToday: 119 * 60_000 })).toEqual({
      ok: true,
    });
  });
});

describe("evaluateRunCaps", () => {
  const usage = { inFlight: 0, runsLastHour: 0, runSlotFreesAt: null, cpuMsToday: 0 };

  it("allows a run under every cap", () => {
    expect(evaluateRunCaps(caps, usage, NOW)).toEqual({ ok: true });
    expect(evaluateRunCaps(caps, { ...usage, runsLastHour: 59 }, NOW)).toEqual({ ok: true });
  });

  it("refuses the 61st run in the trailing hour and says when the next slot frees", () => {
    const d = evaluateRunCaps(
      caps,
      { ...usage, runsLastHour: 60, runSlotFreesAt: new Date(NOW.getTime() + 12 * 60_000 + 5_000) },
      NOW,
    );
    expect(d).toEqual({
      ok: false,
      cap: "runsPerHour",
      message: "You have used 60 runs in the last hour. You can run again in 13 minutes.",
    });
    const soon = evaluateRunCaps(caps, { ...usage, runsLastHour: 60, runSlotFreesAt: new Date(NOW.getTime() + 1) }, NOW);
    expect(soon.ok || soon.message).toContain("in 1 minute.");
    const unknown = evaluateRunCaps(caps, { ...usage, runsLastHour: 61 }, NOW);
    expect(unknown.ok || unknown.message).toContain("within the hour");
  });

  it("refuses a second run in flight", () => {
    const d = evaluateRunCaps(caps, { ...usage, inFlight: 1 }, NOW);
    expect(d.ok || d.message).toBe("Your previous run is still in progress. Wait for it to finish, then run again.");
  });

  it("shares the daily CPU budget with submissions", () => {
    const d = evaluateRunCaps(caps, { ...usage, cpuMsToday: 25 * 60_000 }, NOW);
    expect(d.ok || d.cap).toBe("cpuMinutesPerDay");
  });

  it("finds which run must age out to free a slot", () => {
    expect(freeingRunOffset(59, 60)).toBeNull();
    expect(freeingRunOffset(60, 60)).toBe(0);
    expect(freeingRunOffset(65, 60)).toBe(5);
  });
});

// ── Loaders against a stub transaction ─────────────────────────────────

function stubTx(overrides: {
  usage?: { cpuMs: bigint; submissions: number } | null;
  override?: { practicePerDay: number | null; runsPerHour: number | null; cpuMinutesPerDay: number | null } | null;
  submissionCounts?: { all: number; practice: number };
  runCounts?: { inFlight: number; lastHour: number };
  freeing?: Date | null;
}) {
  const userJudgeUsage = { findUnique: vi.fn(async () => overrides.usage ?? null) };
  const judgeQuotaOverride = { findFirst: vi.fn(async () => overrides.override ?? null) };
  const submission = {
    count: vi.fn(async (args: { where: { origin?: string } }) =>
      args.where.origin === "PRACTICE" ? (overrides.submissionCounts?.practice ?? 0) : (overrides.submissionCounts?.all ?? 0),
    ),
  };
  const runRequest = {
    count: vi.fn(async (args: { where: { status?: unknown } }) =>
      args.where.status ? (overrides.runCounts?.inFlight ?? 0) : (overrides.runCounts?.lastHour ?? 0),
    ),
    findFirst: vi.fn(async () => (overrides.freeing ? { createdAt: overrides.freeing } : null)),
  };
  const tx = { userJudgeUsage, judgeQuotaOverride, submission, runRequest };
  return { tx: tx as unknown as DbTx, mocks: tx };
}

describe("loaders", () => {
  it("loadCaps reads the latest unexpired override and applies it", async () => {
    const { tx, mocks } = stubTx({ override: { practicePerDay: 50, runsPerHour: null, cpuMinutesPerDay: null } });
    expect(await loadCaps(tx, "u1", NOW)).toEqual({ ...caps, practicePerDay: 50 });
    expect(mocks.judgeQuotaOverride.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: "u1", OR: [{ expiresAt: null }, { expiresAt: { gt: NOW } }] },
        orderBy: { createdAt: "desc" },
      }),
    );
    const none = stubTx({});
    expect(await loadCaps(none.tx, "u1", NOW)).toEqual(caps);
  });

  it("loadSubmitUsage = today's finalised practice submissions + those in flight", async () => {
    const { tx, mocks } = stubTx({
      usage: { cpuMs: 123_456n, submissions: 297 },
      submissionCounts: { all: 2, practice: 1 },
    });
    expect(await loadSubmitUsage(tx, "u1", NOW)).toEqual({ inFlight: 2, practiceToday: 298, cpuMsToday: 123_456 });
    expect(mocks.userJudgeUsage.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId_day: { userId: "u1", day: new Date("2026-10-10T00:00:00Z") } } }),
    );
    const fresh = stubTx({});
    expect(await loadSubmitUsage(fresh.tx, "u1", NOW)).toEqual({ inFlight: 0, practiceToday: 0, cpuMsToday: 0 });
  });

  it("loadRunUsage finds when the trailing-hour window frees a slot", async () => {
    const oldest = new Date(NOW.getTime() - 50 * 60_000);
    const { tx, mocks } = stubTx({ runCounts: { inFlight: 0, lastHour: 62 }, freeing: oldest });
    const usage = await loadRunUsage(tx, "u1", NOW, caps);
    expect(usage.runsLastHour).toBe(62);
    expect(usage.runSlotFreesAt?.toISOString()).toBe(new Date(oldest.getTime() + 3_600_000).toISOString());
    expect(mocks.runRequest.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: { createdAt: "asc" }, skip: 2 }),
    );
    const under = stubTx({ runCounts: { inFlight: 1, lastHour: 3 } });
    const u2 = await loadRunUsage(under.tx, "u1", NOW, caps);
    expect(u2).toEqual({ inFlight: 1, runsLastHour: 3, runSlotFreesAt: null, cpuMsToday: 0 });
    expect(under.mocks.runRequest.findFirst).not.toHaveBeenCalled();
  });
});
