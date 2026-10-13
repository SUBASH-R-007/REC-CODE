import { z } from "zod";

/**
 * The custom properties a brand palette sets, in emission order. Identical
 * key sets for light and dark. The status colours (--success, --warning,
 * --danger, --info and their -subtle variants) are deliberately absent:
 * they carry verdict and error meaning and are never themeable, so they
 * always come from tokens.css.
 */
export const PALETTE_KEYS = [
  "background",
  "surface",
  "surface-elevated",
  "glass",
  "border",
  "border-strong",
  "text",
  "text-secondary",
  "muted",
  "primary",
  "primary-hover",
  "primary-active",
  "primary-subtle",
  "primary-soft",
  "primary-fg",
  "accent",
  "accent-subtle",
  "ring",
  "shadow-color",
] as const;

export type PaletteKey = (typeof PALETTE_KEYS)[number];

/** Token names that must never appear in a derived palette or brand CSS. */
export const NON_THEMEABLE_KEYS = [
  "success",
  "success-subtle",
  "warning",
  "warning-subtle",
  "danger",
  "danger-subtle",
  "info",
  "info-subtle",
] as const;

export const RADII = ["0.5rem", "0.75rem", "1rem"] as const;
export type Radius = (typeof RADII)[number];

export const PRESET_KEYS = ["rec-purple", "indigo", "teal", "crimson", "slate"] as const;
export type PresetKey = (typeof PRESET_KEYS)[number];

export type ThemeMode = "light" | "dark";

/** A resolved palette: one value per PALETTE_KEYS entry for each theme. */
export type Palette = {
  light: Record<string, string>;
  dark: Record<string, string>;
  radius: string;
};

const HEX_SEED = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/** "#ABC" / "#aabbcc" → "#aabbcc". Input must already match HEX_SEED. */
export function normalizeHex(hex: string): string {
  const body = hex.slice(1).toLowerCase();
  if (body.length === 3) {
    return `#${body
      .split("")
      .map((ch) => ch + ch)
      .join("")}`;
  }
  return `#${body}`;
}

const seedSchema = z
  .string()
  .trim()
  .regex(HEX_SEED, "Enter the colour as a hex value such as #6d28d9.")
  .transform(normalizeHex);

/**
 * The admin boundary for theming: exactly two colours plus a radius.
 * Seeds are hex only (that is what the colour picker and the PlatformTheme
 * row hold); anything else is rejected rather than guessed at.
 */
export const themeInputSchema = z.object({
  presetKey: z.enum([...PRESET_KEYS, "custom"]),
  brandSeed: seedSchema,
  accentSeed: seedSchema,
  radius: z.enum(RADII),
});

export type ThemeInput = z.infer<typeof themeInputSchema>;

const hexValue = z.string().regex(/^#[0-9a-f]{6}$/);
const glassValue = z
  .string()
  .regex(/^rgba\(\d{1,3}, \d{1,3}, \d{1,3}, (?:0(?:\.\d{1,3})?|1)\)$/);
const shadowValue = z.string().regex(/^\d{1,3} \d{1,3}% \d{1,3}%$/);

const themeTokensSchema = z
  .object({
    background: hexValue,
    surface: hexValue,
    "surface-elevated": hexValue,
    glass: glassValue,
    border: hexValue,
    "border-strong": hexValue,
    text: hexValue,
    "text-secondary": hexValue,
    muted: hexValue,
    primary: hexValue,
    "primary-hover": hexValue,
    "primary-active": hexValue,
    "primary-subtle": hexValue,
    "primary-soft": hexValue,
    "primary-fg": hexValue,
    accent: hexValue,
    "accent-subtle": hexValue,
    ring: hexValue,
    "shadow-color": shadowValue,
  })
  .strict();

/**
 * Validates a stored palette (PlatformTheme.palette is jsonb). Strict: an
 * unknown key — including any status colour — is rejected, and every value
 * must be a plain #rrggbb / rgba() / "h s% l%" literal, so a palette can be
 * written into a <style> element without escaping.
 */
export const paletteSchema = z
  .object({
    light: themeTokensSchema,
    dark: themeTokensSchema,
    radius: z.enum(RADII),
  })
  .strict();
