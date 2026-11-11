import { describe, expect, it } from "vitest";
import { CODE_EXTENSIONS, findFiles, lexSource, lineAt, readRepoFile } from "./support/repo";

/**
 * A seeded pattern's NAME never appears without its notice.
 *
 * SPEC §5 asks for the label in its own words:
 *
 *   Seed patterns modelled on the publicly described TCS NQT, Infosys, Wipro,
 *   Cognizant and Accenture funnels plus a generic campus pattern, each
 *   labelled in the UI "modelled on the publicly described pattern — not an
 *   official test."
 *
 * The label is one shared constant because an editable per-row disclaimer is
 * a per-row opportunity to delete the disclaimer — and a constant plus a
 * manual check is not a fence either. A label a future redesign can quietly
 * drop is a label that implies an endorsement these five companies have not
 * given, so the rule is checked: any module that writes one of their names
 * must also render the notice.
 *
 * The rule is about NAMES, not about the slug. `tcs-nqt` in a route or a
 * query is a key; "TCS NQT" on a page is a claim.
 */

/**
 * The five company names, as the seeds spell them.
 *
 * Held here rather than imported: the repo fences read source text and take
 * no dependency on the workspace packages, which is what lets them run
 * before anything is built. The list is kept honest by the test below, which
 * reads `mock-pattern.ts` and fails if a seed is renamed or a sixth company
 * pattern appears without this fence learning about it.
 */
const COMPANY_NAMES = ["TCS NQT", "Infosys", "Wipro", "Cognizant", "Accenture"] as const;

const SEEDS_FILE = "packages/shared/src/mock-pattern.ts";

/** Where the notice may come from. One component renders it; these are its names. */
const NOTICE_SOURCES = ["MODELLED_ON_NOTICE", "patternNotice", "GENERIC_PATTERN_NOTICE", "PatternNotice"];

/**
 * Files allowed to write a company name without the notice, and why.
 *
 * The seed data itself has to say "TCS NQT" — it is the name — and the
 * notice travels with it through `patternNotice()`. Every other exemption has
 * to earn its line.
 */
const MAY_NAME_A_COMPANY: ReadonlyArray<{ readonly path: string; readonly why: string }> = [
  {
    path: SEEDS_FILE,
    why: "the seed data and the notice constants both live here; patternNotice() is defined beside the names",
  },
  {
    path: "packages/shared/test/mock-pattern.test.ts",
    why: "asserts which patterns claim a company and that each gets a notice",
  },
  {
    path: "packages/shared/test/aptitude-grading.test.ts",
    why: "the spec's gate test, which grades every seeded pattern by slug and name",
  },
  {
    path: "tests/repo/aptitude-notice.test.ts",
    why: "this fence, which has to hold the names to look for them",
  },
];

const EXEMPT = new Set(MAY_NAME_A_COMPANY.map((entry) => entry.path));

/** Every file that could render a name to a person. */
function renderingFiles(): string[] {
  return findFiles({
    extensions: CODE_EXTENSIONS,
    under: ["apps/web/src", "packages/design/src", "packages/shared/src", "packages/shared/test", "tests/repo"],
  });
}

/** Company names written in a file's CODE (not its comments or its imports). */
function companyMentions(source: string): Array<{ name: string; index: number }> {
  const stripped = lexSource(source).code;
  const out: Array<{ name: string; index: number }> = [];
  for (const name of COMPANY_NAMES) {
    for (const match of stripped.matchAll(new RegExp(escape(name), "g"))) {
      out.push({ name, index: match.index ?? 0 });
    }
  }
  return out;
}

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

describe("a seeded pattern's name never appears without its notice", () => {
  const files = renderingFiles();

  it("knows every name the seeds actually claim", () => {
    // Read from the source, so a renamed seed or a sixth company pattern
    // fails HERE rather than shipping an unlabelled claim.
    // A line scan rather than a regex over the whole file: a seed is a
    // `name:` line followed within a few lines by its `modelledOnCompany:`,
    // and reading them in order is both simpler and obvious to check.
    const lines = readRepoFile(SEEDS_FILE).split("\n");
    const claimed: string[] = [];
    let pendingName: string | null = null;
    for (const line of lines) {
      const name = /^\s*name:\s*"([^"]+)",/.exec(line)?.[1];
      if (name) {
        pendingName = name;
        continue;
      }
      const claim = /^\s*modelledOnCompany:\s*(true|false),/.exec(line)?.[1];
      if (claim === undefined) continue;
      if (claim === "true" && pendingName) claimed.push(pendingName);
      pendingName = null;
    }
    expect(claimed).toEqual([...COMPANY_NAMES]);
    // And the generic pattern is not one of them: it claims nobody.
    expect(claimed).not.toContain("Generic campus pattern");
  });

  it("names a reason for every exemption, and every exempted path exists", () => {
    const present = new Set(findFiles({ extensions: CODE_EXTENSIONS }));
    for (const entry of MAY_NAME_A_COMPANY) {
      expect(entry.why.length, entry.path).toBeGreaterThan(20);
      expect(present.has(entry.path), `${entry.path} is exempted but does not exist`).toBe(true);
    }
  });

  describe("self-test of the detector", () => {
    it("sees a name in code and not in a comment or a string that only looks like one", () => {
      expect(companyMentions(`const label = "TCS NQT";`)).toHaveLength(1);
      // A comment is not a rendered label.
      expect(companyMentions(`// TCS NQT is the pattern this models`)).toHaveLength(0);
      expect(companyMentions(`/* Wipro */`)).toHaveLength(0);
      // The slug is a key, not a claim.
      expect(companyMentions(`const slug = "tcs-nqt";`)).toHaveLength(0);
    });

    it("finds every name, not just the first", () => {
      expect(companyMentions(`const a = "Infosys"; const b = "Wipro";`)).toHaveLength(2);
    });
  });

  it("holds the rule over the whole repository", () => {
    const problems: string[] = [];
    for (const file of files) {
      if (EXEMPT.has(file)) continue;
      const source = readRepoFile(file);
      const mentions = companyMentions(source);
      if (mentions.length === 0) continue;
      const carriesNotice = NOTICE_SOURCES.some((token) => source.includes(token));
      if (carriesNotice) continue;
      for (const mention of mentions) {
        problems.push(
          `${file}:${lineAt(source, mention.index)} writes "${mention.name}" with no notice. Render patternNotice(pattern) beside it, or add the file to MAY_NAME_A_COMPANY with a reason.`,
        );
      }
    }
    expect(problems).toEqual([]);
  });

  it("the notice says what the spec requires it to say", () => {
    const source = readRepoFile(SEEDS_FILE);
    expect(source).toContain("Modelled on the publicly described pattern — not an official test.");
    // And the generic pattern's notice does NOT claim to model anything,
    // because that would be the one false sentence on the page.
    expect(source).toContain("A balanced practice pattern — not an official test.");
  });

  it("there is exactly one place each notice is spelled", () => {
    // An editable per-row disclaimer is a per-row opportunity to delete the
    // disclaimer, and two copies of the wording are two things to keep in
    // step. A component renders the constant; nothing retypes it.
    //
    // The two exceptions are the file that DEFINES it and the tests that
    // assert the spec's exact wording — a test that checked the wording by
    // importing the constant would pass whatever the constant said.
    const spellsItOnPurpose = new Set([SEEDS_FILE, "packages/shared/test/mock-pattern.test.ts"]);
    const spellings = findFiles({ extensions: CODE_EXTENSIONS }).filter((file) => {
      if (spellsItOnPurpose.has(file) || file.startsWith("tests/repo/")) return false;
      return readRepoFile(file).includes("Modelled on the publicly described pattern");
    });
    expect(spellings).toEqual([]);
  });
});
