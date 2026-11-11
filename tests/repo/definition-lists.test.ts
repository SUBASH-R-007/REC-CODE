import { describe, expect, it } from "vitest";
import { findFiles, isTestPath, lineAt, readRepoFile } from "./support/repo";

/**
 * A `<dl>` holds `<dt>` and `<dd>` groups, and nothing else.
 *
 * HTML allows a `<dl>` to wrap each pair in a `<div>`, which this codebase
 * does all over the place for the little bordered stat cards. What it does
 * NOT allow is a third element in that group — and the one that gets
 * written is a `<p>` with a hint under the number:
 *
 *     <div>
 *       <dt>Considered</dt>
 *       <dd>128</dd>
 *       <p>Students the sweep looked at.</p>   ← invalid
 *     </div>
 *
 * It looks perfect. It is serious to axe (`definition-list`), because a
 * screen reader walking the list announces the terms and descriptions and
 * has nowhere to put the stray paragraph: the hint is read adrift from the
 * figure it explains, or not at all.
 *
 * Found on `/super/jobs` by the axe suite, in all four viewport and theme
 * combinations, long after the page had been looked at by eye and read
 * perfectly. That suite needs a live stack and 16 minutes; this check is
 * static and runs in the gate, which is where a mistake this mechanical
 * should be caught.
 *
 * The fix is to put the hint inside the `<dd>`, where it belongs: it is
 * part of the description.
 */

/** Block elements that are never a dt/dd group's third child. */
const STRAY = ["p", "ul", "ol", "h1", "h2", "h3", "h4", "section", "article", "table", "form"];

interface Finding {
  readonly file: string;
  readonly line: number;
  readonly what: string;
}

/**
 * Walk a `<dl>`'s literal tags, keeping a stack, and report a stray block
 * element whose ancestors inside the list are only `<div>` groups.
 *
 * **It gives up the moment a COMPONENT is in the way.** `<Fact term="...">`
 * on `/judge` renders the `<dt>` and the `<dd>` itself, so a `<ul>` written
 * inside it is inside a description and perfectly valid -- a scanner that
 * flagged it would be wrong, and a fence with a false positive is a fence
 * people learn to skip. So a capitalised tag anywhere in the ancestor chain
 * means "not mine to judge".
 */
export function strayInDefinitionList(file: string, source: string): Finding[] {
  const findings: Finding[] = [];
  for (const open of source.matchAll(/<dl\b/g)) {
    const close = source.indexOf("</dl>", open.index);
    if (close === -1) continue;
    const block = source.slice(open.index + 3, close);
    const stack: string[] = [];
    for (const tag of block.matchAll(/<(\/?)([A-Za-z][\w.]*)([^>]*?)(\/?)>/g)) {
      const [, slash, name, attrs, selfClose] = tag;
      const closing = slash === "/";
      const selfClosed = selfClose === "/" || (attrs ?? "").endsWith("/");
      if (closing) {
        const at = stack.lastIndexOf(name!);
        if (at !== -1) stack.length = at;
        continue;
      }
      const inside = (needle: string) => stack.includes(needle);
      if (
        STRAY.includes(name!) &&
        !inside("dd") &&
        !inside("dt") &&
        // Nothing but literal <div> groups between the list and this tag.
        stack.every((parent) => parent === "div")
      ) {
        findings.push({
          file,
          line: lineAt(source, open.index + 3 + (tag.index ?? 0)),
          what: `<${name}> inside <dl>`,
        });
      }
      if (!selfClosed && !VOID_ELEMENTS.has(name!)) stack.push(name!);
    }
  }
  return findings;
}

/** Tags with no closing tag, so they never go on the stack. */
const VOID_ELEMENTS = new Set(["br", "hr", "img", "input", "meta", "link", "source", "track", "wbr"]);

describe("detector self-test", () => {
  it("flags the shape that failed on /super/jobs", () => {
    const snippet = `<dl><div><dt>Considered</dt><dd>128</dd><p>Students the sweep looked at.</p></div></dl>`;
    expect(strayInDefinitionList("x.tsx", snippet)).toHaveLength(1);
  });

  it("allows the fix: the hint inside the description", () => {
    const snippet = `<dl><div><dt>Considered</dt><dd><span>128</span>Students the sweep looked at.</dd></div></dl>`;
    expect(strayInDefinitionList("x.tsx", snippet)).toEqual([]);
  });

  it("allows a paragraph inside a <dd>, which is valid", () => {
    expect(strayInDefinitionList("x.tsx", `<dl><dt>A</dt><dd><p>why</p></dd></dl>`)).toEqual([]);
  });

  it("leaves a paragraph after the list alone", () => {
    expect(strayInDefinitionList("x.tsx", `<dl><dt>A</dt><dd>B</dd></dl><p>after</p>`)).toEqual([]);
  });

  it("says nothing when a component renders the group, because it cannot know", () => {
    // `/judge` writes <Fact term="Toolchain"><ul>…</ul></Fact>, and Fact
    // renders the <dt> and <dd>. Flagging that would be wrong.
    const snippet = `<dl><Fact term="Toolchain"><ul><li>a</li></ul></Fact></dl>`;
    expect(strayInDefinitionList("x.tsx", snippet)).toEqual([]);
  });

  it("reads each list separately", () => {
    const two = `<dl><dt>A</dt><dd>B</dd></dl>\n<dl><dt>C</dt><dd>D</dd><p>stray</p></dl>`;
    expect(strayInDefinitionList("x.tsx", two)).toHaveLength(1);
  });
});

describe("every definition list in the web app", () => {
  const files = findFiles({ under: ["apps/web/src"], extensions: [".tsx"], exclude: isTestPath });

  it("scans the components (sanity)", () => {
    expect(files.length).toBeGreaterThan(50);
    expect(files.some((f) => readRepoFile(f).includes("<dl"))).toBe(true);
  });

  it("holds only terms and descriptions", () => {
    const strays = files
      .flatMap((file) => strayInDefinitionList(file, readRepoFile(file)))
      .map((f) => `${f.file}:${f.line}  ${f.what} — put it inside the <dd>, which is what describes the term`);
    expect(strays).toEqual([]);
  });
});
