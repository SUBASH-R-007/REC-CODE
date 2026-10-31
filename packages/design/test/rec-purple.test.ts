import { createHash } from "node:crypto";
import { differenceCiede2000 } from "culori";
import { describe, expect, it } from "vitest";
import { deriveTheme, NON_THEMEABLE_KEYS, PALETTE_KEYS, type ThemeInput } from "../src/derive";
import { CANONICAL_SEEDS, DEFAULT_THEME_INPUT, REC_PURPLE_PALETTE } from "../src/presets";
import { customProperties, HEX, readPackageFile } from "./helpers";

const tokensCss = readPackageFile("tokens.css");
const verbatim = {
  light: customProperties(tokensCss, ":root"),
  dark: customProperties(tokensCss, ":root.dark"),
};
const deltaE = differenceCiede2000();

/** tokens.css properties that are not part of a brand palette, and why. */
const NOT_IN_PALETTE = new Set<string>([
  ...NON_THEMEABLE_KEYS, // status colours: never themeable
  "rec-purple", // literal brand constants
  "rec-purple-bright",
  "rec-purple-deep",
  "rec-gold",
  "radius", // carried as palette.radius
]);

const CANONICAL_INPUTS: Array<[string, ThemeInput]> = [
  ["the rec-purple preset", { ...DEFAULT_THEME_INPUT }],
  [
    "custom seed #6d28d9",
    { presetKey: "custom", ...CANONICAL_SEEDS, radius: "0.75rem" },
  ],
];

describe("tokens.css", () => {
  it("is the verbatim LMS token block (any edit to a value changes this hash)", () => {
    const normalized = tokensCss.replace(/\r\n/g, "\n");
    expect(createHash("sha256").update(normalized).digest("hex")).toBe(
      "69d3c9b95d4f09aad257ba523aaeeee62d3e7ee1ab66194ebe2ffa6e2cc8fb84",
    );
  });

  it("declares every palette key in both themes, and nothing unaccounted for", () => {
    for (const theme of ["light", "dark"] as const) {
      for (const key of PALETTE_KEYS) expect(verbatim[theme][key], `${theme} --${key}`).toBeDefined();
      for (const key of Object.keys(verbatim[theme])) {
        if ((PALETTE_KEYS as readonly string[]).includes(key)) continue;
        expect(NOT_IN_PALETTE.has(key), `${theme} --${key}`).toBe(true);
      }
    }
  });
});

describe.each(CANONICAL_INPUTS)("%s", (_name, input) => {
  const result = deriveTheme(input);

  it("short-circuits to the canonical palette", () => {
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.palette.radius).toBe(verbatim.light.radius);
    expect(result.palette.light).toEqual(REC_PURPLE_PALETTE.light);
    expect(result.palette.dark).toEqual(REC_PURPLE_PALETTE.dark);
  });

  it.each(["light", "dark"] as const)("reproduces every %s token within CIEDE2000 2", (theme) => {
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const key of PALETTE_KEYS) {
      const expected = verbatim[theme][key];
      const actual = result.palette[theme][key];
      expect(expected, key).toBeDefined();
      expect(actual, key).toBeDefined();
      if (!expected || !actual) continue;
      if (HEX.test(expected)) {
        expect(deltaE(expected, actual), `${theme} --${key}`).toBeLessThanOrEqual(2);
      } else {
        // --glass (rgba) and --shadow-color (hsl channels) are not plain colours.
        expect(actual, `${theme} --${key}`).toBe(expected);
      }
    }
  });

  it("is evaluated honestly: the canonical palette's shortfalls are reported, not hidden", () => {
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const failing = result.report.failures.map((f) => `${f.theme}:${f.fg}/${f.bg}`).sort();
    // The LMS palette predates these pairs. It cannot change (pixel parity
    // with the LMS), so the report lists exactly where it falls short.
    expect(failing).toEqual(
      [
        "light:border-strong/surface",
        "light:ring/primary",
        "dark:primary-fg/primary",
        "dark:primary/primary-subtle",
        "dark:primary/primary-soft",
        "dark:border-strong/surface",
        "dark:ring/primary",
      ].sort(),
    );
    expect(result.report.pass).toBe(false);
  });
});

describe("the generic algorithm on #6d28d9 (informational)", () => {
  it("stays legal, and its distance from the canonical tokens is reported", () => {
    const generic = deriveTheme(
      { presetKey: "custom", ...CANONICAL_SEEDS, radius: "0.75rem" },
      { canonicalShortCircuit: false },
    );
    expect(generic.ok).toBe(true);
    if (!generic.ok) return;
    const rows: Array<{ theme: string; token: string; canonical: string; generic: string; deltaE: number }> = [];
    for (const theme of ["light", "dark"] as const) {
      for (const key of PALETTE_KEYS) {
        const canonical = verbatim[theme][key] ?? "";
        const derived = generic.palette[theme][key] ?? "";
        if (!HEX.test(canonical) || !HEX.test(derived)) continue;
        rows.push({
          theme,
          token: key,
          canonical,
          generic: derived,
          deltaE: Math.round(deltaE(canonical, derived) * 100) / 100,
        });
      }
    }
    // #6d28d9 has OKLCH chroma ≈ 0.27, above the 0.21 cap, so the generic
    // path cannot land within ΔE 2 by construction (docs/OPEN-QUESTIONS.md
    // item 6). This is why the canonical seeds short-circuit.
    console.info(
      [
        "Generic derivation of #6d28d9 vs tokens.css (CIEDE2000, informational):",
        ...rows.map(
          (r) =>
            `  ${r.theme.padEnd(5)} --${r.token.padEnd(16)} ${r.canonical} -> ${r.generic}  ΔE ${r.deltaE.toFixed(2)}`,
        ),
      ].join("\n"),
    );
    expect(rows.length).toBeGreaterThan(0);
  });
});
