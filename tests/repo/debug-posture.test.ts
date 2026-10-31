import { describe, expect, it } from "vitest";
import { CODE_EXTENSIONS, findFiles, isTestPath, readRepoFile } from "./support/repo";

/**
 * Debugging problems, as rules a test can hold true (Phase 12m).
 *
 *   1. **The budget is counted in one place.** One pure function in
 *      `@recx/shared`, used by the editor's live counter, the submit and
 *      run refusals and the publish gate — a student told "4 lines" by one
 *      surface and "2" by another can act on neither.
 *   2. **It is refused before the row.** A submission that cannot be
 *      judged on its merits does not cost a student one of their daily
 *      submissions.
 *   3. **The judge never hears about it.** The worker has no starter and
 *      no business having one: the protocol carries no budget, so a node
 *      cannot enforce a rule it cannot see.
 *   4. **Non-null is the kind.** No enum, no second source of truth about
 *      what a debugging problem is.
 */

const SHARED = "packages/shared/src/debug-problem.ts";
const WORKSPACE = "apps/web/src/components/workspace";
const webSources = findFiles({ under: ["apps/web/src"], extensions: [...CODE_EXTENSIONS] }).filter((f) => !isTestPath(f));

describe("the count lives in one place", () => {
  it("is a pure function in @recx/shared, with no imports of its own but the words", () => {
    const shared = readRepoFile(SHARED);
    expect(shared).toContain("export function countEditedLines");
    expect(shared).toContain("export function significantLines");
    // Pure: nothing from the database, the filesystem or the network.
    expect(shared).not.toMatch(/^import .*(db|node:|next)/m);
  });

  it("is what the submit boundary measures with, and it refuses before the row", () => {
    const action = readRepoFile("apps/web/src/server/actions/judge.ts");
    expect(action).toContain("countEditedLines");
    expect(action).toContain("debugOverBudget");
    expect(action).toContain("DEBUG_REFUSALS.noProgram");
    // The refusal is a ValidationError thrown by the helper, and the
    // helper is called before `db.$transaction` in both actions.
    for (const name of ["submitSolution", "runCode"]) {
      const body = action.slice(action.indexOf(`export async function ${name}`));
      const refusal = body.indexOf("refuseOverBudget");
      const write = body.indexOf("db.$transaction");
      expect(refusal, `${name} must check the budget`).toBeGreaterThan(-1);
      expect(refusal, `${name} must check the budget before it writes`).toBeLessThan(write);
    }
  });

  it("and what the publish gate proves the author's own fix against", () => {
    const content = readRepoFile("packages/shared/src/authoring/content.ts");
    expect(content).toContain("countEditedLines");
    expect(content).toContain("DEBUG_UNSOLVABLE");
  });

  it("is never counted a second way", () => {
    // A second line-diff anywhere is a second answer to the one question
    // a student is given a number for.
    for (const file of [...webSources, ...findFiles({ under: ["apps/judge-worker/src"], extensions: [".ts"] })]) {
      const source = readRepoFile(file);
      expect(source, `${file} must not diff lines of its own`).not.toMatch(/longest common subsequence|lcsLength/i);
    }
  });
});

describe("the judge never hears about the budget", () => {
  it("the protocol carries no edit budget", () => {
    const protocol = readRepoFile("packages/shared/src/protocol.ts");
    expect(protocol).not.toContain("maxEditedLines");
  });

  it("neither does the job spec the claim builds", () => {
    for (const file of ["apps/web/src/lib/judge/claim.ts", "apps/web/src/lib/judge/job-spec.ts"]) {
      expect(readRepoFile(file), `${file} must not send a budget to a node`).not.toContain("maxEditedLines");
    }
  });

  it("and nothing in the worker mentions one", () => {
    for (const file of findFiles({ under: ["apps/judge-worker/src", "apps/sql-judge/src"], extensions: [".ts"] })) {
      expect(readRepoFile(file), `${file} must not know about an edit budget`).not.toContain("maxEditedLines");
    }
  });
});

describe("non-null is the kind", () => {
  it("there is no ProblemKind enum, and no DEBUGGING io mode", () => {
    const schema = readRepoFile("packages/db/prisma/schema.prisma");
    expect(schema).not.toMatch(/enum ProblemKind/);
    // A debugging problem is an ordinary STDIN or FUNCTION problem with a
    // rule, so no io mode names it. (Phase 12n added OUTPUT_ONLY, which
    // IS a different way for an answer to reach the judge — the test is
    // that nothing here is about debugging, not that the list never grows.)
    const ioMode = /enum IoMode \{([\s\S]*?)\}/.exec(schema)?.[1] ?? "";
    const values = ioMode.replace(/\/\/.*/g, "").trim().split(/\s+/).filter(Boolean);
    expect(values).toContain("STDIN");
    expect(values.some((v) => /DEBUG|REPAIR|FIX/i.test(v))).toBe(false);
    expect(schema).toContain("maxEditedLines");
  });

  it("the two CHECKs are in the migration and in the guard catalogue", () => {
    const migration = readRepoFile("packages/db/prisma/migrations/20261101150000_phase12m_debug_budget/migration.sql");
    const catalog = readRepoFile("packages/db/test/support/guard-catalog.ts");
    for (const name of ["ProblemVersion_debug_budget_range", "ProblemVersion_debug_budget_kind"]) {
      expect(migration, name).toContain(name);
      expect(catalog, name).toContain(name);
    }
  });

  it("a kind with no program to repair is refused in the database and in the gate", () => {
    const migration = readRepoFile("packages/db/prisma/migrations/20261101150000_phase12m_debug_budget/migration.sql");
    expect(migration).toMatch(/"ioMode" <> 'SQL' AND "compareMode" <> 'INTERACTIVE'/);
    expect(readRepoFile("packages/shared/src/authoring/content.ts")).toContain("DEBUG_NOT_APPLICABLE");
  });
});

describe("the languages a debugging problem is offered in", () => {
  it("are the ones its broken program is written in, in the picker and at the boundary", () => {
    const query = readRepoFile("apps/web/src/server/queries/problems.ts");
    expect(query).toContain("maxEditedLines");
    // The picker skips a language with no starter for a debugging problem.
    expect(query).toMatch(/budget !== null && \(starters\.get\(config\.key\) \?\? ""\)\.trim\(\)\.length === 0/);
    expect(readRepoFile("apps/web/src/server/actions/judge.ts")).toContain("starterCode.findUnique");
  });
});

describe("not sat in an assessment yet, and not quietly", () => {
  it("a trigger refuses the pin, because a sitting cannot refuse a submission", () => {
    const migration = readRepoFile(
      "packages/db/prisma/migrations/20261101151000_phase12m_assessment_rule/migration.sql",
    );
    expect(migration).toContain("AssessmentProblem_no_debug_budget");
    expect(migration).toContain("not sat in an assessment yet");
    expect(migration).toMatch(/CREATE TRIGGER[\s\S]*ON "public"\."AssessmentProblem"/);
    // A contest needs no rule: its arena sends the student to the ordinary
    // workspace, and its submissions go through submitSolution.
    expect(migration).not.toMatch(/ON "public"\."ContestProblem"/);
  });

  it("the action says so in a sentence first", () => {
    const action = readRepoFile("apps/web/src/server/actions/admin-assessments.ts");
    expect(action).toContain("A debugging problem is not sat in an assessment yet");
  });

  it("the trigger and its function are catalogued, so lifting the rule fails the build", () => {
    const catalog = readRepoFile("packages/db/test/support/guard-catalog.ts");
    expect(catalog).toContain("AssessmentProblem_no_debug_budget");
    expect(catalog).toContain("recx_refuse_debug_assessment_problem");
  });

  it("and the exam path, which cannot refuse one, is left alone", () => {
    // submitAttempt writes every answered question at the end of the
    // sitting; a budget check there would throw away work the candidate
    // can no longer redo, which is why the pin is refused instead.
    expect(readRepoFile("apps/web/src/lib/exam/submit.ts")).not.toContain("maxEditedLines");
  });
});

describe("the sentences a student reads", () => {
  it("are defined once, in @recx/shared", () => {
    const shared = readRepoFile(SHARED);
    expect(shared).toContain("export const DEBUG_NOTICES");
    expect(shared).toContain("export const DEBUG_REFUSALS");
    expect(shared).toContain("export const DEBUG_LABELS");
  });

  it("reach the editor and the Description tab from that one module", () => {
    expect(readRepoFile(`${WORKSPACE}/debug-note.tsx`)).toContain("DEBUG_NOTICES");
    const description = readRepoFile(`${WORKSPACE}/problem-description.tsx`);
    for (const key of ["counted", "why", "languages", "reset"]) {
      expect(description, `the Description tab must state DEBUG_NOTICES.${key}`).toContain(`DEBUG_NOTICES.${key}`);
    }
    expect(description).toContain("debugRuleSentence");
  });

  it("count the same lines in the editor as the server refuses on", () => {
    // The bar and the action both call countEditedLines, against the
    // ACTIVE language's starter: a bar that measured something else would
    // promise what the server will not honour.
    const workspace = readRepoFile(`${WORKSPACE}/workspace.tsx`);
    expect(workspace).toContain("countEditedLines(active.starter, source)");
    expect(workspace).toContain("<DebugNote");
  });

  it("are never retyped into a component", () => {
    for (const file of [...webSources, ...findFiles({ under: [WORKSPACE], extensions: [".tsx"] })]) {
      const source = readRepoFile(file);
      expect(source, `${file} must take the counting rule from DEBUG_NOTICES`).not.toContain(
        "Blank lines are ignored",
      );
    }
  });
});
