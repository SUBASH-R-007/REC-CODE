import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { clientProctorEventSchema } from "@recx/shared";

/**
 * Refusing a paste that was not copied inside the sitting (Phase 12s).
 *
 * Asked for as "only accept content to pasted that was copied inside
 * only". It is an OPTION, off by default, because the engine's standing
 * decision is the opposite one and it is a good one — SPEC §5, quoted in
 * `exam-session.tsx`: blocking is bypassable and counterproductive,
 * students legitimately paste their own earlier code, blocking drives them
 * to clipboard-typing macros which SILENCES the signal, and
 * `preventDefault` on copy or contextmenu breaks assistive technology.
 *
 * So the shape is the substance here, and these are the four properties
 * that keep all three objections answered. They are asserted against the
 * source because the behaviour lives in a browser event handler whose
 * `preventDefault` cannot be observed from a unit test — and because each
 * one is a decision somebody could undo without noticing what it cost.
 */

const WEB = path.resolve(__dirname, "..");
const read = (rel: string) => readFileSync(path.join(WEB, rel), "utf8");
const SESSION = () => read("src/components/exam/exam-session.tsx");

describe("the paste policy", () => {
  it("is off unless the paper asks for it", () => {
    // The default lives in the schema and in the action; a paper that says
    // nothing gets the instrumented-not-blocked behaviour SPEC chose.
    expect(readFileSync(path.join(WEB, "../../packages/db/prisma/schema.prisma"), "utf8")).toMatch(
      /refuseOutsidePaste\s+Boolean\s+@default\(false\)/,
    );
    expect(read("src/server/actions/admin-assessments.ts")).toContain(
      "refuseOutsidePaste: z.boolean().optional().default(false)",
    );
  });

  it("refuses only a paste INTO THE EDITOR, so assistive technology keeps working", () => {
    const s = SESSION();
    // The guard is the editor root, not the document.
    expect(s).toContain('target.closest("[data-editor-root]")');
    // And nothing else is ever prevented: copy, cut and the context menu
    // are recorded and left alone, which is SPEC's third objection.
    const prevented = [...s.matchAll(/preventDefault\(\)/g)];
    expect(prevented.length, "exactly one preventDefault, in the paste handler").toBe(1);
    for (const handler of ["onCopy", "onCut", "onContextMenu"]) {
      const at = s.indexOf(`const ${handler} =`);
      expect(at, handler).toBeGreaterThan(-1);
      const body = s.slice(at, at + 400);
      expect(body, `${handler} must not preventDefault`).not.toContain("preventDefault");
    }
  });

  it("still records the paste, so the signal is not silenced", () => {
    // SPEC's substantive objection: a block that hides the attempt is
    // worse than no block. The refusal path falls through to the same
    // `record(...)` every paste takes.
    const s = SESSION();
    const handler = s.slice(s.indexOf("const onPaste ="), s.indexOf("const onContextMenu ="));
    expect(handler).toContain("preventDefault");
    expect(handler).toContain("record({ kind, atMs: atMs(), size");
    expect(handler).toContain("classifyPaste");
  });

  it("decides from text held in the browser, never from a field on the wire", () => {
    /**
     * Two rules at once. `preventDefault` is only honoured inside the
     * event's own tick, so the decision cannot wait for WebCrypto — hence
     * a synchronous set of the copied text, in memory, which never leaves
     * the page (docs/PROCTORING.md §5 forbids clipboard content capture).
     * And the wire schema is strict, so a "refused" field would have made
     * the server reject the whole batch and lose every event in it.
     */
    const s = SESSION();
    expect(s).toContain("copiedTexts");
    expect(s, "the copied-text memory is bounded").toContain("COPIED_TEXT_MEMORY");
    expect(s, "no refused flag on the wire").not.toMatch(/record\(\{[^}]*refused/);
    expect(() =>
      clientProctorEventSchema.parse({ kind: "EXTERNAL_PASTE", clientSeq: 1, atMs: 0, size: 10, refused: true }),
    ).toThrow();
    // The event the refusal does send is accepted.
    expect(() =>
      clientProctorEventSchema.parse({ kind: "EXTERNAL_PASTE", clientSeq: 1, atMs: 0, size: 10 }),
    ).not.toThrow();
  });

  it("tells the candidate why nothing appeared, and says their own work still pastes", () => {
    // A refusal with no explanation is a bug report. The notice names the
    // rule and the exception to it.
    const s = SESSION();
    expect(s).toContain("not copied inside this sitting");
    expect(s).toContain("own earlier work still pastes");
  });
});
