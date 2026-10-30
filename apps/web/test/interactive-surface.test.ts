import { describe, expect, it } from "vitest";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { INTERACTIVE_LABELS, INTERACTIVE_NOTICES, LIMITS } from "@recx/shared";
import { TestResults, WA_NOTES, waNote } from "@/components/workspace/result-view";
import { ProblemDescription } from "@/components/workspace/problem-description";
import { InteractiveNote } from "@/components/workspace/interactive-note";
import { toStudentView, type SubmissionViewSource } from "@/lib/judge/view";
import type { ProblemWorkspace } from "@/server/queries/problems";

/**
 * What a student sees of an interactive problem (Phase 12l, slice 3).
 *
 * An interactive case has no expected output, so the console shows two
 * blocks rather than three: the examiner's data for that case, and the
 * CONVERSATION the worker relayed. A block headed "Expected output" with
 * nothing in it would be a question nobody could answer — the live stage
 * of slice 2 found exactly that, along with a Custom input tab on a
 * question that has no input to type.
 */

(globalThis as { React?: typeof React }).React = React;

const TRANSCRIPT = "> 500000000\n< lower\n> 250000000\n< correct\n";
const DATA = "42 40\n";

function interactiveSubmission(overrides: Partial<SubmissionViewSource> = {}): SubmissionViewSource {
  return {
    kind: "submission",
    id: "sub_int",
    status: "DONE",
    verdict: "AC",
    language: "cpp20",
    languageLabel: "C++20 (GCC 13.2.0)",
    compileOutput: null,
    createdAt: new Date("2026-10-31T08:00:00Z"),
    judgedAt: new Date("2026-10-31T08:00:02Z"),
    samples: [{ index: 0, input: DATA, expected: "" }],
    passedCases: 2,
    totalCases: 2,
    maxTimeMs: 3,
    maxMemoryKb: 460,
    compareMode: "INTERACTIVE",
    testResults: [
      { i: 0, v: "AC", ms: 3, kb: 460, message: "ok found it after 29 queries" },
      { i: 1, v: "AC", ms: 2, kb: 460 },
    ],
    details: [{ testIndex: 0, input: DATA, expected: "", stdout: TRANSCRIPT, stderr: "" }],
    ...overrides,
  };
}

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

const renderResults = (source: SubmissionViewSource) =>
  renderToStaticMarkup(React.createElement(TestResults, { view: toStudentView(source) }));

describe("an interactive case in the result console", () => {
  it("shows the examiner's data and the conversation, and no expected output", () => {
    const body = text(renderResults(interactiveSubmission()));
    expect(body).toContain(INTERACTIVE_LABELS.data);
    expect(body).toContain(INTERACTIVE_LABELS.transcript);
    // The defect the live stage found: an empty block with that heading.
    expect(body).not.toContain("Expected output");
  });

  it("shows the conversation line by line, marked by direction", () => {
    const body = text(renderResults(interactiveSubmission()));
    expect(body).toContain("> 500000000");
    expect(body).toContain("< lower");
    expect(body).toContain("< correct");
    // And says what the markers mean.
    expect(body).toContain(INTERACTIVE_NOTICES.transcript);
  });

  it("shows the interactor's own words about a visible case", () => {
    expect(text(renderResults(interactiveSubmission()))).toContain("found it after 29 queries");
  });

  it("says nothing at all about a hidden case", () => {
    const body = text(
      renderResults(
        interactiveSubmission({
          samples: [],
          details: [],
          testResults: [{ i: 1, v: "WA", ms: 2, kb: 460, message: "did not find the number" }],
        }),
      ),
    );
    expect(body).toContain("Hidden test 2");
    expect(body).not.toContain("did not find the number");
    expect(body).not.toContain(INTERACTIVE_LABELS.transcript);
  });

  it("explains a wrong answer as a dialogue that did not get there", () => {
    expect(waNote({ compareMode: "INTERACTIVE", functionComparator: null })).toBe(WA_NOTES.INTERACTIVE);
    expect(WA_NOTES.INTERACTIVE).toContain("dialogue");
  });

  it("leaves an ordinary problem's three blocks alone", () => {
    const body = text(
      renderResults(
        interactiveSubmission({
          compareMode: "TOKEN",
          samples: [{ index: 0, input: "2 3\n", expected: "5\n" }],
          details: [{ testIndex: 0, input: "2 3\n", expected: "5\n", stdout: "5\n", stderr: "" }],
        }),
      ),
    );
    expect(body).toContain("Input");
    expect(body).toContain("Expected output");
    expect(body).toContain("Your output");
  });
});

describe("the rules over the editor", () => {
  it("names the three things a student needs while typing", () => {
    const body = text(renderToStaticMarkup(React.createElement(InteractiveNote)));
    expect(body).toContain("a conversation");
    expect(body).toContain("flush every line");
    expect(body).toContain(`${LIMITS.interactive.idleMs / 1000} s of silence is a deadlock`);
    // The long form is read out, so a screen reader gets the sentences.
    expect(body).toContain(INTERACTIVE_NOTICES.flush);
  });
});

describe("the Description tab of an interactive problem", () => {
  const problem = (overrides: Partial<ProblemWorkspace> = {}): ProblemWorkspace => ({
    id: "prob_int",
    slug: "guess-the-number",
    displayCode: "REC-0101",
    title: "Guess the number",
    difficulty: "EASY",
    versionId: "ver_1",
    statementMd: "Guess it.",
    statementHtml: "<p>Guess it.</p>",
    constraints: [],
    ioMode: "STDIN",
    compareMode: "INTERACTIVE",
    signature: null,
    sqlDialect: null,
    sqlOrdered: null,
    timeLimitMs: 2000,
    memoryLimitKb: 262_144,
    samples: [{ index: 0, input: DATA, output: "" }],
    languages: [],
    functionUnavailable: [],
    ...overrides,
  });

  const render = (p: ProblemWorkspace) =>
    renderToStaticMarkup(React.createElement(ProblemDescription, { problem: p, statementHtml: p.statementHtml }));

  it("states every rule of a conversation", () => {
    const body = text(render(problem()));
    expect(body).toContain("How your conversation is judged");
    for (const note of Object.values(INTERACTIVE_NOTICES)) {
      expect(body, note.slice(0, 40)).toContain(text(note).trim());
    }
  });

  it("shows the sample as the examiner's data, with no output block", () => {
    const body = text(render(problem()));
    expect(body).toContain(INTERACTIVE_LABELS.data);
    expect(body).toContain("42 40");
    // "Output" belongs to a problem that has one.
    expect(body).not.toMatch(/\bOutput\b/);
  });

  it("leaves an ordinary problem's samples alone", () => {
    const body = text(
      render(problem({ compareMode: "TOKEN", samples: [{ index: 0, input: "2 3\n", output: "5\n" }] })),
    );
    expect(body).toContain("Input");
    expect(body).toContain("Output");
    expect(body).not.toContain("How your conversation is judged");
  });
});
