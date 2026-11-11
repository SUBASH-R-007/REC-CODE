import { describe, expect, it } from "vitest";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DEBUG_NOTICES, debugCountLabel, debugRuleSentence } from "@recx/shared";
import { DebugNote } from "@/components/workspace/debug-note";
import { ProblemDescription } from "@/components/workspace/problem-description";
import type { ProblemWorkspace } from "@/server/queries/problems";

/**
 * What a student sees of a debugging problem (Phase 12m, slice 3).
 *
 * The bar over the editor carries the two numbers that decide whether the
 * submission is judged at all, and the Description tab explains what the
 * counter cannot: what does not count, and why there is a budget. Both
 * take every sentence from `DEBUG_NOTICES`, because a rule stated twice is
 * a rule that goes stale in one place.
 */

(globalThis as { React?: typeof React }).React = React;

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

const note = (budget: number, changed: number) =>
  renderToStaticMarkup(React.createElement(DebugNote, { budget, changed }));

describe("the bar over the editor", () => {
  it("names the budget and the count as it stands", () => {
    const body = text(note(2, 1));
    expect(body).toContain("at most 2 lines");
    expect(body).toContain(debugCountLabel(1, 2));
  });

  it("marks the count as over budget when it is, in a way a screen reader hears", () => {
    expect(note(2, 5)).toContain("text-danger");
    expect(note(2, 1)).not.toContain("text-danger");
    // The count is announced as it changes, not only read on focus.
    expect(note(2, 1)).toContain('aria-live="polite"');
  });

  it("reads the whole rule out, including what does not count", () => {
    const body = text(note(2, 0));
    expect(body).toContain(debugRuleSentence(2));
    expect(body).toContain(DEBUG_NOTICES.counted);
    expect(body).toContain(DEBUG_NOTICES.why);
  });
});

describe("the Description tab of a debugging problem", () => {
  const problem = (overrides: Partial<ProblemWorkspace> = {}): ProblemWorkspace => ({
    id: "prob_dbg",
    slug: "fix-the-sum",
    displayCode: "REC-0199",
    title: "Fix the sum",
    difficulty: "EASY",
    versionId: "ver_1",
    statementMd: "The program adds one number too many.",
    statementHtml: "<p>The program adds one number too many.</p>",
    constraints: [],
    ioMode: "STDIN",
    compareMode: "TOKEN",
    signature: null,
    sqlDialect: null,
    sqlOrdered: null,
    maxEditedLines: 2,
    timeLimitMs: 2000,
    memoryLimitKb: 262_144,
    samples: [{ index: 0, input: "5\n", output: "10\n" }],
    languages: [],
    functionUnavailable: [],
    ...overrides,
  });

  const render = (p: ProblemWorkspace) =>
    renderToStaticMarkup(React.createElement(ProblemDescription, { problem: p, statementHtml: p.statementHtml }));

  it("states every rule of the budget in sentences", () => {
    const body = text(render(problem()));
    expect(body).toContain("How your fix is judged");
    expect(body).toContain(debugRuleSentence(2));
    for (const key of ["counted", "why", "languages", "reset"] as const) {
      expect(body, key).toContain(text(DEBUG_NOTICES[key]).trim());
    }
  });

  it("says nothing about a budget on a problem that has none", () => {
    const body = text(render(problem({ maxEditedLines: null })));
    expect(body).not.toContain("How your fix is judged");
    expect(body).not.toContain("at most");
  });

  it("leaves the samples and the limits exactly as they are: it is an ordinary problem to answer", () => {
    const body = text(render(problem()));
    expect(body).toContain("Input");
    expect(body).toContain("Output");
    expect(body).toContain("Time limit");
  });
});
