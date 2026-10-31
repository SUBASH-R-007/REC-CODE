/**
 * The /api/search response contract, shared by the route handler and the
 * command palette. Dependency-free on purpose (the palette is client code).
 */

export type SearchDifficulty = "EASY" | "MEDIUM" | "HARD";
export type SearchSolveState = "solved" | "attempted" | null;

export interface SearchResult {
  slug: string;
  displayCode: string;
  title: string;
  difficulty: SearchDifficulty;
  /** The viewer's own progress on the problem; null = not attempted. */
  status: SearchSolveState;
}

export interface SearchResponse {
  results: SearchResult[];
}

/** Matches the server's slug rule closely enough to refuse anything odd. */
const SLUG = /^[a-z0-9][a-z0-9-]{0,99}$/;
const DIFFICULTIES: ReadonlySet<string> = new Set(["EASY", "MEDIUM", "HARD"]);

export const SEARCH_RESULT_LIMIT = 8;

/** Client-side validation of the JSON (never trust a response shape). */
export function parseSearchResponse(payload: unknown): SearchResult[] {
  if (typeof payload !== "object" || payload === null) return [];
  const results = (payload as { results?: unknown }).results;
  if (!Array.isArray(results)) return [];
  const out: SearchResult[] = [];
  for (const raw of results) {
    if (typeof raw !== "object" || raw === null) continue;
    const r = raw as Record<string, unknown>;
    if (
      typeof r.slug !== "string" ||
      !SLUG.test(r.slug) ||
      typeof r.displayCode !== "string" ||
      typeof r.title !== "string" ||
      typeof r.difficulty !== "string" ||
      !DIFFICULTIES.has(r.difficulty)
    ) {
      continue;
    }
    const status: SearchSolveState = r.status === "solved" || r.status === "attempted" ? r.status : null;
    out.push({
      slug: r.slug,
      displayCode: r.displayCode,
      title: r.title,
      difficulty: r.difficulty as SearchDifficulty,
      status,
    });
    if (out.length >= SEARCH_RESULT_LIMIT) break;
  }
  return out;
}
