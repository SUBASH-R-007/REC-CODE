import { describe, expect, it } from "vitest";
import { CODE_EXTENSIONS, findFiles, lexSource, lineAt, readRepoFile } from "./support/repo";

/**
 * Tailwind colour utilities must name a token that exists.
 *
 * Tailwind v4 generates a colour utility only for a `--color-*` entry in the
 * theme. A class that names anything else — `text-fg`, `bg-surface-raised`,
 * `text-on-accent` — compiles to NOTHING. No error, no warning, no missing
 * module: the element simply inherits, and on a dark background an inherited
 * colour often looks close enough to pass a glance. It is the kind of bug
 * that reaches a student's screen.
 *
 * Found while building the Phase 6c exam shell, where five such classes were
 * written from memory of a different design system and typechecked, linted
 * and built perfectly green.
 *
 * The check is narrow on purpose, so it has no false positives to train
 * anyone to ignore: a utility is examined only when its suffix contains one
 * of OUR token stems. `text-sm` and `border-r` do not; `text-fg` and
 * `bg-surface-raised` do, and must then resolve exactly.
 */

const THEME = "packages/design/theme.css";

/** Every colour the theme defines, which is exactly what Tailwind will emit. */
function definedTokens(): Set<string> {
  const css = readRepoFile(THEME);
  const names = [...css.matchAll(/--color-([a-z0-9-]+)\s*:/g)].map((m) => m[1]!);
  return new Set(names);
}

/**
 * Stems that mark a suffix as naming one of our colours. A typo is caught
 * because it still contains the stem it was reaching for (`fg` and `on-` are
 * stems of their own: neither is a real token anywhere here, so any class
 * using them is wrong by construction).
 */
const TOKEN_STEMS = [
  "surface",
  "elevated",
  "background",
  "muted",
  "primary",
  "accent",
  "success",
  "danger",
  "warning",
  "info",
  "border",
  "ring",
  "text",
  "fg",
  "on-",
];

/** Prefixes that take a colour. */
const COLOUR_PREFIXES = [
  "bg",
  "text",
  "border",
  "outline",
  "ring",
  "divide",
  "from",
  "to",
  "via",
  "fill",
  "stroke",
  "caret",
  "decoration",
  "placeholder",
  "shadow",
  "accent",
];

/** `border-l-primary` is a real utility: a side, then a colour. */
const SIDES = ["t", "r", "b", "l", "x", "y", "s", "e"];

/**
 * Tailwind utilities whose own name happens to contain a stem. Each is a
 * real built-in, not a colour, so it never needs to resolve.
 */
const BUILT_INS = new Set([
  "clip-text", // bg-clip-text
  "balance", // text-balance
  "pretty", // text-pretty
  "collapse", // border-collapse
  "separate", // border-separate
  "inset", // ring-inset
]);

const CLASS_RE = new RegExp(
  `(?<![\\w-])(${COLOUR_PREFIXES.join("|")})-([a-z][a-z0-9-]*)(?:/\\d{1,3})?(?![\\w-])`,
  "g",
);

interface Violation {
  readonly file: string;
  readonly line: number;
  readonly cls: string;
}

function scan(tokens: Set<string>): Violation[] {
  const out: Violation[] = [];
  const files = findFiles({ extensions: CODE_EXTENSIONS, under: ["apps/web/src", "packages/design/src"] });
  for (const rel of files) {
    const src = readRepoFile(rel);
    // Comments stripped, string and template bodies kept: a class name lives
    // in a string, and prose about "text-on-surface colours" does not.
    const { code } = lexSource(src);
    for (const match of code.matchAll(CLASS_RE)) {
      let suffix = match[2]!;
      if (BUILT_INS.has(suffix)) continue;
      // Strip a leading side segment, so border-l-primary reads as primary.
      if (match[1] === "border" || match[1] === "divide") {
        const parts = suffix.split("-");
        if (parts.length > 1 && SIDES.includes(parts[0]!)) suffix = parts.slice(1).join("-");
      }
      if (!TOKEN_STEMS.some((stem) => suffix.includes(stem))) continue;
      if (tokens.has(suffix)) continue;
      out.push({ file: rel, line: lineAt(src, match.index ?? 0), cls: `${match[1]}-${match[2]}` });
    }
  }
  return out;
}

describe("Tailwind colour utilities name a token that exists", () => {
  const tokens = definedTokens();

  it("finds the theme's colours (sanity)", () => {
    expect(tokens.size).toBeGreaterThan(15);
    for (const expected of ["surface", "elevated", "text", "text-secondary", "primary", "border"]) {
      expect(tokens, `theme.css defines --color-${expected}`).toContain(expected);
    }
  });

  it("knows the names that look right and are not tokens (sanity)", () => {
    // The five that shipped green through typecheck, lint and build.
    for (const wrong of ["fg", "fg-muted", "surface-raised", "on-accent", "on-success"]) {
      expect(tokens, `--color-${wrong} must not exist`).not.toContain(wrong);
      expect(TOKEN_STEMS.some((s) => wrong.includes(s)), `${wrong} is caught by a stem`).toBe(true);
    }
  });

  it("every colour utility in apps/web and packages/design resolves", () => {
    const violations = scan(tokens);
    const report = violations.map((v) => `${v.file}:${v.line} — ${v.cls} is not a --color-* token`);
    expect(report).toEqual([]);
  });

  it("the real utilities the repo already uses are not flagged", () => {
    const fine = [
      'className="text-sm text-text-secondary"',
      'className="border-r border-border"',
      'className="border-l-4 border-l-primary bg-surface"',
      'className="text-xs bg-elevated outline-ring outline-offset-2"',
      'className="bg-clip-text text-balance border-collapse ring-inset"',
      'className="bg-success-subtle text-success border-success/40"',
    ];
    for (const snippet of fine) {
      const hits = [...lexSource(snippet).code.matchAll(CLASS_RE)]
        .map((m) => {
          let suffix = m[2]!;
          if (BUILT_INS.has(suffix)) return null;
          if (m[1] === "border" || m[1] === "divide") {
            const parts = suffix.split("-");
            if (parts.length > 1 && SIDES.includes(parts[0]!)) suffix = parts.slice(1).join("-");
          }
          if (!TOKEN_STEMS.some((stem) => suffix.includes(stem))) return null;
          return tokens.has(suffix) ? null : `${m[1]}-${m[2]}`;
        })
        .filter(Boolean);
      expect(hits, snippet).toEqual([]);
    }
  });

  it("catches each invented name it is meant to catch", () => {
    const wrong = [
      ['className="text-fg"', "text-fg"],
      ['className="bg-surface-raised"', "bg-surface-raised"],
      ['className="text-on-accent"', "text-on-accent"],
      ['className="text-fg-muted"', "text-fg-muted"],
      ['className="text-text-tertiary"', "text-text-tertiary"],
      ['className="border-border-subtle"', "border-border-subtle"],
    ] as const;
    for (const [snippet, expected] of wrong) {
      const hits = [...lexSource(snippet).code.matchAll(CLASS_RE)]
        .map((m) => {
          let suffix = m[2]!;
          if (BUILT_INS.has(suffix)) return null;
          if (m[1] === "border" || m[1] === "divide") {
            const parts = suffix.split("-");
            if (parts.length > 1 && SIDES.includes(parts[0]!)) suffix = parts.slice(1).join("-");
          }
          if (!TOKEN_STEMS.some((stem) => suffix.includes(stem))) return null;
          return tokens.has(suffix) ? null : `${m[1]}-${m[2]}`;
        })
        .filter(Boolean);
      expect(hits, snippet).toEqual([expected]);
    }
  });

  it("ignores prose in a comment, which is not a class", () => {
    const snippet = "/** How the primary, accent and text-on-surface colours read. */\nconst x = 1;";
    const hits = [...lexSource(snippet).code.matchAll(CLASS_RE)];
    expect(hits).toEqual([]);
  });
});
