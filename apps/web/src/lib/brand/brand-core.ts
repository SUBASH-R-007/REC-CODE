import { z } from "zod";
import { buildBrandCss, type Palette } from "@recx/design/derive";
import { REC_PURPLE_PALETTE } from "@recx/design/presets";

/**
 * Pure brand helpers (no database, no Next cache) so they are unit-testable.
 * No `server-only` import: the Pages Router sign-in page (src/lib/pages-server.ts)
 * uses them too, and Next refuses `server-only` in a pages/ import graph.
 * App Router code imports them through ./fallback, which keeps that guard.
 * src/lib/brand/theme.ts wraps them with the cached PlatformTheme read.
 */

export interface Brand {
  /** ":root{…}:root.dark{…}" — injected as <style id="rec-brand">. */
  css: string;
  /** <meta name="theme-color"> for light and dark schemes. */
  themeColorLight: string;
  themeColorDark: string;
}

/** Last resort only; the palettes always carry a background token. */
const DEFAULT_THEME_COLOR = { light: "#f7f5fb", dark: "#12101c" } as const;

/** A colour safe to place in a meta tag: hex, or a plain functional notation. */
const SAFE_COLOR = /^(#[0-9a-f]{3,8}|[a-z]+\([0-9a-z.,%\s/+-]+\))$/i;

const paletteSchema = z.object({
  light: z.record(z.string()),
  dark: z.record(z.string()),
  radius: z.string(),
});

function backgroundOf(tokens: Record<string, string>): string | undefined {
  const value = (tokens["background"] ?? tokens["--background"])?.trim();
  return value && SAFE_COLOR.test(value) ? value : undefined;
}

/**
 * The brand CSS is inlined with dangerouslySetInnerHTML, so it must never be
 * able to close the <style> element. Derived CSS never contains "<" at all;
 * anything that does is treated as corrupt.
 */
export function isSafeInlineCss(css: string): boolean {
  return css.length > 0 && css.length < 64 * 1024 && !css.includes("<");
}

export function brandFromPalette(palette: Palette, css: string): Brand {
  return {
    css,
    themeColorLight:
      backgroundOf(palette.light) ?? backgroundOf(REC_PURPLE_PALETTE.light) ?? DEFAULT_THEME_COLOR.light,
    themeColorDark:
      backgroundOf(palette.dark) ?? backgroundOf(REC_PURPLE_PALETTE.dark) ?? DEFAULT_THEME_COLOR.dark,
  };
}

/** The canonical REC purple brand, built once per process. */
export const FALLBACK_BRAND: Brand = brandFromPalette(REC_PURPLE_PALETTE, buildBrandCss(REC_PURPLE_PALETTE));

/**
 * Turn the stored PlatformTheme row into a Brand. A missing or malformed row
 * yields the REC purple fallback — the page must always render.
 */
export function brandFromRow(row: { palette: unknown; css: string } | null): Brand {
  if (!row) return FALLBACK_BRAND;
  if (!isSafeInlineCss(row.css)) {
    console.error("[brand] stored PlatformTheme css rejected (empty, oversized or contains '<'); using fallback");
    return FALLBACK_BRAND;
  }
  const palette = paletteSchema.safeParse(row.palette);
  if (!palette.success) {
    // The css is still the admin's choice; only the meta colours fall back.
    return { ...FALLBACK_BRAND, css: row.css };
  }
  return brandFromPalette(palette.data, row.css);
}

/** Primary key of the singleton PlatformTheme row. */
export const PLATFORM_THEME_ID = "default";
