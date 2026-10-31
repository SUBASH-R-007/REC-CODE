import { describe, expect, it } from "vitest";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ToastProvider } from "@recx/design";
import { PROBLEM_KINDS, PROBLEM_KIND_HINT, PROBLEM_KIND_LABEL, type ProblemKind } from "@recx/shared";
import { CatalogTable } from "@/components/problems/catalog-table";
import { ProblemKindChip } from "@/components/problems/kind-chip";
import type { CatalogRow } from "@/server/queries/problems";

/**
 * The kind of a question, in the list a student picks from (Phase 12p,
 * slice 3).
 *
 * Two rules, and they pull against each other: every kind that is not an
 * ordinary program must be named, and an ordinary program must NOT be —
 * a chip on every row is a chip nobody reads. The words come from
 * `@recx/shared`, so the list and the workspace cannot drift.
 */

(globalThis as { React?: typeof React }).React = React;

const text = (html: string) =>
  html
    .replace(/<!-- -->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

/** The table's bookmark toggle is a client island that wants the toast context. */
function table(rows: CatalogRow[]): string {
  return renderToStaticMarkup(
    React.createElement(ToastProvider, null, React.createElement(CatalogTable, { rows, caption: "Problems" })),
  );
}

function row(kind: ProblemKind, i = 0): CatalogRow {
  return {
    id: `p${i}`,
    slug: `problem-${i}`,
    displayCode: `REC-100${i}`,
    title: `Problem ${i}`,
    difficulty: "EASY",
    solve: null,
    topics: [],
    kind,
    submissions: 0,
    accepted: 0,
    bookmarked: false,
  };
}

describe("the kind chip", () => {
  it("names every kind that is not an ordinary program", () => {
    for (const kind of PROBLEM_KINDS) {
      if (kind === "program") continue;
      const body = text(renderToStaticMarkup(React.createElement(ProblemKindChip, { kind })));
      expect(body, kind).toContain(PROBLEM_KIND_LABEL[kind]);
      // And says what the word means, for a reader who cannot see a chip.
      expect(body, kind).toContain(PROBLEM_KIND_HINT[kind]);
    }
  });

  it("renders nothing at all for an ordinary program", () => {
    expect(renderToStaticMarkup(React.createElement(ProblemKindChip, { kind: "program" }))).toBe("");
  });

  it("carries its meaning in words, not in a colour", () => {
    const html = renderToStaticMarkup(React.createElement(ProblemKindChip, { kind: "sql" }));
    // The label is text in the markup; nothing here depends on the chip's
    // own colour, which is the same neutral treatment the topic tags use.
    expect(html).toContain(PROBLEM_KIND_LABEL.sql);
    expect(html).not.toMatch(/aria-hidden/);
  });
});

describe("the catalogue row", () => {
  it("shows the chip beside the title, for each named kind", () => {
    const rows = PROBLEM_KINDS.map((kind, i) => row(kind, i));
    const body = text(table(rows));
    for (const kind of PROBLEM_KINDS) {
      if (kind === "program") continue;
      expect(body, kind).toContain(PROBLEM_KIND_LABEL[kind]);
    }
  });

  it("leaves a page of ordinary programs unlabelled", () => {
    const rows = [row("program", 0), row("program", 1), row("program", 2)];
    const body = text(table(rows));
    for (const kind of PROBLEM_KINDS) {
      if (kind === "program") continue;
      expect(body, `a page of programs must not mention ${kind}`).not.toContain(PROBLEM_KIND_LABEL[kind]);
    }
  });

  it("still links every row to the problem, chip or no chip", () => {
    const rows = PROBLEM_KINDS.map((kind, i) => row(kind, i));
    const html = table(rows);
    for (let i = 0; i < rows.length; i++) expect(html).toContain(`/problems/problem-${i}`);
  });
});
