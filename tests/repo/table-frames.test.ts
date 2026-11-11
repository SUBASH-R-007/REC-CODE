import { describe, expect, it } from "vitest";
import { findFiles, readRepoFile } from "./support/repo";

/**
 * A scrollable table frame contains a TABLE (Phase 13k).
 *
 * `TableFrame` (`components/admin/admin-ui.tsx`) is a `<div>` with
 * `overflow-x-auto`, `tabIndex={0}` and `role="region"` — the wrapper that
 * makes a wide table reachable by keyboard and announced by name. It is
 * only a wrapper: the caller supplies the `<table>`.
 *
 * Four of its fifteen call sites, all under `/admin/aptitude`, supplied
 * `<thead>` and `<tbody>` and no `<table>` at all. What that costs is
 * easy to miss, because the page LOOKS right: React builds the orphaned
 * elements through the DOM API during hydration, and a browser gives a
 * stray `<tr>` an anonymous table box, so the columns still line up.
 *
 * What it actually did:
 *
 *   - **No table semantics.** `document.querySelectorAll("table").length`
 *     was 0 on `/admin/aptitude`. A screen reader was handed a region
 *     containing text, with no rows, no columns and no header cells
 *     associated with anything — on a page whose entire content is a
 *     table. The axe gate did not catch it, because axe checks the table
 *     rules against tables, and there was no table to check.
 *   - **A hydration error on every load.** The server's HTML is parsed by
 *     the browser, which foster-parents table sections out of a `<div>`,
 *     so the markup React found never matched the markup it sent.
 *   - **No caption**, which every other table in the app carries.
 *
 * So the rule, checked as text because it is a markup rule: the first
 * element inside a `<TableFrame>` is a `<table>`. Being text, it also
 * catches the case a type never could — the element is valid JSX and
 * valid React, and only invalid HTML.
 */

const UNDER = ["apps/web/src/app", "apps/web/src/components"];

/** `<TableFrame …>` followed by whitespace and the first opening tag. */
const FRAME = /<TableFrame\b[^>]*>\s*(<\w[\w.]*)/g;

export function openingTagsAfterFrames(source: string): string[] {
  return [...source.matchAll(FRAME)].map((m) => m[1]!);
}

describe("every TableFrame holds a table", () => {
  it("reads the component it is about (sanity)", () => {
    const source = readRepoFile("apps/web/src/components/admin/admin-ui.tsx");
    expect(source, "TableFrame is still the scroll wrapper this fence assumes").toMatch(
      /export function TableFrame\([\s\S]*?overflow-x-auto[\s\S]*?role="region"/,
    );
    // It renders children directly: if it ever grows a <table> of its own,
    // this fence is the thing to delete rather than work around.
    expect(source).toMatch(/export function TableFrame\([\s\S]*?\{children\}/);
  });

  it("is given a <table> and nothing else", () => {
    const wrong: string[] = [];
    for (const file of findFiles({ under: UNDER, extensions: [".tsx"] })) {
      const source = readRepoFile(file);
      if (!source.includes("<TableFrame")) continue;
      for (const tag of openingTagsAfterFrames(source)) {
        if (tag !== "<table") wrong.push(`${file}: ${tag} directly inside <TableFrame>`);
      }
    }
    expect(wrong, "a TableFrame wraps a <table>; thead/tbody/tr without one is not a table at all").toEqual([]);
  });

  it("the scanner finds the mistake it exists for (self-test)", () => {
    expect(openingTagsAfterFrames('<TableFrame label="x">\n  <thead>')).toEqual(["<thead"]);
    expect(openingTagsAfterFrames('<TableFrame label="x">\n  <table className="w-full">')).toEqual(["<table"]);
    expect(openingTagsAfterFrames("no frames here")).toEqual([]);
  });

  it("every table inside one carries a caption", () => {
    /**
     * The sr-only caption is how the region's name and the table's name
     * stay in step; the four broken frames had none, because a `<table>`
     * nobody wrote cannot carry one.
     */
    const missing: string[] = [];
    for (const file of findFiles({ under: UNDER, extensions: [".tsx"] })) {
      const source = readRepoFile(file);
      if (!source.includes("<TableFrame")) continue;
      for (const m of source.matchAll(/<TableFrame\b[^>]*>\s*<table\b[^>]*>([\s\S]{0,200})/g)) {
        if (!m[1]!.includes("<caption")) missing.push(`${file}: a TableFrame's table has no <caption>`);
      }
    }
    expect(missing).toEqual([]);
  });
});
