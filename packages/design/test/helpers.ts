import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { wcagContrast } from "culori";
import { REQUIRED_PAIRS, type Palette } from "../src/derive";

/** Re-measures every required pair with culori directly (not via the report). */
export function failingPairs(palette: Palette): string[] {
  const failing: string[] = [];
  for (const theme of ["light", "dark"] as const) {
    for (const pair of REQUIRED_PAIRS) {
      const fg = palette[theme][pair.fg];
      const bg = palette[theme][pair.bg];
      const ratio = fg && bg ? wcagContrast(fg, bg) : 0;
      if (!(ratio >= pair.min)) {
        failing.push(`${theme}:${pair.fg}/${pair.bg}=${ratio.toFixed(2)}<${pair.min}`);
      }
    }
  }
  return failing;
}

export function readPackageFile(relative: string): string {
  return readFileSync(fileURLToPath(new URL(`../${relative}`, import.meta.url)), "utf8");
}

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

/** Custom properties declared directly in the first `selector { … }` block. */
export function customProperties(css: string, selector: string): Record<string, string> {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const block = new RegExp(`(?:^|\\})\\s*${escaped}\\s*\\{([^{}]*)\\}`).exec(stripComments(css));
  if (!block?.[1]) throw new Error(`No ${selector} block found`);
  const props: Record<string, string> = {};
  for (const match of block[1].matchAll(/--([\w-]+)\s*:\s*([^;]+);?/g)) {
    const [, name, value] = match;
    if (name && value) props[name] = value.trim();
  }
  return props;
}

/** Parses buildBrandCss() output strictly; throws on any deviation. */
export function parseBrandCss(css: string): { light: Record<string, string>; dark: Record<string, string> } {
  const match = /^:root\{([^{}]*)\}:root\.dark\{([^{}]*)\}$/.exec(css);
  if (!match?.[1] || !match[2]) throw new Error("Brand CSS is not :root{…}:root.dark{…}");
  const parse = (body: string) => {
    const out: Record<string, string> = {};
    for (const declaration of body.split(";")) {
      const decl = /^--([a-z-]+):(.+)$/.exec(declaration);
      if (!decl?.[1] || !decl[2]) throw new Error(`Malformed declaration: ${declaration}`);
      if (decl[1] in out) throw new Error(`Duplicate declaration: ${decl[1]}`);
      out[decl[1]] = decl[2];
    }
    return out;
  };
  return { light: parse(match[1]), dark: parse(match[2]) };
}

export const HEX = /^#[0-9a-f]{6}$/;
