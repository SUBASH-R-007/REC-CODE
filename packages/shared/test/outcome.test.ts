import { describe, expect, it } from "vitest";
import { effectiveVerdict, validationOutcome } from "../src/harness/outcome";

describe("validationOutcome", () => {
  it("matches the expected verdict exactly", () => {
    expect(validationOutcome("AC", "AC", [{ v: "AC" }])).toBe("MATCHED");
    expect(validationOutcome("WA", "WA", [{ v: "WA" }])).toBe("MATCHED");
    expect(validationOutcome("AC", "WA", [{ v: "WA" }])).toBe("MISMATCHED");
    expect(validationOutcome("TLE", "WA", [{ v: "WA" }])).toBe("MISMATCHED");
  });

  it("lets a deliberately-wrong reference match through its worst failing test under partial scoring", () => {
    const tests = [{ v: "AC" as const }, { v: "TLE" as const }, { v: "SKIPPED" as const }];
    expect(effectiveVerdict("PARTIAL", tests)).toBe("TLE");
    expect(validationOutcome("TLE", "PARTIAL", tests)).toBe("MATCHED");
    expect(validationOutcome("AC", "PARTIAL", tests)).toBe("MISMATCHED");
    expect(effectiveVerdict("PARTIAL", [{ v: "PARTIAL" }])).toBe("PARTIAL");
  });
});
