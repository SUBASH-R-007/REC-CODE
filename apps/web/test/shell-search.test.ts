import { describe, expect, it } from "vitest";
import {
  SEARCH_MAX_LENGTH,
  SEARCH_MIN_LENGTH,
  escapeLikePattern,
  sanitizeSearchQuery,
  searchParamsSchema,
} from "@/app/api/search/query";
import { SEARCH_RESULT_LIMIT, parseSearchResponse } from "@/components/shell/search-result";

describe("sanitizeSearchQuery", () => {
  it.each([
    ["two sum", "two sum"],
    ["  two   sum  ", "two sum"],
    ["two\tsum\nbrackets", "two sum brackets"],
    ["two\u0000sum", "two sum"],
    ["​two‍ sum‮", "two sum"], // zero-width and bidi controls
    ["ＴＷＯ ＳＵＭ", "TWO SUM"], // full-width → NFKC
    ["50% off_", "50% off_"], // wildcards survive here; escaped separately
  ])("%j → %j", (raw, expected) => {
    expect(sanitizeSearchQuery(raw)).toBe(expected);
  });

  it("refuses queries with fewer than the minimum characters", () => {
    expect(SEARCH_MIN_LENGTH).toBe(2);
    expect(sanitizeSearchQuery("")).toBeNull();
    expect(sanitizeSearchQuery("   ")).toBeNull();
    expect(sanitizeSearchQuery("a")).toBeNull();
    expect(sanitizeSearchQuery(" a\u0000 ")).toBeNull();
    expect(sanitizeSearchQuery(null)).toBeNull();
    expect(sanitizeSearchQuery(undefined)).toBeNull();
    expect(sanitizeSearchQuery("ab")).toBe("ab");
  });

  it("caps length by code points without splitting a surrogate pair", () => {
    const long = "x".repeat(500);
    expect(sanitizeSearchQuery(long)).toHaveLength(SEARCH_MAX_LENGTH);
    const emoji = "😀".repeat(100);
    const capped = sanitizeSearchQuery(emoji) ?? "";
    expect(Array.from(capped)).toHaveLength(SEARCH_MAX_LENGTH);
    expect(capped).not.toMatch(/[\uD800-\uDBFF]$/); // no dangling high surrogate
  });
});

describe("escapeLikePattern", () => {
  it("escapes LIKE metacharacters so they match literally", () => {
    expect(escapeLikePattern("100%")).toBe("100\\%");
    expect(escapeLikePattern("snake_case")).toBe("snake\\_case");
    expect(escapeLikePattern("a\\b")).toBe("a\\\\b");
    expect(escapeLikePattern("plain words")).toBe("plain words");
  });
});

describe("searchParamsSchema", () => {
  it("accepts and cleans a normal query", () => {
    expect(searchParamsSchema.parse({ q: "  Two  Sum " })).toEqual({ q: "Two Sum" });
  });

  it("rejects short, missing and oversized input", () => {
    expect(searchParamsSchema.safeParse({ q: "a" }).success).toBe(false);
    expect(searchParamsSchema.safeParse({}).success).toBe(false);
    expect(searchParamsSchema.safeParse({ q: "x".repeat(513) }).success).toBe(false);
    expect(searchParamsSchema.safeParse({ q: 42 }).success).toBe(false);
  });
});

describe("parseSearchResponse (client-side validation)", () => {
  const good = { slug: "two-sum", displayCode: "P0001", title: "Two Sum", difficulty: "EASY", status: "solved" };

  it("keeps well-formed rows and normalises status", () => {
    expect(parseSearchResponse({ results: [good, { ...good, slug: "b", status: "weird" }] })).toEqual([
      good,
      { ...good, slug: "b", status: null },
    ]);
  });

  it("drops malformed rows and unsafe slugs", () => {
    const rows = parseSearchResponse({
      results: [
        null,
        "x",
        { ...good, slug: "../admin" },
        { ...good, slug: "//evil.example" },
        { ...good, difficulty: "IMPOSSIBLE" },
        { ...good, title: 5 },
      ],
    });
    expect(rows).toEqual([]);
  });

  it("tolerates garbage payloads and caps the count", () => {
    expect(parseSearchResponse(null)).toEqual([]);
    expect(parseSearchResponse({ results: "nope" })).toEqual([]);
    const many = Array.from({ length: 20 }, (_, i) => ({ ...good, slug: `p-${i}` }));
    expect(parseSearchResponse({ results: many })).toHaveLength(SEARCH_RESULT_LIMIT);
  });
});
