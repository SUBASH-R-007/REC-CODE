import { describe, expect, it } from "vitest";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ANSWER_LABELS,
  ANSWER_LANGUAGE_KEY,
  EXAM_QUESTION_KINDS,
  SQL_LANGUAGE_KEY,
  SQL_LANGUAGE_VIEW,
  SQL_NOTICES,
  type ExamQuestionKind,
} from "@recx/shared";
import { ExamQuestion } from "@/components/exam/exam-question";
import type { ExamQuestionView } from "@/components/exam/exam-session";
import type { EditorPrefs } from "@/components/editor/editor-types";

/**
 * A SQL question in a sitting (Phase 16o, `docs/ROADMAP.md` §2.1).
 *
 * Phase 12p refused the pin because "a sitting gives every question the
 * same code editor and submits every answer in one programming language",
 * and Phase 16h found a third reason it had missed — the lane. Phase 16n
 * lifted the lane; this is the surface, and these are the things that make
 * lifting it safe:
 *
 *   1. the KIND is read, never the version's current `ioMode`, so a
 *      problem republished mid-sitting cannot turn a query editor into a
 *      C++ one under somebody part way through;
 *   2. the pane offers ONE language and no picker;
 *   3. a candidate reads the SAME three sentences they read in practice —
 *      the dialect, the single statement, the read-only copy of the data;
 *   4. nothing about the OTHER kinds changes.
 */

(globalThis as { React?: typeof React }).React = React;

const text = (html: string) =>
  html
    .replace(/<!-- -->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&mdash;/g, "—")
    .replace(/\s+/g, " ");

const PREFS: EditorPrefs = { fontSize: 14, tabSize: 2, keymap: "DEFAULT" } as EditorPrefs;

function view(over: Partial<ExamQuestionView> = {}): ExamQuestionView {
  return {
    questionId: "q1",
    title: "Students who improved",
    statementHtml: "<p>List the students, ordered by id.</p>",
    points: 10,
    samples: [{ input: "", output: "id | name" }],
    starters: { [SQL_LANGUAGE_KEY]: "-- your query here" },
    languageKey: SQL_LANGUAGE_KEY,
    languages: [SQL_LANGUAGE_VIEW],
    kind: "SQL" as ExamQuestionKind,
    ...over,
  };
}

function render(question: ExamQuestionView): string {
  return renderToStaticMarkup(
    React.createElement(ExamQuestion, {
      question,
      source: "select id, name from students order by id",
      onSourceChange: () => undefined,
      onInsertion: () => undefined,
      position: 1,
      total: 2,
      prefs: PREFS,
      languages: question.languages,
      language: question.languageKey,
      onLanguageChange: () => undefined,
    }),
  );
}

describe("the kind", () => {
  it("is one of the three a sitting knows", () => {
    expect([...EXAM_QUESTION_KINDS]).toEqual(["CODE", "ANSWER", "SQL"]);
  });

  it("keeps `sql17` out of the toolchains, like `answer1`", () => {
    // Both are SubmitLanguageKeys and deliberately not LanguageKeys: a kind
    // read in four places is a smaller change than spreading "this might
    // not be a program" through every route that validates one.
    expect(SQL_LANGUAGE_KEY).not.toBe(ANSWER_LANGUAGE_KEY);
    expect(SQL_LANGUAGE_VIEW.key).toBe(SQL_LANGUAGE_KEY);
    // The editor's grammar travels with the view, so the pane needs no
    // special case to highlight a query.
    expect(SQL_LANGUAGE_VIEW.editorLanguage).not.toBe("plaintext");
  });
});

describe("a SQL question's pane", () => {
  const html = render(view());
  const body = text(html);

  it("reads the same three sentences the practice workspace shows", () => {
    for (const notice of [SQL_NOTICES.dialect, SQL_NOTICES.oneStatement, SQL_NOTICES.readOnly]) {
      expect(body, notice).toContain(text(notice).trim());
    }
  });

  it("offers one language and no picker", () => {
    // A dropdown of one is not a choice; the pane says what it is instead.
    expect(html).not.toContain("<select");
    expect(body).toContain(SQL_LANGUAGE_VIEW.label);
  });

  it("gives a query EDITOR rather than the answer box", () => {
    /**
     * `data-editor-root` is what tells them apart, and not the tag.
     * `CodeEditor` server-renders a plain `<textarea>` and swaps it for
     * CodeMirror on the client, so "there is no textarea" is false of the
     * editor too — it was the first thing this test asserted, and the
     * rendered markup said otherwise. An output-only question's box is a
     * bare textarea with the answer label and no editor root at all.
     */
    expect(html).toContain("data-editor-root");
    expect(html).toContain('aria-label="Code editor for question 1"');
    // The answer box's own visible label, by the constant rather than by a
    // literal, so renaming the copy cannot quietly neuter this.
    expect(body).not.toContain(ANSWER_LABELS.answer);
  });

  it("says nothing about an edit budget it does not have", () => {
    expect(body).not.toMatch(/changed so far/);
  });
});

describe("the other kinds are untouched", () => {
  it("a CODE question reads none of the SQL sentences", () => {
    const body = text(
      render(
        view({
          kind: "CODE" as ExamQuestionKind,
          languageKey: "cpp20",
          languages: [{ key: "cpp20", label: "C++20 (GCC 13.2.0)", shortLabel: "C++20", editorLanguage: "cpp" }],
          starters: { cpp20: "int main() {}" },
        }),
      ),
    );
    expect(body).not.toContain(text(SQL_NOTICES.oneStatement).trim());
    expect(body).not.toContain(text(SQL_NOTICES.readOnly).trim());
  });

  it("an ANSWER question still gets its box and no editor", () => {
    const html = render(
      view({
        kind: "ANSWER" as ExamQuestionKind,
        languageKey: ANSWER_LANGUAGE_KEY,
        languages: [],
        starters: {},
      }),
    );
    expect(html).toContain("<textarea");
    // And NO editor: this is the half that makes the assertion above mean
    // something, because both kinds render a textarea.
    expect(html).not.toContain("data-editor-root");
    expect(text(html)).not.toContain(text(SQL_NOTICES.dialect).trim());
  });
});
