import { describe, expect, it } from "vitest";
import { CODE_EXTENSIONS, findFiles, isTestPath, lexSource, lineAt, readRepoFile } from "./support/repo";

/**
 * The AI helper is a PRACTICE tool, and the promise that it is one has to
 * survive people who have never read this file.
 *
 * Three things are fenced here, each because it is the thing that would
 * quietly stop being true:
 *
 *   1. **Nothing in the exam or contest trees can reach the assistant.** A
 *      candidate was told nobody is helping them; a tab in the arena that
 *      imports `lib/ai/*` or the assistant components breaks that, and it
 *      breaks it in a way no test of behaviour would notice until somebody
 *      sat an exam.
 *
 *   2. **The provider is called from exactly one module.** `lib/ai/provider.ts`
 *      is the one place a student's code leaves this server. A second
 *      caller — a route handler, a worker, a "quick" admin tool — is a
 *      second place to audit, and nobody would know to audit it.
 *
 *   3. **The API key is never read outside the env schema and the provider.**
 *      A key read in a page, an action or a component is a key one render
 *      away from the browser.
 *
 * The practice-only RULE itself lives in `aiHelperAccess()` (@recx/shared)
 * and is enforced through the help chokepoint; this file fences the shape
 * that keeps the rule reachable from one place.
 */

/** Trees that serve a sitting nobody is supposed to be helped in. */
const SEALED = [
  "apps/web/src/app/(exam)",
  "apps/web/src/components/exam",
  "apps/web/src/app/(student)/contests",
  "apps/web/src/components/contests",
  "apps/web/src/lib/exam",
  "apps/web/src/lib/contests",
  "apps/judge-worker/src",
];

/** Anything that is, or reaches, the assistant. */
const AI_MODULE = /(^|[/@])(lib\/ai\/|components\/help\/assistant|actions\/ai-helper|actions\/super-ai)/;

interface Violation {
  readonly file: string;
  readonly line: number;
  readonly detail: string;
}

/** Every module specifier a file imports (static, re-export, dynamic, require). */
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

export function aiImports(file: string, source: string): Violation[] {
  const { code } = lexSource(source);
  return importSpecifiers(code)
    .filter(({ spec }) => AI_MODULE.test(spec))
    .map(({ spec, index }) => ({ file, line: lineAt(code, index), detail: spec }));
}

describe("detector self-test", () => {
  it.each([
    ['import { getAiRuntime } from "@/lib/ai/settings";'],
    ['import { AssistantPanel } from "@/components/help/assistant-panel";'],
    ['const m = await import("@/lib/ai/ask");'],
    ['export { askAiHelper } from "@/server/actions/ai-helper";'],
  ])("flags %s", (snippet) => {
    expect(aiImports("x.ts", snippet)).toHaveLength(1);
  });

  it.each([
    ['import { getHelpState } from "@/lib/help/access";'],
    ['// import { askProvider } from "@/lib/ai/provider";'],
    ['import { aiSomething } from "@/lib/aircraft";'],
  ])("ignores %s", (snippet) => {
    expect(aiImports("x.ts", snippet)).toEqual([]);
  });
});

describe("the AI helper cannot be reached from a proctored or rated sitting", () => {
  const files = findFiles({ under: SEALED, extensions: [...CODE_EXTENSIONS], exclude: isTestPath });

  it("scans the sealed trees (sanity)", () => {
    expect(files.length).toBeGreaterThan(40);
    expect(files.some((f) => f.startsWith("apps/web/src/app/(exam)"))).toBe(true);
    expect(files.some((f) => f.startsWith("apps/web/src/components/exam"))).toBe(true);
  });

  it("imports nothing from the assistant", () => {
    const found = files.flatMap((f) => aiImports(f, readRepoFile(f))).map((v) => `${v.file}:${v.line}  ${v.detail}`);
    expect(found).toEqual([]);
  });
});

describe("the provider has exactly one caller", () => {
  const PROVIDER = "apps/web/src/lib/ai/provider.ts";
  const CALLER = "apps/web/src/lib/ai/ask.ts";
  const files = findFiles({ under: ["apps", "packages", "scripts"], extensions: [...CODE_EXTENSIONS], exclude: isTestPath });

  it("is imported only by lib/ai/ask.ts", () => {
    const importers = files.filter((f) => {
      if (f === PROVIDER) return false;
      const { code } = lexSource(readRepoFile(f));
      return importSpecifiers(code).some(({ spec }) => /(^|[/@])lib\/ai\/provider$/.test(spec));
    });
    expect(importers).toEqual([CALLER]);
  });

  it("is the only module that posts to an AI endpoint", () => {
    const offenders = files
      .filter((f) => f !== PROVIDER)
      .flatMap((f) => {
        const { strings } = lexSource(readRepoFile(f));
        return strings
          .filter((s) => /api\.anthropic\.com|\/v1\/messages|chat\/completions/.test(s.body))
          .map((s) => `${f}:${s.start}`);
      });
    expect(offenders).toEqual([]);
  });
});

describe("the API key stays in the environment", () => {
  /** Where it is declared, and the one place its VALUE is used. */
  const ALLOWED = new Set(["apps/web/src/lib/env.ts", "apps/web/src/lib/ai/provider.ts"]);
  /**
   * May ask WHETHER a key is set, and nothing more. Both the super-admin
   * page and the practice page need that much in order to hide the
   * assistant on a deployment that has no key, rather than offer a button
   * that fails at the student.
   */
  const PRESENCE_ONLY = new Set(["apps/web/src/lib/ai/settings.ts"]);
  /**
   * Phase 12k. The SQL judge names the key in order to REFUSE to start if
   * it is in its environment — the opposite of reading it. It is listed
   * here rather than exempted silently, and the test below holds it to
   * naming and never reading.
   */
  const REFUSES = new Set(["apps/sql-judge/src/config.ts"]);
  const files = findFiles({ under: ["apps", "packages", "scripts"], extensions: [...CODE_EXTENSIONS], exclude: isTestPath });

  it("AI_API_KEY is read only where it is declared and where it is sent", () => {
    const offenders = files
      .filter((f) => !ALLOWED.has(f) && !PRESENCE_ONLY.has(f) && !REFUSES.has(f))
      .flatMap((f) => {
        const { code } = lexSource(readRepoFile(f));
        return [...code.matchAll(/\bAI_API_KEY\b/g)].map((m) => `${f}:${lineAt(code, m.index)}`);
      });
    expect(offenders).toEqual([]);
  });

  it("a file that refuses the key never reads it", () => {
    for (const f of REFUSES) {
      const { code } = lexSource(readRepoFile(f));
      expect(code, f).toContain("AI_API_KEY");
      // Named as a string in a list of keys to refuse, never dereferenced.
      expect(code, f).not.toMatch(/process\.env\.AI_API_KEY|env\.AI_API_KEY|env\[["']AI_API_KEY/);
      expect(code, f).toMatch(/FORBIDDEN_ENV_KEYS/);
    }
  });

  it("a presence-only file never touches the value", () => {
    for (const f of PRESENCE_ONLY) {
      const { code } = lexSource(readRepoFile(f));
      const mentions = [...code.matchAll(/.{0,16}\bAI_API_KEY\b/g)];
      expect(mentions.length, f).toBeGreaterThan(0);
      for (const match of mentions) {
        // Every mention negates it; none reads what it says.
        expect(match[0], `${f}:${lineAt(code, match.index)}`).toMatch(/!\s*[\w.]*AI_API_KEY$/);
      }
    }
  });

  it("each allowed file really mentions it (the allow-list stays honest)", () => {
    for (const f of ALLOWED) expect(readRepoFile(f), f).toContain("AI_API_KEY");
  });
});

describe("an AI answer makes a solve assisted", () => {
  it("the finaliser reads AiAssist, and the policy says yes", () => {
    const apply = readRepoFile("apps/web/src/lib/progress/apply.ts");
    expect(apply).toContain("aiAssist.findFirst");
    expect(apply).toContain("makesSolveAssisted({ ai: true })");
    // The rule itself, not a copy of it: a reader following the import
    // arrives at one function that decides for hints, editorials and this.
    expect(readRepoFile("packages/shared/src/help.ts")).toContain('"ai" in kind');
  });
});
