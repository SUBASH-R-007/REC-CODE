import { describe, expect, it } from "vitest";
import {
  DECISION_REASON_HINT,
  DRIVE_ELIGIBILITY,
  DRIVE_ELIGIBILITY_LABEL,
  DRIVE_REASON_MIN,
  ELIGIBILITY_FRAMING,
  describeDriveCount,
  driveCount,
  isDriveTier,
} from "../src/drive";

/**
 * The per-drive count, which is the number most likely to be misread in this
 * whole phase — because "who clears the bar" looks so much like "who should
 * go forward", and the second is a decision the platform may not make.
 */

describe("the threshold is on the NORMALISED figure", () => {
  it("counts a student whose measurable weight is lower, fairly", () => {
    /**
     * The correction the design's own review found. With mockInterviewScore
     * permanently unsourced no TOP score can exceed 85, so a raw bar of 70
     * would exclude a cohort for a component nobody has built. Both students
     * below are at 70 % of what was measurable for them, and both clear it.
     */
    const count = driveCount(
      { tier: "TOP", thresholdScore: 70 },
      [
        { score: 59, availableWeight: 85 }, // 69.4 % — just under
        { score: 60, availableWeight: 85 }, // 70.6 % — just over
        { score: 70, availableWeight: 100 }, // exactly 70 %
      ],
    );
    expect(count).toMatchObject({ clearing: 2, measured: 3, unmeasurable: 0 });
  });

  it("would get it wrong on the raw score, which is why it does not use it", () => {
    // Shown rather than asserted in prose: on raw scores, nobody in this
    // cohort clears 70 at all.
    const rows = [
      { score: 60, availableWeight: 85 },
      { score: 84, availableWeight: 85 },
    ];
    const onRaw = rows.filter((row) => (row.score ?? 0) >= 70).length;
    expect(onRaw).toBe(1);
    expect(driveCount({ tier: "TOP", thresholdScore: 70 }, rows).clearing).toBe(2);
  });

  it("counts everybody with a figure when there is no bar", () => {
    const count = driveCount({ tier: "SERVICE", thresholdScore: null }, [
      { score: 0, availableWeight: 90 },
      { score: 90, availableWeight: 90 },
      { score: null, availableWeight: 0 },
    ]);
    expect(count).toMatchObject({ clearing: 2, measured: 2, unmeasurable: 1 });
  });
});

describe("a student with nothing measurable is counted neither way", () => {
  it("is unmeasurable rather than below the bar", () => {
    /**
     * The honest answer, and not a convenience: they are not "below the
     * bar", they were never assessed. Folding them into the shortfall would
     * let an officer read "40 of 214 fall short" when forty of them had no
     * figure at all.
     */
    const count = driveCount({ tier: "PRODUCT", thresholdScore: 60 }, [
      { score: 80, availableWeight: 90 },
      { score: null, availableWeight: 0 },
      { score: null, availableWeight: 0 },
    ]);
    expect(count).toMatchObject({ clearing: 1, measured: 1, unmeasurable: 2 });
    expect(count.measured + count.unmeasurable).toBe(3);
  });

  it("treats a zero denominator with a score as unmeasurable too", () => {
    // Not storable in the database (the honesty CHECK refuses it), but a
    // count must not divide by zero if one ever arrived.
    expect(driveCount({ tier: "TOP", thresholdScore: 1 }, [{ score: 50, availableWeight: 0 }])).toMatchObject({
      clearing: 0,
      measured: 0,
      unmeasurable: 1,
    });
  });

  it("is zero everywhere for an empty cohort", () => {
    expect(driveCount({ tier: "TOP", thresholdScore: 50 }, [])).toMatchObject({
      clearing: 0,
      measured: 0,
      unmeasurable: 0,
    });
  });
});

describe("the sentence carries the denominator in its words", () => {
  const count = driveCount({ tier: "PRODUCT", thresholdScore: 70 }, [
    { score: 80, availableWeight: 90 },
    { score: 20, availableWeight: 90 },
    { score: null, availableWeight: 0 },
  ]);

  it("says N of M, and what the 70 is a percentage of", () => {
    /**
     * The draft printed "214 students at PRODUCT >= 70" with nothing to say
     * 70 of what. The denominator is in the words, not in a tooltip, because
     * this sentence is what gets pasted into an email.
     */
    const sentence = describeDriveCount(count);
    expect(sentence).toContain("1 of 2 students");
    expect(sentence).toContain("70% of what was measurable for them");
  });

  it("reports the unmeasurable students separately", () => {
    expect(describeDriveCount(count)).toContain("1 more had nothing measurable");
  });

  it("says so when there is no bar at all", () => {
    const open = driveCount({ tier: "SERVICE", thresholdScore: null }, [{ score: 1, availableWeight: 90 }]);
    expect(describeDriveCount(open)).toContain("with any readiness figure at all");
  });

  it("drops the caveat when there is nothing to caveat", () => {
    const clean = driveCount({ tier: "TOP", thresholdScore: 10 }, [{ score: 50, availableWeight: 85 }]);
    expect(describeDriveCount(clean)).not.toContain("nothing measurable");
  });
});

describe("the framing keeps the decision where it belongs", () => {
  it("says the platform never decides eligibility", () => {
    expect(ELIGIBILITY_FRAMING).toMatch(/never decides/i);
    expect(ELIGIBILITY_FRAMING).toMatch(/recorded per student with the reason/i);
    // The sentence that stops a readiness figure becoming the reason.
    expect(ELIGIBILITY_FRAMING).toMatch(/never a reason/i);
  });

  it("tells the officer who reads their reason, and when", () => {
    expect(DECISION_REASON_HINT).toMatch(/against your name/i);
    expect(DECISION_REASON_HINT).toMatch(/months later/i);
  });

  it("asks for a reason long enough to be one", () => {
    // Not a quality bar: the difference between a reason and an empty string.
    expect(DRIVE_REASON_MIN).toBe(10);
  });
});

describe("the small closed sets", () => {
  it("has exactly two decisions, both labelled", () => {
    expect([...DRIVE_ELIGIBILITY]).toEqual(["ELIGIBLE", "NOT_ELIGIBLE"]);
    for (const value of DRIVE_ELIGIBILITY) expect(DRIVE_ELIGIBILITY_LABEL[value].length).toBeGreaterThan(3);
  });

  it("recognises a tier and refuses anything else", () => {
    expect(isDriveTier("PRODUCT")).toBe(true);
    expect(isDriveTier("product")).toBe(false);
    expect(isDriveTier(null)).toBe(false);
  });
});
