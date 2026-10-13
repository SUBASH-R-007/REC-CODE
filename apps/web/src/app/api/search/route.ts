import { Prisma } from "@recx/db";
import { getCurrentUser } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { hitRateLimit } from "@/lib/rate-limit";
import { escapeLikePattern, searchParamsSchema } from "@/app/api/search/query";
import {
  SEARCH_RESULT_LIMIT,
  type SearchDifficulty,
  type SearchResponse,
  type SearchResult,
} from "@/components/shell/search-result";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Generous for a debounced palette; stops a script hammering the index. */
const SEARCH_RATE_LIMIT = { limit: 90, windowMs: 60_000 };

const NO_STORE = { "cache-control": "private, no-store" };

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: NO_STORE });
}

interface Row {
  slug: string;
  displayCode: string;
  title: string;
  difficulty: string;
  status: string | null;
}

/**
 * GET /api/search?q=… — the command palette's problem search.
 *
 * Signed-in users only; PUBLISHED problems with a live version only; at most
 * eight rows. Matching uses the pg_trgm GIN index on Problem.title
 * (migration 20261010001004): a substring ILIKE (which the trigram index
 * serves) or trigram similarity (`%`, for typos), plus a display-code prefix.
 * Title-prefix matches rank first, then similarity. The viewer's own solve
 * state comes along so the palette can show it; nobody else's data does.
 */
export async function GET(request: Request): Promise<Response> {
  const user = await getCurrentUser();
  if (!user) return json({ error: "Sign in to search." }, 401);

  const url = new URL(request.url);
  const parsed = searchParamsSchema.safeParse({ q: url.searchParams.get("q") ?? "" });
  if (!parsed.success) {
    // Too short or empty: an empty result, not an error, keeps the palette simple.
    return json({ results: [] } satisfies SearchResponse);
  }
  const q = parsed.data.q;

  const limited = await hitRateLimit(`search:${user.id}`, SEARCH_RATE_LIMIT);
  if (!limited.allowed) {
    return Response.json(
      { error: "Too many searches. Wait a moment and try again." },
      { status: 429, headers: { ...NO_STORE, "retry-after": String(Math.ceil(limited.retryAfterMs / 1000)) } },
    );
  }

  const escaped = escapeLikePattern(q);
  const contains = `%${escaped}%`;
  const prefix = `${escaped}%`;

  const rows = await db.$queryRaw<Row[]>(Prisma.sql`
    SELECT p."slug", p."displayCode", p."title", p."difficulty"::text AS "difficulty", s."status"::text AS "status"
    FROM "Problem" p
    LEFT JOIN "UserProblemStatus" s ON s."problemId" = p."id" AND s."userId" = ${user.id}
    WHERE p."status" = 'PUBLISHED'
      AND p."liveVersionId" IS NOT NULL
      AND (p."title" ILIKE ${contains} OR p."title" % ${q} OR p."displayCode" ILIKE ${prefix})
    ORDER BY (p."title" ILIKE ${prefix}) DESC, similarity(p."title", ${q}) DESC, p."displayCode" ASC
    LIMIT ${SEARCH_RESULT_LIMIT}
  `);

  const results: SearchResult[] = rows.map((r) => ({
    slug: r.slug,
    displayCode: r.displayCode,
    title: r.title,
    difficulty: r.difficulty as SearchDifficulty,
    status: r.status === "SOLVED" ? "solved" : r.status === "ATTEMPTED" ? "attempted" : null,
  }));
  return json({ results } satisfies SearchResponse);
}
