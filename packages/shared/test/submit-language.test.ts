import { describe, expect, it } from "vitest";
import {
  ANSWER_EDITOR_LANGUAGE,
  ANSWER_LANGUAGE_KEY,
  ANSWER_LANGUAGE_LABEL,
  ANSWER_STARTER_CODE,
  LANGUAGE_KEYS,
  SQL_EDITOR_LANGUAGE,
  SQL_LANGUAGE_KEY,
  SQL_LANGUAGE_LABEL,
  SQL_STARTER_CODE,
  SUBMIT_LANGUAGE_KEYS,
  isAnswerLanguage,
  isSubmitLanguage,
  isToolchainLanguage,
  submitEditorLanguage,
  submitLanguageLabel,
} from "../src/index";

/**
 * The one list of languages a submission may carry: every toolchain, plus
 * the two that are not toolchains at all — `sql17` (Phase 12k) and
 * `answer1` (Phase 12n). Moved out of the SQL tests when the third one
 * arrived, because a list named after one of its members is a list
 * somebody forgets to extend.
 */

describe("the languages a submission may carry", () => {
  it("is every toolchain plus SQL and the answer file, and nothing else", () => {
    expect(SUBMIT_LANGUAGE_KEYS).toEqual([...LANGUAGE_KEYS, SQL_LANGUAGE_KEY, ANSWER_LANGUAGE_KEY]);
    expect(SUBMIT_LANGUAGE_KEYS).toHaveLength(LANGUAGE_KEYS.length + 2);
    for (const key of SUBMIT_LANGUAGE_KEYS) expect(isSubmitLanguage(key)).toBe(true);
    for (const bad of ["", "sql", "SQL17", "mysql8", "answer", "answer2", null, 7]) {
      expect(isSubmitLanguage(bad)).toBe(false);
    }
  });

  it("keeps the two apart from the toolchains, which is what the judge compiles", () => {
    expect(isToolchainLanguage("cpp20")).toBe(true);
    expect(isToolchainLanguage(SQL_LANGUAGE_KEY)).toBe(false);
    expect(isToolchainLanguage(ANSWER_LANGUAGE_KEY)).toBe(false);
    expect(LANGUAGE_KEYS as readonly string[]).not.toContain(ANSWER_LANGUAGE_KEY);
  });

  it("labels each one, and an unknown key as itself", () => {
    expect(submitLanguageLabel(SQL_LANGUAGE_KEY)).toBe(SQL_LANGUAGE_LABEL);
    expect(submitLanguageLabel(ANSWER_LANGUAGE_KEY)).toBe(ANSWER_LANGUAGE_LABEL);
    expect(submitLanguageLabel("cpp20")).toContain("C++20");
    // A row whose LanguageConfig is long gone still renders.
    expect(submitLanguageLabel("rust180")).toBe("rust180");
  });

  it("gives each one an editor grammar, and an unknown key plaintext", () => {
    expect(submitEditorLanguage(SQL_LANGUAGE_KEY)).toBe(SQL_EDITOR_LANGUAGE);
    expect(submitEditorLanguage(ANSWER_LANGUAGE_KEY)).toBe(ANSWER_EDITOR_LANGUAGE);
    expect(submitEditorLanguage("py312")).toBe("python");
    expect(submitEditorLanguage("rust180")).toBe("plaintext");
  });

  it("opens a SQL editor with a comment and an answer box with nothing", () => {
    expect(SQL_STARTER_CODE.trim().startsWith("--")).toBe(true);
    expect(SQL_STARTER_CODE).not.toMatch(/select/i);
    // A comment here would be a line the student has to delete first.
    expect(ANSWER_STARTER_CODE).toBe("");
    expect(isAnswerLanguage(ANSWER_LANGUAGE_KEY)).toBe(true);
    expect(isAnswerLanguage(SQL_LANGUAGE_KEY)).toBe(false);
  });
});
