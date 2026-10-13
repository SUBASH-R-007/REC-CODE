import { describe, expect, it } from "vitest";
import { clampCpuLimitMs, clampMemoryKb, earlyOleCapBytes, LIMITS, wallTimeSecFor } from "../src/limits";

const MiB = 1024 * 1024;

describe("wallTimeSecFor", () => {
  it("is ceil(2.5 × CPU seconds) + 2", () => {
    expect(wallTimeSecFor(1000)).toBe(5);
    expect(wallTimeSecFor(200)).toBe(3);
    expect(wallTimeSecFor(2000)).toBe(7);
    expect(wallTimeSecFor(2500)).toBe(9);
  });

  it("is capped at 30 seconds", () => {
    expect(wallTimeSecFor(11_200)).toBe(30);
    expect(wallTimeSecFor(15_000)).toBe(30);
    expect(wallTimeSecFor(1_000_000)).toBe(30);
    expect(LIMITS.wallTime.ceilingSec).toBe(30);
  });
});

describe("earlyOleCapBytes", () => {
  it("is 2 × expected + 1 MiB of slack", () => {
    expect(earlyOleCapBytes(0)).toBe(MiB);
    expect(earlyOleCapBytes(1000)).toBe(2000 + MiB);
    expect(earlyOleCapBytes(10 * MiB)).toBe(21 * MiB);
  });

  it("never exceeds the 64 MiB hard cap", () => {
    expect(earlyOleCapBytes(100 * MiB)).toBe(64 * MiB);
    expect(earlyOleCapBytes(Number.MAX_SAFE_INTEGER)).toBe(LIMITS.earlyOle.capBytes);
  });
});

describe("clamps", () => {
  it("clamps CPU limits to [200 ms, 15 s] and rounds", () => {
    expect(clampCpuLimitMs(50)).toBe(200);
    expect(clampCpuLimitMs(99_999)).toBe(15_000);
    expect(clampCpuLimitMs(1234.4)).toBe(1234);
  });

  it("clamps memory limits to [16 MiB, 1 GiB] in KiB", () => {
    expect(clampMemoryKb(1)).toBe(16 * 1024);
    expect(clampMemoryKb(10_000_000)).toBe(LIMITS.memory.ceilingKb);
    expect(clampMemoryKb(262_144)).toBe(262_144);
  });
});

describe("LIMITS table", () => {
  it("keeps the prompt's values", () => {
    expect(LIMITS.cpuTime).toEqual({ ceilingMs: 15_000, floorMs: 200 });
    expect(LIMITS.memory).toEqual({ defaultKb: 262_144, ceilingKb: 1_048_576 });
    expect(LIMITS.source).toEqual({ defaultBytes: 256 * 1024, ceilingBytes: 512 * 1024 });
    expect(LIMITS.customRun.stdinBytes).toBe(64 * 1024);
    expect(LIMITS.compile.outputBytes).toBe(8 * 1024);
    expect(LIMITS.coreDumpKb).toBe(0);
  });

  it("is frozen at the top level", () => {
    expect(Object.isFrozen(LIMITS)).toBe(true);
  });
});
