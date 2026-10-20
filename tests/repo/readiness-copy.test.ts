import { describe, expect, it } from "vitest";
import { CODE_EXTENSIONS, findFiles, lexSource, lineAt, readRepoFile } from "./support/repo";

/**
 * Three fences over the readiness surfaces (Phase 9c).
 *
 * ── 1. The framing is rendered, and it comes first ───────────────────────
 *
 * SPEC §5 calls the framing MANDATORY, and the reason is not legalistic: a
 * student who reads a coverage figure as a prediction will either coast on a
 * high one or give up on a low one, and both are worse than not showing the
 * number at all. So `READINESS_FRAMING` must appear on the page, and it must
 * appear BEFORE the first tier card in DOM order — a disclaimer underneath
 * three big numbers is a disclaimer nobody reads.
 *
 * ── 2. No score is rendered without its denominator ──────────────────────
 *
 * `mockInterviewScore` is 15 % of TOP and has no source in this plan at any
 * phase, so a TOP score is a score out of 85. Every surface that prints a
 * score prints `availableWeight` beside it. The fence counts: a file that
 * renders `.score` more often than it renders `availableWeight` has grown a
 * bare number somewhere.
 *
 * ── 3. Never a band, an integrity score or a flag count ──────────────────
 *
 * SPEC §7 is explicit that no band or "integrity score" is ever shown to a
 * student or a recruiter, and that a student's photo never sits beside a flag
 * count. None of those belong on a readiness surface at all, and the cheapest
 * way to keep it that way is to refuse the vocabulary here.
 */

const SRC = "apps/web/src";

const PAGE = `${SRC}/app/(student)/placement/page.tsx`;

/** Every readiness surface a student reads. */
const STUDENT_SURFACES = [
  PAGE,
  `${SRC}/components/placement/tier-card.tsx`,
  `${SRC}/server/queries/readiness.ts`,
  "packages/shared/src/readiness-snapshot.ts",
];

/**
 * Copy, not code: string literals and the text between tags.
 *
 * The JSX pass runs from `>` OR `}` to `<` OR `{`, not just `>` to `<`.
 * Real copy is interleaved with expressions — "{100 - tier.availableWeight}
 * of the 100 points … Nothing has been redistributed" is three text runs
 * with two interpolations between them — and a tag-to-tag scan sees none of
 * the middle ones, which is exactly where a sentence would hide. It
 * over-captures a little code in return; that costs a false positive at
 * worst, and a copy fence that under-reads costs the thing it was written
 * for.
 */
function copyOf(file: string): Array<{ line: number; text: string }> {
  const source = readRepoFile(file);
  const lexed = lexSource(source);
  const out: Array<{ line: number; text: string }> = [];
  for (const span of lexed.strings) {
    out.push({ line: lineAt(source, span.start), text: span.body });
  }
  for (const match of lexed.code.matchAll(/[>}]([^<>{}]+)[<{]/g)) {
    out.push({ line: lineAt(source, match.index ?? 0), text: match[1] ?? "" });
  }
  return out;
}

describe("the mandatory framing is rendered, before any number", () => {
  const source = readRepoFile(PAGE);

  it("renders READINESS_FRAMING rather than a paraphrase of it", () => {
    /**
     * The constant, not the words. A page that inlined the sentence would
     * pass a substring check and then drift from the constant the next time
     * somebody edits one of the two.
     */
    expect(source, "the page no longer renders the framing constant").toContain("{READINESS_FRAMING}");
  });

  it("puts it above the first tier card", () => {
    const framing = source.indexOf("{READINESS_FRAMING}");
    const firstCard = source.indexOf("<TierCard");
    expect(framing, "READINESS_FRAMING is gone from the page").toBeGreaterThan(-1);
    expect(firstCard, "the page no longer renders a TierCard").toBeGreaterThan(-1);
    expect(
      framing,
      "the framing moved below the tier cards: a disclaimer underneath three big numbers is a disclaimer nobody reads",
    ).toBeLessThan(firstCard);
  });

  it("says the calibration is unproven, which is true and stays said", () => {
    // The weights have never been checked against a real placement cycle.
    // A number presented without that is a number presented as settled.
    expect(source).toContain("READINESS_CALIBRATION_NOTE");
  });
});

describe("no score is rendered without the weight that was measurable", () => {
  it.each(STUDENT_SURFACES)("%s", (file) => {
    const source = readRepoFile(file);
    const code = lexSource(source).code;
    // `.score` as a property read, not `serviceScore` or `topScore` (the
    // snapshot columns, which the query reads next to their own weights).
    const scores = [...code.matchAll(/(?<![A-Za-z0-9_])\.score\b/g)].length;
    const weights = [...code.matchAll(/availableWeight|AvailableWeight/g)].length;
    expect(
      weights,
      [
        `${file} reads .score ${scores} time(s) but names availableWeight only ${weights} time(s).`,
        "",
        "Every readiness figure carries its denominator. mockInterviewScore is 15 %",
        "of TOP and has no source in this plan at any phase, so a TOP score is a",
        "score out of 85 — and a bare number reads as a number out of 100, which",
        "makes a student believe they are further behind than they are.",
      ].join("\n"),
    ).toBeGreaterThanOrEqual(scores);
  });

  /**
   * The adjacency rule, which is the one that actually bites.
   *
   * Counting mentions per file is a weak net: a card can lose the
   * denominator next to the headline number and still name
   * `availableWeight` three times in an aria-label and a progress bar, so
   * the counts stay balanced while the visible number goes bare. (Checked:
   * the count fence passes on exactly that mutation.) So every place the
   * card RENDERS the score as text must say "out of" within the next few
   * tags — the words that turn a second number from a mystery into a
   * denominator.
   */
  const CARD = `${SRC}/components/placement/tier-card.tsx`;
  const ADJACENCY_WINDOW = 200;

  it("renders the score as text at least once, and never bare", () => {
    const code = lexSource(readRepoFile(CARD)).code;
    const rendered = [...code.matchAll(/\{tier\.score\}/g)];
    expect(rendered.length, "the card no longer renders the score as text at all").toBeGreaterThan(0);

    const bare: string[] = [];
    for (const match of rendered) {
      const at = (match.index ?? 0) + match[0].length;
      const after = code.slice(at, at + ADJACENCY_WINDOW);
      if (!/out of/.test(after)) {
        bare.push(`${CARD}:${lineAt(readRepoFile(CARD), match.index ?? 0)}: ${after.replace(/\s+/g, " ").slice(0, 80)}`);
      }
    }
    expect(
      bare,
      [
        "A readiness score is rendered without its denominator beside it.",
        "",
        "mockInterviewScore is 15 % of TOP and has no source in this plan at any",
        'phase, so a TOP score is a score out of 85. "62" reads as 62 out of 100',
        'and makes a student believe they are further behind than they are; "62 out',
        'of 85 measurable" is the same number and the truth.',
        "",
        bare.join("\n"),
      ].join("\n"),
    ).toEqual([]);
  });

  it("says 'measurable', so the denominator is not a second mystery number", () => {
    const text = copyOf(CARD)
      .map((row) => row.text)
      .join(" ");
    expect(text).toMatch(/measurable/i);
  });

  it("tells the student the missing weight was not redistributed", () => {
    /**
     * The one sentence that makes the lower score honest rather than
     * discouraging: the points are missing because nobody can measure them,
     * and they were NOT spread across the components the student does have.
     * Renormalising would make somebody who has never done a mock interview
     * look exactly as ready as somebody who has done five.
     */
    const text = copyOf(`${SRC}/components/placement/tier-card.tsx`)
      .map((row) => row.text)
      .join(" ");
    expect(text).toMatch(/redistributed/i);
    expect(text).toMatch(/cannot be measured/i);
  });
});

describe("a readiness surface never mentions a band, an integrity score or a flag count", () => {
  /**
   * Prose only. `isAtRisk` is a code identifier in the shared module and the
   * officer surfaces legitimately use it; what this refuses is the
   * VOCABULARY reaching a student's screen.
   */
  const FORBIDDEN: Array<{ pattern: RegExp; why: string }> = [
    { pattern: /\bintegrity (score|band|rating)\b/i, why: "SPEC §7: never an integrity score, to anybody" },
    { pattern: /\bband\b/i, why: "SPEC §7: never a band, to a student or a recruiter" },
    { pattern: /\bflag(s|ged)? count\b/i, why: "SPEC §7: never a flag count on a student surface" },
    { pattern: /\bat risk\b/i, why: "the at-risk rule routes staff to a mentor; it is not a label a student reads" },
    {
      pattern: /\b(likely|chance|probability|odds) (of|to) (be |get )?(placed|placement|a job|an offer)\b/i,
      why: "readiness is a coverage measure, explicitly not a prediction of being placed",
    },
    { pattern: /\bwill (not )?(get|be) placed\b/i, why: "the same: it is not a prediction" },
    { pattern: /\b(guarantee|guaranteed|assured)\b/i, why: "nothing here is a guarantee of anything" },
  ];

  it.each(STUDENT_SURFACES)("%s", (file) => {
    const offenders: string[] = [];
    for (const { line, text } of copyOf(file)) {
      // A SCREAMING_SNAKE token is a value, not copy.
      if (/^[A-Z][A-Z0-9_]*$/.test(text.trim())) continue;
      for (const { pattern, why } of FORBIDDEN) {
        if (pattern.test(text)) offenders.push(`${file}:${line}: ${text.trim().slice(0, 100)}  — ${why}`);
      }
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  it("covers every placement surface that exists", () => {
    // A new file under components/placement or app/(student)/placement must
    // be added above, or this fence quietly stops covering it.
    const found = findFiles({
      under: [`${SRC}/components/placement`, `${SRC}/app/(student)/placement`],
      extensions: CODE_EXTENSIONS,
    }).sort();
    const listed = new Set(STUDENT_SURFACES);
    const missing = found.filter((file) => !listed.has(file));
    expect(
      missing,
      `add these to STUDENT_SURFACES in tests/repo/readiness-copy.test.ts:\n${missing.join("\n")}`,
    ).toEqual([]);
  });

  it("mutation check: the forbidden vocabulary is actually caught", () => {
    /**
     * Without this the patterns could be narrowed until the fence passed
     * vacuously. Four sentences that must be caught, and two that must not —
     * "bandwidth" is not "band", and a component label mentioning breadth is
     * ordinary copy.
     */
    const caught = (text: string) => FORBIDDEN.some(({ pattern }) => pattern.test(text));

    expect(caught("You are in the middle band."), "a band").toBe(true);
    expect(caught("Your integrity score is 82."), "an integrity score").toBe(true);
    expect(caught("You are likely to be placed."), "a prediction").toBe(true);
    expect(caught("Three students at risk."), "an at-risk label").toBe(true);
    expect(caught("This does not guarantee anything."), "a guarantee, even a denied one").toBe(true);

    expect(caught("Breadth across topics is the lowest of fourteen."), "ordinary copy").toBe(false);
    expect(caught("It uses very little bandwidth."), "bandwidth is not a band").toBe(false);
  });
});
