import type { Palette, PresetKey, ThemeInput } from "./palette";

export {
  PALETTE_KEYS,
  PRESET_KEYS,
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

/**
 * Server-safe (and client-safe) theme presets. Only rec-purple is canonical;
 * the others are run through deriveTheme() on save.
 */
export const PRESETS: Readonly<
  Record<PresetKey, { label: string; brandSeed: string; accentSeed: string }>
> = Object.freeze({
  "rec-purple": { label: "REC Purple", brandSeed: "#6d28d9", accentSeed: "#b45309" },
  indigo: { label: "Indigo", brandSeed: "#4f46e5", accentSeed: "#b45309" },
  teal: { label: "Teal", brandSeed: "#0f766e", accentSeed: "#b45309" },
  crimson: { label: "Crimson", brandSeed: "#be123c", accentSeed: "#b45309" },
  slate: { label: "Slate", brandSeed: "#475569", accentSeed: "#b45309" },
});

/** The seeds that select the canonical palette instead of a derived one. */
export const CANONICAL_SEEDS = Object.freeze({
  brandSeed: "#6d28d9",
  accentSeed: "#b45309",
});

/**
 * The themeable subset of tokens.css, verbatim, so that the default REC Code
 * theme is pixel-identical to the REC Learning LMS. test/rec-purple.test.ts
 * reads tokens.css from disk and holds these equal to it.
 */
export const REC_PURPLE_PALETTE: Readonly<Palette> = Object.freeze({
  light: Object.freeze({
    background: "#f7f5fb",
    surface: "#ffffff",
    "surface-elevated": "#ffffff",
    glass: "rgba(255, 255, 255, 0.78)",
    border: "#e6e2ef",
    "border-strong": "#d4cee4",
    text: "#1c1730",
    "text-secondary": "#55506b",
    muted: "#6f6a87",
    primary: "#6d28d9",
    "primary-hover": "#5b21b6",
    "primary-active": "#4c1d95",
    "primary-subtle": "#f1ecfc",
    "primary-soft": "#e3d9f8",
    "primary-fg": "#ffffff",
    accent: "#b45309",
    "accent-subtle": "#fef3c7",
    ring: "#8b5cf6",
    "shadow-color": "262 30% 30%",
  }),
  dark: Object.freeze({
    background: "#12101c",
    surface: "#1a1727",
    "surface-elevated": "#211d31",
    glass: "rgba(26, 23, 39, 0.72)",
    border: "#2c2840",
    "border-strong": "#3b3556",
    text: "#f0edf8",
    "text-secondary": "#b6b0cc",
    muted: "#9c95b4",
    primary: "#8b5cf6",
    "primary-hover": "#9d74f8",
    "primary-active": "#7c3aed",
    "primary-subtle": "#241d3d",
    "primary-soft": "#322859",
    "primary-fg": "#ffffff",
    accent: "#fbbf24",
    "accent-subtle": "#3a2e14",
    ring: "#a78bfa",
    "shadow-color": "262 40% 3%",
  }),
  radius: "0.75rem",
});

export const DEFAULT_THEME_INPUT: Readonly<ThemeInput> = Object.freeze({
  presetKey: "rec-purple",
  brandSeed: CANONICAL_SEEDS.brandSeed,
  accentSeed: CANONICAL_SEEDS.accentSeed,
  radius: "0.75rem",
});
