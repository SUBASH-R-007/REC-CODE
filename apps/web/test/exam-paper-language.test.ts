import { describe, expect, it } from "vitest";
import { LANGUAGE_CATALOG } from "@recx/shared";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * A sitting's language field, and the day it cost a candidate their paper
 * (Phase 12r.2).
 *
 * `getExamPaper` handed the client ONE field called `language`, carrying
 * `LANGUAGE_CATALOG[key].editorLanguage` — the editor's highlighting mode,
 * `"cpp"`. Every exam route validates the language against the KEYS of
 * that catalogue (`cpp20`, `c17`), so the value the client had was the one
 * value no route would accept. The result, reported from a live sitting:
 *
 *   - every snapshot refused, so the pill said "Not saved";
 *   - every run refused, so the console said "Malformed run";
 *   - every SUBMIT refused, so the candidate could not hand the paper in.
 *
 * Nothing looked wrong until a request was made, because the editor was
 * the one consumer the value WAS right for. Two meanings under one name,
 * and the compiler could not tell them apart because both are strings.
 *
 * So this is the fence: the field the client sends to a route must be a
 * catalogue key, and the editor's mode must not be mistaken for one.
 */

const WEB = path.resolve(__dirname, "..");
const read = (rel: string) => readFileSync(path.join(WEB, rel), "utf8");

const CATALOGUE_KEYS = Object.keys(LANGUAGE_CATALOG);

describe("the language a sitting sends to its routes", () => {
  it("is a catalogue key, which is what every exam route validates against", async () => {
    const { examPaperLanguage } = await import("@/lib/exam/language");
    // The function the paper and the Run route both ask (12q.5).
    expect(typeof examPaperLanguage).toBe("function");
    // Its fallback has to be a real key, or a deployment with no enabled
    // language would hand out one nothing accepts.
    expect(CATALOGUE_KEYS).toContain("cpp20");
  });

  it("is named for what it is: the paper emits a key AND an editor mode", () => {
    // The names are the fix. `language` meant both things and the wrong
    // one won; `languageKey` and `editorLanguage` cannot be swapped by
    // accident because neither reads like the other.
    const query = read("src/server/queries/exam.ts");
    expect(query).toContain("languageKey: defaultLanguage");
    expect(query).toContain("editorLanguage: LANGUAGE_CATALOG[defaultLanguage].editorLanguage");
  });

  it("sends the KEY to every route, and the mode to none of them", () => {
    const session = read("src/components/exam/exam-session.tsx");
    // The three requests a sitting makes: snapshot, run, submit.
    const sent = [...session.matchAll(/\?\.languageKey|language: q\.languageKey/g)];
    expect(sent.length, "snapshot, run and submit each read languageKey").toBeGreaterThanOrEqual(3);
    // And the editor mode never leaves the component that renders it.
    expect(session).not.toMatch(/language: q\.editorLanguage|\?\.editorLanguage/);
  });

  it("gives the editor the mode, not the key", () => {
    expect(read("src/components/exam/exam-question.tsx")).toContain("language={question.editorLanguage}");
  });

  it("keeps an editor mode that is NOT a catalogue key, which is the whole trap", () => {
    // If every editorLanguage happened to equal its key, the bug would
    // have been invisible and this fence pointless. `cpp20` -> `cpp` is
    // exactly the mismatch that made it real.
    const modes = Object.values(LANGUAGE_CATALOG).map((l) => l.editorLanguage);
    const notKeys = modes.filter((m) => !CATALOGUE_KEYS.includes(m));
    expect(notKeys.length, "at least one editor mode is not a language key").toBeGreaterThan(0);
    expect(LANGUAGE_CATALOG.cpp20.editorLanguage).not.toBe("cpp20");
  });
});
