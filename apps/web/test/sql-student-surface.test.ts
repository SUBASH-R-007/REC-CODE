import { describe, expect, it } from "vitest";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SQL_DIALECT_LABEL, SQL_NOTICES, writeResultSet } from "@recx/shared";
import { TestResults, WA_NOTES, waNote } from "@/components/workspace/result-view";
import { ProblemDescription } from "@/components/workspace/problem-description";
import { toStudentView, type SubmissionViewSource } from "@/lib/judge/view";
import type { ProblemWorkspace } from "@/server/queries/problems";

/**
 * What a student sees for a SQL question (Phase 12k, slice 4).
 *
 * A SQL answer is a result set, so the console shows one: the dataset, the
 * expected rows and the student's own rows as TABLES, with the judge's one
 * sentence about the case above them. The Description tab states the rules
 * a query is judged under — the dialect, one statement, the read-only
 * role, whether the order counts — because none of them can be read off
 * the statement.
 */

// apps/web's vitest config compiles .tsx with the classic JSX runtime.
(globalThis as { React?: typeof React }).React = React;

const ANSWER = writeResultSet({ columns: ["id", "name"], rows: [["1", "Asha"], ["2", "Bala"]] });
const MINE = writeResultSet({ columns: ["id", "name"], rows: [["2", "Bala"], ["1", "Asha"]] });
const DATASET = "CREATE TABLE students (id int, name text);\nINSERT INTO students VALUES (2, 'Bala'), (1, 'Asha');\n";

function sqlSubmission(overrides: Partial<SubmissionViewSource> = {}): SubmissionViewSource {
  return {
    kind: "submission",
    id: "sub_sql",
    status: "DONE",
    verdict: "WA",
    language: "sql17",
    languageLabel: "PostgreSQL 17",
    compileOutput: null,
    createdAt: new Date("2026-10-31T08:00:00Z"),
    judgedAt: new Date("2026-10-31T08:00:01Z"),
    samples: [{ index: 0, input: DATASET, expected: ANSWER }],
    passedCases: 0,
    totalCases: 2,
    maxTimeMs: 4,
    maxMemoryKb: 0,
    compareMode: "ROWS",
    testResults: [
      {
        i: 0,
        v: "WA",
        ms: 4,
        kb: 0,
        message: "The rows are right and the order is not — row 1 differs. This question is compared in order.",
      },
      { i: 1, v: "SKIPPED", ms: 0, kb: 0 },
    ],
    details: [{ testIndex: 0, input: DATASET, expected: ANSWER, stdout: MINE, stderr: null }],
    ...overrides,
  };
}

/**
 * The markup as readable text: React splits text nodes with comments and
 * escapes every apostrophe, so neither survives into an assertion.
 */
function text(html: string): string {
  return html
    .replace(/<!-- -->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
}

function renderResults(source: SubmissionViewSource): string {
  return renderToStaticMarkup(React.createElement(TestResults, { view: toStudentView(source) }));
}

describe("a SQL case in the result console", () => {
  it("shows the dataset, the expected rows and the student's rows as tables", () => {
    const html = renderResults(sqlSubmission());
    const body = text(html);

    expect(body).toContain("Dataset");
    expect(body).toContain("Expected rows");
    expect(body).toContain("Your rows");
    // Not "Input" / "Expected output" / "Your output": a SQL case is a
    // dataset and two result sets, and calling them output helps nobody.
    expect(body).not.toContain("Expected output");
    expect(body).not.toContain("Your output");

    // Both result sets are real tables with the query's own column names.
    expect(html).toContain("<table");
    expect((html.match(/<table/g) ?? []).length).toBe(2);
    expect(html).toContain("<th");
    expect(body).toContain("id");
    expect(body).toContain("name");
    expect(body).toContain("Asha");
    // The dataset is SQL, so it stays a text block.
    expect(body).toContain("CREATE TABLE students");
  });

  it("says which row differs, in the judge's own words", () => {
    const body = text(renderResults(sqlSubmission()));
    expect(body).toContain("The rows are right and the order is not");
    expect(body).toContain("row 1 differs");
  });

  it("names NULL rather than showing an empty cell", () => {
    const html = renderResults(
      sqlSubmission({
        details: [
          {
            testIndex: 0,
            input: DATASET,
            expected: ANSWER,
            stdout: writeResultSet({ columns: ["id", "name"], rows: [["1", null]] }),
            stderr: null,
          },
        ],
      }),
    );
    // '' and NULL are different answers, and a blank cell cannot say which.
    expect(text(html)).toContain("NULL");
  });

  it("falls back to a text block when a side is not a result set", () => {
    // A field cut by the byte budget, or a blob from before this existed.
    const html = renderResults(
      sqlSubmission({
        details: [{ testIndex: 0, input: DATASET, expected: '{"columns":["id"],"rows":[["1"', stdout: MINE, stderr: null }],
      }),
    );
    expect((html.match(/<table/g) ?? []).length).toBe(1);
    expect(text(html)).toContain("Expected rows");
  });

  it("keeps a hidden case to its verdict, whatever the judge sent", () => {
    const html = renderResults(
      sqlSubmission({
        verdict: "WA",
        testResults: [
          { i: 0, v: "AC", ms: 4, kb: 0 },
          { i: 1, v: "WA", ms: 3, kb: 0, message: "Row 7 differs.", stdout: MINE },
        ],
      }),
    );
    const body = text(html);
    expect(body).toContain("Hidden test 2");
    expect(body).not.toContain("Row 7 differs.");
  });

  it("explains a ROWS wrong answer as a result-set comparison", () => {
    expect(waNote({ compareMode: "ROWS", functionComparator: null })).toBe(WA_NOTES.ROWS);
    expect(WA_NOTES.ROWS).toContain("result set");
  });

  it("renders an ordinary problem exactly as before", () => {
    const body = text(
      renderResults(
        sqlSubmission({
          compareMode: "TOKEN",
          language: "cpp20",
          samples: [{ index: 0, input: "2 3\n", expected: "5\n" }],
          details: [{ testIndex: 0, input: "2 3\n", expected: "5\n", stdout: "6\n", stderr: null }],
          testResults: [{ i: 0, v: "WA", ms: 4, kb: 1024 }],
        }),
      ),
    );
    expect(body).toContain("Input");
    expect(body).toContain("Expected output");
    expect(body).toContain("Your output");
  });
});

describe("the Description tab of a SQL question", () => {
  const problem = (overrides: Partial<ProblemWorkspace> = {}): ProblemWorkspace => ({
    id: "prob_sql",
    slug: "every-student",
    displayCode: "SQL-0001",
    title: "Every student, by id",
    difficulty: "EASY",
    versionId: "ver_1",
    statementMd: "List every student.",
    statementHtml: "<p>List every student.</p>",
    constraints: [],
    ioMode: "SQL",
    signature: null,
    sqlDialect: "postgres17",
    sqlOrdered: true,
    timeLimitMs: 1000,
    memoryLimitKb: 262_144,
    samples: [{ index: 0, input: DATASET, output: ANSWER }],
    languages: [],
    functionUnavailable: [],
    ...overrides,
  });

  const render = (p: ProblemWorkspace) =>
    renderToStaticMarkup(React.createElement(ProblemDescription, { problem: p, statementHtml: p.statementHtml }));

  it("states every rule a query is judged under", () => {
    const body = text(render(problem()));
    expect(body).toContain("How your query is judged");
    for (const note of [SQL_NOTICES.dialect, SQL_NOTICES.oneStatement, SQL_NOTICES.readOnly, SQL_NOTICES.columnNames]) {
      expect(body).toContain(text(note).trim());
    }
    expect(body).toContain(SQL_DIALECT_LABEL.postgres17);
  });

  it("says whether the row order is part of the answer, and says it either way", () => {
    expect(text(render(problem()))).toContain(SQL_NOTICES.ordered);
    expect(text(render(problem({ sqlOrdered: false })))).toContain(SQL_NOTICES.unordered);
  });

  it("shows the sample as a dataset and a table of rows", () => {
    const html = render(problem());
    expect(text(html)).toContain("Dataset");
    expect(text(html)).toContain("Expected rows");
    expect(html).toContain("<table");
    expect(text(html)).toContain("Asha");
  });

  it("gives a query's limit rather than a C++ time limit and a memory figure", () => {
    const body = text(render(problem()));
    expect(body).toContain("Query limit");
    expect(body).not.toContain("Memory");
    expect(body).not.toContain("scaled for other languages");
  });

  it("leaves an ordinary problem's limits and samples alone", () => {
    const body = text(
      render(
        problem({
          ioMode: "STDIN",
          sqlDialect: null,
          sqlOrdered: null,
          samples: [{ index: 0, input: "2 3\n", output: "5\n" }],
        }),
      ),
    );
    expect(body).toContain("Time limit");
    expect(body).toContain("Memory");
    expect(body).not.toContain("How your query is judged");
    expect(body).toContain("Input");
    expect(body).toContain("Output");
  });
});
