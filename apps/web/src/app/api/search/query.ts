import { z } from "zod";

/**
 * Problem-title search input handling (pure; unit-tested in
 * test/shell-search.test.ts).
 *
 * The query reaches Postgres only as a bound parameter, so this is not an
 * injection fence; it keeps the search well-behaved: control and format
 * characters removed, whitespace collapsed, Unicode normalised (NFKC), length
 * capped, and the LIKE wildcards escaped so "%" or "_" match themselves
 * instead of everything.
 */

export const SEARCH_MIN_LENGTH = 2;
export const SEARCH_MAX_LENGTH = 64;

// Cc (controls) and Cf (format: zero-width joiners, bidi overrides, …).
const INVISIBLE = /[\p{Cc}\p{Cf}]/gu;

/** The cleaned query, or null when nothing searchable is left. */
export function sanitizeSearchQuery(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const cleaned = raw
    .normalize("NFKC")
    .replace(INVISIBLE, " ")
    .replace(/\s+/g, " ")
    .trim();
  // Cap by code points so a surrogate pair is never split.
  const capped = Array.from(cleaned).slice(0, SEARCH_MAX_LENGTH).join("").trim();
  return Array.from(capped).length >= SEARCH_MIN_LENGTH ? capped : null;
}

/** Escape LIKE / ILIKE metacharacters for use with the default "\" escape. */
export function escapeLikePattern(text: string): string {
  return text.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** The route's query-string boundary. */
export const searchParamsSchema = z.object({
  q: z
    .string()
    .max(512, "The search is too long.")
    .transform((value, ctx) => {
      const query = sanitizeSearchQuery(value);
      if (query === null) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Type at least ${SEARCH_MIN_LENGTH} characters.` });
        return z.NEVER;
      }
      return query;
    }),
});
