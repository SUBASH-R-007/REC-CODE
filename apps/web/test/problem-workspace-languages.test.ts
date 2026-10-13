import { describe, expect, it, vi } from "vitest";
import { LANGUAGE_CATALOG } from "@recx/shared";

/**
 * getProblemWorkspace() hands each enabled language's pinned toolchain
 * version (LanguageConfig.version) to the workspace, whose footer shows it
 * and links to /judge — the version is read from the row, not parsed out of
 * the label.
 */

const h = vi.hoisted(() => ({
  findMany: vi.fn(),
  findUnique: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: { problem: { findUnique: h.findUnique }, languageConfig: { findMany: h.findMany } },
}));

const { getProblemWorkspace } = await import("@/server/queries/problems");

describe("getProblemWorkspace languages", () => {
  it("selects LanguageConfig.version and passes it through", async () => {
    h.findUnique.mockResolvedValue({
      id: "prob_1",
      slug: "two-sum",
      displayCode: "REC-0001",
      title: "Two Sum",
      difficulty: "EASY",
      status: "PUBLISHED",
      liveVersion: {
        id: "ver_1",
        title: "Two Sum",
        difficulty: "EASY",
        statementMd: "…",
        constraints: [],
        ioMode: "STDIN",
        functionSignature: null,
        timeLimitMs: 1000,
        memoryLimitKb: 262_144,
        starterCodes: [],
        testCases: [],
      },
    });
    h.findMany.mockResolvedValue([
      { key: "cpp20", label: "C++20 (GCC 13.2.0)", version: "13.2.0-pinned" },
      { key: "py312", label: "Python 3.12", version: "3.12.6" },
    ]);

    const workspace = await getProblemWorkspace("two-sum");

    expect(h.findMany).toHaveBeenCalledWith(
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
});
