import { describe, expect, it, vi } from "vitest";
import { LANGUAGE_CATALOG } from "@recx/shared";

/**
 * /help's time-limit table reads the same enabled, current LanguageConfig
 * rows as /judge (getPublicLanguageRows + buildJudgeFacts): the multiplier
 * comes from the runtime JSON the worker receives, not from the catalog.
 * The page links to /judge for the exact versions, flags and limits.
 */

const h = vi.hoisted(() => ({ findMany: vi.fn() }));

vi.mock("@/lib/db", () => ({ db: { languageConfig: { findMany: h.findMany } } }));
vi.mock("next/cache", () => ({ unstable_cache: <T>(fn: T) => fn, revalidateTag: vi.fn() }));
vi.mock("@/lib/auth/guards", () => ({ requireUser: async () => ({ id: "user_1" }) }));

const React = await import("react");
(globalThis as { React?: unknown }).React = React;
const { renderToStaticMarkup } = await import("react-dom/server");
const { default: HelpPage } = await import("@/app/(student)/help/page");

describe("/help", () => {
  it("reads the runtime JSON of the enabled rows and links to /judge", async () => {
    const java = { ...LANGUAGE_CATALOG.java21, fallbackMultiplier: 2.2 };
    h.findMany.mockResolvedValue([
      { key: "java21", label: java.label, version: java.version, toolchainId: java.toolchainId, runtime: java },
      {
        key: "py312",
        label: LANGUAGE_CATALOG.py312.label,
        version: LANGUAGE_CATALOG.py312.version,
        toolchainId: LANGUAGE_CATALOG.py312.toolchainId,
        runtime: LANGUAGE_CATALOG.py312,
      },
    ]);
    const html = renderToStaticMarkup(await HelpPage()).replaceAll("<!-- -->", "");

    expect(h.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { enabled: true, isCurrent: true } }));
    expect(html).toContain("C++ limit × 2.2 + 300 ms");
    expect(html).not.toContain(`C++ limit × ${LANGUAGE_CATALOG.java21.fallbackMultiplier} + 300 ms`);
    expect(html).toContain("C++ limit × 5 + 1000 ms");
    expect(html).toMatch(/<a[^>]*href="\/judge"[^>]*>Judge specifications<\/a>/);
  });
});
