import { z } from "zod";
import { LANGUAGE_CATALOG, LANGUAGE_KEYS, isLanguageKey, type LanguageKey } from "./languages";
import { SQL_DIALECT, SQL_DIALECT_LABEL } from "./sql-problem";
import type { IoMode } from "./protocol";

/**
 * SQL as a language a student writes in, which is NOT a language in the
 * toolchain catalogue (Phase 12k).
 *
 * `LANGUAGE_KEYS` describes toolchains: a compile argv, a run argv, an
 * `/opt/toolchains` directory, a process limit, an open-file limit. A SQL
 * submission has none of those — it is one statement handed to a database
 * — so putting it in that list would mean inventing values for nine fields
 * that describe nothing, and the judge worker validates that a runtime
 * points inside `/opt/toolchains`.
 *
 * So SQL gets its own key, its own runtime shape and its own label. What
 * it shares with every other language is the `LanguageConfig` row: a
 * submission still points at one, which is what keeps `Submission`
 * unchanged and the whole pipeline — XP, the leaderboard, contests,
 * assessments, rejudges — working with no change at all.
 */

export const SQL_LANGUAGE_KEY = "sql17";

/** What a student sees in the footer, the submission list and their profile. */
export const SQL_LANGUAGE_LABEL = SQL_DIALECT_LABEL[SQL_DIALECT];

/** Monaco / CodeMirror language id. */
export const SQL_EDITOR_LANGUAGE = "sql";

/**
 * The `LanguageConfig.runtime` of the SQL row. Deliberately nothing like
 * `LanguageRuntime`: no argv, no environment, no toolchain. A reader who
 * finds this in the column knows at once which engine judges it.
 */
export const sqlRuntimeSchema = z
  .object({
    key: z.literal(SQL_LANGUAGE_KEY),
    engine: z.literal("postgres"),
    dialect: z.literal(SQL_DIALECT),
    label: z.string().min(1).max(64),
    editorLanguage: z.literal(SQL_EDITOR_LANGUAGE),
  })
  .strict();
export type SqlRuntime = z.infer<typeof sqlRuntimeSchema>;

export const SQL_RUNTIME: SqlRuntime = Object.freeze({
  key: SQL_LANGUAGE_KEY,
  engine: "postgres",
  dialect: SQL_DIALECT,
  label: SQL_LANGUAGE_LABEL,
  editorLanguage: SQL_EDITOR_LANGUAGE,
});

/** The toolchain id of the SQL row, so the unique (key, toolchainId) holds. */
export const SQL_TOOLCHAIN_ID = "postgres-17";

export function isSqlLanguage(key: string): boolean {
  return key === SQL_LANGUAGE_KEY;
}

/**
 * Which engine judges a problem of this kind.
 *
 * The one place the mapping lives, so the queue, the claim and the fleet
 * page cannot disagree about it.
 */
export function engineForIoMode(ioMode: IoMode): "isolate" | "postgres" {
  return ioMode === "SQL" ? "postgres" : "isolate";
}

/**
 * The starter a SQL problem opens with when its author wrote none.
 *
 * A comment and nothing else: a half-written SELECT would be a hint
 * nobody authored, and an empty editor on a question whose answer is one
 * statement reads like a page that failed to load.
 */
export const SQL_STARTER_CODE = "-- Write one query.\n";

/**
 * Every key a submission may carry: the toolchains, plus SQL.
 *
 * Kept apart from `LANGUAGE_KEYS` on purpose — that list is what the judge
 * worker compiles and runs, and nothing in this one belongs in an argv.
 * This is the list the student-facing surfaces work with: the language
 * picker, a draft, a submission row, a profile's language breakdown.
 */
export type SubmitLanguageKey = LanguageKey | typeof SQL_LANGUAGE_KEY;
export const SUBMIT_LANGUAGE_KEYS: readonly SubmitLanguageKey[] = Object.freeze([...LANGUAGE_KEYS, SQL_LANGUAGE_KEY]);

export function isSubmitLanguage(value: unknown): value is SubmitLanguageKey {
  return typeof value === "string" && (SUBMIT_LANGUAGE_KEYS as readonly string[]).includes(value);
}

/**
 * The label for any language key a submission may carry, SQL included.
 *
 * The fallback is the key itself, because a row written by a LanguageConfig
 * that has since been removed is still a row somebody's profile has to
 * render, and "sql17" on a screen is better than a crash.
 */
export function submitLanguageLabel(key: string): string {
  if (isSqlLanguage(key)) return SQL_LANGUAGE_LABEL;
  return isLanguageKey(key) ? LANGUAGE_CATALOG[key].label : key;
}

/** The editor grammar for a language key; "plaintext" when there is none. */
export function submitEditorLanguage(key: string): string {
  if (isSqlLanguage(key)) return SQL_EDITOR_LANGUAGE;
  return isLanguageKey(key) ? LANGUAGE_CATALOG[key].editorLanguage : "plaintext";
}
