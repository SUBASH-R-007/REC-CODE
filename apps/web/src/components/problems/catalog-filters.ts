import { TOPIC_LABEL, isTopic, type DifficultyKey, type Topic } from "@recx/shared";

/**
 * The /problems catalogue is URL-driven: every filter lives in the query
 * string, so it works without JavaScript, can be bookmarked and shared, and
 * the server is the only place that interprets it. This module is pure (no
 * database, no React) — it parses and sanitises untrusted search params into
 * a closed CatalogFilters value, and serialises one back into a clean URL.
 *
 * Nothing here is trusted later: the query builder only ever sees values
 * that passed these allow-lists, and the search text reaches SQL as a bound
 * parameter.
 */

export const CATALOG_PATH = "/problems";
export const CATALOG_PAGE_SIZE = 50;
/** Id of the results heading; pagination links target it so focus lands on the new page. */
export const CATALOG_RESULTS_ID = "problem-results";

export const SEARCH_MIN_LENGTH = 2;
export const SEARCH_MAX_LENGTH = 64;
/** At most this many words are matched (each one is an indexed ILIKE). */
export const SEARCH_MAX_TERMS = 5;
/** A page number beyond this is treated as page 1 (no one pages 10,000 × 50 rows). */
export const CATALOG_MAX_PAGE = 10_000;

export const CATALOG_DIFFICULTIES = ["EASY", "MEDIUM", "HARD"] as const satisfies readonly DifficultyKey[];

export const DIFFICULTY_LABEL: Readonly<Record<DifficultyKey, string>> = {
  EASY: "Easy",
  MEDIUM: "Medium",
  HARD: "Hard",
};

export const CATALOG_STATUSES = ["all", "solved", "attempted", "not-attempted"] as const;
export type CatalogStatus = (typeof CATALOG_STATUSES)[number];

export const CATALOG_STATUS_LABEL: Readonly<Record<CatalogStatus, string>> = {
  all: "All problems",
  solved: "Solved",
  attempted: "Attempted, not solved",
  "not-attempted": "Not attempted",
};

export const CATALOG_SORTS = ["code", "difficulty", "difficulty-desc", "acceptance", "acceptance-asc"] as const;
export type CatalogSort = (typeof CATALOG_SORTS)[number];

export const CATALOG_SORT_LABEL: Readonly<Record<CatalogSort, string>> = {
  code: "Problem code",
  difficulty: "Difficulty: easiest first",
  "difficulty-desc": "Difficulty: hardest first",
  acceptance: "Acceptance: highest first",
  "acceptance-asc": "Acceptance: lowest first",
};

export interface CatalogFilters {
  /** Sanitised search text as typed (may be shorter than SEARCH_MIN_LENGTH; see searchTerms). */
  q: string;
  /** Selected difficulties in canonical order; empty = any. */
  difficulties: DifficultyKey[];
  topic: Topic | null;
  status: CatalogStatus;
  /** Curated company slug (shape-checked here, resolved against the Company table by the page). */
  company: string | null;
  sort: CatalogSort;
  /** 1-based. */
  page: number;
}

export const DEFAULT_CATALOG_FILTERS: Readonly<CatalogFilters> = Object.freeze({
  q: "",
  difficulties: [],
  topic: null,
  status: "all",
  company: null,
  sort: "code",
  page: 1,
});

export type RawSearchParams = Record<string, string | string[] | undefined>;

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function all(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

/**
 * Search text: letters (with their combining marks, e.g. Tamil vowel
 * signs), digits, spaces and a few title punctuation marks only. The
 * apostrophe is kept — the text is always a bound parameter. Everything else — including the LIKE wildcards `%` and `_`, the
 * escape character `\`, quotes other than the apostrophe, and control
 * characters — becomes a space. Whitespace is collapsed and the result capped
 * at SEARCH_MAX_LENGTH characters.
 */
export function sanitizeSearch(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw
    .slice(0, SEARCH_MAX_LENGTH * 4)
    .normalize("NFKC")
    .replace(/[^\p{L}\p{M}\p{N}' &+#.-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, SEARCH_MAX_LENGTH)
    .trim();
}

/**
 * The words actually matched against titles (each must appear, any order,
 * case-insensitive). Words shorter than SEARCH_MIN_LENGTH are dropped: the
 * trigram index cannot narrow them. An empty array means "no title filter".
 */
export function searchTerms(q: string): string[] {
  if (q.length < SEARCH_MIN_LENGTH) return [];
  const words = q
    .toLowerCase()
    .split(" ")
    .filter((w) => w.length >= SEARCH_MIN_LENGTH);
  return [...new Set(words)].slice(0, SEARCH_MAX_TERMS);
}

/** True when the visitor typed something that is too short to search for. */
export function searchTooShort(q: string): boolean {
  return q.length > 0 && searchTerms(q).length === 0;
}

function parseDifficulties(values: string[]): DifficultyKey[] {
  const wanted = new Set<string>();
  for (const value of values) {
    for (const part of value.split(",")) wanted.add(part.trim().toUpperCase());
  }
  return CATALOG_DIFFICULTIES.filter((d) => wanted.has(d));
}

function parseTopic(value: string | undefined): Topic | null {
  if (!value) return null;
  const upper = value.trim().toUpperCase();
  return isTopic(upper) ? upper : null;
}

function oneOf<T extends string>(allowed: readonly T[], value: string | undefined, fallback: T): T {
  if (!value) return fallback;
  const lower = value.trim().toLowerCase();
  return (allowed as readonly string[]).includes(lower) ? (lower as T) : fallback;
}

const COMPANY_SLUG = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

function parseCompany(value: string | undefined): string | null {
  if (!value) return null;
  const slug = value.trim().toLowerCase();
  return COMPANY_SLUG.test(slug) ? slug : null;
}

function parsePage(value: string | undefined): number {
  if (!value || !/^\d{1,6}$/.test(value.trim())) return 1;
  const page = Number.parseInt(value.trim(), 10);
  return page >= 1 && page <= CATALOG_MAX_PAGE ? page : 1;
}

/** Untrusted search params → a closed, fully-defaulted CatalogFilters. Never throws. */
export function parseCatalogFilters(params: RawSearchParams): CatalogFilters {
  return {
    q: sanitizeSearch(first(params.q)),
    difficulties: parseDifficulties(all(params.difficulty)),
    topic: parseTopic(first(params.topic)),
    status: oneOf(CATALOG_STATUSES, first(params.status), "all"),
    company: parseCompany(first(params.company)),
    sort: oneOf(CATALOG_SORTS, first(params.sort), "code"),
    page: parsePage(first(params.page)),
  };
}

/** Whether anything narrows the list (sort and page do not). */
export function hasActiveFilters(f: CatalogFilters): boolean {
  return (
    searchTerms(f.q).length > 0 ||
    f.difficulties.length > 0 ||
    f.topic !== null ||
    f.status !== "all" ||
    f.company !== null
  );
}

/**
 * The canonical query string for a filter set: defaults are omitted, so
 * `/problems` is the unfiltered first page and links stay short.
 */
export function catalogQuery(f: CatalogFilters): string {
  const params = new URLSearchParams();
  if (f.q) params.set("q", f.q);
  for (const d of f.difficulties) params.append("difficulty", d);
  if (f.topic) params.set("topic", f.topic);
  if (f.status !== "all") params.set("status", f.status);
  if (f.company) params.set("company", f.company);
  if (f.sort !== "code") params.set("sort", f.sort);
  if (f.page > 1) params.set("page", String(f.page));
  return params.toString();
}

export function catalogHref(f: CatalogFilters, overrides: Partial<CatalogFilters> = {}, hash?: string): string {
  const query = catalogQuery({ ...f, ...overrides });
  return `${CATALOG_PATH}${query ? `?${query}` : ""}${hash ? `#${hash}` : ""}`;
}

export function pageCount(total: number, pageSize = CATALOG_PAGE_SIZE): number {
  return Math.max(1, Math.ceil(total / pageSize));
}

/**
 * Page numbers to show around the current one; `null` is a gap ("…").
 * Always includes the first and last page.
 */
export function pageWindow(current: number, totalPages: number, radius = 1): (number | null)[] {
  const pages = new Set<number>([1, totalPages]);
  for (let p = current - radius; p <= current + radius; p++) {
    if (p >= 1 && p <= totalPages) pages.add(p);
  }
  const sorted = [...pages].sort((a, b) => a - b);
  const out: (number | null)[] = [];
  for (const [i, p] of sorted.entries()) {
    const prev = sorted[i - 1];
    if (prev !== undefined && p - prev === 2) out.push(prev + 1);
    else if (prev !== undefined && p - prev > 2) out.push(null);
    out.push(p);
  }
  return out;
}

/** Acceptance as a percentage with one decimal, or null when nothing was submitted yet. */
export function acceptancePercent(accepted: number, submissions: number): string | null {
  if (submissions <= 0) return null;
  const pct = Math.round((Math.min(accepted, submissions) / submissions) * 1000) / 10;
  return `${pct.toFixed(1)}%`;
}

export interface EmptyCopy {
  title: string;
  description: string;
}

interface EmptyLabels {
  /** Display name of the selected (curated) company, when one is selected. */
  companyName?: string | null;
}

/** "Easy or Hard" / "Medium". */
function difficultyPhrase(difficulties: readonly DifficultyKey[]): string {
  const labels = difficulties.map((d) => DIFFICULTY_LABEL[d]);
  if (labels.length <= 1) return labels[0] ?? "";
  return `${labels.slice(0, -1).join(", ")} or ${labels[labels.length - 1]}`;
}

/** A plain-language summary of the narrowing filters, e.g. `Hard problems in Graphs from Acme matching "path"`. */
export function describeFilters(f: CatalogFilters, labels: EmptyLabels = {}): string {
  const parts: string[] = [];
  const diff = difficultyPhrase(f.difficulties);
  parts.push(diff ? `${diff} problems` : "problems");
  if (f.topic) parts.push(`in ${TOPIC_LABEL[f.topic]}`);
  if (f.company && labels.companyName) parts.push(`tagged ${labels.companyName}`);
  const terms = searchTerms(f.q);
  if (terms.length > 0) parts.push(`matching “${f.q}”`);
  if (f.status === "solved") parts.push("that you have solved");
  else if (f.status === "attempted") parts.push("that you have attempted but not solved");
  else if (f.status === "not-attempted") parts.push("that you have not attempted");
  return parts.join(" ");
}

/**
 * The empty state for a filter combination that matched nothing. Status-only
 * filters get their own encouraging copy; anything else names exactly what
 * was asked for, so the student can see which filter to remove.
 */
export function emptyStateCopy(f: CatalogFilters, labels: EmptyLabels = {}): EmptyCopy {
  const narrowedBeyondStatus =
    searchTerms(f.q).length > 0 || f.difficulties.length > 0 || f.topic !== null || f.company !== null;

  if (!narrowedBeyondStatus) {
    switch (f.status) {
      case "solved":
        return {
          title: "You haven't solved a problem yet",
          description: "Problems you solve appear here. An Easy problem is a good place to start.",
        };
      case "attempted":
        return {
          title: "Nothing in progress",
          description: "Problems you have attempted but not yet solved appear here.",
        };
      case "not-attempted":
        return {
          title: "You have attempted every problem",
          description: "Nothing is left untouched. Revisit the problems you attempted to finish them.",
        };
      case "all":
        return {
          title: "No problems published yet",
          description: "Problems appear here as soon as the content team publishes them. Check back soon.",
        };
    }
  }

  const onlySearch =
    searchTerms(f.q).length > 0 &&
    f.difficulties.length === 0 &&
    f.topic === null &&
    f.company === null &&
    f.status === "all";
  if (onlySearch) {
    return {
      title: `No problem titles match “${f.q}”`,
      description: "Check the spelling, or search for one distinctive word from the title.",
    };
  }

  const summary = describeFilters(f, labels);
  return {
    title: "No problems match these filters",
    description: `There are no ${summary}. Remove a filter to see more.`,
  };
}
