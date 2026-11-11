import { describe, expect, it } from "vitest";
import {
  ACCOMMODATION_KINDS,
  ACCOMMODATION_LIMITS,
  accommodatedDurationSec,
  accommodationTermsSchema,
  accommodationTermsSummary,
  reviewerAccommodationView,
  suggestedExemptSignals,
  type AccommodationTerms,
} from "../src/accommodation";
import { PROCTOR_EVENT_KINDS, PROCTOR_EVENT_LABELS } from "../src/proctor";
import { ROSTER_COLUMNS, ROSTER_IMPORT_LIMITS, rosterRowSchema } from "../src/roster";

const DAY = 86_400_000;

function terms(overrides: Partial<AccommodationTerms> = {}): AccommodationTerms {
  return {
    kinds: ["SCREEN_READER"],
    exemptSignals: ["FOCUS_LOSS", "FULLSCREEN_EXIT"],
    extraTimePercent: 0,
    extraTimeMinutes: 0,
    allowBreaks: false,
    breakMinutes: 0,
    fontScalePercent: 100,
    allowScribe: false,
    highContrast: false,
    validUntil: new Date(Date.now() + 30 * DAY),
    ...overrides,
  };
}

function messages(input: unknown): string[] {
  const parsed = accommodationTermsSchema.safeParse(input);
  return parsed.success ? [] : parsed.error.issues.map((i) => i.message);
}

describe("accommodationTermsSchema", () => {
  it("accepts a plain screen-reader grant", () => {
    expect(messages(terms())).toEqual([]);
  });

  it("coerces an ISO validUntil string to a Date", () => {
    const iso = new Date(Date.now() + 10 * DAY).toISOString();
    const parsed = accommodationTermsSchema.parse({ ...terms(), validUntil: iso });
    expect(parsed.validUntil).toBeInstanceOf(Date);
    expect(parsed.validUntil.toISOString()).toBe(iso);
  });

  it("needs at least one kind and no kind twice", () => {
    expect(messages(terms({ kinds: [] }))).toContain("Choose at least one accommodation.");
    expect(messages(terms({ kinds: ["SCREEN_READER", "SCREEN_READER"] }))).toContain("Each accommodation can be chosen once.");
  });

  it("ties EXTRA_TIME to an amount of extra time, both ways", () => {
    expect(messages(terms({ kinds: ["EXTRA_TIME"], extraTimePercent: 33 }))).toEqual([]);
    expect(messages(terms({ kinds: ["EXTRA_TIME"], extraTimeMinutes: 20 }))).toEqual([]);
    expect(messages(terms({ kinds: ["EXTRA_TIME"] })).join(" ")).toMatch(/give a percentage or minutes/);
    expect(messages(terms({ extraTimePercent: 25 })).join(" ")).toMatch(/choose “Extra time”/);
  });

  it("ties BREAKS to allowBreaks and keeps break minutes at 0 without breaks", () => {
    expect(messages(terms({ kinds: ["BREAKS"], allowBreaks: true, breakMinutes: 10 }))).toEqual([]);
    expect(messages(terms({ kinds: ["BREAKS"] })).join(" ")).toMatch(/allow breaks/);
    expect(messages(terms({ allowBreaks: true })).join(" ")).toMatch(/choose “Rest breaks”/);
    expect(messages(terms({ breakMinutes: 5 }))).toContain("Break minutes must be 0 unless breaks are allowed.");
  });

  it("refuses a repeated exempt signal and unknown signals", () => {
    expect(messages(terms({ exemptSignals: ["COPY", "COPY"] }))).toContain("Each exempt signal can be chosen once.");
    expect(accommodationTermsSchema.safeParse({ ...terms(), exemptSignals: ["NOT_A_SIGNAL"] }).success).toBe(false);
  });

  it("holds every number to ACCOMMODATION_LIMITS", () => {
    const { extraTimePercent, extraTimeMinutes, breakMinutes, fontScalePercent } = ACCOMMODATION_LIMITS;
    expect(messages(terms({ kinds: ["EXTRA_TIME"], extraTimePercent: extraTimePercent.max }))).toEqual([]);
    expect(messages(terms({ kinds: ["EXTRA_TIME"], extraTimePercent: extraTimePercent.max + 1 }))).not.toEqual([]);
    expect(messages(terms({ kinds: ["EXTRA_TIME"], extraTimeMinutes: extraTimeMinutes.max + 1 }))).not.toEqual([]);
    expect(messages(terms({ kinds: ["BREAKS"], allowBreaks: true, breakMinutes: breakMinutes.max + 1 }))).not.toEqual([]);
    expect(messages(terms({ fontScalePercent: fontScalePercent.min - 1 }))).not.toEqual([]);
    expect(messages(terms({ fontScalePercent: fontScalePercent.max }))).toEqual([]);
    expect(messages(terms({ fontScalePercent: 150.5 }))).not.toEqual([]);
    expect(messages(terms({ kinds: ["EXTRA_TIME"], extraTimePercent: -1 }))).not.toEqual([]);
  });

  it("needs validUntil in the future and within the maximum validity", () => {
    expect(messages(terms({ validUntil: new Date(Date.now() - DAY) })).join(" ")).toMatch(/future date/);
    const tooFar = new Date(Date.now() + (ACCOMMODATION_LIMITS.maxValidityDays + 1) * DAY);
    expect(messages(terms({ validUntil: tooFar })).join(" ")).toMatch(/at most 400 days/);
    expect(messages(terms({ validUntil: new Date(Date.now() + 399 * DAY) }))).toEqual([]);
  });
});

describe("suggestedExemptSignals", () => {
  it("SCREEN_READER suggests focus loss and full-screen exit (spec)", () => {
    const signals = suggestedExemptSignals(["SCREEN_READER"]);
    expect(signals).toContain("FOCUS_LOSS");
    expect(signals).toContain("FULLSCREEN_EXIT");
  });

  it("unions kinds without duplicates, in PROCTOR_EVENT_KINDS order", () => {
    const signals = suggestedExemptSignals(["SPEECH_INPUT", "MAGNIFIER", "SCREEN_READER"]);
    expect(new Set(signals).size).toBe(signals.length);
    const order = signals.map((s) => PROCTOR_EVENT_KINDS.indexOf(s));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(signals).toEqual(["FOCUS_LOSS", "FULLSCREEN_EXIT", "PROGRAMMATIC_INSERT", "CADENCE_BURST"]);
  });

  it("suggests nothing for kinds that need no exemption", () => {
    expect(suggestedExemptSignals(["EXTRA_TIME", "BREAKS", "SEPARATE_ROOM"])).toEqual([]);
  });
});

describe("reviewerAccommodationView", () => {
  it("carries exactly one key, exemptSignals", () => {
    const view = reviewerAccommodationView(terms({ kinds: ["SCREEN_READER", "EXTRA_TIME"], extraTimePercent: 33 }));
    expect(Object.keys(view)).toEqual(["exemptSignals"]);
    expect(view.exemptSignals).toEqual(["FOCUS_LOSS", "FULLSCREEN_EXIT"]);
    expect(JSON.stringify(view)).not.toMatch(/SCREEN_READER|EXTRA_TIME|kinds|reason/);
  });

  it("is a copy, not the caller's array", () => {
    const source = terms();
    const view = reviewerAccommodationView(source);
    expect(view.exemptSignals).not.toBe(source.exemptSignals);
    expect(Object.isFrozen(view.exemptSignals)).toBe(true);
  });
});

describe("accommodatedDurationSec", () => {
  it("is floor(duration × (1 + p/100)) + minutes × 60", () => {
    expect(accommodatedDurationSec(3600, { extraTimePercent: 0, extraTimeMinutes: 0 })).toBe(3600);
    expect(accommodatedDurationSec(3600, { extraTimePercent: 33, extraTimeMinutes: 0 })).toBe(4788);
    expect(accommodatedDurationSec(5400, { extraTimePercent: 25, extraTimeMinutes: 10 })).toBe(6750 + 600);
    expect(accommodatedDurationSec(1001, { extraTimePercent: 50, extraTimeMinutes: 0 })).toBe(1501);
  });

  it("refuses a negative or non-finite duration", () => {
    expect(() => accommodatedDurationSec(-1, { extraTimePercent: 0, extraTimeMinutes: 0 })).toThrow(RangeError);
    expect(() => accommodatedDurationSec(Number.NaN, { extraTimePercent: 0, extraTimeMinutes: 0 })).toThrow(RangeError);
  });
});

describe("accommodationTermsSummary", () => {
  it("never names a kind", () => {
    const summary = accommodationTermsSummary(
      terms({ kinds: ["SCREEN_READER", "EXTRA_TIME", "BREAKS"], extraTimePercent: 33, allowBreaks: true, breakMinutes: 10 }),
    );
    expect(summary).toBe("+33% time · breaks (10 min) · 2 exempt signals");
    for (const kind of ACCOMMODATION_KINDS) expect(summary).not.toContain(kind);
  });

  it("says so when nothing changes the timing or display", () => {
    expect(accommodationTermsSummary(terms({ exemptSignals: [] }))).toBe("No timing or display changes");
  });
});

describe("proctor labels", () => {
  it("label every kind", () => {
    expect(Object.keys(PROCTOR_EVENT_LABELS).sort()).toEqual([...PROCTOR_EVENT_KINDS].sort());
  });
});

describe("rosterRowSchema", () => {
  const row = {
    lmsUserId: "lms-1001",
    collegeId: "2116231001001",
    email: "  Priya@Example.EDU ",
    firstName: "Priya",
    lastName: "Sharma",
    batchYear: "2027",
    departmentCode: "cse",
    section: "a",
  };

  it("normalises a valid row", () => {
    expect(rosterRowSchema.parse(row)).toEqual({
      lmsUserId: "lms-1001",
      collegeId: "2116231001001",
      email: "priya@example.edu",
      firstName: "Priya",
      lastName: "Sharma",
      batchYear: 2027,
      departmentCode: "CSE",
      section: "A",
    });
  });

  it("reads an empty section as no section", () => {
    expect(rosterRowSchema.parse({ ...row, section: "  " }).section).toBeNull();
  });

  it.each([
    ["lmsUserId", "has space"],
    ["collegeId", "21-16"],
    ["email", "not-an-email"],
    ["firstName", ""],
    ["batchYear", "1999"],
    ["batchYear", "twenty"],
    ["departmentCode", "C5E"],
    ["section", "ABCDE"],
  ])("refuses a bad %s (%s)", (field, value) => {
    expect(rosterRowSchema.safeParse({ ...row, [field]: value }).success).toBe(false);
  });

  it("has the eight columns and the documented limits", () => {
    expect(ROSTER_COLUMNS).toHaveLength(8);
    expect(ROSTER_IMPORT_LIMITS).toEqual({ maxRows: 5000, maxBytes: 921_600 });
  });
});
