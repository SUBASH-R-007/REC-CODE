import { describe, expect, it } from "vitest";
import { CODE_EXTENSIONS, findFiles, lexSource, lineAt, readRepoFile } from "./support/repo";

/**
 * The integrity module cannot reach a score.
 *
 * SPEC §5 asks for this test by name:
 *
 *   Triage banding — structurally unable to touch a score [...] Scores are
 *   written by the judge; no code path from the banding engine reaches a
 *   score column. Add a unit test that fails if the integrity module imports
 *   or writes to anything in the scoring path.
 *
 * And the reason, from the same section:
 *
 *   The maximum automatic consequence in the entire system is: flag for
 *   review and withhold the result from the public leaderboard [...] Never
 *   display a band or an "integrity score" to students or recruiters — it
 *   invites exactly the misreading we are preventing, and penalises the
 *   honest student with the bad laptop while the competent cheater scores a
 *   clean 0.
 *
 * So the fence has two halves: the integrity code may not WRITE a score, and
 * it may not even reach the modules that do. The second half is the one that
 * matters in a year's time, when somebody adds "and dock two marks" to a
 * review handler and finds the import already there.
 */

/** Everything that decides or stores what a student scored. */
const SCORING_MODELS = [
  "submission",
  "submissionTest",
  "contestStanding",
  "contestProblemAttempt",
  "ratingChange",
  "xpEvent",
  "xpBucket",
  "userStats",
  "userProblemStatus",
  "problemStat",
  "studyPlanEnrollment",
];

/** Columns that are a score, wherever they appear. */
const SCORE_COLUMNS = ["totalScore", "maxScore", "score", "penalty", "solved", "rank", "rating", "xp", "integrityScore"];

/** Modules the integrity code may not import. */
const FORBIDDEN_IMPORTS: ReadonlyArray<{ readonly pattern: RegExp; readonly why: string }> = [
  { pattern: /lib\/judge\//, why: "the judge writes scores" },
  { pattern: /judge\/finalize/, why: "the judge writes scores" },
  { pattern: /lib\/contests\//, why: "contest standings are scores" },
  { pattern: /lib\/progress\//, why: "XP and streaks are scores" },
  { pattern: /\bxp\b/, why: "XP is a score" },
  { pattern: /server\/actions\/judge/, why: "the judge writes scores" },
  { pattern: /rating/, why: "a rating is a score" },
];

/** Where the integrity code lives. */
const INTEGRITY_UNDER = [
  "apps/web/src/lib/integrity",
  "apps/web/src/server/queries/integrity",
  "apps/web/src/server/actions/integrity",
  "packages/shared/src/triage.ts",
];

function integrityFiles(): string[] {
  const dirs = findFiles({
    extensions: CODE_EXTENSIONS,
    under: INTEGRITY_UNDER.filter((p) => !p.endsWith(".ts")),
  });
  const singles = INTEGRITY_UNDER.filter((p) => p.endsWith(".ts"));
  return [...dirs, ...singles];
}

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

/** `db.<model>.<write>(` for any scoring model. */
const WRITE_METHODS = ["create", "createMany", "update", "updateMany", "upsert", "delete", "deleteMany"];

function scoringWrites(code: string): Array<{ index: number; what: string }> {
  const out: Array<{ index: number; what: string }> = [];
  for (const model of SCORING_MODELS) {
    const pattern = new RegExp(`\\.${model}\\s*\\.\\s*(${WRITE_METHODS.join("|")})\\s*\\(`, "g");
    for (const match of code.matchAll(pattern)) {
      out.push({ index: match.index ?? 0, what: `${model}.${match[1]}()` });
    }
  }
  // A raw write that names a scoring table.
  for (const match of code.matchAll(/\$executeRaw(?:Unsafe)?/g)) {
    out.push({ index: match.index ?? 0, what: "$executeRaw" });
  }
  return out;
}

function scoreColumnWrites(code: string): Array<{ index: number; what: string }> {
  const out: Array<{ index: number; what: string }> = [];
  for (const column of SCORE_COLUMNS) {
    // `totalScore:` inside an object literal is a write; `row.totalScore` is
    // a read and is fine (a reviewer's screen may legitimately show nothing
    // of the sort, but reading does no harm).
    const pattern = new RegExp(`\\b${column}\\s*:`, "g");
    for (const match of code.matchAll(pattern)) out.push({ index: match.index ?? 0, what: `${column}:` });
  }
  return out;
}

describe("the integrity module is structurally unable to touch a score", () => {
  const files = integrityFiles();

  it("finds the integrity module (sanity)", () => {
    expect(files.length).toBeGreaterThan(1);
    expect(files).toContain("packages/shared/src/triage.ts");
    expect(files.some((f) => f.startsWith("apps/web/src/lib/integrity/"))).toBe(true);
  });

  it("imports nothing from the judge, contests, ratings or XP", () => {
    const violations: string[] = [];
    for (const rel of files) {
      const source = readRepoFile(rel);
      const { code } = lexSource(source);
      for (const { spec, index } of importSpecifiers(code)) {
        for (const rule of FORBIDDEN_IMPORTS) {
          if (rule.pattern.test(spec)) {
            violations.push(`${rel}:${lineAt(source, index)} imports "${spec}" — ${rule.why}`);
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("writes to no scoring model, and runs no raw SQL", () => {
    const violations: string[] = [];
    for (const rel of files) {
      const source = readRepoFile(rel);
      const { code } = lexSource(source);
      for (const { index, what } of scoringWrites(code)) {
        violations.push(`${rel}:${lineAt(source, index)} writes ${what}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("sets no score column", () => {
    const violations: string[] = [];
    for (const rel of files) {
      const source = readRepoFile(rel);
      const { code } = lexSource(source);
      for (const { index, what } of scoreColumnWrites(code)) {
        violations.push(`${rel}:${lineAt(source, index)} sets ${what}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("catches a write it is meant to catch", () => {
    // The thing this fence exists to stop, a year from now: somebody adding
    // "and dock the marks" to a review handler.
    const bad = `
      import { finalizeSubmission } from "@/lib/judge/finalize";
      await db.submission.update({ where: { id }, data: { totalScore: 0 } });
    `;
    const { code } = lexSource(bad);
    expect(importSpecifiers(code).some((s) => FORBIDDEN_IMPORTS.some((r) => r.pattern.test(s.spec)))).toBe(true);
    expect(scoringWrites(code).length).toBeGreaterThan(0);
    expect(scoreColumnWrites(code).length).toBeGreaterThan(0);
  });

  it("allows what the integrity module legitimately needs", () => {
    const fine = `
      import { triage, reviewDeadline } from "@recx/shared";
      import { db } from "@/lib/db";
      import { audit } from "@/lib/audit";
      const events = await db.proctorEvent.findMany({ where: { attemptId } });
      await db.integrityFlag.create({ data: { attemptId, band: "MEDIUM" } });
    `;
    const { code } = lexSource(fine);
    expect(importSpecifiers(code).some((s) => FORBIDDEN_IMPORTS.some((r) => r.pattern.test(s.spec)))).toBe(false);
    expect(scoringWrites(code)).toEqual([]);
    expect(scoreColumnWrites(code)).toEqual([]);
  });

  it("never shows a band or a points total to a student", () => {
    // SPEC §5: "Never display a band or an 'integrity score' to students or
    // recruiters." The student-facing report is checked by name, because this
    // is the one place the temptation is real.
    const studentFacing = findFiles({
      extensions: CODE_EXTENSIONS,
      under: ["apps/web/src/app/(student)", "apps/web/src/components/student"],
    });
    const violations: string[] = [];
    for (const rel of studentFacing) {
      const source = readRepoFile(rel);
      const { code } = lexSource(source);
      for (const needle of ["substantivePoints", "contextPoints", "queuePoints", "integrityScore"]) {
        const at = code.indexOf(needle);
        if (at !== -1) violations.push(`${rel}:${lineAt(source, at)} mentions ${needle}`);
      }
    }
    expect(violations).toEqual([]);
  });
});
