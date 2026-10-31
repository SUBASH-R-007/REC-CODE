import { describe, expect, it } from "vitest";
import {
  TIMER_ANNOUNCEMENT_SECONDS,
  TIMER_DANGER_SECONDS,
  TIMER_WARNING_SECONDS,
  announcementText,
  clockLabel,
  dueAnnouncement,
  formatClock,
  interpolateRemaining,
  timerTone,
} from "../src/exam-timer";

const sec = (n: number) => n * 1000;

describe("formatClock", () => {
  it("is always HH:MM:SS, two digits each", () => {
    expect(formatClock(sec(3 * 3600 + 5 * 60 + 9))).toBe("03:05:09");
    expect(formatClock(sec(9))).toBe("00:00:09");
    expect(formatClock(0)).toBe("00:00:00");
  });

  it("rounds up, so the clock never reads zero while work is still accepted", () => {
    expect(formatClock(1)).toBe("00:00:01");
    expect(formatClock(999)).toBe("00:00:01");
    expect(formatClock(1_001)).toBe("00:00:02");
  });

  it("never renders a negative clock", () => {
    expect(formatClock(-5_000)).toBe("00:00:00");
  });

  it("keeps a three-hour assessment in two digits", () => {
    expect(formatClock(sec(6 * 3600))).toBe("06:00:00");
  });
});

describe("timerTone", () => {
  it("is normal with plenty of time", () => {
    expect(timerTone(sec(3_600))).toBe("normal");
    expect(timerTone(sec(301))).toBe("normal");
  });

  it("turns amber at exactly 5 minutes, not a second later", () => {
    expect(timerTone(sec(TIMER_WARNING_SECONDS))).toBe("warning");
    expect(timerTone(sec(299))).toBe("warning");
  });

  it("turns red at exactly 60 seconds", () => {
    expect(timerTone(sec(TIMER_DANGER_SECONDS))).toBe("danger");
    expect(timerTone(sec(59))).toBe("danger");
    expect(timerTone(sec(61))).toBe("warning");
  });

  it("is red, not normal, at zero", () => {
    expect(timerTone(0)).toBe("danger");
  });
});

describe("dueAnnouncement", () => {
  it("announces nothing on an ordinary tick", () => {
    expect(dueAnnouncement(sec(1_800), sec(1_799))).toBeNull();
    expect(dueAnnouncement(sec(42), sec(41))).toBeNull();
  });

  it.each(TIMER_ANNOUNCEMENT_SECONDS)("announces at exactly %i seconds", (threshold) => {
    expect(dueAnnouncement(sec(threshold) + 1, sec(threshold))).toBe(threshold);
  });

  it("announces once, not again on the following tick", () => {
    expect(dueAnnouncement(sec(301), sec(300))).toBe(300);
    expect(dueAnnouncement(sec(300), sec(299))).toBeNull();
    expect(dueAnnouncement(sec(299), sec(298))).toBeNull();
  });

  it("announces at no other threshold", () => {
    // Every second of a one-hour paper: exactly four announcements.
    const announced: number[] = [];
    for (let s = 3_600; s > 0; s--) {
      const due = dueAnnouncement(sec(s), sec(s - 1));
      if (due !== null) announced.push(due);
    }
    expect(announced).toEqual([600, 300, 60, 10]);
  });

  it("announces only the most urgent threshold when a frozen tab skips several", () => {
    // The OS froze the tab at 11 minutes and woke it at 4. Reading out "10
    // minutes remaining" first would be worse than saying nothing.
    expect(dueAnnouncement(sec(660), sec(240))).toBe(300);
    // Woken past all four.
    expect(dueAnnouncement(sec(660), sec(5))).toBe(10);
  });

  it("says nothing when the clock goes up, and re-arms for the next crossing", () => {
    // An invigilator granted 10 minutes. No announcement for the jump...
    expect(dueAnnouncement(sec(240), sec(840))).toBeNull();
    // ...and crossing 5:00 again later still announces, because nothing here
    // remembers having announced it.
    expect(dueAnnouncement(sec(301), sec(300))).toBe(300);
  });

  it("says nothing when the clock does not move", () => {
    expect(dueAnnouncement(sec(300), sec(300))).toBeNull();
  });

  it("ignores a non-finite reading rather than announcing nonsense", () => {
    expect(dueAnnouncement(Number.NaN, sec(300))).toBeNull();
    expect(dueAnnouncement(sec(301), Number.NaN)).toBeNull();
  });

  it("announces 10 seconds on the way to zero", () => {
    expect(dueAnnouncement(sec(11), sec(10))).toBe(10);
    expect(dueAnnouncement(sec(10), 0)).toBeNull();
  });
});

describe("announcementText", () => {
  it("is a spoken sentence for each of the four moments", () => {
    expect(announcementText(600)).toBe("10 minutes remaining.");
    expect(announcementText(300)).toBe("5 minutes remaining.");
    expect(announcementText(60)).toBe("1 minute remaining.");
    expect(announcementText(10)).toBe("10 seconds remaining.");
  });

  it("never reads out a raw clock", () => {
    for (const threshold of TIMER_ANNOUNCEMENT_SECONDS) {
      expect(announcementText(threshold)).not.toMatch(/\d\d:\d\d/);
    }
  });
});

describe("clockLabel", () => {
  it("names the units a bare clock does not", () => {
    expect(clockLabel(sec(2 * 3600 + 30 * 60))).toBe("Time remaining: 2 hours 30 minutes");
    expect(clockLabel(sec(1 * 3600))).toBe("Time remaining: 1 hour");
    expect(clockLabel(sec(90))).toBe("Time remaining: 1 minute");
  });

  it("names seconds only when they are the whole story", () => {
    expect(clockLabel(sec(42))).toBe("Time remaining: 42 seconds");
    expect(clockLabel(sec(1))).toBe("Time remaining: 1 second");
    expect(clockLabel(0)).toBe("Time remaining: 0 seconds");
    // With minutes present, seconds are omitted so refreshing the label does
    // not read a changing third component.
    expect(clockLabel(sec(90))).not.toMatch(/second/);
  });
});

describe("interpolateRemaining", () => {
  it("counts down between heartbeats", () => {
    expect(interpolateRemaining({ serverMsRemaining: sec(600), atMs: 1_000, nowMs: 4_000 })).toBe(sec(597));
  });

  it("returns the server's number exactly at the moment it arrived", () => {
    expect(interpolateRemaining({ serverMsRemaining: sec(600), atMs: 1_000, nowMs: 1_000 })).toBe(sec(600));
  });

  it("cannot add time when the local clock steps backwards", () => {
    // An NTP correction or a resumed laptop. The delta floors at zero, so the
    // worst a bad local clock can do is fail to count down.
    expect(interpolateRemaining({ serverMsRemaining: sec(600), atMs: 10_000, nowMs: 1_000 })).toBe(sec(600));
  });

  it("never goes below zero", () => {
    expect(interpolateRemaining({ serverMsRemaining: sec(5), atMs: 0, nowMs: sec(60) })).toBe(0);
  });

  it("is monotonic for a monotonic local clock", () => {
    let last = Number.POSITIVE_INFINITY;
    for (let t = 0; t <= 20_000; t += 250) {
      const left = interpolateRemaining({ serverMsRemaining: sec(15), atMs: 0, nowMs: t });
      expect(left).toBeLessThanOrEqual(last);
      last = left;
    }
    expect(last).toBe(0);
  });
});
