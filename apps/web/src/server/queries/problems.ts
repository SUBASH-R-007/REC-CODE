import "server-only";
import { cache } from "react";
import { Prisma, type Difficulty } from "@recx/db";
import {
  LANGUAGE_CATALOG,
  functionSignatureSchema,
  isLanguageKey,
  isTopic,
  type FunctionSignature,
  type LanguageKey,
  type Topic,
} from "@recx/shared";
import { starterStub, supportsFunctionMode } from "@recx/shared/harness";
import { db } from "@/lib/db";
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
  total: bigint;
}

async function catalogRows(userId: string, q: CatalogQuery, page: number): Promise<CatalogSqlRow[]> {
  const offset = (page - 1) * CATALOG_PAGE_SIZE;
  return db.$queryRaw<CatalogSqlRow[]>`
    SELECT p.id, p.slug, p."displayCode", p.title, p.difficulty::text AS difficulty,
      ups.status::text AS progress,
      s.submissions, s.accepted,
      (b."userId" IS NOT NULL) AS bookmarked,
      (SELECT array_agg(t.topic::text ORDER BY t.topic) FROM "ProblemTag" t WHERE t."problemId" = p.id) AS topics,
      count(*) OVER () AS total
    FROM "Problem" p
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

/** Curated companies that tag at least one published problem (the company filter's options). */
export async function listCatalogCompanies(): Promise<CatalogCompany[]> {
  return db.company.findMany({
    where: { curated: true, problems: { some: { problem: { status: "PUBLISHED" } } } },
    orderBy: { name: "asc" },
    select: { id: true, slug: true, name: true },
  });
}

export interface WorkspaceLanguage {
  key: LanguageKey;
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
  constraints: string[];
  ioMode: "STDIN" | "FUNCTION";
  signature: FunctionSignature | null;
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

/**
 * Everything the workspace page needs for one PUBLISHED problem, from its
 * LIVE version. Returns null for an unknown, unpublished or retired problem.
 * Only isSample test cases are loaded — a hidden test's blobs never leave
 * the database through this path. Cached per request (page + metadata).
 */
export const getProblemWorkspace = cache(async (slug: string): Promise<ProblemWorkspace | null> => {
  const problem = await db.problem.findUnique({
    where: { slug },
    select: {
      id: true,
      slug: true,
      displayCode: true,
      title: true,
      difficulty: true,
      status: true,
      liveVersion: {
        select: {
          id: true,
          title: true,
          difficulty: true,
          statementMd: true,
          constraints: true,
          ioMode: true,
          functionSignature: true,
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
      },
    },
  });
  if (!problem || problem.status !== "PUBLISHED" || !problem.liveVersion) return null;
  const version = problem.liveVersion;

  const signature =
    version.ioMode === "FUNCTION" ? functionSignatureSchema.safeParse(version.functionSignature) : null;
  const sig = signature?.success ? signature.data : null;
  // A FUNCTION problem whose signature does not parse cannot be judged.
  if (version.ioMode === "FUNCTION" && !sig) return null;

  const configs = await db.languageConfig.findMany({
    where: { enabled: true, isCurrent: true },
    select: { key: true, label: true, version: true },
    orderBy: { key: "asc" },
  });
  const starters = new Map(version.starterCodes.map((s) => [s.language, s.code]));

  const languages: WorkspaceLanguage[] = [];
  const functionUnavailable: ProblemWorkspace["functionUnavailable"] = [];
  for (const config of configs) {
    if (!isLanguageKey(config.key)) continue;
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
    title: version.title,
    difficulty: version.difficulty,
    versionId: version.id,
    statementMd: version.statementMd,
    constraints: asConstraints(version.constraints),
    ioMode: version.ioMode,
    signature: sig,
    timeLimitMs: version.timeLimitMs,
    memoryLimitKb: version.memoryLimitKb,
    samples: version.testCases.map((t) => ({
      index: t.index,
      input: t.input.inline ?? "",
      output: t.output.inline ?? "",
    })),
    languages,
    functionUnavailable,
  };
});
