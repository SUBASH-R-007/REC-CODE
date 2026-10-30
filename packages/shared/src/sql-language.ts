import { z } from "zod";
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
