import { describe, expect, it } from "vitest";
import { CODE_EXTENSIONS, findFiles, isTestPath, lexSource, lineAt, readRepoFile } from "./support/repo";

/**
 * A measured growth class is a decoration on a verdict, and must stay one
 * (Phase 17).
 *
 * `docs/COMPLEXITY.md` §9 makes four promises that a code review cannot
 * keep, because each is about where a name does NOT appear. This is the
 * static half; `apps/web/test/solution-standing.db.test.ts` is the
 * behavioural one.
 *
 *   R1 — nothing that counts reads the estimate. `timeComplexity`,
 *        `spaceComplexity` and `complexityDetail` may not be named anywhere
 *        in the scoring, XP, progress, contest, exam, readiness or placement
 *        paths — and the files that MAY name them are listed, so the rule
 *        cannot be satisfied by deleting the feature. A fitted curve that
 *        could move a mark would be a signal with a consequence, measured
 *        off timings this project refuses to promise are deterministic
 *        (SPEC §7). Same shape as "do not let the banding engine import or
 *        write to the scoring path".
 *
 *   R2 — the fit happens in exactly one place in the web app.
 *        `estimateComplexity` needs each case's input size, and the sizes of
 *        a frozen version's HIDDEN cases are readable only from the judge and
 *        admin paths (student-exposure R3 and R5). Calling it anywhere else
 *        would mean either widening that fence or fitting a curve through the
 *        sample cases alone, which is three points and a wrong answer.
 *
 *   R3 — there is no O(1) rung, and the flat-curve refusal does not imply
 *        one. "No growth we can see" and "constant time" are different
 *        statements and only the first one is true.
 *
 *   R4 — the two population floors stay distinct, with the reason beside
 *        them. `MIN_RANKED_PEERS` guards a figure about code and
 *        `MIN_PERCENTILE_COHORT` a figure about a person; tidying them into
 *        one constant would lose the reason either exists.
 *
 * The constants are read as TEXT, like every other fence here: `tests/repo`
 * has no dependency on the workspace packages on purpose, so that a fence
 * cannot be made to pass by changing what a module exports.
 */

const WEB_SRC = "apps/web/src";
const COMPLEXITY = "packages/shared/src/complexity.ts";
const STANDING = "packages/shared/src/solution-standing.ts";
const PERCENTILE = "packages/shared/src/percentile.ts";

/** The three stored columns, as they are spelt in code. */
const ESTIMATE_FIELDS = ["timeComplexity", "spaceComplexity", "complexityDetail"] as const;

/** Names only the module doing the fitting may call. */
const FITTING_CALLS = ["estimateComplexity", "complexitySamplesOf"] as const;

/**
 * Paths where a mark, a point, a rank or an eligibility decision is made.
 * Named by tree so a new file under any of them is covered on the day it is
 * written, which is the only way this rule survives.
 */
const COUNTS_FOR_SOMETHING = [
  `${WEB_SRC}/lib/progress`,
  `${WEB_SRC}/lib/contests`,
  `${WEB_SRC}/lib/exam`,
  `${WEB_SRC}/lib/readiness`,
  `${WEB_SRC}/lib/placement`,
  `${WEB_SRC}/lib/integrity`,
];

/** And the query and action modules named for those surfaces. */
const COUNTS_BY_NAME = /\/(?:readiness|placement|mentor|leaderboard|contest|my-assessment)[^/]*\.ts$/;

/** The files allowed to name the stored columns, each for one reason. */
const MAY_NAME_THE_ESTIMATE: Readonly<Record<string, string>> = {
  [`${WEB_SRC}/lib/judge/finalize.ts`]: "writes them: the only path that may read a hidden case's input size",
  [`${WEB_SRC}/server/queries/submissions.ts`]: "reads the detail for the submission page",
  [`${WEB_SRC}/server/queries/solution-standing.ts`]: "reads the class for the peer distribution",
};

function filesNaming(names: readonly string[], under: readonly string[]): string[] {
  return findFiles({ under: [...under], extensions: CODE_EXTENSIONS, exclude: isTestPath }).filter((file) => {
    // Comments never count: a comment saying a mark ignores the estimate is
    // exactly what this rule wants somebody to write.
    const { code } = lexSource(readRepoFile(file));
    return names.some((name) => code.includes(name));
  });
}

/** `export const NAME = 42;` out of a shared module, read as text. */
function constantOf(file: string, name: string): number {
  const match = new RegExp(`export const ${name}\\s*(?::\\s*number\\s*)?=\\s*(\\d+)`).exec(readRepoFile(file));
  expect(match, `${name} in ${file}`).not.toBeNull();
  return Number(match![1]);
}

function scoringFiles(): string[] {
  const trees = findFiles({ under: COUNTS_FOR_SOMETHING, extensions: CODE_EXTENSIONS, exclude: isTestPath });
  const byName = findFiles({
    under: [`${WEB_SRC}/server/queries`, `${WEB_SRC}/server/actions`],
    extensions: [".ts"],
    exclude: isTestPath,
  }).filter((f) => COUNTS_BY_NAME.test(f));
  return [...new Set([...trees, ...byName])].sort();
}

describe("Phase 17: measured growth stays a decoration", () => {
  it("looks at the files it claims to (sanity)", () => {
    const files = scoringFiles();
    expect(files.length).toBeGreaterThan(10);
    expect(files).toContain(`${WEB_SRC}/lib/progress/apply.ts`);
    expect(files).toContain(`${WEB_SRC}/lib/exam/submit.ts`);
  });

  it("R1 no scoring, XP, contest, exam, readiness or placement path names the estimate", () => {
    const findings: string[] = [];
    for (const file of scoringFiles()) {
      const source = readRepoFile(file);
      const { code } = lexSource(source);
      for (const field of ESTIMATE_FIELDS) {
        const at = code.indexOf(field);
        if (at >= 0) findings.push(`${file}:${lineAt(source, at)} names ${field}`);
      }
    }
    expect(
      findings,
      "A fitted growth class may not reach a mark, a point, a rank or an eligibility decision (docs/COMPLEXITY.md §9).",
    ).toEqual([]);
  });

  it("R1 and only the three listed files name it at all", () => {
    expect(filesNaming(ESTIMATE_FIELDS, [WEB_SRC]).sort()).toEqual(Object.keys(MAY_NAME_THE_ESTIMATE).sort());
  });

  it("R2 only the finalise path fits a curve", () => {
    expect(
      filesNaming(FITTING_CALLS, [WEB_SRC]),
      "The fit needs every case's input size, which only the judge path may read (docs/COMPLEXITY.md §7).",
    ).toEqual([`${WEB_SRC}/lib/judge/finalize.ts`]);
  });

  it("R3 there is no constant-time rung", () => {
    const source = readRepoFile(COMPLEXITY);
    const ladder = /export const COMPLEXITY_CLASSES = \[([^\]]*)\]/.exec(source);
    expect(ladder, "COMPLEXITY_CLASSES").not.toBeNull();
    const classes = [...ladder![1]!.matchAll(/"([A-Z_]+)"/g)].map((m) => m[1]!);
    expect(classes.length).toBeGreaterThan(3);
    expect(classes).not.toContain("CONSTANT");
  });

  it("R3 and the flat-curve refusal does not imply one", () => {
    const source = readRepoFile(COMPLEXITY);
    const sentence = /GROWTH_BELOW_NOISE:\s*\n?\s*"([^"]+)"/.exec(source);
    expect(sentence, "the GROWTH_BELOW_NOISE sentence").not.toBeNull();
    expect(sentence![1]!).not.toMatch(/constant|O\(1\)/i);
    expect(sentence![1]!.length).toBeGreaterThan(40);
  });

  it("R4 the code floor and the person floor are different numbers with different reasons", () => {
    const peers = constantOf(STANDING, "MIN_RANKED_PEERS");
    const cohort = constantOf(PERCENTILE, "MIN_PERCENTILE_COHORT");
    expect(peers).toBeLessThan(cohort);
    // The reason has to be written where the number is, or the next reader
    // will tidy the two into one constant.
    expect(readRepoFile(STANDING)).toContain("MIN_PERCENTILE_COHORT");
  });
});
