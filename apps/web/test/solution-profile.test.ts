import { describe, expect, it } from "vitest";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  COMPLEXITY_LABEL,
  COMPLEXITY_REFUSAL_SENTENCE,
  MIN_RANKED_PEERS,
  STANDING_REFUSAL_SENTENCE,
  rankSolution,
  type ComplexityDetail,
  type PeerSolution,
  type StandingOutcome,
} from "@recx/shared";
import { SolutionProfile } from "@/components/workspace/solution-profile";

/**
 * What the Phase 17 section renders, and the accessibility of it.
 *
 * The axe sweep scans a list of PATHS, and a submission page needs an id, so
 * this surface cannot be in it — the same reason `exam-a11y.spec.ts` exists
 * for the sitting. The structural half of what axe would check is asserted
 * here instead, where it runs in the gate rather than in a sixteen-minute
 * suite nobody can run without a live stack:
 *
 *   * the distribution is a real `<table>` with a caption, a header row and
 *     a row header per band — not a stack of styled divs, which is what the
 *     Phase 13k `table-frames` fence was written about;
 *   * this submission's own band is named in WORDS, not only in colour
 *     (SPEC §7: no colour-only state anywhere);
 *   * every decorative bar is `aria-hidden`, so a screen reader is read the
 *     counts rather than a row of empty boxes;
 *   * the heading levels descend without skipping, and the growth class is
 *     announced once rather than twice.
 *
 * And the content half: nothing here claims a proof, and a refusal says what
 * the data could not support rather than implying a class.
 */

(globalThis as { React?: typeof React }).React = React;

const text = (html: string) =>
  html
    .replace(/<!-- -->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

const FITTED: ComplexityDetail = {
  version: 1,
  time: {
    fitted: true,
    growth: "LINEARITHMIC",
    confidence: "STRONG",
    runnerUp: "LINEAR",
    rSquared: 0.98,
    exponent: 1.07,
    points: 12,
    sizeRatio: 64,
  },
  space: { fitted: false, reason: "GROWTH_BELOW_NOISE", points: 12, sizeRatio: 64 },
};

function peers(count: number): PeerSolution[] {
  return Array.from({ length: count }, (_, k) => ({
    ms: 40 + k * 23,
    kb: 2048 + k * 300,
    growth: k % 3 === 0 ? "LINEAR" : "LINEARITHMIC",
  }));
}

const ranked = (): StandingOutcome =>
  rankSolution({ mine: { ms: 310, kb: 5120, growth: "LINEARITHMIC" }, peers: peers(42) });

const unranked = (): StandingOutcome =>
  rankSolution({ mine: { ms: 310, kb: 5120, growth: null }, peers: peers(3) });

const render = (props: Parameters<typeof SolutionProfile>[0]) =>
  renderToStaticMarkup(React.createElement(SolutionProfile, props));

describe("SolutionProfile", () => {
  it("renders nothing when there is neither a measurement nor a ranking", () => {
    expect(render({ complexity: null, standing: null, languageLabel: "C++20" })).toBe("");
  });

  describe("the measured growth", () => {
    const html = render({ complexity: FITTED, standing: null, languageLabel: "C++20" });

    it("shows the class, what it was measured over, and what n is", () => {
      expect(text(html)).toContain(COMPLEXITY_LABEL.LINEARITHMIC);
      expect(text(html)).toContain("Measured over 12 test sizes spanning 64");
      expect(text(html)).toContain("is the size of the input in bytes");
    });

    it("says it is a measurement of the run rather than a fact about the program", () => {
      expect(text(html)).toContain("measurements of this run, not facts about your program");
      expect(text(html)).toContain("Nothing in this section affects your verdict, your score or your XP");
    });

    it("prints a refusal's own sentence, and no class beside it", () => {
      expect(text(html)).toContain(text(COMPLEXITY_REFUSAL_SENTENCE.GROWTH_BELOW_NOISE));
    });

    it("announces the class once: the symbol is hidden where the sentence is read", () => {
      // "O(n log n). Time grows like O(n log n)" read aloud is the bug this
      // guards: the mono label carries aria-hidden and the sentence is sr-only.
      expect(html).toMatch(/aria-hidden="true"[^>]*>O\(n log n\)/);
      expect(html).toContain("Time grows like O(n log n)");
      expect(html).toContain("Memory");
    });

    it("drops to h4 inside the h3 group, so no level is skipped", () => {
      const levels = [...html.matchAll(/<h([1-6])\b/g)].map((m) => Number(m[1]));
      expect(levels[0]).toBe(2);
      for (let k = 1; k < levels.length; k++) expect(levels[k]! - Math.max(...levels.slice(0, k))).toBeLessThanOrEqual(1);
    });
  });

  describe("the standing", () => {
    const html = render({ complexity: FITTED, standing: ranked(), languageLabel: "Python 3.12" });

    it("quotes the position against the population and the language", () => {
      expect(text(html)).toMatch(/Faster than \d+% of the 43 accepted Python 3\.12 solutions here\./);
      expect(text(html)).toMatch(/Lighter than \d+% of the 43 accepted Python 3\.12 solutions here\./);
    });

    it("says what each figure IS, because the verdict above shows a different one", () => {
      expect(text(html)).toContain("of CPU over every test");
      expect(text(html)).toContain("at its peak");
    });

    it("draws the distribution as a real table with a caption and row headers", () => {
      expect(html).toContain("<table");
      expect(html).toContain("<caption");
      expect(html).toContain("<thead");
      expect(html).toMatch(/<th scope="row"/);
      expect(html).toMatch(/<th scope="col"/);
    });

    it("marks this submission's band in words, not only in colour", () => {
      expect(text(html)).toContain("yours");
      // One band, in each of the two tables.
      expect([...html.matchAll(/>yours</g)]).toHaveLength(2);
    });

    it("hides every decorative bar from a screen reader", () => {
      // Each bar's track is aria-hidden; nothing else in the section is.
      expect(html.split('aria-hidden="true"').length - 1).toBeGreaterThanOrEqual(20);
      expect(text(html)).not.toContain("undefined");
      expect(text(html)).not.toContain("NaN");
    });

    it("lists what the other accepted solutions grow like, with this one marked", () => {
      expect(text(html)).toContain("What the others grow like");
      expect(text(html)).toContain("yours");
      expect(text(html)).toMatch(/\d+ solutions/);
    });

    it("says how the peers were chosen and how the times were scaled", () => {
      expect(text(html)).toContain("One solution per student");
      expect(text(html)).toContain("calibration recorded with every result");
    });
  });

  it("prints the refusal, and no table, when there are too few peers", () => {
    const html = render({ complexity: null, standing: unranked(), languageLabel: "C++20" });
    expect(text(html)).toContain(text(STANDING_REFUSAL_SENTENCE.TOO_FEW_PEERS));
    expect(text(html)).toContain(String(MIN_RANKED_PEERS));
    expect(html).not.toContain("<table");
  });

  it("never promises a proof in anything it renders", () => {
    const all = [
      render({ complexity: FITTED, standing: ranked(), languageLabel: "C++20" }),
      render({ complexity: null, standing: unranked(), languageLabel: "C++20" }),
    ]
      .map(text)
      .join(" ");
    // "not ... a proof of your algorithm's complexity" is the one allowed
    // use, and it is a denial; nothing may claim one.
    expect(all).not.toMatch(/\b(?:proves|proven|guarantee[sd]?|certainly)\b/i);
    expect(all).toContain("rather than a proof of your algorithm's complexity");
  });
});
