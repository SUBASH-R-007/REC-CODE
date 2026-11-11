import { describe, expect, it } from "vitest";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ANSWER_LABELS, ANSWER_NOTICES } from "@recx/shared";
import { AnswerNote } from "@/components/workspace/answer-note";
import { ProblemDescription } from "@/components/workspace/problem-description";
import { ResultSummary, TestResults } from "@/components/workspace/result-view";
import { toStudentView, type SubmissionViewSource } from "@/lib/judge/view";
import type { ProblemWorkspace } from "@/server/queries/problems";

/**
 * What a student sees of an output-only problem (Phase 12n, slice 3).
 *
 * The one thing that must never appear is the expected answer. The case is
 * a sample — its data IS the question — and on every other kind of problem
 * "sample" means the student sees the expected output too. Here that would
 * be the answer, so it is withheld in the query and absent from the
 * console, and these tests hold both halves true.
 */

(globalThis as { React?: typeof React }).React = React;

const DATA = "10\n3 1 4 1 5 9 2 6 5 3\n";
const ANSWER = "39\n";
const SECRET = "the-expected-answer-nobody-should-see";

const text = (html: string) =>
  html
    .replace(/<!-- -->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");

function answerSubmission(overrides: Partial<SubmissionViewSource> = {}): SubmissionViewSource {
  return {
    kind: "submission",
    id: "sub_answer",
    status: "DONE",
    verdict: "WA",
    language: "answer1",
    languageLabel: "Answer file",
    compileOutput: null,
    createdAt: new Date("2026-10-31T08:00:00Z"),
    judgedAt: new Date("2026-10-31T08:00:01Z"),
    // What the query sends for this kind: the data, and no expected text.
    samples: [{ index: 0, input: DATA, expected: "" }],
    passedCases: 0,
    totalCases: 1,
    maxTimeMs: 0,
    maxMemoryKb: 0,
    compareMode: "TOKEN",
    ioMode: "OUTPUT_ONLY",
    testResults: [{ i: 0, v: "WA", ms: 0, kb: 0 }],
    details: [{ testIndex: 0, input: DATA, expected: "", stdout: ANSWER, stderr: "" }],
    ...overrides,
  };
}

const renderResults = (source: SubmissionViewSource) =>
  renderToStaticMarkup(React.createElement(TestResults, { view: toStudentView(source) }));

describe("an output-only case in the result console", () => {
  it("shows the data and the student's own answer", () => {
    const body = text(renderResults(answerSubmission()));
    expect(body).toContain(ANSWER_LABELS.data);
    expect(body).toContain(ANSWER_LABELS.answer);
    expect(body).toContain("39");
  });

  it("shows no expected block at all, whatever the details carry", () => {
    const body = text(
      renderResults(
        answerSubmission({
          samples: [{ index: 0, input: DATA, expected: SECRET }],
          details: [{ testIndex: 0, input: DATA, expected: SECRET, stdout: ANSWER, stderr: "" }],
        }),
      ),
    );
    expect(body).not.toContain("Expected output");
    expect(body).not.toContain(SECRET);
  });

  it("shows no time and no memory, because nothing of the student's ran", () => {
    const body = text(renderResults(answerSubmission()));
    expect(body).not.toContain("0 ms");
    expect(body).not.toMatch(/\bKB\b/);
  });

  it("and the summary line reports no time or memory either", () => {
    // Rendered through the console's own summary, which the submission
    // page shows above the tests.
    const body = text(
      renderToStaticMarkup(
        React.createElement(ResultSummary, { view: toStudentView(answerSubmission({ verdict: "AC", passedCases: 1 })) }),
      ),
    );
    expect(body).toContain("Passed");
    expect(body).not.toContain("0 ms");
    expect(body).not.toContain(" KB");
  });

  it("leaves an ordinary problem's three blocks alone", () => {
    const body = text(
      renderResults(
        answerSubmission({
          ioMode: "STDIN",
          language: "cpp20",
          languageLabel: "C++20",
          samples: [{ index: 0, input: "2 3\n", expected: "5\n" }],
          details: [{ testIndex: 0, input: "2 3\n", expected: "5\n", stdout: "4\n", stderr: "" }],
        }),
      ),
    );
    expect(body).toContain("Input");
    expect(body).toContain("Expected output");
    expect(body).toContain("Your output");
  });
});

describe("the rules over the editor", () => {
  it("names what to submit, that nothing runs, and the one case", () => {
    const body = text(renderToStaticMarkup(React.createElement(AnswerNote)));
    expect(body).toContain("your answer, not a program");
    expect(body).toContain("nothing is compiled or run");
    expect(body).toContain("one case, and you can see it");
    // Read out in full to a screen reader.
    expect(body).toContain(text(ANSWER_NOTICES.whatToSubmit).trim());
  });
});

describe("the Description tab of an output-only problem", () => {
  const problem = (overrides: Partial<ProblemWorkspace> = {}): ProblemWorkspace => ({
    id: "prob_answer",
    slug: "the-hard-instance",
    displayCode: "REC-0210",
    title: "The hard instance",
    difficulty: "HARD",
    versionId: "ver_1",
    statementMd: "Submit the answer.",
    statementHtml: "<p>Submit the answer.</p>",
    constraints: [],
    ioMode: "OUTPUT_ONLY",
    compareMode: "TOKEN",
    signature: null,
    sqlDialect: null,
    sqlOrdered: null,
    maxEditedLines: null,
    timeLimitMs: 2000,
    memoryLimitKb: 262_144,
    // The query withholds the expected answer for this kind.
    samples: [{ index: 0, input: DATA, output: "" }],
    languages: [],
    functionUnavailable: [],
    ...overrides,
  });

  const render = (p: ProblemWorkspace) =>
    renderToStaticMarkup(React.createElement(ProblemDescription, { problem: p, statementHtml: p.statementHtml }));

  it("states every rule of an answer", () => {
    const body = text(render(problem()));
    expect(body).toContain("How your answer is judged");
    for (const note of Object.values(ANSWER_NOTICES)) {
      expect(body, note.slice(0, 40)).toContain(text(note).trim());
    }
  });

  it("shows the data and no expected side, and says there is no time limit", () => {
    const body = text(render(problem()));
    expect(body).toContain(ANSWER_LABELS.data);
    expect(body).toContain("3 1 4 1 5 9 2 6 5 3");
    expect(body).toContain("No time limit");
    expect(body).not.toContain("Memory");
    // "Output" belongs to a problem whose expected output a student may see.
    expect(body).not.toMatch(/\bOutput\b/);
  });

  it("does not leak an expected answer even if one reaches it", () => {
    const body = text(render(problem({ samples: [{ index: 0, input: DATA, output: SECRET }] })));
    expect(body).not.toContain(SECRET);
  });

  it("leaves an ordinary problem's samples and limits alone", () => {
    const body = text(
      render(problem({ ioMode: "STDIN", samples: [{ index: 0, input: "2 3\n", output: "5\n" }] })),
    );
    expect(body).toContain("Input");
    expect(body).toContain("Output");
    expect(body).toContain("Time limit");
    expect(body).not.toContain("How your answer is judged");
  });
});
