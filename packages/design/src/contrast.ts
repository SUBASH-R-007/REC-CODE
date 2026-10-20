import { wcagContrast } from "culori";
import type { Palette, PaletteKey, ThemeMode } from "./palette";

export interface ContrastPair {
  fg: PaletteKey;
  bg: PaletteKey;
  /** Minimum WCAG 2 contrast ratio. */
  min: number;
}

/**
 * Pairs that block a palette. Evaluated in both themes; a derived palette
 * that fails any of them is never returned as ok. 4.5 is WCAG AA body text,
 * 3.0 is WCAG 1.4.11 non-text contrast (controls, focus indicators).
 */
export const REQUIRED_PAIRS: readonly ContrastPair[] = [
  { fg: "text", bg: "surface", min: 4.5 },
  { fg: "text", bg: "background", min: 4.5 },
  { fg: "text-secondary", bg: "surface", min: 4.5 },
  { fg: "muted", bg: "surface", min: 4.5 },
  { fg: "muted", bg: "background", min: 4.5 },
  { fg: "primary-fg", bg: "primary", min: 4.5 },
  { fg: "primary", bg: "surface", min: 3.0 },
  { fg: "primary", bg: "background", min: 3.0 },
  { fg: "primary", bg: "primary-subtle", min: 4.5 },
  { fg: "primary", bg: "primary-soft", min: 4.5 },
  { fg: "accent", bg: "surface", min: 4.5 },
  { fg: "accent", bg: "accent-subtle", min: 4.5 },
  { fg: "border-strong", bg: "surface", min: 3.0 },
  { fg: "ring", bg: "surface", min: 3.0 },
  { fg: "ring", bg: "primary", min: 3.0 },
];

export interface ContrastCheck {
  theme: ThemeMode;
  fg: PaletteKey;
  bg: PaletteKey;
  fgValue: string;
  bgValue: string;
  /** Measured ratio (unrounded; format for display). 0 when a value is missing. */
  ratio: number;
  min: number;
  pass: boolean;
}

export type ContrastFailure = ContrastCheck & { pass: false };

export interface ContrastReport {
  checks: ContrastCheck[];
  failures: ContrastFailure[];
  pass: boolean;
}

/** WCAG 2 contrast ratio between two opaque colours. */
export function contrast(a: string, b: string): number {
  return wcagContrast(a, b);
}

function isFailure(check: ContrastCheck): check is ContrastFailure {
  return !check.pass;
}

/** Measures every required pair in both themes. Never throws. */
export function evaluatePalette(palette: Palette): ContrastReport {
  const checks: ContrastCheck[] = [];
  for (const theme of ["light", "dark"] as const) {
    const tokens = palette[theme];
    for (const pair of REQUIRED_PAIRS) {
      const fgValue = tokens[pair.fg] ?? "";
      const bgValue = tokens[pair.bg] ?? "";
      let ratio = 0;
      if (fgValue && bgValue) {
        const measured = contrast(fgValue, bgValue);
        ratio = Number.isFinite(measured) ? measured : 0;
      }
      checks.push({
        theme,
        fg: pair.fg,
        bg: pair.bg,
        fgValue,
        bgValue,
        ratio,
        min: pair.min,
        pass: ratio >= pair.min,
      });
    }
  }
  const failures = checks.filter(isFailure);
  return { checks, failures, pass: failures.length === 0 };
}
