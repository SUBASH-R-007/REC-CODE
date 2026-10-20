import { describe, expect, it } from "vitest";
import { CODE_EXTENSIONS, findFiles, lexSource, lineAt, readRepoFile } from "./support/repo";

/**
 * The exam shell imports nothing from the app shell.
 *
 * SPEC §5: "Own route group (exam) with its own layout importing nothing from
 * the app shell: no sidebar, no bottom bar, no search, no command palette, no
 * notifications, no leaderboard, no XP chip, no theme toggle (fixed at start
 * so there is no mid-exam repaint), no outbound links except an in-page
 * 'Report a problem' dialog."
 *
 * Each of those is a way out of the exam, a distraction, or a repaint
 * mid-question. The rule is easy to state and easy to break by accident: the
 * natural thing for a contributor adding a page under `(exam)` is to reach
 * for `AppShell`, which brings a sidebar with a leaderboard link in it.
 *
 * So the check is static, and it is about IMPORTS rather than about rendered
 * output, because an import is what a reviewer can see in a diff.
 */

const EXAM_UNDER = ["apps/web/src/app/(exam)", "apps/web/src/components/exam"];

/** Modules the exam tree must not reach, and why each one matters. */
const FORBIDDEN: ReadonlyArray<{ readonly pattern: RegExp; readonly why: string }> = [
  { pattern: /components\/shell\//, why: "the app shell brings the sidebar, search and nav" },
  { pattern: /app-shell/, why: "the app shell brings the sidebar, search and nav" },
  { pattern: /components\/nav\//, why: "navigation is a way out of the exam" },
  { pattern: /command-palette/, why: "a command palette is a way out of the exam" },
  { pattern: /components\/search\//, why: "search is a way out of the exam" },
  { pattern: /notifications?/, why: "notifications interrupt a sitting" },
  { pattern: /leaderboard/, why: "no leaderboard inside an exam" },
  { pattern: /theme-toggle|theme-switch/, why: "the theme is fixed at start: no mid-exam repaint" },
  { pattern: /\bxp\b|xp-chip/, why: "no XP chip inside an exam" },
  { pattern: /impersonation/, why: "an impersonated session cannot sit an exam" },
  /**
   * Phase 10d. A locked-down page should make exactly the requests its own
   * protocol describes: a beacon leaving an attempt is something an
   * invigilator would have to explain, and a student watching the network
   * tab during an exam should see nothing they cannot account for. The
   * reporter is mounted in the app shell, which the exam tree already
   * cannot reach — this entry is here so that stays true if somebody moves
   * it to the root layout.
   */
  { pattern: /vitals|web-vitals/, why: "no field-vitals beacon leaves a proctored attempt" },
];

interface Violation {
  readonly file: string;
  readonly line: number;
  readonly spec: string;
  readonly why: string;
}

/** Every module specifier a file imports (static imports, re-exports, dynamic). */
function importSpecifiers(code: string): Array<{ spec: string; index: number }> {
  const out: Array<{ spec: string; index: number }> = [];
  const patterns = [
    /\bimport\s+[^;'"]*?from\s*["']([^"']+)["']/g,
    /\bimport\s*["']([^"']+)["']/g,
    /\bexport\s+[^;'"]*?from\s*["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of code.matchAll(pattern)) out.push({ spec: match[1]!, index: match.index ?? 0 });
  }
  return out;
}

function scan(): Violation[] {
  const out: Violation[] = [];
  for (const rel of findFiles({ extensions: CODE_EXTENSIONS, under: EXAM_UNDER })) {
    const src = readRepoFile(rel);
    const { code } = lexSource(src);
    for (const { spec, index } of importSpecifiers(code)) {
      for (const rule of FORBIDDEN) {
        if (rule.pattern.test(spec)) {
          out.push({ file: rel, line: lineAt(src, index), spec, why: rule.why });
        }
      }
    }
  }
  return out;
}

describe("the exam shell is isolated from the app shell", () => {
  it("finds the exam tree (sanity)", () => {
    const files = findFiles({ extensions: CODE_EXTENSIONS, under: EXAM_UNDER });
    expect(files.length).toBeGreaterThan(3);
    expect(files).toContain("apps/web/src/app/(exam)/layout.tsx");
  });

  it("imports nothing from the app shell, nav, search, notifications or the leaderboard", () => {
    const report = scan().map((v) => `${v.file}:${v.line} — imports "${v.spec}": ${v.why}`);
    expect(report).toEqual([]);
  });

  it("catches each forbidden import it is meant to catch", () => {
    const snippets = [
      'import { AppShell } from "@/components/shell/app-shell";',
      'import { CommandPalette } from "@/components/command-palette";',
      'import { ThemeToggle } from "@/components/theme-toggle";',
      'export { Nav } from "@/components/nav/nav";',
      'const m = await import("@/components/search/search-dialog");',
    ];
    for (const snippet of snippets) {
      const { code } = lexSource(snippet);
      const specs = importSpecifiers(code).map((s) => s.spec);
      expect(specs.length, snippet).toBeGreaterThan(0);
      const hit = specs.some((spec) => FORBIDDEN.some((rule) => rule.pattern.test(spec)));
      expect(hit, snippet).toBe(true);
    }
  });

  it("allows what the exam tree legitimately needs", () => {
    const fine = [
      'import { requireUser } from "@/lib/auth/guards";',
      'import { formatClock } from "@recx/shared";',
      'import { Check } from "lucide-react";',
      'import { Button } from "@recx/design";',
      'import { guardAttempt } from "@/lib/exam/attempt";',
    ];
    for (const snippet of fine) {
      const specs = importSpecifiers(lexSource(snippet).code).map((s) => s.spec);
      const hit = specs.some((spec) => FORBIDDEN.some((rule) => rule.pattern.test(spec)));
      expect(hit, snippet).toBe(false);
    }
  });

  it("the exam layout does not render the shared AppShell", () => {
    // The lexed code, not the raw file: the layout's own comment names
    // AppShell to explain why it is not used, and that prose is the point.
    const { code } = lexSource(readRepoFile("apps/web/src/app/(exam)/layout.tsx"));
    expect(code).not.toMatch(/AppShell/);
  });
});
