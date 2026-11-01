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
    const mod = await import("@/lib/exam/language");
    // One derivation, and the readers the exam surfaces ask (12q.5, 12r.4,
    // and the SET of them in 13a).
    expect(typeof mod.examPaperLanguage).toBe("function");
    expect(typeof mod.languageOfSitting).toBe("function");
    expect(typeof mod.languagesOfSitting).toBe("function");
    expect(typeof mod.acceptedLanguagesFor).toBe("function");
    // The fallback has to be a real key, or a deployment with no enabled
    // language would hand out one nothing accepts.
    expect(CATALOGUE_KEYS).toContain("cpp20");
  });

  it("is read from the sitting's own layout, not derived per request", () => {
    /**
     * Phase 12r.4. Deriving it per request meant an administrator enabling
     * a toolchain whose key sorts earlier, while somebody was part way
     * through, moved that candidate's whole paper to it. Phase 13a froze
     * the whole accepted SET for the same reason, so every one of these
     * reads `languagesOfSitting(layout)` and not the assessment's current
     * list.
     */
    expect(read("src/lib/exam/language.ts")).toContain("export async function languagesOfSitting");
    expect(read("src/lib/exam/language.ts")).toContain("export async function languagesOfQuestion");
    for (const rel of [
      "src/server/queries/exam.ts",
      "src/app/api/exam/[attemptId]/run/route.ts",
      "src/app/api/exam/[attemptId]/snapshot/route.ts",
      "src/lib/exam/submit.ts",
    ]) {
      // Either reader: the paper's set, or the question's narrowing of it
      // (Phase 13c). Both read the layout and neither reads the live rows.
      expect(read(rel), rel).toMatch(/languagesOf(Sitting|Question)\(/);
      expect(read(rel), rel).not.toContain("allowedLanguages");
    }
  });

  it("is named for what it is: the paper emits keys AND editor modes, separately", () => {
    // The names are the fix. `language` meant both things and the wrong
    // one won; a key and an editor mode cannot be swapped by accident
    // because neither reads like the other.
    const query = read("src/server/queries/exam.ts");
    // The key a question OPENS in — the first language it accepts, which
    // is the paper's default unless the question narrows past it (13c).
    expect(query).toContain("languageKey: acceptedFor(question.questionId)[0] ?? defaultLanguage");
    // Phase 13a: the modes travel inside the accepted-language views,
    // resolved on the server, each field named for what it carries.
    expect(query).toContain("paperLanguageViews(accepted)");
    // Phase 13c: and the per-question list the pane actually renders.
    expect(query).toContain("paperLanguageViews(acceptedFor(");
  });

  it("sends the KEY to every route, and the mode to none of them", () => {
    const session = read("src/components/exam/exam-session.tsx");
    // The three requests a sitting makes: snapshot, run, submit. Each
    // reads the question's chosen language, falling back to the key.
    const sent = [...session.matchAll(/langsRef\.current\[/g)];
    expect(sent.length, "snapshot, run and submit each read the chosen language").toBeGreaterThanOrEqual(3);
    // And the editor mode never leaves the component that renders it.
    expect(session).not.toMatch(/language: q\.editorLanguage|\?\.editorLanguage/);
    // Nothing in the session READS an editor mode: it holds keys, hands
    // the views straight to the pane, and the pane picks the mode out.
    // (The only mention left is the Phase 12r.2 story in a comment.)
    expect(session.replace(/\/\*[\s\S]*?\*\//g, "")).not.toContain("editorLanguage");
  });

  it("gives the editor the mode of the language the candidate picked", () => {
    // Phase 13a: the pane renders the ACTIVE language's grammar, so the
    // highlighting follows the picker. Before it, the mode was fixed to
    // the paper's one language.
    const pane = read("src/components/exam/exam-question.tsx");
    expect(pane).toContain("language={active?.editorLanguage");
    expect(pane).toContain("onLanguageChange");
  });

  it("validates membership of the accepted set, not equality with one language", () => {
    /**
     * Phase 13a. A paper may accept several languages, so a route
     * comparing against ONE would refuse a candidate's legitimate choice
     * -- which is exactly how a sitting felt before this phase, when the
     * only language was whichever toolchain key sorted first.
     */
    for (const rel of [
      "src/app/api/exam/[attemptId]/run/route.ts",
      "src/app/api/exam/[attemptId]/snapshot/route.ts",
      "src/lib/exam/submit.ts",
    ]) {
      expect(read(rel), rel).toContain("acceptsLanguage(");
    }
  });

  it("looks up a toolchain row per language used, not one for the paper", () => {
    /**
     * The defect this fence exists for (Phase 13a). `submitAttempt` read
     * the LanguageConfig for `answers[0].language` and stamped every
     * submission with it. Invisible while a sitting had one language; the
     * moment it had two, a paper answered in Python and C would have had
     * the Python compiled by gcc and come back as a compile error on a
     * correct program.
     */
    const submit = read("src/lib/exam/submit.ts");
    expect(submit).toContain("configs.get(answer.language)");
    expect(submit).not.toMatch(/languageConfigId: config\.id/);
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
