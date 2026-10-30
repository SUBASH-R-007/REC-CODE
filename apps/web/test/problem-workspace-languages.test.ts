import { describe, expect, it, vi } from "vitest";
import { LANGUAGE_CATALOG, SQL_EDITOR_LANGUAGE, SQL_STARTER_CODE } from "@recx/shared";

/**
 * getProblemWorkspace() hands each enabled language's pinned toolchain
 * version (LanguageConfig.version) to the workspace, whose footer shows it
 * and links to /judge — the version is read from the row, not parsed out of
 * the label.
 *
 * Since Phase 10c the read is three cached reads rather than one query, and
 * this test is also where that shape is asserted: the live POINTER, the
 * frozen CONTENT keyed by `problem:{id}:v{n}`, and the language list — which
 * is deliberately NOT inside the version-keyed entry, because an admin
 * enables and disables languages on their own schedule and freezing them
 * under a problem's version would keep offering a language that had been
 * turned off.
 */

const h = vi.hoisted(() => ({
  languages: vi.fn(),
  problem: vi.fn(),
  version: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    problem: { findUnique: h.problem },
    problemVersion: { findUnique: h.version },
    languageConfig: { findMany: h.languages },
  },
}));

// The cache is Next's; in a unit test it is the identity, so the reads run.
vi.mock("next/cache", () => ({
  unstable_cache: <T>(fn: T) => fn,
  revalidateTag: vi.fn(),
  revalidatePath: vi.fn(),
}));

const { getProblemWorkspace } = await import("@/server/queries/problems");
const { problemCacheKey } = await import("@/lib/problems/cache");

function pointer(overrides: Record<string, unknown> = {}) {
  return {
    id: "prob_1",
    slug: "two-sum",
    displayCode: "REC-0001",
    status: "PUBLISHED",
    version: 7,
    liveVersionId: "ver_1",
    ...overrides,
  };
}

function content(overrides: Record<string, unknown> = {}) {
  return {
    id: "ver_1",
    title: "Two Sum",
    difficulty: "EASY",
    statementMd: "Add **two** numbers.",
    constraints: [],
    ioMode: "STDIN",
    functionSignature: null,
    sqlDialect: null,
    sqlOrdered: null,
    timeLimitMs: 1000,
    memoryLimitKb: 262_144,
    starterCodes: [],
    testCases: [],
    ...overrides,
  };
}

describe("getProblemWorkspace languages", () => {
  it("selects LanguageConfig.version and passes it through", async () => {
    h.problem.mockResolvedValue(pointer());
    h.version.mockResolvedValue(content());
    h.languages.mockResolvedValue([
      { key: "cpp20", label: "C++20 (GCC 13.2.0)", version: "13.2.0-pinned" },
      { key: "py312", label: "Python 3.12", version: "3.12.6" },
    ]);

    const workspace = await getProblemWorkspace("two-sum");

    expect(h.languages).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { enabled: true, isCurrent: true },
        select: expect.objectContaining({ key: true, label: true, version: true }),
      }),
    );
    expect(workspace?.languages.map((l) => [l.key, l.label, l.version])).toEqual([
      ["cpp20", "C++20 (GCC 13.2.0)", "13.2.0-pinned"],
      ["py312", "Python 3.12", "3.12.6"],
    ]);
    expect(workspace?.languages[0]?.editorLanguage).toBe(LANGUAGE_CATALOG.cpp20.editorLanguage);
  });

  it("reads the content under the version's own key, and renders the statement there", async () => {
    h.problem.mockResolvedValue(pointer({ version: 7 }));
    h.version.mockResolvedValue(content());
    h.languages.mockResolvedValue([]);

    const workspace = await getProblemWorkspace("two-sum");

    // The key is the one SPEC §10 names, and the version in it is what makes
    // the entry immutable: a publish writes a new key rather than
    // invalidating this one.
    expect(problemCacheKey("prob_1", 7)).toBe("problem:prob_1:v7");
    expect(h.version).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "ver_1" } }));
    // Rendered inside the cached read: the markdown render and the sanitiser
    // were the expensive half of a statement.
    expect(workspace?.statementHtml).toContain("<strong>two</strong>");
    expect(workspace?.statementMd).toBe("Add **two** numbers.");
  });

  it("asks the database for the sample test cases only", async () => {
    h.problem.mockResolvedValue(pointer());
    h.version.mockResolvedValue(content());
    h.languages.mockResolvedValue([]);

    await getProblemWorkspace("two-sum");

    // A cache is a second place a hidden test could end up, and it is the
    // one with no access control over it at all.
    const select = h.version.mock.calls[0]?.[0]?.select as { testCases?: { where?: unknown } };
    expect(select.testCases?.where).toEqual({ isSample: true });
  });

  /**
   * Phase 12k. A SQL problem is answered with SQL and nothing else, and no
   * other problem is answered with SQL — the submit action refuses the
   * other pairing anyway, so offering it would be offering a locked door.
   */
  const SQL_ROW = { key: "sql17", label: "PostgreSQL 17", version: "17.2" };

  it("offers a SQL problem SQL alone, with the SQL grammar and starter", async () => {
    h.problem.mockResolvedValue(pointer());
    h.version.mockResolvedValue(content({ ioMode: "SQL", sqlDialect: "postgres17", sqlOrdered: true }));
    h.languages.mockResolvedValue([
      { key: "cpp20", label: "C++20 (GCC 13.2.0)", version: "13.2.0-pinned" },
      SQL_ROW,
    ]);

    const workspace = await getProblemWorkspace("two-sum");

    expect(workspace?.languages.map((l) => l.key)).toEqual(["sql17"]);
    expect(workspace?.languages[0]?.label).toBe("PostgreSQL 17");
    expect(workspace?.languages[0]?.editorLanguage).toBe(SQL_EDITOR_LANGUAGE);
    expect(workspace?.languages[0]?.starter).toBe(SQL_STARTER_CODE);
    // The ordering rule travels with it: the Description tab states it, and
    // it is the one thing about a SQL answer only a human could decide.
    expect(workspace?.sqlOrdered).toBe(true);
    expect(workspace?.sqlDialect).toBe("postgres17");
  });

  it("uses the author's starter query when there is one", async () => {
    h.problem.mockResolvedValue(pointer());
    h.version.mockResolvedValue(
      content({
        ioMode: "SQL",
        sqlDialect: "postgres17",
        sqlOrdered: false,
        starterCodes: [{ language: "sql17", code: "SELECT -- your columns here" }],
      }),
    );
    h.languages.mockResolvedValue([SQL_ROW]);

    const workspace = await getProblemWorkspace("two-sum");
    expect(workspace?.languages[0]?.starter).toBe("SELECT -- your columns here");
  });

  it("never offers SQL for a problem that is not a SQL problem", async () => {
    h.problem.mockResolvedValue(pointer());
    h.version.mockResolvedValue(content());
    h.languages.mockResolvedValue([{ key: "cpp20", label: "C++20 (GCC 13.2.0)", version: "13.2.0" }, SQL_ROW]);

    const workspace = await getProblemWorkspace("two-sum");
    expect(workspace?.languages.map((l) => l.key)).toEqual(["cpp20"]);
    expect(workspace?.sqlDialect).toBeNull();
  });

  it("returns null for an unpublished or retired problem without reading its content", async () => {
    for (const bad of [pointer({ status: "DRAFT" }), pointer({ status: "RETIRED" }), pointer({ liveVersionId: null })]) {
      h.version.mockClear();
      h.problem.mockResolvedValue(bad);
      expect(await getProblemWorkspace("two-sum")).toBeNull();
      // The pointer is the guard: a draft's statement is never fetched, so
      // it can never land in the cache.
      expect(h.version).not.toHaveBeenCalled();
    }
  });
});
