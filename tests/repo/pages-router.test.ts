import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { abs, lexSource, readRepoFile } from "./support/repo";

/**
 * The Pages Router is an exception with one purpose (docs/ARCHITECTURE.md):
 * a sign-in page that ships NO JavaScript. Everything else lives in the App
 * Router (apps/web/src/app). This keeps it that way: src/pages holds only
 * the document, the app shell and /login, and /login keeps
 * `unstable_runtimeJS: false`. (scripts/size-budget.mjs proves the zero-JS
 * claim on the served HTML of every production build.)
 */
const PAGES_DIR = "apps/web/src/pages";

/** Every file under a directory, relative to it, with "/" separators. */
function walk(dirRel: string, prefix = ""): string[] {
  return readdirSync(abs(dirRel), { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? walk(`${dirRel}/${entry.name}`, `${prefix}${entry.name}/`) : [`${prefix}${entry.name}`],
  );
}

describe("Pages Router: only the zero-JS sign-in page", () => {
  it(`${PAGES_DIR} contains only _app.tsx, _document.tsx and login.tsx`, () => {
    expect(walk(PAGES_DIR).sort()).toEqual(["_app.tsx", "_document.tsx", "login.tsx"]);
  });

  it("login.tsx exports config with unstable_runtimeJS: false (and nothing turns it back on)", () => {
    // Comments stripped, so a commented-out config does not count.
    const { code } = lexSource(readRepoFile(`${PAGES_DIR}/login.tsx`));
    const configs = [...code.matchAll(/export\s+const\s+config\b[^=]*=\s*\{([^}]*)\}/g)];
    expect(configs, "exactly one exported config").toHaveLength(1);
    const body = configs[0]![1]!;
    expect(body).toMatch(/^\s*unstable_runtimeJS\s*:\s*false\s*,?\s*$/);
  });

  it("no page in src/pages but login.tsx (the document and app shell are not routes)", () => {
    for (const file of ["_app.tsx", "_document.tsx"]) {
      const { code } = lexSource(readRepoFile(`${PAGES_DIR}/${file}`));
      expect(code, `${file} has no data fetching of a page`).not.toMatch(/export\s+(?:async\s+)?(?:const|function)\s+getServerSideProps\b/);
    }
  });
});
