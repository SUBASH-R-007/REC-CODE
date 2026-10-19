import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { functionSignatureSchema, isTopic, LANGUAGE_CATALOG, LANGUAGE_KEYS, TOPIC_LABEL, type Topic } from "@recx/shared";
import {
  comparedTypeOf,
  functionCompareMode,
  parseType,
  parseValue,
  starterStub,
  supportsFunctionMode,
  validateFunctionTest,
} from "@recx/shared/harness";
import { generateTwoSumTests, TWO_SUM, TWO_SUM_REFERENCE } from "@recx/shared/samples/two-sum";
import { BADGES } from "../scripts/content/badges";
import { campusDayNumber, dailyChallengeIndex } from "../scripts/content/daily-challenge";
import { HANDLE_MAKER, handleOf, MAX_NAME_LENGTH } from "../scripts/content/handle-maker";
import { AUTHORED_PROBLEMS, HELP_BY_SLUG, TOPICS_BY_SLUG } from "../scripts/content/index";
import { LAB_POWER_BUDGET, LAB_POWER_LIMITS } from "../scripts/content/lab-power-budget";
import { SECOND_SWIPE, SECOND_SWIPE_LIMITS } from "../scripts/content/second-swipe";
import { desiredSections, SEEDED_PLANS, UNTAGGED_SECTION, type PublishedProblem } from "../scripts/content/study-plans";
import type { AuthoredProblem, AuthoredTest } from "../scripts/content/types";

/**
 * The seed's authored content (scripts/content). Every expected output is
 * re-derived here by a DIFFERENT algorithm than the generator's, every input
 * is checked against the stated constraints, and every deliberately-wrong
 * solution is mirrored in JS to prove the tests actually catch it — the same
 * promises the judge's validation pipeline checks, made before a judge runs.
 */

const NEW_PROBLEMS = [HANDLE_MAKER, LAB_POWER_BUDGET, SECOND_SWIPE];

function functionArgs(def: AuthoredProblem, test: AuthoredTest): unknown[] {
  const lines = test.input.split("\n");
  expect(lines.at(-1)).toBe("");
  return def.signature!.params.map((p, i) => parseValue(parseType(p.type), lines[i]!));
}

/** The expected value: the return value, or the mutated parameter after the call (IN_PLACE_MUTATION). */
function functionResult(def: AuthoredProblem, test: AuthoredTest): unknown {
  expect(test.output.endsWith("\n")).toBe(true);
  return parseValue(comparedTypeOf(def.signature!), test.output.trimEnd());
}

/** Catalog languages offered by default — the golden gate's "enabled languages". */
const ENABLED_LANGUAGES = LANGUAGE_KEYS.filter((k) => LANGUAGE_CATALOG[k].enabledByDefault);

function stdinNumbers(test: AuthoredTest): number[] {
  return test.input.trim().split(/\s+/).map(Number);
}

describe("authored problems: catalogue", () => {
  it("has unique slugs and display codes, two-sum included", () => {
    const slugs = [TWO_SUM.slug, ...AUTHORED_PROBLEMS.map((p) => p.slug)];
    const codes = [TWO_SUM.displayCode, ...AUTHORED_PROBLEMS.map((p) => p.displayCode)];
    expect(new Set(slugs).size).toBe(slugs.length);
    expect(new Set(codes).size).toBe(codes.length);
    for (const slug of slugs) expect(slug).toMatch(/^[a-z0-9][a-z0-9-]{0,99}$/);
  });

  it("adds a FUNCTION-mode Easy, a Medium and a STDIN-mode Easy/Medium", () => {
    for (const p of NEW_PROBLEMS) expect(AUTHORED_PROBLEMS).toContain(p);
    expect(HANDLE_MAKER).toMatchObject({ ioMode: "FUNCTION", difficulty: "EASY" });
    expect(LAB_POWER_BUDGET.difficulty).toBe("MEDIUM");
    expect(SECOND_SWIPE.ioMode).toBe("STDIN");
    expect(["EASY", "MEDIUM"]).toContain(SECOND_SWIPE.difficulty);
  });

  it("tags every problem with known, distinct topics", () => {
    expect([...TOPICS_BY_SLUG.keys()].sort()).toEqual([TWO_SUM.slug, ...AUTHORED_PROBLEMS.map((p) => p.slug)].sort());
    for (const [slug, topics] of TOPICS_BY_SLUG) {
      expect(topics.length, slug).toBeGreaterThan(0);
      expect(new Set(topics).size, slug).toBe(topics.length);
      for (const t of topics) expect(isTopic(t), `${slug}: ${t}`).toBe(true);
    }
  });

  it.each(AUTHORED_PROBLEMS.map((p) => [p.slug, p] as const))("%s: mode, signature, starters and references are consistent", (_slug, def) => {
    if (def.ioMode === "FUNCTION") {
      const sig = functionSignatureSchema.parse(def.signature);
      // The CHECKER mirror (protocol 3, CHECK ProblemVersion_function_checker_mirror).
      expect(def.compareMode).toBe(functionCompareMode(sig.comparator));
      expect(def.checkerSource !== null).toBe(sig.comparator === "CUSTOM_CHECKER");
      expect(def.starters.cpp20).toBe(starterStub("cpp20", sig));
      expect(def.starters.py312).toBe(starterStub("py312", sig));
      if (def.starters.java21 !== undefined) expect(def.starters.java21).toBe(starterStub("java21", sig));
      // The harness supplies main(); a FUNCTION reference is a class only.
      for (const r of def.references) {
        expect(r.source).not.toMatch(/\bint main\s*\(|static void main\s*\(/);
        expect(supportsFunctionMode(r.language), `${r.language} has no FUNCTION harness`).toBe(true);
      }
    } else {
      expect(def.signature).toBeNull();
      expect(def.starters.cpp20).toMatch(/int main\(\)/);
      expect(def.starters.py312).toMatch(/sys\.stdin/);
    }
    const models = def.references.filter((r) => r.expected === "AC");
    // Every enabled-by-default language has a model solution (the golden gate needs one to judge).
    expect(models.map((r) => r.language)).toEqual(expect.arrayContaining([...ENABLED_LANGUAGES]));
    expect(def.references.some((r) => r.expected !== "AC")).toBe(true);
    expect(new Set(def.references.map((r) => `${r.language}|${r.label}`)).size).toBe(def.references.length);
  });
});

describe("authored problems: hints and editorials", () => {
  it("covers every seeded problem", () => {
    expect([...HELP_BY_SLUG.keys()].sort()).toEqual([...TOPICS_BY_SLUG.keys()].sort());
  });

  it.each([...HELP_BY_SLUG].map(([slug, help]) => [slug, help] as const))("%s: three tiers and a full editorial", (_slug, help) => {
    expect(help.hints).toHaveLength(3);
    for (const hint of help.hints) {
      expect(hint.trim().length).toBeGreaterThan(80);
      expect(Buffer.byteLength(hint)).toBeLessThan(4096);
    }
    // Tiers get more concrete: the near-solution is the longest.
    expect(help.hints[2].length).toBeGreaterThan(help.hints[0].length);
    for (const heading of ["### Approach", "### Complexity", "### C++", "### Python"]) expect(help.editorial).toContain(heading);
    expect(help.editorial).toMatch(/```cpp\n[\s\S]+?\n```/);
    expect(help.editorial).toMatch(/```python\n[\s\S]+?\n```/);
    // Statements render h3 and below; keep authored help on the same scale.
    for (const text of [...help.hints, help.editorial]) expect(text).not.toMatch(/^#{1,2} /m);
  });
});

describe.each(AUTHORED_PROBLEMS.map((p) => [p.slug, p] as const))("%s: generated tests", (_slug, def) => {
  const tests = def.generateTests();

  it("are deterministic (byte-identical on every call)", () => {
    expect(def.generateTests()).toEqual(tests);
  });

  it("are distinct, samples first, with enough hidden tests", () => {
    expect(new Set(tests.map((t) => t.input)).size).toBe(tests.length);
    const samples = tests.filter((t) => t.isSample);
    expect(samples.length).toBe(2);
    expect(tests.slice(0, samples.length).every((t) => t.isSample)).toBe(true);
    expect(tests.length - samples.length).toBeGreaterThanOrEqual(10);
    for (const t of tests) {
      expect(t.input.endsWith("\n")).toBe(true);
      expect(t.output.endsWith("\n")).toBe(true);
    }
  });

  it("show their samples in the statement", () => {
    for (const t of tests.filter((s) => s.isSample)) {
      if (def.ioMode === "STDIN") {
        expect(def.statement).toContain(`Input:\n${t.input}`);
        expect(def.statement).toContain(t.output.trimEnd());
      } else {
        const shown = (value: unknown) => JSON.stringify(value).replace(/,/g, ", ");
        const args = functionArgs(def, t);
        const inputs = def.signature!.params.map((p, i) => `${p.name} = ${shown(args[i])}`).join(", ");
        expect(def.statement).toContain(`Input:  ${inputs}\nOutput: ${shown(functionResult(def, t))}`);
      }
    }
  });
});

describe("handle-maker", () => {
  const tests = HANDLE_MAKER.generateTests();
  /** Independent rule: maximal runs of letters/digits, lowercased, joined by '-'. */
  const viaRegex = (name: string) => (name.match(/[A-Za-z0-9]+/g) ?? []).map((w) => w.toLowerCase()).join("-");

  it("expects exactly what an independent implementation produces", () => {
    for (const t of tests) {
      const [name] = functionArgs(HANDLE_MAKER, t) as [string];
      expect(functionResult(HANDLE_MAKER, t)).toBe(viaRegex(name));
      expect(handleOf(name)).toBe(viaRegex(name));
    }
  });

  it("keeps every input inside the constraints", () => {
    for (const t of tests) {
      const [name] = functionArgs(HANDLE_MAKER, t) as [string];
      expect(name.length).toBeGreaterThanOrEqual(1);
      expect(name.length).toBeLessThanOrEqual(MAX_NAME_LENGTH);
      expect(name).toMatch(/^[\x20-\x7e]+$/);
      expect(name).toMatch(/[A-Za-z0-9]/);
      // One JSON line per parameter: nothing in the name may break the line.
      expect(t.input.split("\n")).toHaveLength(2);
    }
  });

  it("exercises the edge cases: quotes and backslashes, long names, separator-only ends", () => {
    const names = tests.map((t) => (functionArgs(HANDLE_MAKER, t) as [string])[0]);
    expect(names.some((n) => n.includes('"') && n.includes("\\"))).toBe(true);
    expect(names.filter((n) => n.length === MAX_NAME_LENGTH).length).toBeGreaterThanOrEqual(3);
    expect(names.some((n) => /^[^A-Za-z0-9]/.test(n))).toBe(true);
    expect(names.filter((n) => /[^A-Za-z0-9]$/.test(n)).length).toBeGreaterThanOrEqual(3);
  });

  it("catches the deliberately-wrong solution (a trailing dash)", () => {
    const wrong = (name: string) => {
      let out = "";
      for (const ch of name) {
        if (/[A-Za-z0-9]/.test(ch)) out += ch.toLowerCase();
        else if (out.length > 0 && !out.endsWith("-")) out += "-";
      }
      return out;
    };
    const caught = tests.filter((t) => wrong((functionArgs(HANDLE_MAKER, t) as [string])[0]) !== functionResult(HANDLE_MAKER, t));
    expect(caught.length).toBeGreaterThanOrEqual(3);
    expect(caught[0]?.isSample).toBe(true);
  });
});

describe("lab-power-budget", () => {
  const tests = LAB_POWER_BUDGET.generateTests();
  /** Independent count: prefix sums, then for each right end binary-search the first safe left end. */
  function viaPrefixSums(watts: number[], budget: number): number {
    const prefix = [0];
    for (const w of watts) prefix.push(prefix.at(-1)! + w);
    let blocks = 0;
    for (let r = 1; r <= watts.length; r++) {
      let lo = 0;
      let hi = r;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (prefix[r]! - prefix[mid]! <= budget) hi = mid;
        else lo = mid + 1;
      }
      blocks += r - lo;
    }
    return blocks;
  }

  it("expects exactly what an independent implementation produces", () => {
    for (const t of tests) {
      const [watts, budget] = functionArgs(LAB_POWER_BUDGET, t) as [number[], number];
      expect(functionResult(LAB_POWER_BUDGET, t)).toBe(viaPrefixSums(watts, budget));
    }
  });

  it("keeps every input inside the constraints", () => {
    for (const t of tests) {
      const [watts, budget] = functionArgs(LAB_POWER_BUDGET, t) as [number[], number];
      expect(watts.length).toBeGreaterThanOrEqual(1);
      expect(watts.length).toBeLessThanOrEqual(LAB_POWER_LIMITS.maxN);
      expect(watts.every((w) => Number.isInteger(w) && w >= 1 && w <= LAB_POWER_LIMITS.maxWatts)).toBe(true);
      expect(budget).toBeGreaterThanOrEqual(1);
      expect(budget).toBeLessThanOrEqual(LAB_POWER_LIMITS.maxBudget);
    }
  });

  it("needs 64-bit answers and punishes O(n²)", () => {
    const answers = tests.map((t) => functionResult(LAB_POWER_BUDGET, t) as number);
    expect(Math.max(...answers)).toBeGreaterThan(2 ** 32);
    // The brute force does about one step per safe block: 2·10¹⁰ steps cannot finish in a second.
    expect(answers.some((a) => a >= 1e10)).toBe(true);
  });

  it("catches the deliberately-wrong solution (if instead of while)", () => {
    const wrong = (watts: number[], budget: number) => {
      let total = 0;
      let left = 0;
      let blocks = 0;
      for (let right = 0; right < watts.length; right++) {
        total += watts[right]!;
        if (total > budget) total -= watts[left++]!;
        blocks += right - left + 1;
      }
      return blocks;
    };
    const caught = tests.filter((t) => {
      const [watts, budget] = functionArgs(LAB_POWER_BUDGET, t) as [number[], number];
      return wrong(watts, budget) !== functionResult(LAB_POWER_BUDGET, t);
    });
    expect(caught.length).toBeGreaterThanOrEqual(3);
  });
});

describe("second-swipe", () => {
  const tests = SECOND_SWIPE.generateTests();
  const parse = (t: AuthoredTest) => {
    const [n, ...cards] = stdinNumbers(t);
    return { n: n!, cards };
  };
  /** Independent answer: for every card, its second occurrence; the earliest of those wins. */
  function viaSecondOccurrence(cards: number[]): string {
    const seenOnce = new Map<number, number>();
    let best: { card: number; position: number } | null = null;
    cards.forEach((card, i) => {
      const count = seenOnce.get(card) ?? 0;
      if (count === 1 && (best === null || i + 1 < best.position)) best = { card, position: i + 1 };
      seenOnce.set(card, count + 1);
    });
    const found = best as { card: number; position: number } | null;
    return found ? `${found.card} ${found.position}\n` : "-1\n";
  }

  it("expects exactly what an independent implementation produces", () => {
    for (const t of tests) expect(t.output).toBe(viaSecondOccurrence(parse(t).cards));
  });

  it("keeps every input inside the constraints", () => {
    for (const t of tests) {
      const { n, cards } = parse(t);
      expect(cards).toHaveLength(n);
      expect(n).toBeGreaterThanOrEqual(1);
      expect(n).toBeLessThanOrEqual(SECOND_SWIPE_LIMITS.maxN);
      expect(cards.every((c) => Number.isInteger(c) && c >= 1 && c <= SECOND_SWIPE_LIMITS.maxCard)).toBe(true);
      expect(t.input.split("\n")).toHaveLength(3);
    }
  });

  it("includes the no-repeat answer and a full-size test without repeats", () => {
    expect(tests.filter((t) => t.output === "-1\n").length).toBeGreaterThanOrEqual(3);
    expect(tests.some((t) => t.output === "-1\n" && parse(t).n === SECOND_SWIPE_LIMITS.maxN)).toBe(true);
  });

  it("catches the deliberately-wrong solution (the repeated card seen first)", () => {
    const wrong = (cards: number[]) => {
      const count = new Map<number, number>();
      for (const c of cards) count.set(c, (count.get(c) ?? 0) + 1);
      for (let i = 0; i < cards.length; i++) {
        if ((count.get(cards[i]!) ?? 0) < 2) continue;
        return `${cards[i]} ${cards.indexOf(cards[i]!, i + 1) + 1}\n`;
      }
      return "-1\n";
    };
    const caught = tests.filter((t) => wrong(parse(t).cards) !== t.output);
    expect(caught.length).toBeGreaterThanOrEqual(3);
    expect(caught.some((t) => !t.isSample && parse(t).n === SECOND_SWIPE_LIMITS.maxN)).toBe(true);
  });
});

describe("badges", () => {
  it("has exactly the catalogue keys, ordered, each with a real lucide icon", () => {
    expect(BADGES.map((b) => b.key)).toEqual([
      "first-solve",
      "ten-solves",
      "fifty-solves",
      "first-medium",
      "first-hard",
      "streak-7",
      "streak-30",
    ]);
    const orders = BADGES.map((b) => b.sortOrder);
    expect([...orders].sort((a, b) => a - b)).toEqual(orders);
    const icons = path.resolve(__dirname, "../node_modules/lucide-react/dist/esm/icons");
    for (const b of BADGES) {
      expect(b.name.length).toBeGreaterThan(0);
      expect(b.description).toMatch(/\.$/);
      expect(b.icon).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
      expect(existsSync(path.join(icons, `${b.icon}.js`)), b.icon).toBe(true);
    }
  });
});

describe("study plans", () => {
  const problem = (slug: string, difficulty: PublishedProblem["difficulty"], tags: Topic[] = []): PublishedProblem => ({
    id: `id-${slug}`,
    slug,
    displayCode: `X-${slug}`,
    difficulty,
    tags,
  });
  const ALL_PUBLISHED = [
    problem("two-sum", "EASY"),
    problem("bracket-cleanup", "EASY"),
    problem("study-pairs", "MEDIUM"),
    problem("handle-maker", "EASY"),
    problem("lab-power-budget", "MEDIUM"),
    problem("second-swipe", "EASY"),
  ];
  const sheet = SEEDED_PLANS.find((p) => p.kind === "SHEET")!;
  const track = SEEDED_PLANS.find((p) => p.kind === "TRACK")!;

  it("seeds one sheet and one track with the agreed titles", () => {
    expect(sheet.title).toBe("REC Starter Sheet");
    expect(track.title).toBe("Arrays & Hashing Basics");
    expect(new Set(SEEDED_PLANS.map((p) => p.slug)).size).toBe(SEEDED_PLANS.length);
  });

  it("files every published Easy/Medium problem once, under its primary topic, in topic order", () => {
    const sections = desiredSections(sheet, ALL_PUBLISHED);
    const ids = sections.flatMap((s) => s.problemIds);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.sort()).toEqual(ALL_PUBLISHED.map((p) => p.id).sort());
    expect(sections.map((s) => s.title)).toEqual([
      TOPIC_LABEL.ARRAYS_HASHING,
      TOPIC_LABEL.TWO_POINTERS,
      TOPIC_LABEL.SLIDING_WINDOW,
      TOPIC_LABEL.STACK_QUEUE,
      TOPIC_LABEL.STRINGS,
    ]);
    expect(sections[0]!.problemIds).toEqual(["id-second-swipe", "id-two-sum"]);
    // lab-power-budget's primary topic is Sliding Window, although it is also tagged Two Pointers.
    expect(sections[1]!.problemIds).toEqual(["id-study-pairs"]);
    expect(sections[2]!.problemIds).toEqual(["id-lab-power-budget"]);
  });

  it("leaves out Hard and unpublished problems, and files unknown problems by their tags", () => {
    const sections = desiredSections(sheet, [
      problem("two-sum", "EASY"),
      problem("admin-hard", "HARD", ["GRAPHS"]),
      problem("admin-graph", "MEDIUM", ["GREEDY", "GRAPHS"]),
      problem("admin-untagged", "EASY"),
    ]);
    expect(sections).toEqual([
      { title: TOPIC_LABEL.ARRAYS_HASHING, problemIds: ["id-two-sum"] },
      { title: TOPIC_LABEL.GRAPHS, problemIds: ["id-admin-graph"] },
      { title: UNTAGGED_SECTION, problemIds: ["id-admin-untagged"] },
    ]);
  });

  it("orders a sheet section Easy first, then by display code", () => {
    const sections = desiredSections(sheet, [
      { ...problem("b-medium", "MEDIUM", ["STRINGS"]), displayCode: "A-1" },
      { ...problem("c-easy", "EASY", ["STRINGS"]), displayCode: "A-3" },
      { ...problem("a-easy", "EASY", ["STRINGS"]), displayCode: "A-2" },
    ]);
    expect(sections).toEqual([{ title: TOPIC_LABEL.STRINGS, problemIds: ["id-a-easy", "id-c-easy", "id-b-medium"] }]);
  });

  it("builds the track from curated sections, skipping what is not published yet", () => {
    if (track.sections === "EASY_MEDIUM_BY_TOPIC") throw new Error("the track must be curated");
    const known = new Set([TWO_SUM.slug, ...AUTHORED_PROBLEMS.map((p) => p.slug)]);
    for (const s of track.sections) for (const slug of s.slugs) expect(known.has(slug), slug).toBe(true);
    const full = desiredSections(track, ALL_PUBLISHED);
    expect(full.flatMap((s) => s.problemIds)).toEqual(["id-handle-maker", "id-second-swipe", "id-two-sum", "id-study-pairs"]);
    const partial = desiredSections(track, [problem("two-sum", "EASY"), problem("study-pairs", "MEDIUM")]);
    expect(partial.map((s) => s.problemIds)).toEqual([["id-two-sum"], ["id-study-pairs"]]);
  });
});

describe("daily challenge rotation", () => {
  it("is deterministic per campus day and stays in range", () => {
    expect(campusDayNumber("1970-01-02")).toBe(1);
    expect(dailyChallengeIndex("2026-10-10", 6)).toBe(dailyChallengeIndex("2026-10-10", 6));
    const week = ["2026-10-10", "2026-10-11", "2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15"].map((d) =>
      dailyChallengeIndex(d, 6),
    );
    expect(new Set(week).size).toBe(6);
    for (const i of week) expect(i).toBeGreaterThanOrEqual(0);
    expect(() => dailyChallengeIndex("2026-10-10", 0)).toThrow();
    expect(() => campusDayNumber("10/10/2026")).toThrow();
  });
});

// ── FUNCTION harness and comparators (Phase 4) ──────────────────────────

const FUNCTION_SEEDS = AUTHORED_PROBLEMS.filter((p) => p.ioMode === "FUNCTION");

describe("FUNCTION seeds: comparators, canonical tests and references", () => {
  it("seeds at least three IN_PLACE_MUTATION and three CUSTOM_CHECKER problems", () => {
    const count = (c: string) => FUNCTION_SEEDS.filter((p) => p.signature!.comparator === c).length;
    expect(count("IN_PLACE_MUTATION")).toBeGreaterThanOrEqual(3);
    expect(count("CUSTOM_CHECKER")).toBeGreaterThanOrEqual(3);
  });

  it("two-sum: canonical tests and a model solution in every enabled language", () => {
    for (const t of generateTwoSumTests()) expect(validateFunctionTest(TWO_SUM.signature, t.input, t.output)).toEqual([]);
    for (const language of ENABLED_LANGUAGES) {
      expect(TWO_SUM_REFERENCE[language]?.some((r) => r.expected === "AC"), language).toBe(true);
    }
  });

  it.each(FUNCTION_SEEDS.map((p) => [p.slug, p] as const))("%s: every test is canonical for its signature", (_slug, def) => {
    const sig = functionSignatureSchema.parse(def.signature);
    for (const [i, t] of def.generateTests().entries()) {
      expect(validateFunctionTest(sig, t.input, t.output), `test ${i}`).toEqual([]);
    }
  });

  it.each(FUNCTION_SEEDS.map((p) => [p.slug, p] as const))(
    "%s: a Java model solution (judged by the golden suite's extra languages)",
    (_slug, def) => {
      expect(def.references.some((r) => r.language === "java21" && r.expected === "AC")).toBe(true);
    },
  );
});

type Args = unknown[];
interface Mirror {
  /** Re-derives the expected value by a different algorithm (IN_PLACE / EXACT problems). */
  expected?: (args: Args) => unknown;
  /** The checker's rule, written independently (CUSTOM_CHECKER problems). */
  accepts?: (args: Args, answer: unknown) => boolean;
  /** JS mirrors of the deliberately-wrong references, by label. */
  wrong: Record<string, (args: Args) => unknown>;
}

const isPermutation = (values: readonly number[], lo: number, hi: number) =>
  values.length === hi - lo + 1 && [...values].sort((a, b) => a - b).every((v, i) => v === lo + i);

function interleave(a: readonly number[], b: readonly number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (i < a.length) out.push(a[i]!);
    if (i < b.length) out.push(b[i]!);
  }
  return out;
}

const MIRRORS: Record<string, Mirror> = {
  "conveyor-shift": {
    // Slice the last k mod n parcels off the end and put them in front.
    expected: ([parcels, k]) => {
      const a = parcels as number[];
      const s = (k as number) % a.length;
      return [...a.slice(a.length - s), ...a.slice(0, a.length - s)];
    },
    wrong: {
      "Deliberately wrong: shifts left": ([parcels, k]) => {
        const a = parcels as number[];
        const s = (k as number) % a.length;
        return [...a.slice(s), ...a.slice(0, s)];
      },
      "Deliberately wrong: rebinds parcels": ([parcels]) => parcels,
    },
  },
  "playlist-fold": {
    // First half (rounded up) woven with the second half reversed.
    expected: ([songs]) => {
      const a = songs as number[];
      const half = Math.ceil(a.length / 2);
      return interleave(a.slice(0, half), a.slice(half).reverse());
    },
    wrong: {
      "Deliberately wrong: interleaves the halves without reversing": ([songs]) => {
        const a = songs as number[];
        const half = Math.ceil(a.length / 2);
        return interleave(a.slice(0, half), a.slice(half));
      },
    },
  },
  "bench-blackout": {
    // Collect the faulty coordinates first, then close their rows and columns.
    expected: ([grid]) => {
      const g = (grid as number[][]).map((row) => [...row]);
      const faults: [number, number][] = [];
      g.forEach((row, r) => row.forEach((v, c) => v === 0 && faults.push([r, c])));
      for (const [r, c] of faults) {
        g[r]!.fill(0);
        for (const row of g) row[c] = 0;
      }
      return g;
    },
    wrong: {
      "Deliberately wrong: closes while scanning, so closures cascade": ([grid]) => {
        const g = (grid as number[][]).map((row) => [...row]);
        for (let r = 0; r < g.length; r++) {
          for (let c = 0; c < g[r]!.length; c++) {
            if (g[r]![c] !== 0) continue;
            g[r]!.fill(0);
            for (const row of g) row[c] = 0;
          }
        }
        return g;
      },
    },
  },
  "session-order": {
    accepts: ([n, prerequisites], answer) => {
      const order = answer as number[];
      if (!isPermutation(order, 0, (n as number) - 1)) return false;
      const at = new Map(order.map((s, i) => [s, i]));
      return (prerequisites as number[][]).every(([a, b]) => at.get(a!)! < at.get(b!)!);
    },
    wrong: { "Deliberately wrong: index order": ([n]) => Array.from({ length: n as number }, (_, i) => i) },
  },
  "exact-change-pair": {
    accepts: ([prices, amount], answer) => {
      const p = prices as number[];
      const [i, j] = answer as [number, number];
      return Number.isInteger(i) && Number.isInteger(j) && i >= 0 && i < j && j < p.length && p[i]! + p[j]! === amount;
    },
    wrong: {
      // A dict comprehension keeps the LAST position of each price; looking the partner
      // up there can find the item itself when its price is half the amount.
      "Deliberately wrong: may buy one item twice": ([prices, amount]) => {
        const p = prices as number[];
        const where = new Map<number, number>();
        p.forEach((price, i) => where.set(price, i));
        for (const [i, price] of p.entries()) {
          const j = where.get((amount as number) - price);
          if (j !== undefined) return [Math.min(i, j), Math.max(i, j)];
        }
        return [-1, -1];
      },
    },
  },
  "no-neighbour-seating": {
    accepts: ([n], answer) => {
      const seats = answer as number[];
      return isPermutation(seats, 1, n as number) && seats.every((s, i) => i === 0 || Math.abs(s - seats[i - 1]!) !== 1);
    },
    wrong: {
      "Deliberately wrong: odds, then evens": ([n]) => {
        const all = Array.from({ length: n as number }, (_, i) => i + 1);
        return [...all.filter((r) => r % 2 === 1), ...all.filter((r) => r % 2 === 0)];
      },
    },
  },
};

describe("Phase 4 seeds: independent mirrors", () => {
  it("covers every IN_PLACE_MUTATION and CUSTOM_CHECKER seed", () => {
    for (const p of FUNCTION_SEEDS) {
      if (p.signature!.comparator === "IN_PLACE_MUTATION" || p.signature!.comparator === "CUSTOM_CHECKER") {
        expect(MIRRORS[p.slug], p.slug).toBeDefined();
      }
    }
  });

  describe.each(Object.keys(MIRRORS).map((slug) => [slug] as const))("%s", (slug) => {
    const def = AUTHORED_PROBLEMS.find((p) => p.slug === slug);
    const mirror = MIRRORS[slug]!;

    it("is seeded", () => {
      expect(def, `${slug} is not in AUTHORED_PROBLEMS`).toBeDefined();
    });

    // The 20s suite-wide timeout in vitest.config.ts covers these two: they
    // run an independent implementation over every generated test of every
    // authored problem, which is real compute.
    it.runIf(def !== undefined)(
      "expects what an independent implementation expects (or the checker's rule accepts)",
      () => {
        for (const t of def!.generateTests()) {
          const args = functionArgs(def!, t);
          const expected = functionResult(def!, t);
          if (mirror.expected) expect(expected).toEqual(mirror.expected(args));
          if (mirror.accepts) expect(mirror.accepts(args, expected), "the jury answer must satisfy the checker's rule").toBe(true);
        }
      },
      30_000,
    );

    it.runIf(def !== undefined)(
      "catches every deliberately-wrong reference, mirrored in JS",
      () => {
        const tests = def!.generateTests();
        for (const r of def!.references.filter((x) => x.expected === "WA")) {
          const wrong = mirror.wrong[r.label];
          expect(wrong, `no JS mirror for "${r.label}"`).toBeDefined();
          const caught = tests.filter((t) => {
            const args = functionArgs(def!, t);
            const out = wrong!(args);
            return mirror.accepts ? !mirror.accepts(args, out) : JSON.stringify(out) !== JSON.stringify(functionResult(def!, t));
          });
          expect(caught.length, r.label).toBeGreaterThanOrEqual(1);
        }
      },
      30_000,
    );
  });
});
