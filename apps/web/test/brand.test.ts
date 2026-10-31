import { describe, expect, it, vi } from "vitest";
import { REC_PURPLE_PALETTE } from "@recx/design/presets";
import { brandFromRow, FALLBACK_BRAND, isSafeInlineCss } from "@/lib/brand/fallback";

/** The declarations of one top-level block, whitespace removed. */
function block(css: string, selector: ":root" | ":root.dark"): string {
  const compact = css.replace(/\s+/g, "");
  const escaped = selector.replace(".", "\\.");
  const match = new RegExp(`(?:^|})${escaped}\\{([^}]*)\\}`).exec(compact);
  if (!match?.[1]) throw new Error(`no ${selector} block in brand css`);
  return match[1];
}

describe("fallback brand (REC purple)", () => {
  it("emits the verbatim LMS values for light", () => {
    const light = block(FALLBACK_BRAND.css, ":root");
    expect(light).toContain("--primary:#6d28d9");
    expect(light).toContain("--muted:#6f6a87");
  });

  it("emits the verbatim LMS values for dark", () => {
    const dark = block(FALLBACK_BRAND.css, ":root.dark");
    expect(dark).toContain("--muted:#9c95b4");
  });

  it("never themes the semantic status colours", () => {
    for (const token of ["--success", "--warning", "--danger", "--info"]) {
      expect(FALLBACK_BRAND.css).not.toContain(token);
    }
  });

  it("derives theme-color from the palette backgrounds", () => {
    expect(FALLBACK_BRAND.themeColorLight.toLowerCase()).toBe("#f7f5fb");
    expect(FALLBACK_BRAND.themeColorDark.toLowerCase()).toBe("#12101c");
  });

  it("is safe to inline in a <style> element", () => {
    expect(isSafeInlineCss(FALLBACK_BRAND.css)).toBe(true);
  });
});

describe("brandFromRow", () => {
  it("falls back when the row is missing", () => {
    expect(brandFromRow(null)).toBe(FALLBACK_BRAND);
  });

  it("uses the stored css and palette colours", () => {
    const palette = {
      ...REC_PURPLE_PALETTE,
      light: { ...REC_PURPLE_PALETTE.light, background: "#fafafa", "--background": "#fafafa" },
    };
    const brand = brandFromRow({ palette, css: ":root{--primary:#0f766e}" });
    expect(brand.css).toBe(":root{--primary:#0f766e}");
    expect(brand.themeColorLight).toBe("#fafafa");
    expect(brand.themeColorDark).toBe(FALLBACK_BRAND.themeColorDark);
  });

  it("refuses css that could close the <style> element", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const brand = brandFromRow({ palette: REC_PURPLE_PALETTE, css: ":root{}</style><script>alert(1)</script>" });
    expect(brand).toBe(FALLBACK_BRAND);
    expect(error).toHaveBeenCalledOnce();
    error.mockRestore();
  });

  it("keeps the css but falls back on meta colours when the palette json is malformed", () => {
    const brand = brandFromRow({ palette: { nope: true }, css: ":root{--primary:#0f766e}" });
    expect(brand.css).toBe(":root{--primary:#0f766e}");
    expect(brand.themeColorLight).toBe(FALLBACK_BRAND.themeColorLight);
  });

  it("ignores a palette background that is not a plain colour", () => {
    const palette = { ...REC_PURPLE_PALETTE, light: { background: 'red" onload="x' } };
    expect(brandFromRow({ palette, css: ":root{}" }).themeColorLight).toBe(FALLBACK_BRAND.themeColorLight);
  });
});
