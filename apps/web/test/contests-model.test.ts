import { ICPC_PENALTY_MINUTES, MIN_RATED_PARTICIPANTS } from "@recx/shared";
import { describe, expect, it } from "vitest";
import {
  KIND_DESCRIPTION,
  KIND_LABEL,
  PHASE_LABEL,
  arenaProblemHref,
  contestHref,
  formatClock,
  formatDuration,
  freezeNotice,
  phaseTone,
  ratedNotice,
} from "../src/components/contests/model";

/**
 * The contest pages' presentation model. It is pure so that the copy stating
 * a contest's RULES is tested rather than buried in JSX — if the penalty
 * ever changed, a student reading the rules must not be told the old number.
 */

describe("labels", () => {
  it("names both scoring kinds", () => {
    expect(KIND_LABEL).toEqual({ ICPC: "ICPC", SUBTASK: "Subtask scoring" });
  });

  it("names all three phases", () => {
    expect(PHASE_LABEL).toEqual({ upcoming: "Upcoming", running: "Running", finished: "Finished" });
  });

  it.each([
    ["running", "success"],
    ["upcoming", "info"],
    ["finished", "default"],
  ] as const)("%s is toned %s", (phase, tone) => {
    expect(phaseTone(phase)).toBe(tone);
  });
});

describe("the rules copy states the real numbers", () => {
  it("the ICPC description quotes the penalty constant, not a literal", () => {
    expect(KIND_DESCRIPTION.ICPC).toContain(`${ICPC_PENALTY_MINUTES} minutes`);
  });

  it("the ICPC description states that an unsolved problem costs nothing", () => {
    expect(KIND_DESCRIPTION.ICPC).toMatch(/never solve costs nothing/i);
  });

  it("the SUBTASK description promises partial credit and no time penalty", () => {
    expect(KIND_DESCRIPTION.SUBTASK).toMatch(/partial credit/i);
    expect(KIND_DESCRIPTION.SUBTASK).toMatch(/no time penalty/i);
  });
});

describe("formatDuration", () => {
  it.each([
    [30, "30 m"],
    [59, "59 m"],
    [60, "1 h"],
    [90, "1 h 30 m"],
    [120, "2 h"],
    [185, "3 h 5 m"],
  ])("%d minutes reads %s", (minutes, text) => {
    expect(formatDuration(minutes)).toBe(text);
  });
});

describe("formatClock", () => {
  it.each([
    [0, "0:00:00"],
    [-5_000, "0:00:00"],
    [1_000, "0:00:01"],
    [59_000, "0:00:59"],
    [60_000, "0:01:00"],
    [3_600_000, "1:00:00"],
    [7_384_000, "2:03:04"],
  ])("%d ms reads %s", (ms, text) => {
    expect(formatClock(ms)).toBe(text);
  });

  it("never shows a negative clock once the contest is over", () => {
    expect(formatClock(-10_000_000)).toBe("0:00:00");
  });
});

describe("ratedNotice — said in advance, as the spec requires", () => {
  it("an unrated contest says the rating will not change", () => {
    const notice = ratedNotice({ isRated: false, phase: "upcoming", ratedParticipants: null });
    expect(notice.rated).toBe(false);
    expect(notice.text).toMatch(/will not change/i);
  });

  it("a rated contest warns BEFORE the start that it needs 30 students", () => {
    const notice = ratedNotice({ isRated: true, phase: "upcoming", ratedParticipants: null });
    expect(notice.rated).toBe(true);
    expect(notice.text).toContain(String(MIN_RATED_PARTICIPANTS));
    expect(notice.text).toMatch(/becomes unrated/i);
  });

  it("once rated, it reports the field that actually counted", () => {
    const notice = ratedNotice({ isRated: true, phase: "finished", ratedParticipants: 142 });
    expect(notice.text).toContain("142");
    expect(notice.text).not.toMatch(/at least 30/i);
  });

  it("an unrated contest never mentions the 30-student rule", () => {
    const notice = ratedNotice({ isRated: false, phase: "finished", ratedParticipants: null });
    expect(notice.text).not.toContain(String(MIN_RATED_PARTICIPANTS));
  });
});

describe("freezeNotice", () => {
  it("states the window and that your own row stays visible", () => {
    const text = freezeNotice({ canFreeze: true, freezeMinutes: 30 });
    expect(text).toContain("30 minutes");
    expect(text).toMatch(/your own row/i);
  });

  it("is absent when the contest cannot freeze", () => {
    expect(freezeNotice({ canFreeze: false, freezeMinutes: 30 })).toBeNull();
  });
});

describe("hrefs", () => {
  it("builds the contest pages", () => {
    expect(contestHref("div2-round-7")).toBe("/contests/div2-round-7");
    expect(contestHref("div2-round-7", "arena")).toBe("/contests/div2-round-7/arena");
    expect(contestHref("div2-round-7", "standings")).toBe("/contests/div2-round-7/standings");
    expect(contestHref("div2-round-7", "analysis")).toBe("/contests/div2-round-7/analysis");
  });

  it("selects a problem in the arena by its letter", () => {
    expect(arenaProblemHref("round-7", "C")).toBe("/contests/round-7/arena?p=C");
  });

  it("encodes a problem letter rather than trusting it", () => {
    expect(arenaProblemHref("round-7", "A&B")).toBe("/contests/round-7/arena?p=A%26B");
  });
});
