import { describe, expect, it } from "vitest";
import { deriveTheme, paletteSchema, PALETTE_KEYS, REQUIRED_PAIRS } from "../src/derive";
import { PRESET_KEYS, PRESETS } from "../src/presets";
import { failingPairs } from "./helpers";

const DERIVED_PRESETS = PRESET_KEYS.filter((key) => key !== "rec-purple");

describe("derived presets", () => {
  it("covers the four non-canonical presets", () => {
    expect(DERIVED_PRESETS).toEqual(["indigo", "teal", "crimson", "slate"]);
  });

  it.each(DERIVED_PRESETS)("%s passes every required pair in both themes", (key) => {
    const preset = PRESETS[key];
    const result = deriveTheme({
      presetKey: key,
      brandSeed: preset.brandSeed,
      accentSeed: preset.accentSeed,
      radius: "0.75rem",
    });
    expect(result.ok, result.ok ? "" : JSON.stringify(result.failures)).toBe(true);
    if (!result.ok) return;
    expect(failingPairs(result.palette)).toEqual([]);
    expect(result.report.pass).toBe(true);
    expect(result.report.checks).toHaveLength(REQUIRED_PAIRS.length * 2);
    expect(() => paletteSchema.parse(result.palette)).not.toThrow();
    for (const theme of ["light", "dark"] as const) {
      expect(Object.keys(result.palette[theme]).sort()).toEqual([...PALETTE_KEYS].sort());
    }
  });

  it("uses the preset's own seeds for a preset key, whatever seeds are submitted", () => {
    const a = deriveTheme({ presetKey: "teal", brandSeed: "#000000", accentSeed: "#000000", radius: "1rem" });
    const b = deriveTheme({
      presetKey: "teal",
      brandSeed: PRESETS.teal.brandSeed,
      accentSeed: PRESETS.teal.accentSeed,
      radius: "1rem",
    });
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) expect(a.palette).toEqual(b.palette);
  });

  it("is deterministic", () => {
    const input = { presetKey: "crimson", brandSeed: "#be123c", accentSeed: "#b45309", radius: "0.5rem" } as const;
    expect(deriveTheme(input)).toEqual(deriveTheme(input));
  });
});
