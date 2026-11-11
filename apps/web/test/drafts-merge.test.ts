import { describe, expect, it } from "vitest";
import {
  isWorthOffering,
  normalizeTime,
  pickInitialLanguage,
  readDraftRecord,
  resolveDraft,
  type DraftCopy,
} from "@/lib/drafts/merge";

/**
 * Which copy of a student's code the workspace opens with. A student losing
 * 40 minutes of code to a campus wifi drop is the fastest way to lose the
 * cohort's trust, so every branch is pinned here.
 */

const STARTER = "class Solution {\n  // write your code here\n};\n";
const T = Date.UTC(2026, 9, 10, 9, 0, 0);
const min = (n: number) => n * 60_000;

const copy = (source: string, updatedAt: number): DraftCopy => ({ source, updatedAt });

describe("resolveDraft — the newer copy wins", () => {
  it("opens the starter code when nothing is saved anywhere", () => {
    const r = resolveDraft({ local: null, server: null, starter: STARTER });
    expect(r).toEqual({
      source: STARTER,
      origin: "starter",
      updatedAt: null,
      alternative: null,
      localCorrupt: false,
      serverBehind: false,
    });
  });

  it("opens the device copy when only the device has one, and syncs it up", () => {
    const r = resolveDraft({ local: copy("int x;", T), server: null, starter: STARTER });
    expect(r.source).toBe("int x;");
    expect(r.origin).toBe("local");
    expect(r.updatedAt).toBe(T);
    expect(r.alternative).toBeNull();
    expect(r.serverBehind).toBe(true);
  });

  it("does not push an untouched starter copy to the server", () => {
    const r = resolveDraft({ local: copy(STARTER, T), server: null, starter: STARTER });
    expect(r.origin).toBe("local");
    expect(r.serverBehind).toBe(false);
  });

  it("opens the server copy on a new device (nothing on this device) with no restore offer", () => {
    const r = resolveDraft({ local: null, server: copy("print(1)", T), starter: STARTER });
    expect(r).toMatchObject({ source: "print(1)", origin: "server", updatedAt: T, alternative: null, serverBehind: false });
  });

  it("wifi drop: 40 minutes on this device beat the 10-minute copy that reached the server", () => {
    const atMinute10 = copy("partial solution", T + min(10));
    const atMinute40 = copy("partial solution\n+ 30 more minutes of work", T + min(40));
    const r = resolveDraft({ local: atMinute40, server: atMinute10, starter: STARTER });
    expect(r.source).toBe(atMinute40.source);
    expect(r.origin).toBe("local");
    expect(r.serverBehind).toBe(true);
    // The older server copy is still offered, never silently thrown away.
    expect(r.alternative).toEqual({ origin: "server", source: atMinute10.source, updatedAt: atMinute10.updatedAt });
  });

  it("another device: a newer server copy wins and this device's version is offered back", () => {
    const here = copy("version on the lab PC", T);
    const there = copy("version from the laptop", T + min(90));
    const r = resolveDraft({ local: here, server: there, starter: STARTER });
    expect(r.source).toBe(there.source);
    expect(r.origin).toBe("server");
    expect(r.serverBehind).toBe(false);
    expect(r.alternative).toEqual({ origin: "local", source: here.source, updatedAt: T });
  });

  it("identical code on both sides is no conflict, and keeps the later edit time", () => {
    const r1 = resolveDraft({ local: copy("same", T + 5), server: copy("same", T), starter: STARTER });
    expect(r1).toMatchObject({ source: "same", origin: "local", updatedAt: T + 5, alternative: null, serverBehind: false });
    const r2 = resolveDraft({ local: copy("same", T), server: copy("same", T + 5), starter: STARTER });
    expect(r2).toMatchObject({ source: "same", origin: "server", updatedAt: T + 5, alternative: null, serverBehind: false });
  });

  it("an exact timestamp tie with different code keeps this device's copy and offers the other", () => {
    const r = resolveDraft({ local: copy("mine", T), server: copy("theirs", T), starter: STARTER });
    expect(r.source).toBe("mine");
    expect(r.origin).toBe("local");
    expect(r.alternative?.source).toBe("theirs");
  });

  it("a newer reset to the starter code still wins, and the real code is offered back", () => {
    const r = resolveDraft({ local: copy(STARTER, T + min(5)), server: copy("real work", T), starter: STARTER });
    expect(r.source).toBe(STARTER);
    expect(r.alternative).toEqual({ origin: "server", source: "real work", updatedAt: T });
  });

  it("a newer empty editor wins, and the previous code is offered back", () => {
    const r = resolveDraft({ local: copy("", T + 1), server: copy("real work", T), starter: STARTER });
    expect(r.source).toBe("");
    expect(r.alternative?.source).toBe("real work");
  });

  it("does not offer a losing copy that is blank or the untouched starter", () => {
    const blankLoser = resolveDraft({ local: copy("   \n", T), server: copy("real", T + 1), starter: STARTER });
    expect(blankLoser.source).toBe("real");
    expect(blankLoser.alternative).toBeNull();
    const starterLoser = resolveDraft({ local: copy(STARTER, T), server: copy("real", T + 1), starter: STARTER });
    expect(starterLoser.alternative).toBeNull();
  });

  it("a whitespace-only difference is still a difference (Python indentation matters)", () => {
    const r = resolveDraft({
      local: copy("if x:\n    y()\n", T),
      server: copy("if x:\n  y()\n", T + 1),
      starter: STARTER,
    });
    expect(r.source).toBe("if x:\n  y()\n");
    expect(r.alternative?.source).toBe("if x:\n    y()\n");
  });
});

describe("resolveDraft — corrupt or odd local copies", () => {
  it("ignores a corrupt local record and opens the server copy, reporting it", () => {
    const r = resolveDraft({ local: "corrupt", server: copy("server code", T), starter: STARTER });
    expect(r).toMatchObject({ source: "server code", origin: "server", localCorrupt: true, alternative: null });
  });

  it("falls back to the starter code when the only local record is corrupt", () => {
    const r = resolveDraft({ local: "corrupt", server: null, starter: STARTER });
    expect(r).toMatchObject({ source: STARTER, origin: "starter", localCorrupt: true, serverBehind: false });
  });

  it("treats a missing or broken edit time as the oldest possible", () => {
    const legacy = copy("phase 1 draft", 0);
    expect(resolveDraft({ local: legacy, server: copy("newer", T), starter: STARTER }).source).toBe("newer");
    const nan = { source: "nan", updatedAt: Number.NaN };
    expect(resolveDraft({ local: nan, server: copy("newer", T), starter: STARTER }).source).toBe("newer");
    const negative = { source: "negative", updatedAt: -5 };
    expect(resolveDraft({ local: copy("x", 1), server: negative, starter: STARTER }).source).toBe("x");
  });

  it("a legacy (untimed) local draft alone is still opened rather than lost", () => {
    const r = resolveDraft({ local: copy("phase 1 draft", 0), server: null, starter: STARTER });
    expect(r).toMatchObject({ source: "phase 1 draft", origin: "local", updatedAt: 0, serverBehind: true });
  });
});

describe("readDraftRecord", () => {
  it("reads a well-formed record", () => {
    expect(readDraftRecord({ source: "code", updatedAt: T })).toEqual({ source: "code", updatedAt: T });
    expect(readDraftRecord({ source: "", updatedAt: 0 })).toEqual({ source: "", updatedAt: 0 });
    expect(readDraftRecord({ source: "a", updatedAt: T + 0.7, extra: true })).toEqual({ source: "a", updatedAt: T });
  });

  it("reports nothing stored for undefined / null", () => {
    expect(readDraftRecord(undefined)).toBeNull();
    expect(readDraftRecord(null)).toBeNull();
  });

  it("reports anything else as corrupt — never throws", () => {
    const bad: unknown[] = [
      "a string",
      42,
      true,
      [],
      ["code", T],
      {},
      { source: 5, updatedAt: T },
      { source: "x" },
      { source: "x", updatedAt: "yesterday" },
      { source: "x", updatedAt: Number.NaN },
      { source: "x", updatedAt: Number.POSITIVE_INFINITY },
      { source: "x", updatedAt: -1 },
      { source: "x".repeat(512 * 1024 + 1), updatedAt: T },
    ];
    for (const value of bad) expect(readDraftRecord(value)).toBe("corrupt");
  });
});

describe("helpers", () => {
  it("normalizeTime", () => {
    expect(normalizeTime(T)).toBe(T);
    expect(normalizeTime(T + 0.9)).toBe(T);
    for (const v of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, "1", null, undefined]) expect(normalizeTime(v)).toBe(0);
  });

  it("isWorthOffering", () => {
    expect(isWorthOffering("code", STARTER)).toBe(true);
    expect(isWorthOffering(STARTER, STARTER)).toBe(false);
    expect(isWorthOffering("", STARTER)).toBe(false);
    expect(isWorthOffering(" \n\t", STARTER)).toBe(false);
  });
});

describe("pickInitialLanguage", () => {
  const available = ["c17", "cpp20", "py312"] as const;

  it("prefers the remembered language when the problem offers it", () => {
    expect(pickInitialLanguage({ preferred: "py312", available, serverDrafts: [{ language: "cpp20", updatedAt: T }] })).toBe(
      "py312",
    );
  });

  it("ignores a remembered language the problem does not offer, using the newest draft's", () => {
    const serverDrafts = [
      { language: "c17", updatedAt: T },
      { language: "cpp20", updatedAt: T + 10 },
      { language: "java21", updatedAt: T + 99 },
    ];
    expect(pickInitialLanguage({ preferred: "kotlin", available, serverDrafts })).toBe("cpp20");
  });

  it("falls back to the first offered language", () => {
    expect(pickInitialLanguage({ preferred: null, available, serverDrafts: [] })).toBe("c17");
    expect(pickInitialLanguage({ preferred: "", available, serverDrafts: [] })).toBe("c17");
    expect(pickInitialLanguage({ preferred: undefined, available: [], serverDrafts: [] })).toBeNull();
  });
});
