import { describe, expect, it } from "vitest";
import {
  LANGUAGE_KEYS,
  acceptsLanguage,
  normalisePaperLanguages,
  paperLanguageLabel,
  paperLanguageViews,
  paperLanguages,
  questionLanguages,
  shortLanguageLabel,
} from "../src";

/**
 * The accepted-language set (Phase 13a).
 *
 * The rules asserted here are the ones that decide what a candidate can
 * type into, mid-exam, with a clock running. Each test is a thing that
 * would otherwise be found in a hall.
 */

describe("normalisePaperLanguages", () => {
  it("keeps the catalog's order, whatever order they were ticked in", () => {
    // The picker is read mid-exam. A list that reorders itself because an
    // administrator re-saved the paper is a list a candidate mis-clicks.
    expect(normalisePaperLanguages(["py312", "c17", "cpp20"])).toEqual(["c17", "cpp20", "py312"]);
  });

  it("drops duplicates", () => {
    expect(normalisePaperLanguages(["py312", "py312"])).toEqual(["py312"]);
  });

  it("drops a key the catalog does not know, rather than throwing", () => {
    // This reads stored rows. A language retired from the catalog must not
    // make an existing paper unreadable; the ACTION refuses a typo.
    expect(normalisePaperLanguages(["cpp20", "fortran77"])).toEqual(["cpp20"]);
  });

  it("treats anything that is not a list as no restriction", () => {
    expect(normalisePaperLanguages(null)).toEqual([]);
    expect(normalisePaperLanguages(undefined)).toEqual([]);
    expect(normalisePaperLanguages("cpp20")).toEqual([]);
    expect(normalisePaperLanguages({ 0: "cpp20" })).toEqual([]);
  });
});

describe("paperLanguages", () => {
  const available = ["cpp20", "py312", "java21"];

  it("offers every installed language when the paper restricts nothing", () => {
    // Which is what every assessment already in the database holds, so
    // this feature changes no stored meaning.
    expect(paperLanguages({ allowed: [], available })).toEqual(["cpp20", "java21", "py312"]);
  });

  it("offers the paper's own set when it has one", () => {
    expect(paperLanguages({ allowed: ["py312", "cpp20"], available })).toEqual(["cpp20", "py312"]);
  });

  it("never offers a language the judge cannot run", () => {
    /**
     * The one that matters. An administrator picks Rust, somebody
     * disables the Rust toolchain a week later, and the candidate must
     * not be given an editor whose every Run is refused with "that
     * language is not available right now".
     */
    expect(paperLanguages({ allowed: ["cpp20", "rust180"], available })).toEqual(["cpp20"]);
  });

  it("can come back empty, which the caller has to handle", () => {
    expect(paperLanguages({ allowed: ["rust180"], available })).toEqual([]);
    expect(paperLanguages({ allowed: [], available: [] })).toEqual([]);
  });

  it("ignores an available key the catalog does not know", () => {
    // `LanguageConfig` rows are data; a row for a language this build has
    // never heard of is not something to offer a candidate.
    expect(paperLanguages({ allowed: [], available: ["cpp20", "cobol85"] })).toEqual(["cpp20"]);
  });
});

describe("acceptsLanguage", () => {
  it("answers from the frozen set it is given, and nothing else", () => {
    expect(acceptsLanguage(["cpp20", "py312"], "py312")).toBe(true);
    expect(acceptsLanguage(["cpp20", "py312"], "java21")).toBe(false);
    expect(acceptsLanguage([], "cpp20")).toBe(false);
  });
});

describe("the labels", () => {
  it("names the pinned toolchain in full, because that is what judges the answer", () => {
    expect(paperLanguageLabel("cpp20")).toContain("GCC 13.2.0");
  });

  it("drops the toolchain for the dropdown", () => {
    expect(shortLanguageLabel("cpp20")).toBe("C++20");
    expect(shortLanguageLabel("py312")).toBe("Python 3.12");
    expect(shortLanguageLabel("rust180")).toBe("Rust 1.80.0");
  });

  it("falls back to the key for a language it does not know", () => {
    // A stored row written by a build whose catalog had a language this
    // one does not is still a row some screen has to render.
    expect(paperLanguageLabel("fortran77")).toBe("fortran77");
    expect(shortLanguageLabel("fortran77")).toBe("fortran77");
  });

  it("has a short label for every language in the catalog", () => {
    for (const key of LANGUAGE_KEYS) {
      expect(shortLanguageLabel(key).length).toBeGreaterThan(0);
      expect(shortLanguageLabel(key)).not.toContain("(");
    }
  });
});

describe("paperLanguageViews", () => {
  it("resolves both labels and the editor mode, so no client needs the catalog", () => {
    /**
     * The reason this function exists. A client component that called
     * `shortLanguageLabel` itself pulled `LANGUAGE_CATALOG` — eleven
     * toolchains' compiler argv, environment and limits — into the
     * browser bundle and into the chunk every budgeted route shares. The
     * sitting's own size budget caught it, 1.2 KB over, on the one page
     * that loads on a lab machine over a campus network.
     */
    expect(paperLanguageViews(["cpp20", "py312"])).toEqual([
      { key: "cpp20", label: "C++20 (GCC 13.2.0)", shortLabel: "C++20", editorLanguage: "cpp" },
      {
        key: "py312",
        label: "Python 3.12 (CPython 3.12.6, numpy 1.26.4)",
        shortLabel: "Python 3.12",
        editorLanguage: "python",
      },
    ]);
  });

  it("gives an unknown key a plaintext editor rather than throwing", () => {
    expect(paperLanguageViews(["fortran77"])).toEqual([
      { key: "fortran77", label: "fortran77", shortLabel: "fortran77", editorLanguage: "plaintext" },
    ]);
  });
});

describe("questionLanguages", () => {
  const paper = ["cpp20", "py312", "java21"];

  it("gives the paper's set to a question that does not narrow it", () => {
    expect(questionLanguages({ question: [], paper })).toEqual(["cpp20", "java21", "py312"]);
    expect(questionLanguages({ question: undefined, paper })).toEqual(["cpp20", "java21", "py312"]);
  });

  it("narrows to the question's own list", () => {
    // "Answer this one in C" is a real thing to ask of a question about
    // pointers, without making the whole paper C.
    expect(questionLanguages({ question: ["py312"], paper })).toEqual(["py312"]);
  });

  it("narrows, and never widens", () => {
    /**
     * A question cannot quietly accept something the paper does not: the
     * paper is what the candidate was told, on the readiness page, before
     * the clock started.
     */
    expect(questionLanguages({ question: ["py312", "rust180"], paper })).toEqual(["py312"]);
  });

  it("falls back to the paper when narrowing would leave nothing", () => {
    /**
     * A question restricted to a language the paper does not accept is a
     * misconfiguration, and the admin screen refuses it where somebody is
     * choosing. Mid-sitting the better answer is the paper's own set: a
     * question nobody can answer is worse than one answerable in what the
     * paper already promised.
     */
    expect(questionLanguages({ question: ["rust180"], paper })).toEqual(["cpp20", "java21", "py312"]);
  });

  it("intersects with what the judge can run when asked to", () => {
    expect(questionLanguages({ question: [], paper, available: ["cpp20", "py312"] })).toEqual(["cpp20", "py312"]);
    expect(questionLanguages({ question: ["java21"], paper, available: ["cpp20", "py312"] })).toEqual([
      "cpp20",
      "py312",
    ]);
  });
});
