import { describe, expect, it } from "vitest";
import { CODE_EXTENSIONS, findFiles, lexSource, lineAt, readRepoFile } from "./support/repo";

/**
 * The answer key never reaches a student before they have answered.
 *
 * `correctOptionIndexes`, `numericAnswer`, `numericTolerance` and
 * `explanation` are a new class of student-unreachable data, and the Phase 4
 * student-exposure fence knows nothing about these columns. So Phase 7 adds
 * this one, in its own file (no collision with the existing fence) with its
 * own rule:
 *
 *   every `aptitudeQuestion` read in a student-reachable module selects
 *   through `APTITUDE_PUBLIC_SELECT`, unless the module is on the short list
 *   of paths that may legitimately see the key — and each of those names the
 *   reason it may.
 *
 * Why a static fence and not a careful component: the key would be in the
 * page's serialised props, which is a view-source away. A component that
 * does not render it is not a component that does not ship it.
 *
 * The live half is in `apps/web/test/` (a canary asserting the practice and
 * sitting queries come back without those fields); this half is the one that
 * fails when somebody adds a sixth query next year.
 */

const KEY_FIELDS = ["correctOptionIndexes", "numericAnswer", "numericTolerance", "explanation"] as const;

/** The only paths that may select the key, and why each one may. */
const MAY_SEE_THE_KEY: ReadonlyArray<{ readonly path: string; readonly why: string }> = [
  {
    path: "apps/web/src/server/queries/aptitude-select.ts",
    why: "it is where APTITUDE_ANSWER_SELECT is defined",
  },
  {
    path: "packages/db/src/mock.ts",
    why: "grading compares a response to the key on the server; the result reaches a student, the key does not",
  },
  {
    path: "apps/web/src/lib/aptitude/practice.ts",
    why: "a practice answer is committed and THEN the working is returned, which is the whole point of the phase",
  },
];

/**
 * Staff authoring modules are not on the list because they are not
 * student-reachable at all: the `admin-` and `super-` filename prefixes are
 * what carry the sensitive-path rule (`docs/CONVENTIONS.md`), and
 * `studentReachableFiles()` below excludes them by that prefix. A staff
 * module that forgets the prefix fails `tests/repo/student-exposure.test.ts`
 * first.
 *
 * The review of a FINALISED sitting will need `APTITUDE_ANSWER_SELECT` when
 * slice 7e builds it. It goes on this list THEN, with the reason it may —
 * adding it in advance would exempt a file nobody has written.
 */

const EXEMPT = new Set(MAY_SEE_THE_KEY.map((entry) => entry.path));

/** Every module that a student's request can reach. */
function studentReachableFiles(): string[] {
  return findFiles({
    extensions: CODE_EXTENSIONS,
    under: [
      "apps/web/src/app/(student)",
      "apps/web/src/app/(exam)",
      "apps/web/src/app/api/aptitude",
      "apps/web/src/components",
      "apps/web/src/lib/aptitude",
      "apps/web/src/server/actions",
      "apps/web/src/server/queries",
    ],
  }).filter((file) => {
    // Staff modules carry the admin-/super- prefix by convention
    // (docs/CONVENTIONS.md, "Sensitive paths") and are not student-reachable.
    const base = file.split("/").pop() ?? "";
    return !base.startsWith("admin-") && !base.startsWith("super-") && !file.includes("/admin/") && !file.includes("/super/");
  });
}

/** `aptitudeQuestion` reads in a file, with the line each one is on. */
function aptitudeQuestionReads(code: string): number[] {
  const stripped = lexSource(code).code;
  const out: number[] = [];
  for (const match of stripped.matchAll(/\.aptitudeQuestion\s*\.\s*(findMany|findFirst|findUnique|findUniqueOrThrow|findFirstOrThrow|count|aggregate)\s*\(/g)) {
    out.push(match.index ?? 0);
  }
  return out;
}

describe("the aptitude answer key is not student-reachable", () => {
  const files = studentReachableFiles();

  it("finds the student tree at all (sanity)", () => {
    expect(files.length).toBeGreaterThan(20);
    expect(files).toContain("apps/web/src/lib/aptitude/sitting.ts");
  });

  it("names a reason for every exemption", () => {
    // An exemption without a reason is an exemption nobody can review.
    for (const entry of MAY_SEE_THE_KEY) {
      expect(entry.why.length, entry.path).toBeGreaterThan(20);
    }
  });

  it("every exempted path exists, so the list cannot rot into a free pass", () => {
    // A path that no longer exists exempts nothing today and would exempt
    // whatever a future slice puts there.
    const present = new Set(findFiles({ extensions: CODE_EXTENSIONS }));
    for (const entry of MAY_SEE_THE_KEY) {
      expect(present.has(entry.path), `${entry.path} is exempted but does not exist`).toBe(true);
    }
  });

  it("no student-reachable module selects a key field", () => {
    const problems: string[] = [];
    for (const file of files) {
      if (EXEMPT.has(file)) continue;
      const source = readRepoFile(file);
      const stripped = lexSource(source).code;
      for (const field of KEY_FIELDS) {
        // `field: true` inside a select, which is the only way a Prisma read
        // asks for a column.
        for (const match of stripped.matchAll(new RegExp(`\\b${field}\\s*:\\s*true\\b`, "g"))) {
          problems.push(`${file}:${lineAt(source, match.index ?? 0)} selects ${field}`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it("every student-reachable aptitudeQuestion read goes through a named select", () => {
    // Not "does not select the key" — that is the test above. This one is
    // stronger: a read with an inline `select` is how the key gets added one
    // field at a time, so the select has to be one of the two constants.
    const problems: string[] = [];
    for (const file of files) {
      if (EXEMPT.has(file)) continue;
      const source = readRepoFile(file);
      const reads = aptitudeQuestionReads(source);
      if (reads.length === 0) continue;
      const usesNamedSelect =
        /APTITUDE_PUBLIC_SELECT|APTITUDE_ANSWER_SELECT|APTITUDE_POOL_SELECT/.test(source) ||
        // A read that asks for nothing but ids and scalars with no select at
        // all would return every column, key included.
        false;
      if (!usesNamedSelect) {
        for (const index of reads) {
          problems.push(`${file}:${lineAt(source, index)} reads aptitudeQuestion without a named select`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it("the public select names none of the key fields", () => {
    const source = readRepoFile("apps/web/src/server/queries/aptitude-select.ts");
    const publicBlock = /APTITUDE_PUBLIC_SELECT = \{([\s\S]*?)\} as const;/.exec(source)?.[1] ?? "";
    expect(publicBlock.length).toBeGreaterThan(50);
    for (const field of KEY_FIELDS) {
      expect(publicBlock, `APTITUDE_PUBLIC_SELECT must not select ${field}`).not.toContain(field);
    }
  });

  it("the answer select names all four, so the two are genuinely different", () => {
    const source = readRepoFile("apps/web/src/server/queries/aptitude-select.ts");
    const answerBlock = /APTITUDE_ANSWER_SELECT = \{([\s\S]*?)\} as const;/.exec(source)?.[1] ?? "";
    for (const field of KEY_FIELDS) {
      expect(answerBlock, `APTITUDE_ANSWER_SELECT selects ${field}`).toContain(field);
    }
  });
});
