import { differenceCiede2000, rgb } from "culori";
import { describe, expect, it } from "vitest";
import { CVD_TYPES, simulate } from "../src/derive";
import { HEX } from "./helpers";

const deltaE = differenceCiede2000();

describe("simulate", () => {
  it.each(CVD_TYPES)("%s keeps white white and black black", (type) => {
    expect(simulate("#ffffff", type)).toBe("#ffffff");
    expect(simulate("#000000", type)).toBe("#000000");
  });

  it.each(CVD_TYPES)("%s returns plain #rrggbb", (type) => {
    for (const hex of ["#6d28d9", "#15803d", "#b91c1c", "#1d4ed8", "#b45309"]) {
      expect(simulate(hex, type)).toMatch(HEX);
    }
  });

  it("grayscale gives equal channels at the colour's relative luminance", () => {
    const grey = rgb(simulate("#6d28d9", "grayscale"));
    expect(grey).toBeDefined();
    if (!grey) return;
    expect(grey.r).toBeCloseTo(grey.g, 5);
    expect(grey.g).toBeCloseTo(grey.b, 5);
    // A neutral grey is unchanged.
    expect(simulate("#808080", "grayscale")).toBe("#808080");
  });

  it("collapses red/green for red-green dichromats but not for tritanopes", () => {
    const red = "#b91c1c";
    const green = "#15803d";
    const normal = deltaE(red, green);
    for (const type of ["deuteranopia", "protanopia"] as const) {
      expect(deltaE(simulate(red, type), simulate(green, type))).toBeLessThan(normal * 0.6);
    }
    expect(deltaE(simulate(red, "tritanopia"), simulate(green, "tritanopia"))).toBeGreaterThan(normal * 0.6);
  });

  it("collapses blue/green-ish distinctions for tritanopes", () => {
    const blue = "#1d4ed8";
    const teal = "#0f766e";
    expect(deltaE(simulate(blue, "tritanopia"), simulate(teal, "tritanopia"))).toBeLessThan(deltaE(blue, teal));
  });

  it("rejects an unparseable colour", () => {
    expect(() => simulate("not-a-colour", "deuteranopia")).toThrow();
  });
});
