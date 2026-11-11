import { describe, expect, it } from "vitest";
import {
  CATALOG_MAX_PAGE,
  DEFAULT_CATALOG_FILTERS,
  SEARCH_MAX_LENGTH,
  acceptancePercent,
  catalogHref,
  catalogQuery,
  describeFilters,
  emptyStateCopy,
  hasActiveFilters,
  pageCount,
  pageWindow,
  parseCatalogFilters,
  sanitizeSearch,
  searchTerms,
  searchTooShort,
  type CatalogFilters,
} from "@/components/problems/catalog-filters";

/**
 * The /problems catalogue's URL contract: untrusted search params are parsed
 * into a closed filter set (never throwing), search text is sanitised before
 * it can reach an ILIKE pattern, and the canonical URL omits defaults.
 */

const filters = (overrides: Partial<CatalogFilters> = {}): CatalogFilters => ({
  ...DEFAULT_CATALOG_FILTERS,
  difficulties: [],
  ...overrides,
});

describe("parseCatalogFilters", () => {
  it("defaults everything for an empty query string", () => {
    expect(parseCatalogFilters({})).toEqual(DEFAULT_CATALOG_FILTERS);
  });

  it("treats the empty fields a plain GET form submits as absent", () => {
    const parsed = parseCatalogFilters({ q: "", topic: "", status: "all", company: "", sort: "code" });
    expect(parsed).toEqual(DEFAULT_CATALOG_FILTERS);
    expect(hasActiveFilters(parsed)).toBe(false);
  });

  it("accepts several difficulties (repeated or comma-separated, any case) in canonical order, deduplicated", () => {
    expect(parseCatalogFilters({ difficulty: ["hard", "EASY", "Hard"] }).difficulties).toEqual(["EASY", "HARD"]);
    expect(parseCatalogFilters({ difficulty: "medium,easy" }).difficulties).toEqual(["EASY", "MEDIUM"]);
    expect(parseCatalogFilters({ difficulty: ["EXPERT", "", "easy;drop table"] }).difficulties).toEqual([]);
  });

  it("accepts only the 14 topics", () => {
    expect(parseCatalogFilters({ topic: "graphs" }).topic).toBe("GRAPHS");
    expect(parseCatalogFilters({ topic: "DYNAMIC_PROGRAMMING" }).topic).toBe("DYNAMIC_PROGRAMMING");
    expect(parseCatalogFilters({ topic: "QUANTUM" }).topic).toBeNull();
    expect(parseCatalogFilters({ topic: ["TREES", "GRAPHS"] }).topic).toBe("TREES");
  });

  it("accepts only the known statuses and sorts", () => {
    expect(parseCatalogFilters({ status: "solved" }).status).toBe("solved");
    expect(parseCatalogFilters({ status: "NOT-ATTEMPTED" }).status).toBe("not-attempted");
    expect(parseCatalogFilters({ status: "hacked" }).status).toBe("all");
    expect(parseCatalogFilters({ sort: "acceptance" }).sort).toBe("acceptance");
    expect(parseCatalogFilters({ sort: "difficulty-desc" }).sort).toBe("difficulty-desc");
    expect(parseCatalogFilters({ sort: "title; DROP TABLE" }).sort).toBe("code");
  });

  it("shape-checks the company slug (resolution against curated companies happens later)", () => {
    expect(parseCatalogFilters({ company: "acme-corp" }).company).toBe("acme-corp");
    expect(parseCatalogFilters({ company: "Acme-Corp" }).company).toBe("acme-corp");
    expect(parseCatalogFilters({ company: "-acme" }).company).toBeNull();
    expect(parseCatalogFilters({ company: "acme corp" }).company).toBeNull();
    expect(parseCatalogFilters({ company: "a".repeat(65) }).company).toBeNull();
  });

  it("parses the page defensively", () => {
    expect(parseCatalogFilters({ page: "3" }).page).toBe(3);
    expect(parseCatalogFilters({ page: "0" }).page).toBe(1);
    expect(parseCatalogFilters({ page: "-2" }).page).toBe(1);
    expect(parseCatalogFilters({ page: "2.5" }).page).toBe(1);
    expect(parseCatalogFilters({ page: "1e3" }).page).toBe(1);
    expect(parseCatalogFilters({ page: "abc" }).page).toBe(1);
    expect(parseCatalogFilters({ page: String(CATALOG_MAX_PAGE) }).page).toBe(CATALOG_MAX_PAGE);
    expect(parseCatalogFilters({ page: String(CATALOG_MAX_PAGE + 1) }).page).toBe(1);
    expect(parseCatalogFilters({ page: "99999999999999999999" }).page).toBe(1);
  });

  it("never throws on hostile input", () => {
    const hostile = {
      q: ["%' OR 1=1 --", "x"],
      difficulty: "\u0000",
      topic: "__proto__",
      status: "constructor",
      company: "../../etc",
      sort: "toString",
      page: "NaN",
      extra: "ignored",
    };
    expect(() => parseCatalogFilters(hostile)).not.toThrow();
    const parsed = parseCatalogFilters(hostile);
    expect(parsed.topic).toBeNull();
    expect(parsed.status).toBe("all");
    expect(parsed.sort).toBe("code");
    expect(parsed.company).toBeNull();
    // The apostrophe is title punctuation and harmless: the text is a bound parameter.
    expect(parsed.q).toBe("' OR 1 1 --");
    expect(parsed.q).not.toMatch(/[%_\\=]/);
  });
});

describe("search sanitising", () => {
  it("removes LIKE wildcards, the escape character and quotes, collapsing whitespace", () => {
    expect(sanitizeSearch("  two   sum ")).toBe("two sum");
    expect(sanitizeSearch("50%_off\\now")).toBe("50 off now");
    expect(sanitizeSearch('"quoted" `tick`')).toBe("quoted tick");
    expect(sanitizeSearch("line\nbreak\ttab\u0007bell")).toBe("line break tab bell");
  });

  it("keeps letters in any script, digits and title punctuation", () => {
    expect(sanitizeSearch("Dijkstra's path-finding")).toBe("Dijkstra's path-finding");
    expect(sanitizeSearch("C++ & C#")).toBe("C++ & C#");
    expect(sanitizeSearch("தமிழ் 2")).toBe("தமிழ் 2");
    // NFKC folds full-width forms.
    expect(sanitizeSearch("ＡＢＣ")).toBe("ABC");
  });

  it("caps the length", () => {
    expect(sanitizeSearch("x".repeat(500))).toHaveLength(SEARCH_MAX_LENGTH);
  });

  it("ignores non-strings", () => {
    expect(sanitizeSearch(undefined)).toBe("");
    expect(sanitizeSearch(42)).toBe("");
    expect(sanitizeSearch(["a"])).toBe("");
  });

  it("matches words of at least 2 characters, lower-cased, deduplicated, at most 5", () => {
    expect(searchTerms("Two Sum")).toEqual(["two", "sum"]);
    expect(searchTerms("a")).toEqual([]);
    expect(searchTerms("a b c")).toEqual([]);
    expect(searchTerms("x path")).toEqual(["path"]);
    expect(searchTerms("sum SUM Sum")).toEqual(["sum"]);
    expect(searchTerms("aa bb cc dd ee ff gg")).toEqual(["aa", "bb", "cc", "dd", "ee"]);
  });

  it("flags a search that is too short to run", () => {
    expect(searchTooShort("")).toBe(false);
    expect(searchTooShort("a")).toBe(true);
    expect(searchTooShort("a b")).toBe(true);
    expect(searchTooShort("ab")).toBe(false);
  });

  it("a search that is too short does not count as a filter", () => {
    expect(hasActiveFilters(parseCatalogFilters({ q: "a" }))).toBe(false);
    expect(hasActiveFilters(parseCatalogFilters({ q: "ab" }))).toBe(true);
  });
});

describe("canonical URLs", () => {
  it("omits defaults", () => {
    expect(catalogQuery(filters())).toBe("");
    expect(catalogHref(filters())).toBe("/problems");
    expect(catalogHref(filters({ page: 1, sort: "code", status: "all" }))).toBe("/problems");
  });

  it("serialises every filter and round-trips through the parser", () => {
    const f = filters({
      q: "two sum",
      difficulties: ["EASY", "HARD"],
      topic: "GRAPHS",
      status: "not-attempted",
      company: "acme",
      sort: "acceptance-asc",
      page: 3,
    });
    const href = catalogHref(f);
    expect(href).toBe(
      "/problems?q=two+sum&difficulty=EASY&difficulty=HARD&topic=GRAPHS&status=not-attempted&company=acme&sort=acceptance-asc&page=3",
    );
    const params = new URLSearchParams(href.split("?")[1]);
    const raw: Record<string, string | string[]> = {};
    for (const key of new Set(params.keys())) {
      const values = params.getAll(key);
      raw[key] = values.length > 1 ? values : (values[0] ?? "");
    }
    expect(parseCatalogFilters(raw)).toEqual(f);
  });

  it("applies overrides and an optional fragment", () => {
    expect(catalogHref(filters({ topic: "TREES", page: 4 }), { page: 5 }, "problem-results")).toBe(
      "/problems?topic=TREES&page=5#problem-results",
    );
  });
});

describe("pagination", () => {
  it("counts pages of 50, with at least one page", () => {
    expect(pageCount(0)).toBe(1);
    expect(pageCount(50)).toBe(1);
    expect(pageCount(51)).toBe(2);
    expect(pageCount(450)).toBe(9);
  });

  it("windows page numbers around the current page with gaps", () => {
    expect(pageWindow(1, 1)).toEqual([1]);
    expect(pageWindow(1, 3)).toEqual([1, 2, 3]);
    expect(pageWindow(5, 10)).toEqual([1, null, 4, 5, 6, null, 10]);
    expect(pageWindow(1, 10)).toEqual([1, 2, null, 10]);
    expect(pageWindow(10, 10)).toEqual([1, null, 9, 10]);
    // A gap of exactly one page shows that page instead of an ellipsis.
    expect(pageWindow(4, 10)).toEqual([1, 2, 3, 4, 5, null, 10]);
  });
});

describe("acceptance", () => {
  it("formats one decimal and shows nothing without submissions", () => {
    expect(acceptancePercent(0, 0)).toBeNull();
    expect(acceptancePercent(1, 3)).toBe("33.3%");
    expect(acceptancePercent(2, 2)).toBe("100.0%");
    expect(acceptancePercent(0, 7)).toBe("0.0%");
    expect(acceptancePercent(9, 3)).toBe("100.0%");
  });
});

describe("empty states per filter combination", () => {
  it("has its own copy for each status on its own", () => {
    expect(emptyStateCopy(filters()).title).toBe("No problems published yet");
    expect(emptyStateCopy(filters({ status: "solved" })).title).toBe("You haven't solved a problem yet");
    expect(emptyStateCopy(filters({ status: "attempted" })).title).toBe("Nothing in progress");
    expect(emptyStateCopy(filters({ status: "not-attempted" })).title).toBe("You have attempted every problem");
  });

  it("names the search when only a search was made", () => {
    const copy = emptyStateCopy(filters({ q: "zebra" }));
    expect(copy.title).toBe("No problem titles match “zebra”");
  });

  it("describes the whole combination otherwise", () => {
    const f = filters({
      q: "path",
      difficulties: ["MEDIUM", "HARD"],
      topic: "GRAPHS",
      company: "acme",
      status: "solved",
    });
    expect(describeFilters(f, { companyName: "Acme" })).toBe(
      "Medium or Hard problems in Graphs tagged Acme matching “path” that you have solved",
    );
    const copy = emptyStateCopy(f, { companyName: "Acme" });
    expect(copy.title).toBe("No problems match these filters");
    expect(copy.description).toBe(
      "There are no Medium or Hard problems in Graphs tagged Acme matching “path” that you have solved. Remove a filter to see more.",
    );
    expect(emptyStateCopy(filters({ difficulties: ["EASY"], status: "attempted" })).description).toBe(
      "There are no Easy problems that you have attempted but not solved. Remove a filter to see more.",
    );
    expect(describeFilters(filters({ difficulties: ["EASY", "MEDIUM", "HARD"] }))).toBe(
      "Easy, Medium or Hard problems",
    );
  });
});
