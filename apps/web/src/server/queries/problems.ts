import "server-only";
import { unstable_cache } from "next/cache";
import { cache } from "react";
import { Prisma, type Difficulty } from "@recx/db";
import {
  ANSWER_LANGUAGE_KEY,
  ANSWER_STARTER_CODE,
  LANGUAGE_CATALOG,
  SQL_LANGUAGE_KEY,
  SQL_STARTER_CODE,
  functionSignatureSchema,
  isLanguageKey,
  isAnswerLanguage,
  isSqlLanguage,
  isTopic,
  problemKind,
  submitEditorLanguage,
  type FunctionSignature,
  type CompareMode,
  type IoMode,
  type LanguageKey,
  type ProblemKind,
  type SqlDialect,
  type SubmitLanguageKey,
  type Topic,
} from "@recx/shared";
import { starterStub, supportsFunctionMode } from "@recx/shared/harness";
import { db } from "@/lib/db";
import { renderMarkdown } from "@/lib/markdown";
import { PROBLEMS_TAG, PROBLEM_POINTER_TTL_SECONDS, problemCacheKey } from "@/lib/problems/cache";
import { getPublicLanguageRows } from "@/server/queries/judge-languages";
import {
  CATALOG_PAGE_SIZE,
  pageCount,
  searchTerms,
  type CatalogFilters,
  type CatalogSort,
} from "@/components/problems/catalog-filters";

export type SolveState = "solved" | "attempted" | null;

// ── Catalogue (/problems) ──────────────────────────────────────────────

export interface CatalogRow {
  id: string;
  slug: string;
  displayCode: string;
  title: string;
  difficulty: Difficulty;
  /** From UserProblemStatus — never derived from Submission. */
  solve: SolveState;
  /** Topic tags in taxonomy order. */
  topics: Topic[];
  /**
   * What kind of question it is (Phase 12p), derived from the live
   * version. A student should not have to open a problem to find out that
   * it wants a query, a one-line fix, a conversation or an answer.
   */
  kind: ProblemKind;
  /** ProblemStat counters (0 when the problem has no stat row yet). */
  submissions: number;
  accepted: number;
  bookmarked: boolean;
}

export interface CatalogPage {
  rows: CatalogRow[];
  total: number;
  /** The page actually shown (clamped to the last page). */
  page: number;
  pageCount: number;
}

/** The catalogue filters with the company slug resolved to a curated Company id. */
export type CatalogQuery = Omit<CatalogFilters, "company"> & { companyId: string | null };

/**
 * ORDER BY fragments, chosen from a closed set — never built from input.
 * Acceptance sorts on the maintained ProblemStat.acceptanceRate; problems
 * nobody has submitted to yet (no stat row, or zero submissions) sort last
 * in both directions, in code order.
 */
const RATE_WHEN_SUBMITTED = Prisma.sql`CASE WHEN s.submissions > 0 THEN s."acceptanceRate" END`;
const ORDER_BY: Readonly<Record<CatalogSort, Prisma.Sql>> = {
  code: Prisma.sql`p."displayCode" ASC`,
  difficulty: Prisma.sql`p.difficulty ASC, p."displayCode" ASC`,
  "difficulty-desc": Prisma.sql`p.difficulty DESC, p."displayCode" ASC`,
  acceptance: Prisma.sql`(COALESCE(s.submissions, 0) = 0) ASC, ${RATE_WHEN_SUBMITTED} DESC, p."displayCode" ASC`,
  "acceptance-asc": Prisma.sql`(COALESCE(s.submissions, 0) = 0) ASC, ${RATE_WHEN_SUBMITTED} ASC, p."displayCode" ASC`,
};

/** Escape LIKE metacharacters so a term always matches literally (backslash is ILIKE's default escape). */
function likeLiteral(term: string): string {
  return term.replace(/[\\%_]/g, "\\$&");
}

/**
 * WHERE clause for the catalogue. Every value is a bound parameter. The title
 * search is one `title ILIKE '%word%'` per word, which the pg_trgm GIN index
 * (Problem_title_trgm_idx) serves — never an unindexed scan over titles. The
 * words were already sanitised by parseCatalogFilters; LIKE metacharacters
 * are escaped here as well, so the query never depends on that.
 * The status conditions read the viewer's UserProblemStatus row, which the
 * caller joins as `ups`.
 */
function catalogWhere(q: CatalogQuery): Prisma.Sql {
  const conditions: Prisma.Sql[] = [Prisma.sql`p.status = 'PUBLISHED'`, Prisma.sql`p."liveVersionId" IS NOT NULL`];

  for (const term of searchTerms(q.q)) {
    conditions.push(Prisma.sql`p.title ILIKE ${`%${likeLiteral(term)}%`}`);
  }
  if (q.difficulties.length > 0) {
    conditions.push(
      Prisma.sql`p.difficulty IN (${Prisma.join(q.difficulties.map((d) => Prisma.sql`${d}::"Difficulty"`))})`,
    );
  }
  if (q.topic) {
    conditions.push(
      Prisma.sql`EXISTS (SELECT 1 FROM "ProblemTag" t WHERE t."problemId" = p.id AND t.topic = ${q.topic}::"Topic")`,
    );
  }
  if (q.companyId) {
    conditions.push(
      Prisma.sql`EXISTS (SELECT 1 FROM "ProblemCompanyTag" ct WHERE ct."problemId" = p.id AND ct."companyId" = ${q.companyId})`,
    );
  }
  switch (q.status) {
    case "solved":
      conditions.push(Prisma.sql`ups.status = 'SOLVED'`);
      break;
    case "attempted":
      conditions.push(Prisma.sql`ups.status = 'ATTEMPTED'`);
      break;
    case "not-attempted":
      conditions.push(Prisma.sql`ups."userId" IS NULL`);
      break;
    case "all":
      break;
  }
  return Prisma.join(conditions, " AND ");
}

interface CatalogSqlRow {
  id: string;
  slug: string;
  displayCode: string;
  title: string;
  difficulty: Difficulty;
  progress: "SOLVED" | "ATTEMPTED" | null;
  submissions: number | null;
  accepted: number | null;
  bookmarked: boolean;
  topics: string[] | null;
  ioMode: IoMode;
  compareMode: CompareMode;
  maxEditedLines: number | null;
  total: bigint;
}

async function catalogRows(userId: string, q: CatalogQuery, page: number): Promise<CatalogSqlRow[]> {
  const offset = (page - 1) * CATALOG_PAGE_SIZE;
  return db.$queryRaw<CatalogSqlRow[]>`
    SELECT p.id, p.slug, p."displayCode", p.title, p.difficulty::text AS difficulty,
      ups.status::text AS progress,
      s.submissions, s.accepted,
      (b."userId" IS NOT NULL) AS bookmarked,
      v."ioMode"::text AS "ioMode", v."compareMode"::text AS "compareMode", v."maxEditedLines",
      (SELECT array_agg(t.topic::text ORDER BY t.topic) FROM "ProblemTag" t WHERE t."problemId" = p.id) AS topics,
      count(*) OVER () AS total
    FROM "Problem" p
    -- The live version, for the kind. catalogWhere already requires a
    -- liveVersionId, so this join adds a column rather than a condition.
    LEFT JOIN "ProblemVersion" v ON v.id = p."liveVersionId"
    LEFT JOIN "ProblemStat" s ON s."problemId" = p.id
    LEFT JOIN "UserProblemStatus" ups ON ups."problemId" = p.id AND ups."userId" = ${userId}
    LEFT JOIN "Bookmark" b ON b."problemId" = p.id AND b."userId" = ${userId}
    WHERE ${catalogWhere(q)}
    ORDER BY ${ORDER_BY[q.sort]}
    LIMIT ${CATALOG_PAGE_SIZE} OFFSET ${offset}`;
}

async function catalogCount(userId: string, q: CatalogQuery): Promise<number> {
  const [row] = await db.$queryRaw<{ total: bigint }[]>`
    SELECT count(*) AS total
    FROM "Problem" p
    LEFT JOIN "UserProblemStatus" ups ON ups."problemId" = p.id AND ups."userId" = ${userId}
    WHERE ${catalogWhere(q)}`;
  return Number(row?.total ?? 0);
}

function toCatalogRow(r: CatalogSqlRow): CatalogRow {
  return {
    id: r.id,
    slug: r.slug,
    displayCode: r.displayCode,
    title: r.title,
    difficulty: r.difficulty,
    solve: r.progress === "SOLVED" ? "solved" : r.progress === "ATTEMPTED" ? "attempted" : null,
    topics: (r.topics ?? []).filter(isTopic),
    kind: problemKind({ ioMode: r.ioMode, compareMode: r.compareMode, maxEditedLines: r.maxEditedLines }),
    submissions: r.submissions ?? 0,
    accepted: r.accepted ?? 0,
    bookmarked: r.bookmarked,
  };
}

/**
 * One page (CATALOG_PAGE_SIZE rows) of published problems for the viewer,
 * filtered and sorted server-side. Solve state comes from UserProblemStatus,
 * acceptance from the maintained ProblemStat row, bookmarks from Bookmark —
 * one round trip for the page and its total (a window count). A page past
 * the end is clamped to the last page.
 */
export async function listCatalog(userId: string, q: CatalogQuery): Promise<CatalogPage> {
  let page = q.page;
  let raw = await catalogRows(userId, q, page);
  let total = Number(raw[0]?.total ?? 0);

  if (raw.length === 0 && page > 1) {
    total = await catalogCount(userId, q);
    if (total === 0) return { rows: [], total: 0, page: 1, pageCount: 1 };
    page = pageCount(total);
    raw = await catalogRows(userId, q, page);
    total = Number(raw[0]?.total ?? total);
  }

  return { rows: raw.map(toCatalogRow), total, page, pageCount: pageCount(total) };
}

export interface CatalogCompany {
  id: string;
  slug: string;
  name: string;
}

/**
 * Curated companies that tag at least one published problem (the company
 * filter's options).
 *
 * Cached under the `problems` tag (Phase 10c). It is the catalogue's most
 * expensive shared read — an EXISTS over ProblemCompanyTag for every
 * curated company — and it is the same list for every student on the page,
 * so it is the one piece of /problems that can be cached without a user id
 * in the key. The catalogue ROWS are not cached and must not be: they carry
 * the viewer's solve state and bookmarks, and a student who has just solved
 * a problem should not be told for the next minute that they have not.
 */
export const listCatalogCompanies: () => Promise<CatalogCompany[]> = unstable_cache(
  async (): Promise<CatalogCompany[]> =>
    /**
     * Curated by the placement cell, OR reported by a student in the
     * interview archive (Phase 12e).
     *
     * `curated` used to be the whole filter, and a company created from a
     * reported interview is deliberately `curated: false` — it is not the
     * college's guess, it is what somebody sat. Without the second clause
     * those companies had real "asked at" tags and no way to filter by
     * them, which is the archive doing its work and the catalogue hiding
     * it. Either way the company needs at least one tag on a published
     * problem, so an empty filter is never offered.
     */
    db.company.findMany({
      where: {
        problems: { some: { problem: { status: "PUBLISHED" } } },
        OR: [{ curated: true }, { interviews: { some: { status: "APPROVED" } } }],
      },
      orderBy: { name: "asc" },
      select: { id: true, slug: true, name: true },
    }),
  ["catalog-companies", "v2"],
  { tags: [PROBLEMS_TAG], revalidate: PROBLEM_POINTER_TTL_SECONDS },
);

export interface WorkspaceLanguage {
  /** A toolchain key, or `sql17` for a SQL problem (Phase 12k). */
  key: SubmitLanguageKey;
  /** LanguageConfig.label, e.g. "C++20 (GCC 13.2.0)". */
  label: string;
  /** LanguageConfig.version, the pinned toolchain's exact version (workspace footer, /judge). */
  version: string;
  /** Monaco language id. */
  editorLanguage: string;
  starter: string;
}

export interface WorkspaceSample {
  index: number;
  input: string;
  output: string;
}

export interface ProblemWorkspace {
  id: string;
  slug: string;
  displayCode: string;
  title: string;
  difficulty: Difficulty;
  versionId: string;
  statementMd: string;
  /**
   * The statement, rendered and sanitised (Phase 10c).
   *
   * Rendered inside the cached read rather than in the page, because the
   * render is the expensive half — markdown to HTML and then the
   * sanitiser, per request, for a string that cannot change while the key
   * is the same.
   */
  statementHtml: string;
  constraints: string[];
  ioMode: IoMode;
  /** How the answer is compared; INTERACTIVE means a conversation (Phase 12l). */
  compareMode: CompareMode;
  signature: FunctionSignature | null;
  /** SQL problems only (Phase 12k): the dialect, and whether the row order is part of the answer. */
  sqlDialect: SqlDialect | null;
  sqlOrdered: boolean | null;
  /**
   * DEBUGGING problems (Phase 12m): the most lines a student may change in
   * the program they were given. Null for every other problem, and
   * non-null is what makes the workspace show the rule and count the
   * lines as they type.
   */
  maxEditedLines: number | null;
  timeLimitMs: number;
  memoryLimitKb: number;
  samples: WorkspaceSample[];
  languages: WorkspaceLanguage[];
  /** FUNCTION problems: enabled languages without a FUNCTION harness, named in a note (never offered). */
  functionUnavailable: { key: LanguageKey; label: string }[];
}

function asConstraints(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((c): c is string => typeof c === "string") : [];
}

// ── The problem cache (Phase 10c) ─────────────────────────────────

interface ProblemPointer {
  id: string;
  slug: string;
  displayCode: string;
  status: string;
  version: number;
  liveVersionId: string | null;
}

/**
 * slug → which version is live.
 *
 * The only part of a problem read that has to be fresh, and the only part
 * that is tagged: everything else hangs off the version this returns. Small
 * on purpose — six columns, no joins — because it is the one read a publish
 * must be able to make visible immediately.
 */
const readProblemPointer: (slug: string) => Promise<ProblemPointer | null> = unstable_cache(
  async (slug: string) =>
    db.problem.findUnique({
      where: { slug },
      select: { id: true, slug: true, displayCode: true, status: true, version: true, liveVersionId: true },
    }),
  ["problem-pointer", "v1"],
  { tags: [PROBLEMS_TAG], revalidate: PROBLEM_POINTER_TTL_SECONDS },
);

/** The immutable half of a workspace read: everything frozen at publish. */
interface WorkspaceContent {
  versionId: string;
  title: string;
  difficulty: Difficulty;
  statementMd: string;
  statementHtml: string;
  constraints: string[];
  ioMode: IoMode;
  compareMode: CompareMode;
  signature: FunctionSignature | null;
  sqlDialect: SqlDialect | null;
  sqlOrdered: boolean | null;
  maxEditedLines: number | null;
  timeLimitMs: number;
  memoryLimitKb: number;
  samples: WorkspaceSample[];
  starters: Array<{ language: string; code: string }>;
}

/**
 * One frozen version's content, under the immutable key.
 *
 * **Nothing here is ever invalidated — it is orphaned.** A publish writes a
 * new `Problem.version`, so the next read asks for a different key and this
 * entry is never consulted again. That is why there is no tag and no
 * `revalidate`: a cache entry that cannot be wrong does not need either, and
 * every invalidation this code does not have to perform is an invalidation
 * it cannot get wrong.
 *
 * `key` is the first argument rather than a `keyParts` entry because
 * `unstable_cache` hashes its arguments into the cache key: passing SPEC's
 * own `problem:{id}:v{n}` string makes the real key the documented one, and
 * makes it readable in a test.
 *
 * The language list is deliberately NOT in here. Languages are enabled and
 * disabled by an admin on their own schedule, and freezing them under a
 * problem's version key would offer C++ for as long as that version stayed
 * live. They come from `getPublicLanguageRows()`, which has its own cache
 * and its own tag.
 *
 * Only `isSample` test cases are loaded, as before: a hidden test's blobs
 * never leave the database through this path, and now they never enter a
 * cache either.
 */
const readWorkspaceContent: (key: string, versionId: string) => Promise<WorkspaceContent | null> = unstable_cache(
  async (_key: string, versionId: string): Promise<WorkspaceContent | null> => {
    const version = await db.problemVersion.findUnique({
      where: { id: versionId },
      select: {
        id: true,
        title: true,
        difficulty: true,
        statementMd: true,
        constraints: true,
        ioMode: true,
        compareMode: true,
        functionSignature: true,
        sqlDialect: true,
        sqlOrdered: true,
        maxEditedLines: true,
        timeLimitMs: true,
        memoryLimitKb: true,
        starterCodes: { select: { language: true, code: true } },
        testCases: {
          where: { isSample: true },
          orderBy: { index: "asc" },
          select: {
            index: true,
            input: { select: { inline: true } },
            output: { select: { inline: true } },
          },
        },
      },
    });
    if (!version) return null;

    const parsed =
      version.ioMode === "FUNCTION" ? functionSignatureSchema.safeParse(version.functionSignature) : null;
    const signature = parsed?.success ? parsed.data : null;
    // A FUNCTION problem whose signature does not parse cannot be judged.
    if (version.ioMode === "FUNCTION" && !signature) return null;

    return {
      versionId: version.id,
      title: version.title,
      difficulty: version.difficulty,
      statementMd: version.statementMd,
      statementHtml: renderMarkdown(version.statementMd),
      constraints: asConstraints(version.constraints),
      ioMode: version.ioMode,
      compareMode: version.compareMode,
      signature,
      sqlDialect: version.sqlDialect,
      sqlOrdered: version.sqlOrdered,
      maxEditedLines: version.maxEditedLines,
      timeLimitMs: version.timeLimitMs,
      memoryLimitKb: version.memoryLimitKb,
      /**
       * Phase 12n. An output-only problem's one case IS a sample, because
       * its data is the question — and its expected output IS THE ANSWER,
       * so it is withheld here, in the query, rather than anywhere the
       * student could be served it by accident. `isSample` means "the
       * student may see this case" everywhere else on the platform; for
       * this one kind it means the input only.
       */
      samples: version.testCases.map((t) => ({
        index: t.index,
        input: t.input.inline ?? "",
        output: version.ioMode === "OUTPUT_ONLY" ? "" : (t.output.inline ?? ""),
      })),
      starters: version.starterCodes.map((s) => ({ language: s.language, code: s.code })),
    };
  },
  ["problem-workspace", "v5"],
);

/**
 * Everything the workspace page needs for one PUBLISHED problem, from its
 * LIVE version. Returns null for an unknown, unpublished or retired problem.
 *
 * Three reads, each cached where it is safe to be (Phase 10c): the live
 * pointer (tagged, 60-second backstop), the version's frozen content (keyed
 * by version, never invalidated) and the enabled languages (their own tag).
 * Nothing user-scoped passes through any of them — solve state, bookmarks
 * and drafts are read elsewhere, per request, because a cache entry holding
 * one student's progress is the one caching mistake that shows another
 * student their data.
 *
 * Still wrapped in React `cache` so the page and its `generateMetadata` make
 * one set of reads rather than two.
 */
export const getProblemWorkspace = cache(async (slug: string): Promise<ProblemWorkspace | null> => {
  const problem = await readProblemPointer(slug);
  if (!problem || problem.status !== "PUBLISHED" || !problem.liveVersionId) return null;

  const content = await readWorkspaceContent(problemCacheKey(problem.id, problem.version), problem.liveVersionId);
  if (!content) return null;

  const configs = await getPublicLanguageRows();
  const starters = new Map(content.starters.map((s) => [s.language, s.code]));
  const sig = content.signature;

  /**
   * Phase 12k: a SQL problem offers SQL and nothing else, and no other
   * problem offers SQL. Both halves of that are this one line, because a
   * picker that offers C++ for a question answered with a SELECT is a
   * picker that wastes a student's submission — and the submit action
   * refuses the pairing anyway (`loadTarget`), so offering it would be
   * offering a door that is locked.
   */
  const sql = content.ioMode === "SQL";
  /**
   * Phase 12n: an output-only problem is answered in `answer1` and nothing
   * else, and no other problem accepts one. Same shape as the SQL pairing
   * above it, and the submit action refuses the other combinations, so
   * nothing offered here is a locked door.
   */
  const answerOnly = content.ioMode === "OUTPUT_ONLY";
  /**
   * Phase 12m: a debugging problem is offered in the languages its broken
   * program is written in and no others. Each language would be a
   * different program with a different mistake, so an author writes the
   * ones they mean — and a language with no starter would open an empty
   * editor on a question that allows two changed lines. `loadTarget`
   * refuses the same pairing, so nothing offered here is a locked door and
   * nothing hidden here is reachable by typing.
   */
  const budget = content.maxEditedLines;
  const languages: WorkspaceLanguage[] = [];
  const functionUnavailable: ProblemWorkspace["functionUnavailable"] = [];
  for (const config of configs) {
    const kind = isSqlLanguage(config.key) ? "sql" : isAnswerLanguage(config.key) ? "answer" : "program";
    if (kind !== (sql ? "sql" : answerOnly ? "answer" : "program")) continue;
    if (kind === "answer") {
      languages.push({
        key: ANSWER_LANGUAGE_KEY,
        label: config.label,
        version: config.version,
        editorLanguage: submitEditorLanguage(config.key),
        // An empty box: a comment here would be a line to delete first.
        starter: starters.get(ANSWER_LANGUAGE_KEY) ?? ANSWER_STARTER_CODE,
      });
      continue;
    }
    if (sql) {
      languages.push({
        key: SQL_LANGUAGE_KEY,
        label: config.label,
        version: config.version,
        editorLanguage: submitEditorLanguage(config.key),
        starter: starters.get(SQL_LANGUAGE_KEY) ?? SQL_STARTER_CODE,
      });
      continue;
    }
    if (!isLanguageKey(config.key)) continue;
    if (budget !== null && (starters.get(config.key) ?? "").trim().length === 0) continue;
    if (sig && !supportsFunctionMode(config.key)) {
      functionUnavailable.push({ key: config.key, label: config.label });
      continue;
    }
    const starter = starters.get(config.key) ?? (sig ? starterStub(config.key, sig) : "");
    languages.push({
      key: config.key,
      label: config.label,
      version: config.version,
      editorLanguage: LANGUAGE_CATALOG[config.key].editorLanguage,
      starter,
    });
  }

  return {
    id: problem.id,
    slug: problem.slug,
    displayCode: problem.displayCode,
    title: content.title,
    difficulty: content.difficulty,
    versionId: content.versionId,
    statementMd: content.statementMd,
    statementHtml: content.statementHtml,
    constraints: content.constraints,
    ioMode: content.ioMode,
    compareMode: content.compareMode,
    maxEditedLines: content.maxEditedLines,
    signature: sig,
    sqlDialect: content.sqlDialect,
    sqlOrdered: content.sqlOrdered,
    timeLimitMs: content.timeLimitMs,
    memoryLimitKb: content.memoryLimitKb,
    samples: content.samples,
    languages,
    functionUnavailable,
  };
});
