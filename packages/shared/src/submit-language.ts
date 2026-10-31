import { ANSWER_EDITOR_LANGUAGE, ANSWER_LANGUAGE_KEY, ANSWER_LANGUAGE_LABEL, isAnswerLanguage } from "./answer-problem";
import { LANGUAGE_CATALOG, LANGUAGE_KEYS, isLanguageKey, type LanguageKey } from "./languages";
import { SQL_EDITOR_LANGUAGE, SQL_LANGUAGE_KEY, SQL_LANGUAGE_LABEL, isSqlLanguage } from "./sql-language";

/**
 * Every key a submission may carry: the toolchains, plus the two that are
 * not toolchains at all.
 *
 * Kept apart from `LANGUAGE_KEYS` on purpose — that list is what the judge
 * worker compiles and runs, and nothing else in this one belongs in an
 * argv. This is the list the student-facing surfaces work with: the
 * language picker, a draft, a submission row, a profile's language
 * breakdown.
 *
 *   `sql17`   one statement against a dataset (Phase 12k), judged by the
 *             postgres engine;
 *   `answer1` the answer itself (Phase 12n), judged by comparing text —
 *             nothing is compiled and nothing is run.
 *
 * It lives in a module of its own because it is no longer about SQL: a
 * list named after one of its members is a list somebody will forget to
 * add the third one to.
 */
export type SubmitLanguageKey = LanguageKey | typeof SQL_LANGUAGE_KEY | typeof ANSWER_LANGUAGE_KEY;

export const SUBMIT_LANGUAGE_KEYS: readonly SubmitLanguageKey[] = Object.freeze([
  ...LANGUAGE_KEYS,
  SQL_LANGUAGE_KEY,
  ANSWER_LANGUAGE_KEY,
]);

export function isSubmitLanguage(value: unknown): value is SubmitLanguageKey {
  return typeof value === "string" && (SUBMIT_LANGUAGE_KEYS as readonly string[]).includes(value);
}

/** The two keys that are languages a student submits in but not toolchains. */
export function isToolchainLanguage(key: string): key is LanguageKey {
  return isLanguageKey(key) && !isSqlLanguage(key) && !isAnswerLanguage(key);
}

/**
 * The label for any language key a submission may carry.
 *
 * The fallback is the key itself, because a row written by a LanguageConfig
 * that has since been removed is still a row somebody's profile has to
 * render, and "sql17" on a screen is better than a crash.
 */
export function submitLanguageLabel(key: string): string {
  if (isSqlLanguage(key)) return SQL_LANGUAGE_LABEL;
  if (isAnswerLanguage(key)) return ANSWER_LANGUAGE_LABEL;
  return isLanguageKey(key) ? LANGUAGE_CATALOG[key].label : key;
}

/** The editor grammar for a language key; "plaintext" when there is none. */
export function submitEditorLanguage(key: string): string {
  if (isSqlLanguage(key)) return SQL_EDITOR_LANGUAGE;
  if (isAnswerLanguage(key)) return ANSWER_EDITOR_LANGUAGE;
  return isLanguageKey(key) ? LANGUAGE_CATALOG[key].editorLanguage : "plaintext";
}
