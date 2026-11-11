import { describe, expect, it } from "vitest";
import { CODE_EXTENSIONS, findFiles, isTestPath, lexSource, readRepoFile } from "./support/repo";

/**
 * The keymaps are self-hosted, optional, and cannot take the way out of
 * the editor (Phase 12j).
 *
 *   1. **Self-hosted, never a CDN.** Same reasoning as Monaco itself
 *      (`scripts/copy-monaco.mjs`): a strict CSP, a cold cross-origin cost
 *      on 3 Mbps campus wifi, and an exam LAN with no route off campus. A
 *      jsdelivr URL in here would work on the developer's machine and fail
 *      in the lab, which is the worst way for it to fail.
 *
 *   2. **Nobody pays for a keymap they do not use.** Both Monaco builds
 *      are fetched through Monaco's own AMD loader and both CodeMirror
 *      ones through a dynamic import, so neither is in a bundle and the
 *      size budgets do not move.
 *
 *   3. **The way out is above the editor.** `Esc` then `Tab` is handled on
 *      the wrapper in the CAPTURE phase, before Monaco, before CodeMirror
 *      and before any keymap — WCAG 2.1.2 is not a thing a preference may
 *      switch off.
 *
 *   4. **The proctored arena keeps the standard keys.** What the arena
 *      records about typing is defined in terms of CodeMirror's own
 *      transaction origins; a keymap's register commands are a paste path
 *      those origins do not describe.
 */

const COPY_SCRIPT = "apps/web/scripts/copy-monaco.mjs";
const MONACO_KEYMAP = "apps/web/src/components/editor/monaco-keymap.ts";
const CODEMIRROR = "apps/web/src/components/editor/codemirror.ts";
const CODE_EDITOR = "apps/web/src/components/editor/code-editor.tsx";
const EXAM_QUESTION = "apps/web/src/components/exam/exam-question.tsx";
const POLICY = "packages/shared/src/editor-keymap.ts";

const WEB_FILES = findFiles({ under: ["apps/web/src"], extensions: [...CODE_EXTENSIONS], exclude: isTestPath });

describe("self-hosted, never a CDN", () => {
  it("the copy script self-hosts both Monaco keymap builds", () => {
    const script = readRepoFile(COPY_SCRIPT);
    expect(script).toContain("monaco-vim");
    expect(script).toContain("monaco-emacs");
    expect(script).toContain("keymaps");
  });

  it("the loader asks for them under /monaco/keymaps and nowhere else", () => {
    const source = readRepoFile(MONACO_KEYMAP);
    expect(source).toContain("/monaco/keymaps/monaco-vim");
    expect(source).toContain("/monaco/keymaps/monaco-emacs");
  });

  it("no file names a CDN for a keymap, an editor or anything else", () => {
    const hosts = ["cdn.jsdelivr.net", "unpkg.com", "cdnjs.cloudflare.com", "esm.sh", "skypack.dev"];
    const offenders: string[] = [];
    for (const file of [...WEB_FILES, COPY_SCRIPT, POLICY]) {
      const source = readRepoFile(file);
      for (const host of hosts) {
        if (source.includes(host)) offenders.push(`${file}: ${host}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("nobody pays for a keymap they do not use", () => {
  it("no module imports a keymap package at the top level", () => {
    const packages = ["monaco-vim", "monaco-emacs", "@replit/codemirror-vim", "@replit/codemirror-emacs"];
    const offenders: string[] = [];
    for (const file of WEB_FILES) {
      const { code } = lexSource(readRepoFile(file));
      for (const name of packages) {
        // A static `import … from "monaco-vim"` would put it in a bundle;
        // `await import("…")` and the AMD loader's string id would not.
        const statically = new RegExp(`(^|\\n)\\s*import[^;]*from\\s*["']${name.replace("/", "\\/")}["']`);
        if (statically.test(code)) offenders.push(`${file}: ${name}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the CodeMirror keymaps are dynamic imports", () => {
    const { code } = lexSource(readRepoFile(CODEMIRROR));
    expect(code).toContain('await import("@replit/codemirror-vim")');
    expect(code).toContain('await import("@replit/codemirror-emacs")');
  });

  it("the standard keymap fetches nothing", () => {
    const policy = readRepoFile(POLICY);
    expect(policy).toContain("DEFAULT: null");
  });
});

describe("the way out is above the editor", () => {
  it("the escape hatch is a capture-phase listener on the wrapper, for both editors", () => {
    const { code } = lexSource(readRepoFile(CODE_EDITOR));
    // The third argument is `true`: capture, so it runs before anything
    // inside the editor, whatever a keymap binds.
    expect(code).toContain('wrapper.addEventListener("keydown", onKeyDown, true)');
    // Phase 12j removed the Monaco-only gate; a CodeMirror mount gets the
    // same way out, because a keymap binds Esc there too.
    expect(code).not.toContain('kind !== "monaco"');
  });

  it("the note beside the editor always leads with the way out", () => {
    const policy = readRepoFile(POLICY);
    expect(policy).toContain("Esc then Tab leaves the editor");
  });
});

describe("the proctored arena keeps the standard keys", () => {
  it("the exam editor is handed DEFAULT whatever the candidate prefers", () => {
    const { code } = lexSource(readRepoFile(EXAM_QUESTION));
    expect(code).toContain('keymap: "DEFAULT"');
    // And it is still pinned to CodeMirror, for the telemetry.
    expect(code).toContain('forceKind="codemirror"');
  });

  it("and says so on the page when the candidate has one set", () => {
    const { code } = lexSource(readRepoFile(EXAM_QUESTION));
    expect(code).toContain("EDITOR_KEYMAP_NOTICES.examDefault");
  });
});
