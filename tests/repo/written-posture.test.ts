import { describe, expect, it } from "vitest";
import { CODE_EXTENSIONS, findFiles, isTestPath, lexSource, readRepoFile } from "./support/repo";

/**
 * What a written mark is, and what it is not (Phase 12i).
 *
 *   1. **It feeds nothing.** Not XP, not the leaderboard, not readiness,
 *      not a band. A weighted percentage from one TA reading one answer
 *      is exactly that; the moment it reached a number students compete
 *      on, it would be optimised from one end and inflated from the
 *      other. The fence is on the import graph, where a scoring module
 *      would have to reach for the table first.
 *
 *   2. **A student's prose is untrusted markdown.** A question is a TA's
 *      and renders with the trusted renderer; an ANSWER is a student's,
 *      read by a member of staff on a page in the staff tree, and
 *      renders with `renderUntrustedMarkdown`. This is the same line the
 *      discussion board draws, and it matters more here: the reader is
 *      signed in with a mentor's session.
 *
 *   3. **Nothing in a request path deletes an answer.** Retiring a
 *      question hides it and keeps the work; there is no path that
 *      removes somebody's writing, as there is none that removes a
 *      student.
 *
 *   4. **Every write is parsed at the boundary.** The library takes
 *      `unknown` and parses it, so a shape no form sends cannot reach a
 *      column.
 */

const LIB = "apps/web/src/lib/written/answers.ts";
const QUERIES = "apps/web/src/server/queries/written.ts";
const SCHEMA = "apps/web/src/lib/written/schema.ts";
const POLICY = "packages/shared/src/written.ts";

const WEB_FILES = findFiles({ under: ["apps/web/src"], extensions: [...CODE_EXTENSIONS], exclude: isTestPath });

describe("a mark feeds nothing", () => {
  /** Where a number that counted for something would have to be read. */
  const SCORING = [
    "apps/web/src/lib/progress",
    "apps/web/src/lib/readiness",
    "apps/web/src/server/queries/leaderboard",
    "apps/web/src/server/queries/readiness",
    "packages/shared/src/xp.ts",
    "packages/shared/src/readiness.ts",
    "packages/db/src/readiness.ts",
  ];

  it("no scoring, XP, readiness or leaderboard module touches the written tables", () => {
    const files = findFiles({
      under: ["apps/web/src", "packages/shared/src", "packages/db/src"],
      extensions: [...CODE_EXTENSIONS],
      exclude: isTestPath,
    }).filter((file) => SCORING.some((prefix) => file.startsWith(prefix)));
    expect(files.length).toBeGreaterThan(3);

    const offenders = files.filter((file) => /writtenAnswer|writtenMark|WrittenAnswer|WrittenMark/.test(readRepoFile(file)));
    expect(offenders).toEqual([]);
  });

  it("the policy module says so, in the words the pages show", () => {
    const notice = readRepoFile(POLICY);
    expect(notice).toContain("gradingCountsForNothing");
    for (const thing of ["XP", "leaderboard", "readiness", "recruiter"]) {
      expect(notice, `the notice must name ${thing}`).toContain(thing);
    }
  });

  it("the policy module is pure: no database, no clock, no network", () => {
    const source = readRepoFile(POLICY);
    for (const name of ["server-only", "@/lib/db", "fetch(", "Date.now(", "new Date("]) {
      expect(source, `the policy must not use ${name}`).not.toContain(name);
    }
  });
});

describe("a student's prose is untrusted markdown", () => {
  it("the grading read renders the answer with the untrusted renderer", () => {
    const source = readRepoFile(QUERIES);
    expect(source).toContain("renderUntrustedMarkdown(row.bodyMd)");
    // And the question, which a TA wrote, with the trusted one.
    expect(source).toContain("renderMarkdown(row.promptMd)");
  });

  it("no page renders a raw answer body as HTML", () => {
    const offenders = WEB_FILES.filter((file) => {
      const { code } = lexSource(readRepoFile(file));
      return /dangerouslySetInnerHTML[^}]*bodyMd/.test(code);
    });
    expect(offenders).toEqual([]);
  });
});

describe("nothing deletes an answer", () => {
  it("no request path hard-deletes an answer, a mark's parent or a question", () => {
    const offenders: string[] = [];
    for (const file of WEB_FILES) {
      const { code } = lexSource(readRepoFile(file));
      for (const call of ["writtenAnswer.delete", "writtenAnswer.deleteMany", "writtenPrompt.delete", "writtenPrompt.deleteMany"]) {
        if (code.includes(call)) offenders.push(`${file}: ${call}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("retiring is a status change, and keeps what was written", () => {
    const source = readRepoFile(LIB);
    expect(source).toContain('status: "RETIRED"');
    // The only delete in the library is the mark rewrite inside the grade
    // transaction, which replaces this grader's own marks on this answer.
    const deletes = [...source.matchAll(/db\.(\w+)\.deleteMany/g)].map((m) => m[1]);
    expect(deletes).toEqual(["writtenMark"]);
  });
});

describe("every write is parsed at the boundary", () => {
  it("each exported library function parses its input with a schema", () => {
    const source = readRepoFile(LIB);
    const exported = [...source.matchAll(/export async function (\w+)/g)].map((m) => m[1]!);
    expect(exported.length).toBeGreaterThanOrEqual(7);

    for (const name of exported) {
      const start = source.indexOf(`export async function ${name}`);
      const next = exported
        .map((other) => source.indexOf(`export async function ${other}`))
        .filter((index) => index > start)
        .sort((a, b) => a - b)[0];
      const body = source.slice(start, next === undefined ? source.length : next);
      expect(body, `${name} must parse its input`).toMatch(/Schema\.parse\(/);
    }
  });

  it("every schema is strict, so an unexpected key is refused rather than dropped", () => {
    const source = readRepoFile(SCHEMA);
    const objects = (source.match(/z\s*\n?\s*\.object\(|z\.object\(/g) ?? []).length;
    const stricts = (source.match(/\.strict\(\)/g) ?? []).length;
    expect(stricts).toBe(objects);
  });
});
