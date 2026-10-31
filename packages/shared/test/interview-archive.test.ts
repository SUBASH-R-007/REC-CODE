import { describe, expect, it } from "vitest";
import {
  COMPANY_TAG_SOURCES,
  INTERVIEW_LIMITS,
  INTERVIEW_MODES,
  INTERVIEW_MODE_LABEL,
  INTERVIEW_OUTCOMES,
  INTERVIEW_OUTCOME_LABEL,
  INTERVIEW_PENDING_LIMIT,
  INTERVIEW_PREPARATION,
  INTERVIEW_PREPARATION_LABEL,
  INTERVIEW_REFUSALS,
  INTERVIEW_ROUND_KINDS,
  INTERVIEW_ROUND_LABEL,
  TOPICS,
  anonymousAuthor,
  companyTagNotice,
  companyTagSource,
  topicsAreValid,
} from "../src/index";

describe("what a student is shown instead of a name", () => {
  it("names the batch and the department, and never the section", () => {
    expect(anonymousAuthor({ batchYear: 2026, departmentCode: "CSE" })).toBe("A CSE student, batch of 2026");
  });

  it("degrades sensibly when a field is missing", () => {
    expect(anonymousAuthor({ batchYear: 2026, departmentCode: null })).toBe("A student, batch of 2026");
    expect(anonymousAuthor({ batchYear: null, departmentCode: "ECE" })).toBe("An ECE student");
    expect(anonymousAuthor({ batchYear: null, departmentCode: null })).toBe("A student");
  });

  it("gets the article right for a code read letter by letter", () => {
    // The sound of the first letter's NAME, not whether it is a vowel.
    expect(anonymousAuthor({ batchYear: 2026, departmentCode: "ECE" })).toBe("An ECE student, batch of 2026");
    expect(anonymousAuthor({ batchYear: null, departmentCode: "IT" })).toBe("An IT student");
    expect(anonymousAuthor({ batchYear: null, departmentCode: "MECH" })).toBe("An MECH student");
    expect(anonymousAuthor({ batchYear: null, departmentCode: "CSE" })).toBe("A CSE student");
    expect(anonymousAuthor({ batchYear: null, departmentCode: "BME" })).toBe("A BME student");
  });

  it("never contains anything that could be a name", () => {
    for (const batchYear of [null, 2026]) {
      for (const departmentCode of [null, "CSE"]) {
        const text = anonymousAuthor({ batchYear, departmentCode });
        expect(text).not.toMatch(/@/);
        expect(text.startsWith("A")).toBe(true);
      }
    }
  });
});

describe("the curated label SPEC §11 asks for", () => {
  it("says a curated track is a guess, in as many words", () => {
    const notice = companyTagNotice("CURATED", 0);
    expect(notice).toContain("Curated by the placement cell");
    expect(notice).toContain("best guess");
    expect(notice).toContain("not a record");
  });

  it("counts the interviews behind an experience-backed track", () => {
    expect(companyTagNotice("EXPERIENCE", 1)).toBe("From one interview a student reported here.");
    expect(companyTagNotice("EXPERIENCE", 7)).toBe("From 7 interviews students reported here.");
  });

  it("says when a track is both curated and reported", () => {
    expect(companyTagNotice("EXPERIENCE", 2, true)).toBe(
      "From 2 interviews students reported here, alongside the placement cell's own curation.",
    );
  });

  it("keys the label on whether anybody REPORTED one, not on a tag's source", () => {
    // A company whose tags were all reversed back to zero still has the
    // accounts behind it; calling that curated would be untrue.
    expect(companyTagSource(0)).toBe("CURATED");
    expect(companyTagSource(1)).toBe("EXPERIENCE");
    expect(companyTagSource(12)).toBe("EXPERIENCE");
  });

  it("has exactly two sources: somebody guessed, or students reported", () => {
    expect([...COMPANY_TAG_SOURCES]).toEqual(["CURATED", "EXPERIENCE"]);
  });
});

describe("the closed vocabularies", () => {
  it("label every value, because an unlabelled enum reaches a student as a constant", () => {
    for (const value of INTERVIEW_ROUND_KINDS) expect(INTERVIEW_ROUND_LABEL[value].length).toBeGreaterThanOrEqual(2);
    for (const value of INTERVIEW_MODES) expect(INTERVIEW_MODE_LABEL[value].length).toBeGreaterThanOrEqual(2);
    for (const value of INTERVIEW_OUTCOMES) expect(INTERVIEW_OUTCOME_LABEL[value].length).toBeGreaterThanOrEqual(2);
    for (const value of INTERVIEW_PREPARATION) expect(INTERVIEW_PREPARATION_LABEL[value].length).toBeGreaterThanOrEqual(2);
  });

  it("offer a way to say an interview is still open", () => {
    // Without it every unresolved interview is reported as a rejection,
    // and the archive reads as a wall of failure.
    expect(INTERVIEW_OUTCOMES).toContain("WAITING");
  });

  it("validate topics against the fourteen, and refuse repeats", () => {
    expect(topicsAreValid(["GRAPHS", "TREES"])).toBe(true);
    expect(topicsAreValid([])).toBe(true);
    expect(topicsAreValid([...TOPICS])).toBe(true);
    expect(topicsAreValid(["GRAPHS", "GRAPHS"])).toBe(false);
    expect(topicsAreValid(["NOT_A_TOPIC"])).toBe(false);
  });
});

describe("the limits", () => {
  it("are ordered, and the only free text is a company name", () => {
    for (const [key, range] of Object.entries(INTERVIEW_LIMITS)) {
      expect(range.max, key).toBeGreaterThanOrEqual(range.min);
    }
    // The archive's whole point is that there is nowhere to write a story.
    expect(INTERVIEW_LIMITS.companyName.max).toBeLessThanOrEqual(80);
  });

  it("cap what one person can leave in a moderator's queue", () => {
    expect(INTERVIEW_PENDING_LIMIT).toBeGreaterThan(0);
    expect(INTERVIEW_PENDING_LIMIT).toBeLessThanOrEqual(5);
    expect(INTERVIEW_REFUSALS.pendingLimit).toContain("will be read");
  });

  it("every refusal is a sentence a student can act on", () => {
    for (const [key, text] of Object.entries(INTERVIEW_REFUSALS)) {
      expect(text.length, key).toBeGreaterThan(15);
      expect(text.trim(), key).toMatch(/[.!]$/);
    }
  });
});
