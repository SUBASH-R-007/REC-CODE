import { describe, expect, it } from "vitest";
import { LANGUAGE_CATALOG, LANGUAGE_KEYS } from "@recx/shared";
import { median } from "../src/calibration";
import { helloWorldFor } from "../src/startup-credit";

describe("startup-credit median (per language, over LIMITS.startupCredit.runs)", () => {
  it("is the median CPU ms of the sampled runs", () => {
    expect(median([12, 11, 13, 12, 100])).toBe(12);
    expect(median([5, 7])).toBe(6);
  });

  it("rounds to a whole millisecond when the runtime reports fractional work", () => {
    expect(Math.round(median([10, 11, 13]))).toBe(11);
  });
});

describe("helloWorldFor", () => {
  it("has a hello-world for every catalog language", () => {
    for (const key of LANGUAGE_KEYS) {
      const source = helloWorldFor(LANGUAGE_CATALOG[key]);
      expect(source, key).not.toBeNull();
      expect(source!.length).toBeGreaterThan(0);
    }
  });

  it("uses the language's own syntax (C printf, Python print, Java class Main, Go package main)", () => {
    expect(helloWorldFor(LANGUAGE_CATALOG.c17)).toContain("printf");
    expect(helloWorldFor(LANGUAGE_CATALOG.py312)).toContain("print(");
    expect(helloWorldFor(LANGUAGE_CATALOG.java21)).toContain("class Main");
    expect(helloWorldFor(LANGUAGE_CATALOG.go123)).toContain("package main");
  });
});
