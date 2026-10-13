/**
 * Brand palette derivation. Pure and server-only: it runs once when a
 * super-admin saves the theme, the result is stored on the PlatformTheme row,
 * and the root layout injects the stored CSS. Never imported by the client
 * barrel (src/index.ts) and never run per request.
 *
 * Input is exactly two colours (brand, accent) plus a radius. Output is a
 * palette of plain #rrggbb values for the keys in PALETTE_KEYS — the status
 * colours (success / warning / danger / info) are not themeable and never
 * appear here. A palette that fails any required contrast pair is returned
 * as ok:false with the measured ratios; an illegal palette is never shipped.
 */
import { clampChroma, formatHex, hsl, oklch, rgb, type Oklch } from "culori";
import {
  contrast,
  evaluatePalette,
  type ContrastFailure,
  type ContrastReport,
} from "./contrast";
import {
  PALETTE_KEYS,
  paletteSchema,
  themeInputSchema,
  type Palette,
  type PaletteKey,
  type ThemeInput,
} from "./palette";
import { CANONICAL_SEEDS, PRESETS, REC_PURPLE_PALETTE } from "./presets";

export {
  REQUIRED_PAIRS,
  contrast,
  evaluatePalette,
  type ContrastCheck,
  type ContrastFailure,
  type ContrastPair,
  type ContrastReport,
} from "./contrast";
export { simulate, CVD_TYPES, type CvdType } from "./cvd";
export {
  NON_THEMEABLE_KEYS,
  PALETTE_KEYS,
  RADII,
  paletteSchema,
  themeInputSchema,
  type Palette,
  type PaletteKey,
  type PresetKey,
  type Radius,
  type ThemeInput,
  type ThemeMode,
} from "./palette";

/** Seeds above this OKLCH chroma are clamped (advisory warning). */
export const MAX_CHROMA = 0.21;

const STEP = 0.01;
const WHITE = "#ffffff";
/** The canonical dark surface; the dark primary must clear 4.5:1 on it. */
const CANONICAL_DARK_SURFACE = "#1a1727";
const LIGHT_GLASS = "rgba(255, 255, 255, 0.78)";

/** Lightness windows from the algorithm specification. */
const LIGHT_PRIMARY_START = { min: 0.38, max: 0.56 } as const;
const LIGHT_PRIMARY_FLOOR = 0.3;
const DARK_PRIMARY_START = { min: 0.62, max: 0.76 } as const;
const DARK_PRIMARY_CEILING = 0.95;
const DARK_ACCENT_START = 0.78;

/** Reference hues (OKLCH) of the non-themeable danger red and success green. */
const DANGER_HUE = 25;
const SUCCESS_HUE = 145;
const HUE_WARNING_DISTANCE = 25;

export type ThemeWarning =
  | {
      code: "hue-near-danger" | "hue-near-success";
      /** OKLCH hue of the brand seed, degrees. */
      hue: number;
      message: string;
    }
  | {
      code: "chroma-clamped";
      seed: "brand" | "accent";
      /** The hex the admin submitted. */
      submitted: string;
      /** The seed after the chroma cap, which derivation actually used. */
      used: string;
      message: string;
    };

export type DeriveResult =
  | {
      ok: true;
      palette: Palette;
      css: string;
      warnings: ThemeWarning[];
      report: ContrastReport;
    }
  | { ok: false; failures: ContrastFailure[]; report: ContrastReport };

export interface DeriveOptions {
  /**
   * When true (the default) the canonical REC seeds return the verbatim
   * LMS palette instead of a derived one. Tests turn it off to measure what
   * the generic algorithm would produce.
   */
  canonicalShortCircuit?: boolean;
}

// ── colour helpers ──────────────────────────────────────────────────────

interface SeedLch {
  hex: string;
  l: number;
  c: number;
  /** 0 when the seed is achromatic (OKLCH hue undefined). */
  h: number;
  hueDefined: boolean;
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function parseSeed(hex: string): SeedLch {
  const parsed = oklch(hex);
  if (!parsed) throw new Error(`Unparseable colour seed: ${hex}`);
  const hueDefined = typeof parsed.h === "number" && Number.isFinite(parsed.h);
  return {
    hex,
    l: parsed.l,
    c: parsed.c,
    h: hueDefined ? (parsed.h as number) : 0,
    hueDefined,
  };
}

/**
 * Builds an OKLCH colour, caps chroma, maps it into sRGB by reducing chroma
 * (clampChroma), and returns plain #rrggbb.
 */
function mk(l: number, c: number, h: number): string {
  const color: Oklch = {
    mode: "oklch",
    l: clampNumber(l, 0, 1),
    c: clampNumber(c, 0, MAX_CHROMA),
    h,
  };
  return formatHex(clampChroma(color, "oklch", "rgb"));
}

/**
 * Steps lightness from `start` by `delta` until `ok` holds or `limit` is
 * passed. Returns the first passing colour, or the last one tried, in which
 * case the palette evaluation reports the measured ratio as a failure.
 */
function stepUntil(
  start: number,
  delta: number,
  limit: number,
  build: (l: number) => string,
  ok: (hex: string) => boolean,
): string {
  let last = build(start);
  for (let i = 0; i <= 200; i++) {
    const l = round4(start + i * delta);
    if (delta < 0 ? l < limit - 1e-9 : l > limit + 1e-9) break;
    last = build(l);
    if (ok(last)) return last;
  }
  return last;
}

/**
 * The focus ring sits between the primary and the surface in lightness,
 * so it reads against both (3:1 to each, WCAG 1.4.11). Starting from the
 * specified offset (moved onto the surface side of the primary if needed),
 * it steps away from the primary until it separates from it, then checks it
 * still separates from the surface. Returns null when no such ring exists
 * for this primary, which tells the caller to move the primary further.
 */
function findRing(
  primaryL: number,
  primaryHex: string,
  c: number,
  h: number,
  surfaceHex: string,
  offset: number,
  towardSurface: 1 | -1,
): string | null {
  let r = round4(primaryL + offset);
  if ((r - primaryL) * towardSurface < STEP - 1e-9) {
    r = round4(primaryL + STEP * towardSurface);
  }
  const inRange = (value: number) => value >= -1e-9 && value <= 1 + 1e-9;
  if (!inRange(r)) return null;
  let hex = mk(r, c, h);
  let moved = false;
  while (contrast(hex, primaryHex) < 3) {
    r = round4(r + STEP * towardSurface);
    if (!inRange(r)) return null;
    hex = mk(r, c, h);
    moved = true;
  }
  if (contrast(hex, surfaceHex) >= 3) return hex;
  if (moved) return null;
  while (contrast(hex, surfaceHex) < 3) {
    r = round4(r - STEP * towardSurface);
    if ((r - primaryL) * towardSurface < STEP - 1e-9) return null;
    hex = mk(r, c, h);
    if (contrast(hex, primaryHex) < 3) return null;
  }
  return hex;
}

function hslHue(hex: string): number {
  const h = hsl(hex)?.h;
  if (typeof h !== "number" || !Number.isFinite(h)) return 0;
  return Math.round(h) % 360;
}

function rgbaOf(hex: string, alpha: number): string {
  const color = rgb(hex);
  if (!color) throw new Error(`Unparseable colour: ${hex}`);
  const channel = (v: number) => Math.round(clampNumber(v, 0, 1) * 255);
  return `rgba(${channel(color.r)}, ${channel(color.g)}, ${channel(color.b)}, ${alpha})`;
}

function hueDistance(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

// ── derivation ──────────────────────────────────────────────────────────

type Tokens = Record<PaletteKey, string>;

/**
 * Neutrals carry a faint tint of the brand hue. An achromatic seed has no
 * hue to carry, so its neutrals stay untinted rather than drifting to hue 0.
 */
function neutralBuilder(brand: SeedLch): (l: number, chroma: number) => string {
  return (l, chroma) => mk(l, brand.hueDefined ? chroma : 0, brand.h);
}

function deriveLight(brand: SeedLch, accent: SeedLch, shadowHue: number): Tokens {
  const h = brand.h;
  const c = Math.min(brand.c, MAX_CHROMA);
  const neutral = neutralBuilder(brand);
  const surface = WHITE;

  const background = neutral(0.975, 0.008);
  const border = neutral(0.915, 0.012);
  // border-strong outlines inputs, so it is held to 3:1 on the surface.
  const borderStrong = stepUntil(0.865, -STEP, 0, (l) => neutral(l, 0.018), (hex) =>
    contrast(hex, surface) >= 3,
  );
  const text = neutral(0.22, 0.045);
  const textSecondary = neutral(0.46, 0.035);
  const muted = stepUntil(0.53, -STEP, 0, (l) => neutral(l, 0.03), (hex) =>
    contrast(hex, surface) >= 4.5 && contrast(hex, background) >= 4.5,
  );

  const primarySubtle = mk(0.965, c * 0.16, h);
  const primarySoft = mk(0.915, c * 0.3, h);

  // Primary: step darker from the seed until white text, the page and both
  // tints clear, and a focus ring fits between it and the surface at 3:1 to
  // each (which needs the primary at ≥ 9:1 on white, since the ratios
  // multiply).
  let primaryL = LIGHT_PRIMARY_FLOOR;
  let primary = mk(primaryL, c, h);
  let ring = mk(primaryL + 0.12, c, h);
  const start = clampNumber(brand.l, LIGHT_PRIMARY_START.min, LIGHT_PRIMARY_START.max);
  for (let i = 0; i <= 100; i++) {
    const l = round4(start - i * STEP);
    if (l < LIGHT_PRIMARY_FLOOR - 1e-9) break;
    const candidate = mk(l, c, h);
    if (
      contrast(candidate, WHITE) < 4.5 ||
      contrast(candidate, background) < 3 ||
      contrast(candidate, primarySubtle) < 4.5 ||
      contrast(candidate, primarySoft) < 4.5
    ) {
      continue;
    }
    const candidateRing = findRing(l, candidate, c, h, surface, 0.12, 1);
    if (!candidateRing) continue;
    primaryL = l;
    primary = candidate;
    ring = candidateRing;
    break;
  }

  const ac = Math.min(accent.c, MAX_CHROMA);
  const accentSubtle = mk(0.96, ac * 0.35, accent.h);
  const accentColor = stepUntil(
    clampNumber(accent.l, LIGHT_PRIMARY_START.min, LIGHT_PRIMARY_START.max),
    -STEP,
    LIGHT_PRIMARY_FLOOR,
    (l) => mk(l, ac, accent.h),
    (hex) => contrast(hex, surface) >= 4.5 && contrast(hex, accentSubtle) >= 4.5,
  );

  return {
    background,
    surface,
    "surface-elevated": WHITE,
    glass: LIGHT_GLASS,
    border,
    "border-strong": borderStrong,
    text,
    "text-secondary": textSecondary,
    muted,
    primary,
    "primary-hover": mk(primaryL - 0.06, c, h),
    "primary-active": mk(primaryL - 0.12, c, h),
    "primary-subtle": primarySubtle,
    "primary-soft": primarySoft,
    "primary-fg": WHITE,
    accent: accentColor,
    "accent-subtle": accentSubtle,
    ring,
    "shadow-color": `${shadowHue} 30% 30%`,
  };
}

function deriveDark(brand: SeedLch, accent: SeedLch, shadowHue: number): Tokens {
  const h = brand.h;
  const c = Math.min(brand.c, MAX_CHROMA);
  const neutral = neutralBuilder(brand);

  const background = neutral(0.165, 0.022);
  const surface = neutral(0.195, 0.024);
  const surfaceElevated = neutral(0.225, 0.026);
  const border = neutral(0.285, 0.03);
  const borderStrong = stepUntil(0.355, STEP, 1, (l) => neutral(l, 0.038), (hex) =>
    contrast(hex, surface) >= 3,
  );
  const text = neutral(0.955, 0.015);
  const textSecondary = neutral(0.745, 0.028);
  const muted = stepUntil(0.655, STEP, 1, (l) => neutral(l, 0.026), (hex) =>
    contrast(hex, surface) >= 4.5 && contrast(hex, background) >= 4.5,
  );

  const primarySubtle = mk(0.24, c * 0.3, h);
  const primarySoft = mk(0.3, c * 0.4, h);
  // A dark-theme primary bright enough to clear 4.5:1 on the dark surface
  // (and 9:1, so a focus ring fits between them) cannot also carry white
  // text at 4.5:1 — no colour has 4.5:1 against both white and a dark
  // surface. Text on the dark primary is therefore the dark background.
  const primaryFg = background;

  // Primary: step lighter from the seed until it clears the canonical and the
  // derived dark surface, its text, both tints, and a focus ring fits between
  // it and the surface. In dark the ring is therefore darker than the
  // primary: a ring lighter than a primary this bright cannot reach 3:1
  // against it.
  let primaryL = DARK_PRIMARY_CEILING;
  let primary = mk(primaryL, c, h);
  let ring = mk(primaryL - 0.08, c, h);
  const start = clampNumber(brand.l, DARK_PRIMARY_START.min, DARK_PRIMARY_START.max);
  for (let i = 0; i <= 100; i++) {
    const l = round4(start + i * STEP);
    if (l > DARK_PRIMARY_CEILING + 1e-9) break;
    const candidate = mk(l, c, h);
    if (
      contrast(candidate, CANONICAL_DARK_SURFACE) < 4.5 ||
      contrast(candidate, surface) < 4.5 ||
      contrast(candidate, background) < 3 ||
      contrast(candidate, primaryFg) < 4.5 ||
      contrast(candidate, primarySubtle) < 4.5 ||
      contrast(candidate, primarySoft) < 4.5
    ) {
      continue;
    }
    const candidateRing = findRing(l, candidate, c, h, surface, 0.08, -1);
    if (!candidateRing) continue;
    primaryL = l;
    primary = candidate;
    ring = candidateRing;
    break;
  }

  const ac = Math.min(accent.c, MAX_CHROMA);
  const accentSubtle = mk(0.27, ac * 0.3, accent.h);
  const accentColor = stepUntil(
    DARK_ACCENT_START,
    STEP,
    1,
    (l) => mk(l, ac, accent.h),
    (hex) => contrast(hex, surface) >= 4.5 && contrast(hex, accentSubtle) >= 4.5,
  );

  return {
    background,
    surface,
    "surface-elevated": surfaceElevated,
    glass: rgbaOf(surface, 0.72),
    border,
    "border-strong": borderStrong,
    text,
    "text-secondary": textSecondary,
    muted,
    primary,
    "primary-hover": mk(primaryL + 0.05, c, h),
    "primary-active": mk(primaryL - 0.08, c, h),
    "primary-subtle": primarySubtle,
    "primary-soft": primarySoft,
    "primary-fg": primaryFg,
    accent: accentColor,
    "accent-subtle": accentSubtle,
    ring,
    "shadow-color": `${shadowHue} 40% 3%`,
  };
}

function seedWarnings(brand: SeedLch, accent: SeedLch): ThemeWarning[] {
  const warnings: ThemeWarning[] = [];
  if (brand.hueDefined && brand.c > 0) {
    const hue = Math.round(brand.h);
    if (hueDistance(brand.h, DANGER_HUE) <= HUE_WARNING_DISTANCE) {
      warnings.push({
        code: "hue-near-danger",
        hue,
        message:
          "The brand colour is close to the red used for errors and wrong answers. Buttons may read as warnings.",
      });
    }
    if (hueDistance(brand.h, SUCCESS_HUE) <= HUE_WARNING_DISTANCE) {
      warnings.push({
        code: "hue-near-success",
        hue,
        message:
          "The brand colour is close to the green used for accepted answers. Buttons may read as success states.",
      });
    }
  }
  for (const [seed, value] of [
    ["brand", brand],
    ["accent", accent],
  ] as const) {
    if (value.c > MAX_CHROMA) {
      warnings.push({
        code: "chroma-clamped",
        seed,
        submitted: value.hex,
        used: mk(value.l, MAX_CHROMA, value.h),
        message: `The ${seed} colour is more saturated than the palette allows; a less saturated version was used.`,
      });
    }
  }
  return warnings;
}

function toPalette(light: Tokens, dark: Tokens, radius: string): Palette {
  const pick = (tokens: Tokens) =>
    Object.fromEntries(PALETTE_KEYS.map((key) => [key, tokens[key]])) as Record<string, string>;
  return { light: pick(light), dark: pick(dark), radius };
}

function isCanonical(brandSeed: string, accentSeed: string): boolean {
  return brandSeed === CANONICAL_SEEDS.brandSeed && accentSeed === CANONICAL_SEEDS.accentSeed;
}

/**
 * Derives the brand palette. Throws a ZodError when the input fails
 * themeInputSchema (validate at the boundary first). For a preset key the
 * preset's own seeds are used; for "custom" the submitted seeds are.
 */
export function deriveTheme(input: ThemeInput, options: DeriveOptions = {}): DeriveResult {
  const parsed = themeInputSchema.parse(input);
  const seeds =
    parsed.presetKey === "custom"
      ? { brandSeed: parsed.brandSeed, accentSeed: parsed.accentSeed }
      : PRESETS[parsed.presetKey];

  // The canonical palette is the LMS palette, verbatim — not a re-derivation
  // (#6d28d9 exceeds the chroma cap, so the generic path cannot reproduce it).
  // It is evaluated honestly; pairs it misses are listed in the report.
  if (
    (options.canonicalShortCircuit ?? true) &&
    (parsed.presetKey === "rec-purple" || isCanonical(seeds.brandSeed, seeds.accentSeed))
  ) {
    const palette: Palette = {
      light: { ...REC_PURPLE_PALETTE.light },
      dark: { ...REC_PURPLE_PALETTE.dark },
      radius: parsed.radius,
    };
    return {
      ok: true,
      palette,
      css: buildBrandCss(palette),
      warnings: [],
      report: evaluatePalette(palette),
    };
  }

  const brand = parseSeed(seeds.brandSeed);
  const accent = parseSeed(seeds.accentSeed);
  const shadowHue = hslHue(seeds.brandSeed);
  const palette = toPalette(
    deriveLight(brand, accent, shadowHue),
    deriveDark(brand, accent, shadowHue),
    parsed.radius,
  );
  const report = evaluatePalette(palette);
  if (!report.pass) return { ok: false, failures: report.failures, report };
  return {
    ok: true,
    palette,
    css: buildBrandCss(palette),
    warnings: seedWarnings(brand, accent),
    report,
  };
}

/**
 * ":root{--background:#…;…;--radius:…}:root.dark{…}" — light then dark,
 * only PALETTE_KEYS. Throws if the palette fails paletteSchema, so a
 * tampered or stale jsonb value can never inject CSS.
 */
export function buildBrandCss(palette: Palette): string {
  const valid = paletteSchema.parse(palette);
  const declarations = (tokens: Record<PaletteKey, string>) =>
    PALETTE_KEYS.map((key) => `--${key}:${tokens[key]}`).join(";");
  return `:root{${declarations(valid.light)};--radius:${valid.radius}}:root.dark{${declarations(valid.dark)}}`;
}
