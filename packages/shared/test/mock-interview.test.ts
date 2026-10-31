import { describe, expect, it } from "vitest";
import {
  MOCK_CANCEL_CUTOFF_MINUTES,
  MOCK_FEEDBACK_NOTICE,
  MOCK_INTERVIEW_LIMITS,
  MOCK_INTERVIEW_NEXT,
  MOCK_INTERVIEW_RATINGS,
  MOCK_INTERVIEW_RATING_LABEL,
  MOCK_INTERVIEW_REFUSALS,
  MOCK_INTERVIEW_STATUSES,
  MOCK_INTERVIEW_STATUS_LABEL,
  MOCK_JOIN_BEFORE_MINUTES,
  MOCK_MIRROR_NOTICE,
  MOCK_NO_SHOW_AFTER_MINUTES,
  canTransitionInterview,
  endsAt,
  isJoinable,
  joinOpensAt,
  mayCancel,
  mayMarkNoShow,
  type MockInterviewStatus,
} from "../src/index";

const START = new Date("2026-11-07T10:00:00.000Z");
const slot = { startsAt: START, durationMinutes: 45 };
const at = (minutesFromStart: number) => new Date(START.getTime() + minutesFromStart * 60_000);

describe("the lifecycle", () => {
  it("lets a slot be taken, run and finished", () => {
    expect(canTransitionInterview("OPEN", "BOOKED")).toBe(true);
    expect(canTransitionInterview("BOOKED", "IN_PROGRESS")).toBe(true);
    expect(canTransitionInterview("IN_PROGRESS", "COMPLETED")).toBe(true);
  });

  it("lets a booked slot go back to open — a student giving it up frees it", () => {
    expect(canTransitionInterview("BOOKED", "OPEN")).toBe(true);
  });

  it("refuses every jump", () => {
    expect(canTransitionInterview("OPEN", "IN_PROGRESS")).toBe(false);
    expect(canTransitionInterview("OPEN", "COMPLETED")).toBe(false);
    expect(canTransitionInterview("BOOKED", "COMPLETED")).toBe(false);
    expect(canTransitionInterview("OPEN", "NO_SHOW")).toBe(false);
  });

  it("makes the three endings final", () => {
    for (const ending of ["COMPLETED", "CANCELLED", "NO_SHOW"] as MockInterviewStatus[]) {
      expect(MOCK_INTERVIEW_NEXT[ending]).toEqual([]);
      for (const to of MOCK_INTERVIEW_STATUSES) expect(canTransitionInterview(ending, to)).toBe(false);
    }
  });

  it("never lets a running interview become a no-show", () => {
    // Somebody who turned up and worked for twenty minutes did not fail
    // to turn up, whatever happened next.
    expect(canTransitionInterview("IN_PROGRESS", "NO_SHOW")).toBe(false);
  });

  it("labels every status", () => {
    for (const status of MOCK_INTERVIEW_STATUSES) expect(MOCK_INTERVIEW_STATUS_LABEL[status].length).toBeGreaterThan(3);
  });
});

describe("the clock", () => {
  it("opens the room ten minutes before and closes it at the end", () => {
    expect(joinOpensAt(slot)).toEqual(at(-MOCK_JOIN_BEFORE_MINUTES));
    expect(endsAt(slot)).toEqual(at(45));
    expect(isJoinable(slot, at(-MOCK_JOIN_BEFORE_MINUTES - 1))).toBe(false);
    expect(isJoinable(slot, at(-MOCK_JOIN_BEFORE_MINUTES))).toBe(true);
    expect(isJoinable(slot, at(0))).toBe(true);
    expect(isJoinable(slot, at(45))).toBe(true);
    expect(isJoinable(slot, at(46))).toBe(false);
  });

  it("lets a candidate give a slot back until an hour before", () => {
    expect(mayCancel(slot, at(-MOCK_CANCEL_CUTOFF_MINUTES - 1))).toBe(true);
    expect(mayCancel(slot, at(-MOCK_CANCEL_CUTOFF_MINUTES))).toBe(false);
    expect(mayCancel(slot, at(0))).toBe(false);
  });

  it("holds a no-show back for ten minutes", () => {
    // A slow lift is not a no-show on somebody's record.
    expect(mayMarkNoShow(slot, at(MOCK_NO_SHOW_AFTER_MINUTES - 1))).toBe(false);
    expect(mayMarkNoShow(slot, at(MOCK_NO_SHOW_AFTER_MINUTES))).toBe(true);
  });

  it("leaves a window where a slot can be neither given back nor joined", () => {
    // Between the cutoff and the room opening, on purpose: the student is
    // committed, and the way out is to call it off and say why.
    const between = at(-30);
    expect(mayCancel(slot, between)).toBe(false);
    expect(isJoinable(slot, between)).toBe(false);
    expect(MOCK_INTERVIEW_REFUSALS.cancelTooLate).toContain("tell your interviewer");
  });
});

describe("what people are told", () => {
  it("tells the candidate who can see the editor, and who cannot", () => {
    expect(MOCK_MIRROR_NOTICE).toContain("interviewer can see");
    expect(MOCK_MIRROR_NOTICE).toContain("cannot type");
    expect(MOCK_MIRROR_NOTICE).toContain("nobody else");
  });

  it("tells the interviewer the feedback is for the candidate and counts for nothing", () => {
    expect(MOCK_FEEDBACK_NOTICE).toContain("not a score");
    expect(MOCK_FEEDBACK_NOTICE).toContain("readiness does not read it");
  });

  it("every refusal is a sentence somebody can act on", () => {
    for (const [key, text] of Object.entries(MOCK_INTERVIEW_REFUSALS)) {
      expect(text.length, key).toBeGreaterThan(15);
      expect(text.trim(), key).toMatch(/[.!]$/);
    }
  });

  it("labels each rating as a behaviour rather than a quality", () => {
    for (const key of MOCK_INTERVIEW_RATINGS) {
      const label = MOCK_INTERVIEW_RATING_LABEL[key];
      expect(label.length).toBeGreaterThan(10);
      // "Explained their thinking", not "Communication: 3/5 as a person".
      expect(label).toMatch(/^[A-Z]/);
    }
  });
});

describe("the limits", () => {
  it("are ordered, and a slot is between a quarter of an hour and two", () => {
    expect(MOCK_INTERVIEW_LIMITS.durationMinutes.min).toBe(15);
    expect(MOCK_INTERVIEW_LIMITS.durationMinutes.max).toBe(120);
    expect(MOCK_INTERVIEW_LIMITS.feedback.max).toBeGreaterThan(MOCK_INTERVIEW_LIMITS.feedback.min);
    expect(MOCK_INTERVIEW_LIMITS.concurrentBookings).toBeGreaterThan(0);
  });

  it("caps the mirror, because the interviewer's page renders it", () => {
    expect(MOCK_INTERVIEW_LIMITS.snapshotChars).toBeGreaterThan(1_000);
    expect(MOCK_INTERVIEW_LIMITS.snapshotChars).toBeLessThanOrEqual(100_000);
  });
});
