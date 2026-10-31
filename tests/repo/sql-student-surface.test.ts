import { describe, expect, it } from "vitest";
import { CODE_EXTENSIONS, findFiles, isTestPath, readRepoFile } from "./support/repo";

/**
 * What a SQL question looks like to a student (Phase 12k, slice 4), as
 * rules a test can hold true:
 *
 *   1. **The sentences are written once.** Every rule a student reads —
 *      the dialect, one statement, the read-only role, the timeout, the
 *      refusals — comes from `SQL_NOTICES` / `SQL_REFUSALS` in
 *      `@recx/shared`, never retyped into a component. Two copies of a
 *      sentence is one copy that goes stale, and the stale one is always
 *      the one on the screen.
 *   2. **The hidden rule holds for the new channel too.** A case's message
 *      is stored for a VISIBLE case only, decided by the version's own
 *      sample indexes rather than by anything the worker sent.
 *   3. **Nothing about SQL runs in the web process.** The student surface
 *      formats a result set; it never parses, rewrites or executes one.
 */

const WORKSPACE = "apps/web/src/components/workspace";
const SHARED_SQL = "packages/shared/src/sql-problem.ts";

const webSources = findFiles({ under: ["apps/web/src"], extensions: [...CODE_EXTENSIONS] }).filter(
  (f) => !isTestPath(f),
);

describe("the sentences a student reads", () => {
  it("are defined once, in @recx/shared", () => {
    const shared = readRepoFile(SHARED_SQL);
    expect(shared).toContain("export const SQL_NOTICES");
    expect(shared).toContain("export const SQL_REFUSALS");
  });

  it("are never retyped into a component", () => {
    // The dialect's own name is the giveaway: it belongs to
    // SQL_DIALECT_LABEL, and a component that spells it out has a second
    // copy of a fact that an upgrade has to change in two places.
    for (const file of webSources) {
      expect(readRepoFile(file), `${file} must take the dialect name from SQL_DIALECT_LABEL`).not.toContain(
        "PostgreSQL 17",
      );
    }
  });

  it("reach the editor and the Description tab from that one module", () => {
    expect(readRepoFile(`${WORKSPACE}/sql-note.tsx`)).toContain("SQL_NOTICES");
    const description = readRepoFile(`${WORKSPACE}/problem-description.tsx`);
    for (const key of ["dialect", "oneStatement", "readOnly", "columnNames", "timeout"]) {
      expect(description, `the Description tab must state SQL_NOTICES.${key}`).toContain(`SQL_NOTICES.${key}`);
    }
    // Both ways round: a question whose order matters says so, and one
    // whose order does not says that, rather than saying nothing.
    expect(description).toContain("SQL_NOTICES.ordered");
    expect(description).toContain("SQL_NOTICES.unordered");
  });

  it("are what the submit boundary refuses with", () => {
    const action = readRepoFile("apps/web/src/server/actions/judge.ts");
    for (const key of ["tooLong", "multiple", "customInput", "noSampleCase"]) {
      expect(action, `the submit boundary must refuse with SQL_REFUSALS.${key}`).toContain(`SQL_REFUSALS.${key}`);
    }
  });
});

describe("a hidden case says nothing new", () => {
  it("stores a message only for a case the version itself marks as a sample", () => {
    const finalize = readRepoFile("apps/web/src/lib/judge/finalize.ts");
    // The visible set is built from the version's sample cases, which is
    // the same source the detail rows use — not from the result body.
    expect(finalize).toContain("compactTestResults(body.tests, new Set(samples.map((s) => s.index)))");
    const truncate = readRepoFile("apps/web/src/lib/judge/truncate.ts");
    expect(truncate).toContain("if (visible.has(t.i) && t.message)");
  });

  it("keeps a hidden entry to its four keys", () => {
    const view = readRepoFile("apps/web/src/lib/judge/view.ts");
    expect(view).toContain("return { i: t.i, v: t.v, ms: Math.round(t.ms), kb: Math.round(t.kb) };");
  });
});

describe("the student surface only formats SQL", () => {
  it("never executes a query: no client, no pool, no connection", () => {
    for (const file of webSources) {
      const source = readRepoFile(file);
      for (const banned of ["from \"pg\"", "require(\"pg\")", "new Pool(", "new Client("]) {
        expect(source, `${file} must not open a database connection of its own`).not.toContain(banned);
      }
    }
  });

  it("renders a result set from the shared reader, which cannot throw", () => {
    const table = readRepoFile(`${WORKSPACE}/result-set.tsx`);
    // The table is a pure component: no reader, no parser, no fetch.
    expect(table).not.toContain("JSON.parse");
    expect(table).not.toContain("use client");
    const resultView = readRepoFile(`${WORKSPACE}/result-view.tsx`);
    expect(resultView).toContain("readResultSet");
    expect(resultView).not.toContain("JSON.parse");
  });
});
describe("not sat in an assessment yet, and not quietly (Phase 12p)", () => {
  it("a trigger refuses the pin, because a sitting has one editor and one language", () => {
    const migration = readRepoFile(
      "packages/db/prisma/migrations/20261101170000_phase12p_sql_assessment_rule/migration.sql",
    );
    expect(migration).toContain("AssessmentProblem_no_sql");
    expect(migration).toContain("not sat in an assessment yet");
    expect(migration).toMatch(/CREATE TRIGGER[\s\S]*ON "public"\."AssessmentProblem"/);
    // A contest's arena links to the ordinary workspace, so it needs no rule
    // — the same reason the other three triggers are not on ContestProblem.
    expect(migration).not.toMatch(/ON "public"\."ContestProblem"/);
  });

  it("the action says so in a sentence first", () => {
    const action = readRepoFile("apps/web/src/server/actions/admin-assessments.ts");
    expect(action).toContain("A SQL problem is not sat in an assessment yet");
  });

  it("the trigger and its function are catalogued, so lifting the rule fails the build", () => {
    const catalog = readRepoFile("packages/db/test/support/guard-catalog.ts");
    expect(catalog).toContain("AssessmentProblem_no_sql");
    expect(catalog).toContain("recx_refuse_sql_assessment_problem");
  });

  it("every kind the exam engine cannot sit is refused, not just this one", () => {
    // The four rules read the same on purpose: one sentence per kind, in the
    // one place a person is choosing the question.
    const action = readRepoFile("apps/web/src/server/actions/admin-assessments.ts");
    for (const sentence of [
      "An interactive problem is not sat in an assessment yet",
      "A debugging problem is not sat in an assessment yet",
      "An output-only problem is not sat in an assessment yet",
      "A SQL problem is not sat in an assessment yet",
    ]) {
      expect(action, "the four pin refusals are one family").toContain(sentence);
    }
  });
});
describe("the catalogue names the kind, in the shared words (Phase 12p)", () => {
  it("derives the kind rather than storing it", () => {
    // A stored column would be a second truth beside the version's own
    // CHECKs, and the two would drift the first time a kind changed.
    const shared = readRepoFile("packages/shared/src/problem-kind.ts");
    expect(shared).toContain("export function problemKind");
    expect(shared).toContain("export const PROBLEM_KIND_LABEL");
    expect(readRepoFile("packages/db/prisma/schema.prisma")).not.toContain("ProblemKind");
  });

  it("takes every word from @recx/shared, never retyped into a component", () => {
    const chip = readRepoFile("apps/web/src/components/problems/kind-chip.tsx");
    expect(chip).toContain("PROBLEM_KIND_LABEL");
    expect(chip).toContain("PROBLEM_KIND_HINT");
    for (const word of ["Conversation", "Debugging", "Answer only"]) {
      expect(chip, `${word} belongs in PROBLEM_KIND_LABEL, not in the chip`).not.toContain(`"${word}"`);
    }
  });

  it("asks the query for the kind, so a listing cannot forget it", () => {
    const query = readRepoFile("apps/web/src/server/queries/problems.ts");
    expect(query).toContain("problemKind(");
    expect(query).toMatch(/LEFT JOIN "ProblemVersion" v ON v\.id = p\."liveVersionId"/);
  });
});
