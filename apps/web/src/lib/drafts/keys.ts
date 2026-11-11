/**
 * Draft persistence constants, shared by the browser side (IndexedDB, the
 * beacon) and the server side (the action, the /api/drafts route and the
 * page that reads the language cookie). No I/O here.
 */

/** IndexedDB write: 400 ms after the last keystroke. */
export const LOCAL_DEBOUNCE_MS = 400;
/** Server CodeDraft write: 3 s after the last keystroke (and on blur / page hide). */
export const SERVER_DEBOUNCE_MS = 3_000;
/** Retry delays for a failed server save (offline, rate limited, 5xx). */
export const SERVER_RETRY_MS: readonly number[] = [5_000, 10_000, 20_000, 40_000, 60_000];

/** Where page-hide beacons are posted. */
export const DRAFT_BEACON_URL = "/api/drafts";

/**
 * The language the student last picked, as a plain (non-HttpOnly) cookie so
 * the server renders the workspace in that language with no flash.
 */
export const LANGUAGE_COOKIE = "recx_lang";

/**
 * A device clock may run ahead. A clientUpdatedAt further than this past
 * the server's clock is clamped, so one fast clock cannot make its copy win
 * every later comparison (or refuse every later save from a correct clock).
 */
export const MAX_CLOCK_SKEW_MS = 2 * 60_000;

/** The IndexedDB key of one (problem, language) draft. */
export function localDraftKey(problemId: string, language: string): string {
  return `draft:${problemId}:${language}`;
}

/** Phase 1 kept drafts in localStorage under this key; read once, then migrated. */
export function legacyDraftKey(slug: string, language: string): string {
  return `recx:draft:${slug}:${language}`;
}

/** Retry delay before failed server save number `failures` (1-based). */
export function serverRetryDelayMs(failures: number): number {
  const n = Number.isFinite(failures) ? Math.max(1, Math.floor(failures)) : 1;
  const last = SERVER_RETRY_MS[SERVER_RETRY_MS.length - 1] ?? 60_000;
  return SERVER_RETRY_MS[n - 1] ?? last;
}
