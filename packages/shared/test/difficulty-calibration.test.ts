import { describe, expect, it } from "vitest";
import {
  CALIBRATED_DIFFICULTIES,
  CALIBRATION_BANDS,
  CALIBRATION_MIN_ATTEMPTERS,
  CALIBRATION_VERDICT_LABEL,
  calibrationDistance,
  calibrationSentence,
  calibrationVerdict,
} from "../src/difficulty-calibration";

/**
 * The bands are a choice (Phase 16b), so the tests are mostly about the
 * edges of that choice being where the module says they are — a threshold
 * that drifted by five points would change which problems an author is
 * asked to look at, silently.
 */

const at = (difficulty: "EASY" | "MEDIUM" | "HARD", solvers: number, attempters: number) =>
  calibrationVerdict({ difficulty, solvers, attempters });

describe("too few attempts says nothing", () => {
  it("refuses to judge below the minimum, however bad the share looks", () => {
    // 0 of 7 is the most alarming share there is, and it is still seven
    // students: a report that cried about it would cry about every new
    // problem in its first week.
    expect(at("EASY", 0, CALIBRATION_MIN_ATTEMPTERS - 1)).toBe("too-few-attempts");
    expect(at("EASY", 0, CALIBRATION_MIN_ATTEMPTERS)).toBe("harder-than-labelled");
  });

  it("does not divide by zero", () => {
    expect(at("MEDIUM", 0, 0)).toBe("too-few-attempts");
    expect(calibrationDistance({ difficulty: "MEDIUM", solvers: 0, attempters: 0 })).toBe(0);
  });
});

describe("the bands, at their edges", () => {
  it("flags an EASY problem at or below 35% and not above it", () => {
    expect(at("EASY", 35, 100)).toBe("harder-than-labelled");
    expect(at("EASY", 36, 100)).toBe("as-labelled");
    // There is no "easier than EASY": it is already the bottom rung.
    expect(at("EASY", 100, 100)).toBe("as-labelled");
    expect(CALIBRATION_BANDS.EASY.easierAtOrAbove).toBeNull();
  });

  it("gives MEDIUM the wide middle, 15% to 85%", () => {
    expect(at("MEDIUM", 15, 100)).toBe("harder-than-labelled");
    expect(at("MEDIUM", 16, 100)).toBe("as-labelled");
    expect(at("MEDIUM", 50, 100)).toBe("as-labelled");
    expect(at("MEDIUM", 84, 100)).toBe("as-labelled");
    expect(at("MEDIUM", 85, 100)).toBe("easier-than-labelled");
  });

  it("flags a HARD problem at or above 70% and never as harder", () => {
    expect(at("HARD", 70, 100)).toBe("easier-than-labelled");
    expect(at("HARD", 69, 100)).toBe("as-labelled");
    // A HARD problem with a 3% solve share is just hard.
    expect(at("HARD", 3, 100)).toBe("as-labelled");
    expect(CALIBRATION_BANDS.HARD.harderAtOrBelow).toBeNull();
  });

  it("is asymmetric on purpose: EASY is tighter than HARD", () => {
    // An EASY problem nobody finishes costs a beginner their first week; a
    // HARD problem everybody finishes costs a strong student an afternoon.
    const easyGap = CALIBRATION_BANDS.EASY.harderAtOrBelow!;
    const hardGap = 1 - CALIBRATION_BANDS.HARD.easierAtOrAbove!;
    expect(easyGap).toBeGreaterThan(hardGap);
  });
});

describe("sorting puts the worst disagreement first", () => {
  it("measures distance outside the band, not the raw share", () => {
    const bad = { difficulty: "EASY" as const, solvers: 5, attempters: 100 };
    const less = { difficulty: "EASY" as const, solvers: 30, attempters: 100 };
    expect(calibrationDistance(bad)).toBeGreaterThan(calibrationDistance(less));
  });

  it("is zero for anything the report does not show", () => {
    expect(calibrationDistance({ difficulty: "MEDIUM", solvers: 50, attempters: 100 })).toBe(0);
    expect(calibrationDistance({ difficulty: "EASY", solvers: 0, attempters: 3 })).toBe(0);
  });

  it("compares a harder-than and an easier-than fairly", () => {
    // 5% on an EASY problem is 30 points outside its band; 95% on a HARD
    // one is 25 points outside its own. The first sorts first, which is the
    // intended order.
    const harder = calibrationDistance({ difficulty: "EASY", solvers: 5, attempters: 100 });
    const easier = calibrationDistance({ difficulty: "HARD", solvers: 95, attempters: 100 });
    expect(harder).toBeGreaterThan(easier);
  });
});

describe("the sentence beside the row", () => {
  it("says what to look at before the label, for a harder-than problem", () => {
    const sentence = calibrationSentence({ difficulty: "EASY", solvers: 2, attempters: 25 });
    expect(sentence).toContain("8%");
    expect(sentence).toContain("25");
    // The order matters: the tests may be broken, and re-labelling a broken
    // problem hides the break.
    expect(sentence).toMatch(/tests and the constraints before the label/);
  });

  it("suggests a rung rather than asserting one, for an easier-than problem", () => {
    expect(calibrationSentence({ difficulty: "HARD", solvers: 90, attempters: 100 })).toMatch(/may belong a rung lower/);
  });

  it("counts one student as a student", () => {
    expect(calibrationSentence({ difficulty: "EASY", solvers: 0, attempters: 1 })).toContain("1 student has");
    expect(calibrationSentence({ difficulty: "EASY", solvers: 0, attempters: 2 })).toContain("2 students have");
  });
});

describe("the module is complete", () => {
  it("bands every difficulty and labels every verdict", () => {
    for (const difficulty of CALIBRATED_DIFFICULTIES) {
      expect(CALIBRATION_BANDS[difficulty], difficulty).toBeDefined();
    }
    for (const verdict of ["too-few-attempts", "as-labelled", "harder-than-labelled", "easier-than-labelled"] as const) {
      expect(CALIBRATION_VERDICT_LABEL[verdict], verdict).toBeTruthy();
    }
  });
});
