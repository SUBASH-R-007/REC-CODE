import { describe, expect, it } from "vitest";
import {
  gradeAnswer,
  isAnswered,
  isResponseCorrect,
  scoreMock,
  scoreSection,
  sectionPercent,
  type AnswerKey,
  type AnswerResponse,
  type GradedAnswer,
  type SectionRule,
} from "../src/aptitude-grading";
import { MOCK_PATTERN_SEEDS, patternTotals } from "../src/mock-pattern";

/**
 * SPEC §5's Phase 7 gate: "a test asserts negative marking and per-section
 * cutoffs compute correctly across ALL SEEDED PATTERNS".
 *
 * So the last half of this file grades every seeded pattern rather than a
 * hand-made example — which is why the patterns live in `@recx/shared` beside
 * the arithmetic rather than under `apps/web/scripts/content/`, where a test
 * here could not reach them.
 */

const BLANK: AnswerResponse = { selectedIndexes: [], numericValue: null };
const scoring = (negativeMarkFraction = 0, marksPerCorrect = 1) => ({ marksPerCorrect, negativeMarkFraction });

const singleKey: AnswerKey = {
  kind: "SINGLE_CHOICE",
  correctOptionIndexes: [2],
  numericAnswer: null,
  numericTolerance: null,
};

const rule = (over: Partial<SectionRule> = {}): SectionRule => ({
  key: "s",
  label: "Section",
  timeLimitSec: 600,
  questionCount: 10,
  cutoffPercent: 50,
  marksPerCorrect: 1,
  negativeMarkFraction: 0,
  allowBackNavigation: true,
  ...over,
});

/** `n` graded answers of one state. */
const graded = (counts: { correct?: number; wrong?: number }, s = scoring()): GradedAnswer[] => [
  ...Array.from({ length: counts.correct ?? 0 }, () => gradeAnswer(singleKey, { selectedIndexes: [2], numericValue: null }, s)),
  ...Array.from({ length: counts.wrong ?? 0 }, () => gradeAnswer(singleKey, { selectedIndexes: [0], numericValue: null }, s)),
];

// ── One answer ──────────────────────────────────────────────────────────

describe("is a question answered at all?", () => {
  it("treats both shapes empty as unanswered", () => {
    expect(isAnswered(BLANK)).toBe(false);
    expect(isAnswered({ selectedIndexes: [1], numericValue: null })).toBe(true);
    expect(isAnswered({ selectedIndexes: [], numericValue: 0 })).toBe(true);
  });

  it("counts a typed zero as answered", () => {
    // `0` is falsy, and a candidate who typed 0 answered the question.
    expect(isAnswered({ selectedIndexes: [], numericValue: 0 })).toBe(true);
  });
});

describe("single choice", () => {
  it("marks the right option right and anything else wrong", () => {
    expect(isResponseCorrect(singleKey, { selectedIndexes: [2], numericValue: null })).toBe(true);
    expect(isResponseCorrect(singleKey, { selectedIndexes: [1], numericValue: null })).toBe(false);
    expect(isResponseCorrect(singleKey, BLANK)).toBe(false);
  });

  it("refuses an answer that adds an extra option", () => {
    expect(isResponseCorrect(singleKey, { selectedIndexes: [2, 3], numericValue: null })).toBe(false);
  });
});

describe("multi choice is all or nothing", () => {
  const key: AnswerKey = { ...singleKey, kind: "MULTI_CHOICE", correctOptionIndexes: [0, 2] };
  const pick = (...selectedIndexes: number[]) => ({ selectedIndexes, numericValue: null });

  it("accepts the exact set, in any order", () => {
    expect(isResponseCorrect(key, pick(0, 2))).toBe(true);
    expect(isResponseCorrect(key, pick(2, 0))).toBe(true);
  });

  it("scores a strict subset as WRONG, not as partially right", () => {
    // docs/OPEN-QUESTIONS.md: partial credit needs a published formula a
    // candidate can check their own marks against, and the per-option
    // conventions differ by recruiter with none documented.
    expect(isResponseCorrect(key, pick(0))).toBe(false);
    expect(gradeAnswer(key, pick(0), scoring(0.25)).state).toBe("WRONG");
    expect(gradeAnswer(key, pick(0), scoring(0.25)).awarded).toBe(-0.25);
  });

  it("scores right-plus-extra as wrong", () => {
    expect(isResponseCorrect(key, pick(0, 1, 2))).toBe(false);
  });

  it("applies the negative mark ONCE however many options were wrong", () => {
    const one = gradeAnswer(key, pick(1), scoring(0.25));
    const three = gradeAnswer(key, pick(1, 3, 4), scoring(0.25));
    expect(three.awarded).toBe(one.awarded);
  });
});

describe("numeric entry", () => {
  const key: AnswerKey = {
    kind: "NUMERIC_ENTRY",
    correctOptionIndexes: [],
    numericAnswer: 12.5,
    numericTolerance: 0.01,
  };
  const typed = (numericValue: number | string | null) => ({ selectedIndexes: [], numericValue });

  it("accepts the exact answer", () => {
    expect(isResponseCorrect(key, typed(12.5))).toBe(true);
  });

  it("accepts the tolerance boundary, inclusively, on both sides", () => {
    // A candidate told "within 0.01" who is exactly 0.01 away has done what
    // they were asked.
    expect(isResponseCorrect(key, typed(12.51))).toBe(true);
    expect(isResponseCorrect(key, typed(12.49))).toBe(true);
  });

  it("refuses one step beyond the tolerance", () => {
    expect(isResponseCorrect(key, typed(12.52))).toBe(false);
    expect(isResponseCorrect(key, typed(12.48))).toBe(false);
  });

  it("compares at a fixed scale rather than with float equality", () => {
    // `0.1 + 0.2 <= 0.3` is false in binary floating point. A candidate who
    // typed the right number must not lose a mark to that.
    const third: AnswerKey = { ...key, numericAnswer: 0.3, numericTolerance: 0 };
    expect(isResponseCorrect(third, typed(0.1 + 0.2))).toBe(true);
  });

  it("treats a zero tolerance as exact", () => {
    const exact: AnswerKey = { ...key, numericAnswer: 7, numericTolerance: 0 };
    expect(isResponseCorrect(exact, typed(7))).toBe(true);
    expect(isResponseCorrect(exact, typed(7.000002))).toBe(false);
  });

  it("accepts the answer as a string, which is how Prisma returns a Decimal", () => {
    expect(isResponseCorrect({ ...key, numericAnswer: "12.500000", numericTolerance: "0.010000" }, typed("12.51"))).toBe(
      true,
    );
  });

  it("refuses a non-finite entry rather than marking it", () => {
    expect(isResponseCorrect(key, typed(Number.NaN))).toBe(false);
    expect(isResponseCorrect(key, typed(Number.POSITIVE_INFINITY))).toBe(false);
  });

  it("is wrong, not a crash, when a numeric question has no key", () => {
    expect(isResponseCorrect({ ...key, numericAnswer: null }, typed(12.5))).toBe(false);
  });
});

describe("negative marking", () => {
  it("awards the section's marks for a correct answer", () => {
    expect(gradeAnswer(singleKey, { selectedIndexes: [2], numericValue: null }, scoring(0.25, 4)).awarded).toBe(4);
  });

  it("deducts the stated FRACTION of the question's marks for a wrong one", () => {
    // Never an absolute mark: a 2-mark penalty on a 1-mark question makes a
    // mock strictly harsher than the funnel it claims to model.
    expect(gradeAnswer(singleKey, { selectedIndexes: [0], numericValue: null }, scoring(0.25, 4)).awarded).toBe(-1);
    expect(gradeAnswer(singleKey, { selectedIndexes: [0], numericValue: null }, scoring(1, 4)).awarded).toBe(-4);
  });

  it("awards exactly zero for an unanswered question, never a penalty", () => {
    // The single line in the phase most likely to be written wrongly. A
    // section timer already punishes not finishing; penalising a blank would
    // punish it twice.
    const result = gradeAnswer(singleKey, BLANK, scoring(1, 4));
    expect(result.state).toBe("UNANSWERED");
    expect(result.awarded).toBe(0);
    expect(result.isCorrect).toBeNull();
  });

  it("deducts nothing when the fraction is zero, and never a negative zero", () => {
    // `-0.25 * 0` is `-0` in JavaScript, which renders as "-0" in a mark
    // column. A candidate should never see a minus sign they did not earn.
    const awarded = gradeAnswer(singleKey, { selectedIndexes: [0], numericValue: null }, scoring(0)).awarded;
    expect(awarded).toBe(0);
    expect(Object.is(awarded, -0)).toBe(false);
    expect(Object.is(scoreSection(rule(), graded({ wrong: 10 })).rawScore, -0)).toBe(false);
  });

  it("leaves isCorrect null only for an unanswered question", () => {
    // `isCorrect` and `awarded` are written together or not at all, which is
    // what CHECK MockAttemptAnswer_graded_check holds in the data.
    expect(gradeAnswer(singleKey, { selectedIndexes: [2], numericValue: null }, scoring()).isCorrect).toBe(true);
    expect(gradeAnswer(singleKey, { selectedIndexes: [0], numericValue: null }, scoring()).isCorrect).toBe(false);
  });
});

// ── One section ─────────────────────────────────────────────────────────

describe("a section's percent", () => {
  it("floors a negative raw total at zero", () => {
    // No candidate is ever shown a negative percentage.
    expect(sectionPercent(-4, 16)).toBe(0);
  });

  it("caps at 100 and handles an empty section without dividing by zero", () => {
    expect(sectionPercent(20, 16)).toBe(100);
    expect(sectionPercent(5, 0)).toBe(0);
  });

  it("rounds to two places, so no candidate sees a third", () => {
    expect(sectionPercent(1, 3)).toBe(33.33);
  });
});

describe("scoring a section", () => {
  it("counts the questions nobody reached as unanswered", () => {
    // A candidate who never reached the last five is still scored out of the
    // whole section, which is what a cutoff means.
    const result = scoreSection(rule({ questionCount: 10 }), graded({ correct: 3, wrong: 2 }));
    expect(result.correct).toBe(3);
    expect(result.wrong).toBe(2);
    expect(result.unanswered).toBe(5);
    expect(result.maxScore).toBe(10);
  });

  it("carries the true signed raw score", () => {
    const s = scoring(0.25);
    const result = scoreSection(rule({ negativeMarkFraction: 0.25 }), graded({ correct: 1, wrong: 9 }, s));
    expect(result.rawScore).toBe(-1.25); // 1 − 9 × 0.25
    // …while the reported percent is floored.
    expect(result.percent).toBe(0);
  });

  it("computes the percent AFTER the penalty", () => {
    // Otherwise negative marking would not affect whether a cutoff is met,
    // which would make the two settings independent when they are not.
    const s = scoring(0.25);
    const result = scoreSection(rule({ cutoffPercent: 60, negativeMarkFraction: 0.25 }), graded({ correct: 7, wrong: 3 }, s));
    expect(result.rawScore).toBe(6.25);
    expect(result.percent).toBe(62.5);
    expect(result.passedCutoff).toBe(true);
  });

  it("clears a cutoff reached exactly", () => {
    // A candidate who scores the published cutoff has met it; a strict
    // comparison would fail them on a rule nobody wrote down.
    const result = scoreSection(rule({ cutoffPercent: 60 }), graded({ correct: 6, wrong: 4 }));
    expect(result.percent).toBe(60);
    expect(result.passedCutoff).toBe(true);
  });

  it("fails a cutoff missed by one mark", () => {
    expect(scoreSection(rule({ cutoffPercent: 60 }), graded({ correct: 5, wrong: 5 })).passedCutoff).toBe(false);
  });

  it("treats a zero cutoff as a section everyone clears", () => {
    // Which is how "no cutoff" is said — see the Accenture English section.
    expect(scoreSection(rule({ cutoffPercent: 0 }), graded({ wrong: 10 })).passedCutoff).toBe(true);
    expect(scoreSection(rule({ cutoffPercent: 0 }), []).passedCutoff).toBe(true);
  });

  it("scales the whole section when marksPerCorrect is not 1", () => {
    const s = scoring(0.25, 4);
    const result = scoreSection(rule({ marksPerCorrect: 4, negativeMarkFraction: 0.25 }), graded({ correct: 5, wrong: 5 }, s));
    expect(result.maxScore).toBe(40);
    expect(result.rawScore).toBe(15); // 20 − 5
    expect(result.percent).toBe(37.5);
  });
});

// ── A whole mock ────────────────────────────────────────────────────────

describe("a whole mock", () => {
  const rules = [rule({ key: "a", cutoffPercent: 60 }), rule({ key: "b", cutoffPercent: 60 }), rule({ key: "c", cutoffPercent: 0 })];

  it("passes only when every section clears its own cutoff", () => {
    const result = scoreMock(rules, {
      a: graded({ correct: 6, wrong: 4 }),
      b: graded({ correct: 7, wrong: 3 }),
      c: graded({ correct: 1, wrong: 9 }),
    });
    expect(result.passedOverall).toBe(true);
    expect(result.sectionsPassed).toBe(3);
    expect(result.failedSections).toEqual([]);
  });

  it("names the sections that were not cleared, in pattern order", () => {
    const result = scoreMock(rules, { a: graded({ correct: 3, wrong: 7 }), b: graded({ correct: 9, wrong: 1 }) });
    expect(result.passedOverall).toBe(false);
    expect(result.failedSections).toEqual(["a"]);
    expect(result.sectionsPassed).toBe(2);
  });

  it("does not let a high total rescue a failed section", () => {
    // A candidate at 90% quant and 10% verbal is screened out by the real
    // funnel; a mock that averaged them to 50% and said "pass" would tell
    // them the exact opposite of the truth.
    const result = scoreMock(rules, { a: graded({ wrong: 10 }), b: graded({ correct: 10 }), c: graded({ correct: 10 }) });
    expect(result.percent).toBeGreaterThan(60);
    expect(result.passedOverall).toBe(false);
    expect(result.failedSections).toEqual(["a"]);
  });

  it("has no overall cutoff: clearing every section is clearing the mock", () => {
    // SPEC §5 lists "per-section cutoff" and nothing else
    // (docs/OPEN-QUESTIONS.md, the narrower reading).
    const result = scoreMock(rules, { a: graded({ correct: 6, wrong: 4 }), b: graded({ correct: 6, wrong: 4 }) });
    expect(result.percent).toBeLessThan(50);
    expect(result.passedOverall).toBe(true);
  });

  it("grades a section with no answers at all rather than skipping it", () => {
    // A candidate who never reached the last section still has it graded, or
    // their percent would be computed over a paper they did not sit.
    const result = scoreMock(rules, { a: graded({ correct: 10 }) });
    expect(result.sections).toHaveLength(3);
    expect(result.totalMax).toBe(30);
    expect(result.sections[2]!.unanswered).toBe(10);
  });

  it("sums the sections' signed raw scores", () => {
    const s = scoring(0.25);
    const negatives = [rule({ key: "a", negativeMarkFraction: 0.25 }), rule({ key: "b" })];
    const result = scoreMock(negatives, { a: graded({ wrong: 10 }, s), b: graded({ correct: 10 }) });
    expect(result.totalRaw).toBe(7.5); // −2.5 + 10
    expect(result.percent).toBe(37.5);
  });
});

// ── The gate: every seeded pattern ──────────────────────────────────────

const SEEDS = MOCK_PATTERN_SEEDS.map((p) => [p.slug, p] as const);

describe("every seeded pattern grades correctly", () => {
  it("seeds the six patterns the spec names", () => {
    expect(MOCK_PATTERN_SEEDS.map((p) => p.slug)).toEqual([
      "tcs-nqt",
      "infosys",
      "wipro",
      "cognizant",
      "accenture",
      "campus-generic",
    ]);
  });

  it.each(SEEDS)("%s: a perfect attempt scores 100% and clears every cutoff", (_slug, pattern) => {
    const result = scoreMock(
      pattern.sections,
      Object.fromEntries(pattern.sections.map((s) => [s.key, graded({ correct: s.questionCount }, s)])),
    );
    expect(result.percent).toBe(100);
    expect(result.passedOverall).toBe(true);
    expect(result.totalMax).toBe(patternTotals(pattern).totalQuestions);
  });

  it.each(SEEDS)("%s: a blank attempt scores zero and is never penalised", (_slug, pattern) => {
    const result = scoreMock(
      pattern.sections,
      Object.fromEntries(pattern.sections.map((s) => [s.key, []])),
    );
    expect(result.totalRaw).toBe(0);
    expect(result.percent).toBe(0);
    for (const [index, section] of result.sections.entries()) {
      // Every question the section declares, counted as unanswered — and not
      // one mark deducted for any of them.
      expect(section.unanswered, section.key).toBe(pattern.sections[index]!.questionCount);
      expect(section.rawScore, section.key).toBe(0);
    }
  });

  it.each(SEEDS)("%s: a blank attempt fails every section that has a cutoff", (_slug, pattern) => {
    const result = scoreMock(pattern.sections, {});
    const gated = result.sections.filter((s) => s.cutoffPercent > 0);
    expect(gated.length).toBeGreaterThan(0);
    expect(gated.every((s) => !s.passedCutoff)).toBe(true);
    expect(result.passedOverall).toBe(false);
  });

  it.each(SEEDS)("%s: guessing every question never beats leaving them blank", (_slug, pattern) => {
    const allWrong = scoreMock(
      pattern.sections,
      Object.fromEntries(pattern.sections.map((s) => [s.key, graded({ wrong: s.questionCount }, s)])),
    );
    const allBlank = scoreMock(pattern.sections, {});
    expect(allWrong.percent).toBe(allBlank.percent);
    // And with negative marking the raw total is strictly worse, which is the
    // lesson the pattern exists to teach.
    const penalised = pattern.sections.some((s) => s.negativeMarkFraction > 0);
    expect(allWrong.totalRaw < allBlank.totalRaw).toBe(penalised);
  });

  it.each(SEEDS)("%s: a candidate exactly on each cutoff clears the mock", (_slug, pattern) => {
    const bySection: Record<string, GradedAnswer[]> = {};
    for (const s of pattern.sections) {
      // The fewest correct answers that reach this section's cutoff, with
      // every remaining question answered wrongly.
      let correct = s.questionCount;
      for (let c = 0; c <= s.questionCount; c++) {
        const raw = c * s.marksPerCorrect - (s.questionCount - c) * s.negativeMarkFraction * s.marksPerCorrect;
        if (sectionPercent(raw, s.questionCount * s.marksPerCorrect) >= s.cutoffPercent) {
          correct = c;
          break;
        }
      }
      bySection[s.key] = graded({ correct, wrong: s.questionCount - correct }, s);
    }
    const result = scoreMock(pattern.sections, bySection);
    expect(result.passedOverall, `failed: ${result.failedSections.join(", ")}`).toBe(true);
  });

  it.each(SEEDS)("%s: one mark below a section's cutoff fails the mock", (_slug, pattern) => {
    // Only meaningful for a section that HAS a cutoff; the Accenture English
    // section has none, so it is skipped by the filter.
    for (const s of pattern.sections.filter((x) => x.cutoffPercent > 0)) {
      const bySection: Record<string, GradedAnswer[]> = Object.fromEntries(
        pattern.sections.map((x) => [x.key, graded({ correct: x.questionCount }, x)]),
      );
      // Highest `correct` that still misses this section's cutoff.
      let correct = -1;
      for (let c = s.questionCount; c >= 0; c--) {
        const raw = c * s.marksPerCorrect - (s.questionCount - c) * s.negativeMarkFraction * s.marksPerCorrect;
        if (sectionPercent(raw, s.questionCount * s.marksPerCorrect) < s.cutoffPercent) {
          correct = c;
          break;
        }
      }
      expect(correct, `${_slug}/${s.key} has no failing score`).toBeGreaterThanOrEqual(0);
      bySection[s.key] = graded({ correct, wrong: s.questionCount - correct }, s);
      const result = scoreMock(pattern.sections, bySection);
      expect(result.passedOverall, `${_slug}/${s.key}`).toBe(false);
      expect(result.failedSections, `${_slug}/${s.key}`).toEqual([s.key]);
    }
  });

  it("gives every section a sane shape", () => {
    for (const pattern of MOCK_PATTERN_SEEDS) {
      for (const s of pattern.sections) {
        const where = `${pattern.slug}/${s.key}`;
        expect(s.cutoffPercent, where).toBeGreaterThanOrEqual(0);
        expect(s.cutoffPercent, where).toBeLessThanOrEqual(100);
        expect(s.marksPerCorrect, where).toBeGreaterThan(0);
        expect(s.negativeMarkFraction, where).toBeGreaterThanOrEqual(0);
        // A penalty of a whole mark or more turns a guess into a net loss
        // bigger than the question is worth, which no published funnel does.
        expect(s.negativeMarkFraction, where).toBeLessThan(1);
        expect(s.questionCount, where).toBeGreaterThan(0);
        // At least 20 seconds a question, or the timer is the test.
        expect(s.timeLimitSec / s.questionCount, where).toBeGreaterThanOrEqual(20);
      }
      const keys = pattern.sections.map((s) => s.key);
      expect(new Set(keys).size, pattern.slug).toBe(keys.length);
    }
  });

  it("covers both settings the machinery exists for", () => {
    // A seed set where no pattern penalises guessing, or none forbids going
    // back, would leave half the phase untested in practice.
    expect(MOCK_PATTERN_SEEDS.some((p) => p.sections.some((s) => s.negativeMarkFraction > 0))).toBe(true);
    expect(MOCK_PATTERN_SEEDS.some((p) => p.sections.some((s) => !s.allowBackNavigation))).toBe(true);
    expect(MOCK_PATTERN_SEEDS.some((p) => p.sections.some((s) => s.allowBackNavigation))).toBe(true);
    expect(MOCK_PATTERN_SEEDS.some((p) => p.sections.some((s) => s.cutoffPercent === 0))).toBe(true);
  });
});
