import { describe, expect, it } from "vitest";

/**
 * The workspace footer's language: label plus the pinned version
 * (LanguageConfig.version), linked to that language's section of /judge in
 * a new tab — or plain text where the workspace turns the link off.
 */

const React = await import("react");
(globalThis as { React?: unknown }).React = React;
const { createElement } = React;
const { renderToStaticMarkup } = await import("react-dom/server");
const { LanguageVersion } = await import("@/components/workspace/language-version");
const { JUDGE_PAGE_PATH, formatLanguageVersion, judgeLanguageAnchor, judgeLanguageHref } = await import(
  "@/lib/judge/judge-links"
);

describe("judge links", () => {
  it("anchors and hrefs", () => {
    expect(JUDGE_PAGE_PATH).toBe("/judge");
    expect(judgeLanguageAnchor("cpp20")).toBe("lang-cpp20");
    expect(judgeLanguageHref("py312")).toBe("/judge#lang-py312");
  });

  it("does not repeat a version the label already carries", () => {
    expect(formatLanguageVersion("C++20 (GCC 13.2.0)", "13.2.0")).toBe("C++20 (GCC 13.2.0)");
    expect(formatLanguageVersion("Go 1.23.2", "1.23.2")).toBe("Go 1.23.2");
  });

  it("appends a version the label lacks, and nothing for an empty one", () => {
    expect(formatLanguageVersion("C++20", "13.2.0")).toBe("C++20 · 13.2.0");
    expect(formatLanguageVersion("C++20", "  ")).toBe("C++20");
  });
});

describe("LanguageVersion", () => {
  it("links to the language's /judge section in a new tab, and says so", () => {
    const html = renderToStaticMarkup(
      createElement(LanguageVersion, { label: "C++20", version: "13.2.0", href: judgeLanguageHref("cpp20") }),
    );
    expect(html).toContain('href="/judge#lang-cpp20"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener"');
    expect(html).toContain("C++20 · 13.2.0");
    expect(html).toMatch(/<span class="sr-only">[^<]*opens in a new tab<\/span>/);
  });

  it("renders plain text without a link when href is null", () => {
    const html = renderToStaticMarkup(
      createElement(LanguageVersion, { label: "Python 3.12 (CPython 3.12.6, numpy 1.26.4)", version: "3.12.6", href: null }),
    );
    expect(html).not.toContain("<a");
    expect(html).toContain("Python 3.12 (CPython 3.12.6, numpy 1.26.4)");
    expect(html).not.toContain("3.12.6 · ");
  });
});
