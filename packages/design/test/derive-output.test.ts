import { clampChroma, formatHex, oklch, type Oklch } from "culori";
import { describe, expect, it } from "vitest";
import {
  buildBrandCss,
  deriveTheme,
  evaluatePalette,
  MAX_CHROMA,
  NON_THEMEABLE_KEYS,
  PALETTE_KEYS,
  themeInputSchema,
  type DeriveResult,
  type Palette,
  type ThemeInput,
} from "../src/derive";
import { CANONICAL_SEEDS, PRESET_KEYS, PRESETS, REC_PURPLE_PALETTE } from "../src/presets";
import { HEX, parseBrandCss } from "./helpers";

const STATUS_WORDS = /success|warning|danger|info/;

function sampleInputs(): ThemeInput[] {
  const inputs: ThemeInput[] = PRESET_KEYS.map((key) => ({
    presetKey: key,
    brandSeed: PRESETS[key].brandSeed,
    accentSeed: PRESETS[key].accentSeed,
    radius: "0.75rem",
  }));
  for (let h = 0; h < 360; h += 20) {
    const seed = formatHex(clampChroma({ mode: "oklch", l: 0.55, c: 0.15, h } as Oklch, "oklch", "rgb"));
    inputs.push({ presetKey: "custom", brandSeed: seed, accentSeed: seed, radius: "1rem" });
  }
  return inputs;
}

function okPalette(result: DeriveResult): Palette {
  if (!result.ok) throw new Error(`expected ok: ${JSON.stringify(result.failures)}`);
  return result.palette;
}

describe("derivation output", () => {
  const results = sampleInputs().map((input) => deriveTheme(input));

  it("never contains a success / warning / danger / info key", () => {
    for (const result of results) {
      const palette = okPalette(result);
      for (const theme of ["light", "dark"] as const) {
        for (const key of Object.keys(palette[theme])) {
          expect(key).not.toMatch(STATUS_WORDS);
          expect(NON_THEMEABLE_KEYS as readonly string[]).not.toContain(key);
        }
      }
      expect(result.ok && result.css).not.toMatch(/--(?:success|warning|danger|info)/);
    }
  });

  it("emits plain #rrggbb colours (never oklch()) and parseable brand CSS", () => {
    for (const result of results) {
      const palette = okPalette(result);
      if (!result.ok) continue;
      expect(result.css).not.toContain("oklch(");
      const parsed = parseBrandCss(result.css);
      expect(Object.keys(parsed.light)).toEqual([...PALETTE_KEYS, "radius"]);
      expect(Object.keys(parsed.dark)).toEqual([...PALETTE_KEYS]);
      expect(parsed.light.radius).toBe(palette.radius);
      for (const theme of ["light", "dark"] as const) {
        for (const key of PALETTE_KEYS) {
          expect(parsed[theme][key]).toBe(palette[theme][key]);
          if (key !== "glass" && key !== "shadow-color") expect(palette[theme][key]).toMatch(HEX);
        }
      }
      expect(palette.light.glass).toBe("rgba(255, 255, 255, 0.78)");
      expect(palette.dark.glass).toMatch(/^rgba\(\d+, \d+, \d+, 0\.72\)$/);
      expect(palette.light["shadow-color"]).toMatch(/^\d{1,3} 30% 30%$/);
      expect(palette.dark["shadow-color"]).toMatch(/^\d{1,3} 40% 3%$/);
    }
  });

  it("keeps surfaces white and white text on the light primary", () => {
    for (const result of results) {
      const palette = okPalette(result);
      expect(palette.light.surface).toBe("#ffffff");
      expect(palette.light["surface-elevated"]).toBe("#ffffff");
      expect(palette.light["primary-fg"]).toBe("#ffffff");
    }
  });

  it("builds the canonical brand CSS from the verbatim palette", () => {
    const css = buildBrandCss({ ...REC_PURPLE_PALETTE });
    expect(css.startsWith(":root{--background:#f7f5fb;--surface:#ffffff;")).toBe(true);
    expect(css).toContain(";--radius:0.75rem}:root.dark{--background:#12101c;");
    expect(css.endsWith("--shadow-color:262 40% 3%}")).toBe(true);
  });
});

describe("buildBrandCss refuses anything but a clean palette", () => {
  const base = (): Palette => ({
    light: { ...REC_PURPLE_PALETTE.light },
    dark: { ...REC_PURPLE_PALETTE.dark },
    radius: "0.75rem",
  });

  it("rejects a status colour key", () => {
    const palette = base();
    palette.light.success = "#15803d";
    expect(() => buildBrandCss(palette)).toThrow();
  });

  it("rejects a value that would break out of the declaration", () => {
    const palette = base();
    palette.dark.primary = "#8b5cf6;}body{display:none";
    expect(() => buildBrandCss(palette)).toThrow();
    const closing = base();
    closing.light.ring = "</style><script>";
    expect(() => buildBrandCss(closing)).toThrow();
  });

  it("rejects oklch() values, missing keys and unknown radii", () => {
    const withOklch = base();
    withOklch.light.primary = "oklch(0.5 0.2 290)";
    expect(() => buildBrandCss(withOklch)).toThrow();
    const missing = base();
    delete missing.dark.muted;
    expect(() => buildBrandCss(missing)).toThrow();
    expect(() => buildBrandCss({ ...base(), radius: "2rem" })).toThrow();
  });
});

describe("evaluatePalette", () => {
  it("lists each failing pair with its measured ratio", () => {
    const palette: Palette = {
      light: { ...REC_PURPLE_PALETTE.light, text: "#f0f0f0" },
      dark: { ...REC_PURPLE_PALETTE.dark },
      radius: "0.75rem",
    };
    const report = evaluatePalette(palette);
    expect(report.pass).toBe(false);
    const text = report.failures.find((f) => f.theme === "light" && f.fg === "text" && f.bg === "surface");
    expect(text).toBeDefined();
    expect(text?.ratio).toBeGreaterThan(1);
    expect(text?.ratio).toBeLessThan(1.2);
    expect(text?.min).toBe(4.5);
    expect(text?.fgValue).toBe("#f0f0f0");
  });

  it("fails a pair whose value is missing instead of throwing", () => {
    const palette: Palette = { light: {}, dark: {}, radius: "0.75rem" };
    const report = evaluatePalette(palette);
    expect(report.failures).toHaveLength(report.checks.length);
    expect(report.failures.every((f) => f.ratio === 0)).toBe(true);
  });
});

describe("themeInputSchema", () => {
  const valid = { presetKey: "custom", brandSeed: "#ABC", accentSeed: " #b45309 ", radius: "1rem" };

  it("normalises hex seeds", () => {
    expect(themeInputSchema.parse(valid)).toEqual({
      presetKey: "custom",
      brandSeed: "#aabbcc",
      accentSeed: "#b45309",
      radius: "1rem",
    });
  });

  it.each(["rebeccapurple", "#12345", "#gggggg", "oklch(0.5 0.2 290)", "", "#6d28d9ff"])(
    "rejects the seed %j",
    (seed) => {
      expect(themeInputSchema.safeParse({ ...valid, brandSeed: seed }).success).toBe(false);
    },
  );

  it("rejects unknown presets and radii", () => {
    expect(themeInputSchema.safeParse({ ...valid, presetKey: "neon" }).success).toBe(false);
    expect(themeInputSchema.safeParse({ ...valid, radius: "0.6rem" }).success).toBe(false);
  });

  it("is enforced by deriveTheme itself", () => {
    expect(() =>
      deriveTheme({ presetKey: "custom", brandSeed: "purple", accentSeed: "#b45309", radius: "1rem" }),
    ).toThrow();
  });
});

describe("canonical short-circuit", () => {
  it("honours the chosen radius without changing a colour", () => {
    for (const presetKey of ["rec-purple", "custom"] as const) {
      const palette = okPalette(deriveTheme({ presetKey, ...CANONICAL_SEEDS, radius: "1rem" }));
      expect(palette.radius).toBe("1rem");
      expect(palette.light).toEqual(REC_PURPLE_PALETTE.light);
      expect(palette.dark).toEqual(REC_PURPLE_PALETTE.dark);
    }
  });

  it("matches canonical seeds case-insensitively, and only when both seeds match", () => {
    const upper = okPalette(
      deriveTheme({ presetKey: "custom", brandSeed: "#6D28D9", accentSeed: "#B45309", radius: "0.75rem" }),
    );
    expect(upper.light).toEqual(REC_PURPLE_PALETTE.light);
    const otherAccent = okPalette(
      deriveTheme({ presetKey: "custom", brandSeed: "#6d28d9", accentSeed: "#0f766e", radius: "0.75rem" }),
    );
    expect(otherAccent.light.primary).not.toBe(REC_PURPLE_PALETTE.light.primary);
  });

  it("returns copies, so callers cannot mutate the canonical constant", () => {
    const palette = okPalette(deriveTheme({ presetKey: "rec-purple", ...CANONICAL_SEEDS, radius: "0.75rem" }));
    palette.light.primary = "#000000";
    expect(REC_PURPLE_PALETTE.light.primary).toBe("#6d28d9");
  });
});

describe("advisory warnings", () => {
  it("flags a brand hue near the danger red", () => {
    const result = deriveTheme({ presetKey: "crimson", ...PRESETS.crimson, radius: "0.75rem" });
    expect(result.ok && result.warnings.map((w) => w.code)).toContain("hue-near-danger");
  });

  it("flags a brand hue near the success green", () => {
    const green = formatHex(clampChroma({ mode: "oklch", l: 0.5, c: 0.12, h: 150 } as Oklch, "oklch", "rgb"));
    const result = deriveTheme({ presetKey: "custom", brandSeed: green, accentSeed: "#b45309", radius: "0.75rem" });
    expect(result.ok && result.warnings.map((w) => w.code)).toContain("hue-near-success");
  });

  it("reports a clamped chroma with both the submitted and the used hex", () => {
    const result = deriveTheme({ presetKey: "indigo", ...PRESETS.indigo, radius: "0.75rem" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const clamped = result.warnings.find((w) => w.code === "chroma-clamped");
    expect(clamped).toBeDefined();
    if (clamped?.code !== "chroma-clamped") return;
    expect(clamped.seed).toBe("brand");
    expect(clamped.submitted).toBe("#4f46e5");
    expect(clamped.used).toMatch(HEX);
    expect(oklch(clamped.used)?.c ?? 1).toBeLessThanOrEqual(MAX_CHROMA + 0.005);
  });

  it("is silent for a calm, in-range seed", () => {
    const result = deriveTheme({ presetKey: "teal", ...PRESETS.teal, radius: "0.75rem" });
    expect(result.ok && result.warnings).toEqual([]);
  });
});
