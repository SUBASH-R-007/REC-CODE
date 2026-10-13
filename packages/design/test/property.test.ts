import { clampChroma, formatHex, type Oklch } from "culori";
import { describe, expect, it } from "vitest";
import { deriveTheme } from "../src/derive";
import { failingPairs } from "./helpers";

function seedAt(l: number, c: number, h: number): string {
  const color: Oklch = { mode: "oklch", l, c, h };
  return formatHex(clampChroma(color, "oklch", "rgb"));
}

/**
 * Never ok:true with a failing pair. Every result is either legal (each
 * required pair independently re-measured) or a refusal that says why.
 */
describe("derivation property: never an illegal palette", () => {
  it("holds for 360 hues x chroma {0.05, 0.12, 0.21} as the brand seed", () => {
    const violations: string[] = [];
    let ok = 0;
    let refused = 0;
    for (const c of [0.05, 0.12, 0.21]) {
      for (let h = 0; h < 360; h++) {
        const seed = seedAt(0.5, c, h);
        const result = deriveTheme({
          presetKey: "custom",
          brandSeed: seed,
          accentSeed: "#b45309",
          radius: "0.75rem",
        });
        if (result.ok) {
          ok++;
          const failing = failingPairs(result.palette);
          if (failing.length > 0) violations.push(`${seed} (c=${c}, h=${h}): ${failing.join(", ")}`);
        } else {
          refused++;
          if (result.failures.length === 0) violations.push(`${seed}: refused with no failures`);
          if (result.failures.some((f) => f.pass || f.ratio >= f.min)) {
            violations.push(`${seed}: a listed failure actually passes`);
          }
        }
      }
    }
    expect(violations).toEqual([]);
    expect(ok + refused).toBe(1080);
    console.info(`Brand sweep: ${ok} legal palettes, ${refused} refused.`);
  });

  it("holds when the same sweep drives the accent seed", () => {
    const violations: string[] = [];
    for (const c of [0.05, 0.12, 0.21]) {
      for (let h = 0; h < 360; h += 3) {
        const seed = seedAt(0.5, c, h);
        const result = deriveTheme({
          presetKey: "custom",
          brandSeed: "#4f46e5",
          accentSeed: seed,
          radius: "0.75rem",
        });
        if (result.ok) {
          const failing = failingPairs(result.palette);
          if (failing.length > 0) violations.push(`${seed}: ${failing.join(", ")}`);
        } else if (result.failures.length === 0) {
          violations.push(`${seed}: refused with no failures`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("holds at the lightness extremes", () => {
    const violations: string[] = [];
    for (const l of [0.05, 0.2, 0.35, 0.65, 0.8, 0.95]) {
      for (let h = 0; h < 360; h += 15) {
        const seed = seedAt(l, 0.12, h);
        const result = deriveTheme({ presetKey: "custom", brandSeed: seed, accentSeed: seed, radius: "1rem" });
        if (result.ok) {
          const failing = failingPairs(result.palette);
          if (failing.length > 0) violations.push(`${seed}: ${failing.join(", ")}`);
        } else if (result.failures.length === 0) {
          violations.push(`${seed}: refused with no failures`);
        }
      }
    }
    for (const grey of ["#000000", "#808080", "#ffffff"]) {
      const result = deriveTheme({ presetKey: "custom", brandSeed: grey, accentSeed: grey, radius: "0.5rem" });
      if (result.ok && failingPairs(result.palette).length > 0) violations.push(`${grey}: illegal`);
      if (!result.ok && result.failures.length === 0) violations.push(`${grey}: refused with no failures`);
    }
    expect(violations).toEqual([]);
  });
});

describe("derivation property: the DO-NOT bounds on --muted", () => {
  it("light muted is never lighter than #6f6a87 and dark muted never darker than #9c95b4 (WCAG luminance)", async () => {
    const { contrast } = await import("../src/contrast");
    const lum = (hex: string) => contrast(hex, "#000000");
    const ceiling = lum("#6f6a87");
    const floor = lum("#9c95b4");
    const violations: string[] = [];
    for (const c of [0.05, 0.12, 0.21]) {
      for (let h = 0; h < 360; h += 2) {
        const seed = seedAt(0.5, c, h);
        const result = deriveTheme({ presetKey: "custom", brandSeed: seed, accentSeed: "#b45309", radius: "0.75rem" });
        if (!result.ok) continue;
        const { light, dark } = result.palette as unknown as { light: Record<string, string>; dark: Record<string, string> };
        if (lum(light.muted!) > ceiling + 1e-9) violations.push(`${seed} light muted ${light.muted}`);
        if (lum(dark.muted!) < floor - 1e-9) violations.push(`${seed} dark muted ${dark.muted}`);
      }
    }
    expect(violations).toEqual([]);
  });
});
