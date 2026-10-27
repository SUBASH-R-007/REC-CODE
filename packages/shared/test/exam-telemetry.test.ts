import { describe, expect, it } from "vitest";
import { suggestedExemptSignals } from "../src/accommodation";
import { PROCTOR_EVENT_KINDS } from "../src/proctor";
import {
  CADENCE_BURST_MIN_CHARS,
  CADENCE_BURST_WINDOW_MS,
  classifyInsertion,
  classifyPaste,
  CLIENT_EMITTED_KINDS,
  CLIENT_EVENT_KINDS,
  clientProctorEventSchema,
  EVENT_FLUSH_COUNT,
  EVENT_FLUSH_INTERVAL_MS,
  EVENT_PAYLOAD_MAX_BYTES,
  EVENT_PAYLOAD_TARGET_BYTES,
  FOCUS_LOSS_NOISE_MS,
  focusWarningOutcome,
  FULLSCREEN_REENTRY_GRACE_MS,
  IDLE_GAP_MS,
  isClientReportableKind,
  isExemptSignal,
  isIdleGap,
  isNoiseFocusLoss,
  MAX_RAW_EVENTS_PER_ATTEMPT,
  MAX_SNAPSHOTS_PER_ATTEMPT,
  overlayBody,
  proctorEventBatchSchema,
  PROGRAMMATIC_INSERT_MIN_CHARS,
  RESERVED_EVENT_KINDS,
  SERVER_DERIVED_KINDS,
  SERVER_ONLY_EVENT_KINDS,
  shouldFlush,
  SNAPSHOT_INTERVAL_MS,
} from "../src/exam-telemetry";

const SHA = "a".repeat(64);

describe("thresholds match the spec", () => {
  it("drops focus losses under 1500ms, records 80-char programmatic inserts, idles at 120s", () => {
    expect(FOCUS_LOSS_NOISE_MS).toBe(1_500);
    expect(FULLSCREEN_REENTRY_GRACE_MS).toBe(10_000);
    expect(PROGRAMMATIC_INSERT_MIN_CHARS).toBe(80);
    expect(CADENCE_BURST_MIN_CHARS).toBe(80);
    expect(CADENCE_BURST_WINDOW_MS).toBe(200);
    expect(IDLE_GAP_MS).toBe(120_000);
  });

  it("caps raw rows at 2,000 per attempt and snapshots at 200", () => {
    expect(MAX_RAW_EVENTS_PER_ATTEMPT).toBe(2_000);
    expect(MAX_SNAPSHOTS_PER_ATTEMPT).toBe(200);
    expect(SNAPSHOT_INTERVAL_MS).toBe(30_000);
  });

  it("flushes on a 5s tick or 25 events, with a 32 KB target and a 64 KB ceiling", () => {
    expect(EVENT_FLUSH_INTERVAL_MS).toBe(5_000);
    expect(EVENT_FLUSH_COUNT).toBe(25);
    expect(EVENT_PAYLOAD_TARGET_BYTES).toBe(32 * 1024);
    expect(EVENT_PAYLOAD_MAX_BYTES).toBe(64 * 1024);
    expect(EVENT_PAYLOAD_TARGET_BYTES).toBeLessThan(EVENT_PAYLOAD_MAX_BYTES);
  });
});

describe("classifyPaste", () => {
  const internal = new Set([SHA]);

  it("is INTERNAL when the text was copied inside the exam", () => {
    expect(classifyPaste({ hash: SHA, internalHashes: internal })).toBe("INTERNAL_PASTE");
  });

  it("is EXTERNAL when it was not", () => {
    expect(classifyPaste({ hash: "b".repeat(64), internalHashes: internal })).toBe("EXTERNAL_PASTE");
  });

  it("is EXTERNAL on the first paste of an attempt, when nothing has been copied yet", () => {
    expect(classifyPaste({ hash: SHA, internalHashes: new Set() })).toBe("EXTERNAL_PASTE");
  });
});

describe("isNoiseFocusLoss", () => {
  it("drops a flicker", () => {
    expect(isNoiseFocusLoss(200)).toBe(true);
    expect(isNoiseFocusLoss(1_499)).toBe(true);
  });

  it("keeps anything at or past the threshold", () => {
    expect(isNoiseFocusLoss(1_500)).toBe(false);
    expect(isNoiseFocusLoss(30_000)).toBe(false);
  });

  it("treats a missing duration as noise rather than inventing a signal", () => {
    expect(isNoiseFocusLoss(Number.NaN)).toBe(true);
  });
});

describe("classifyInsertion", () => {
  it("says nothing about ordinary typing", () => {
    expect(classifyInsertion({ chars: 1, origin: "input.type" })).toBeNull();
    expect(classifyInsertion({ chars: 400, origin: "input.type" })).toBeNull();
  });

  it("records a large unannotated insertion as PROGRAMMATIC_INSERT", () => {
    // What an extension typing the clipboard looks like.
    expect(classifyInsertion({ chars: 80, origin: null })).toBe("PROGRAMMATIC_INSERT");
    expect(classifyInsertion({ chars: 500, origin: "programmatic" })).toBe("PROGRAMMATIC_INSERT");
  });

  it("ignores a small unannotated insertion", () => {
    // An editor auto-closing a bracket, a snippet, a format-on-save.
    expect(classifyInsertion({ chars: 79, origin: null })).toBeNull();
    expect(classifyInsertion({ chars: 2, origin: "programmatic" })).toBeNull();
  });

  it("leaves a paste alone — a paste is classified by its hash, not its size", () => {
    expect(classifyInsertion({ chars: 5_000, origin: "input.paste" })).toBeNull();
  });

  it("records a typed burst too fast for a person as CADENCE_BURST", () => {
    expect(classifyInsertion({ chars: 80, origin: "input.type", windowMs: 200 })).toBe("CADENCE_BURST");
    expect(classifyInsertion({ chars: 300, origin: "input.type", windowMs: 50 })).toBe("CADENCE_BURST");
  });

  it("does not call fast human typing a burst", () => {
    expect(classifyInsertion({ chars: 79, origin: "input.type", windowMs: 200 })).toBeNull();
    expect(classifyInsertion({ chars: 80, origin: "input.type", windowMs: 201 })).toBeNull();
  });

  it("needs a window before it will call anything a burst", () => {
    expect(classifyInsertion({ chars: 500, origin: "input.type" })).toBeNull();
  });

  it("treats a non-finite character count as zero rather than as a signal", () => {
    expect(classifyInsertion({ chars: Number.NaN, origin: null })).toBeNull();
  });
});

describe("isIdleGap", () => {
  it("fires at two minutes", () => {
    expect(isIdleGap(120_000)).toBe(true);
    expect(isIdleGap(119_999)).toBe(false);
  });
});

describe("isExemptSignal", () => {
  const screenReader = suggestedExemptSignals(["SCREEN_READER"]);

  it("exempts focus loss and fullscreen exit for a screen-reader candidate", () => {
    // SPEC §7: assistive technology legitimately moves focus and leaves
    // fullscreen, so these must not count against them.
    expect(isExemptSignal("FOCUS_LOSS", screenReader)).toBe(true);
    expect(isExemptSignal("FULLSCREEN_EXIT", screenReader)).toBe(true);
  });

  it("does not exempt anything else for them", () => {
    expect(isExemptSignal("EXTERNAL_PASTE", screenReader)).toBe(false);
    expect(isExemptSignal("PROGRAMMATIC_INSERT", screenReader)).toBe(false);
  });

  it("exempts nothing when there is no accommodation", () => {
    for (const kind of PROCTOR_EVENT_KINDS) expect(isExemptSignal(kind, [])).toBe(false);
  });

  it("exempts typing bursts and inserted text for a speech-input candidate", () => {
    const speech = suggestedExemptSignals(["SPEECH_INPUT"]);
    expect(isExemptSignal("CADENCE_BURST", speech)).toBe(true);
    expect(isExemptSignal("PROGRAMMATIC_INSERT", speech)).toBe(true);
  });
});

describe("focusWarningOutcome", () => {
  const base = { maxWarnings: 3, onLimit: "AUTOSUBMIT" as const, exempt: false };

  it("warns below the limit", () => {
    expect(focusWarningOutcome({ ...base, previousWarnings: 0 })).toEqual({
      warningNumber: 1,
      atLimit: false,
      action: "WARN",
    });
    expect(focusWarningOutcome({ ...base, previousWarnings: 1 })).toEqual({
      warningNumber: 2,
      atLimit: false,
      action: "WARN",
    });
  });

  it("auto-submits at the limit when that is the policy", () => {
    expect(focusWarningOutcome({ ...base, previousWarnings: 2 })).toEqual({
      warningNumber: 3,
      atLimit: true,
      action: "AUTOSUBMIT",
    });
  });

  it("only flags at the limit when that is the policy", () => {
    expect(focusWarningOutcome({ ...base, previousWarnings: 2, onLimit: "FLAG_ONLY" })).toEqual({
      warningNumber: 3,
      atLimit: true,
      action: "FLAG_ONLY",
    });
  });

  it("never voids, scores or disables anything", () => {
    const actions = new Set<string>();
    for (const onLimit of ["AUTOSUBMIT", "FLAG_ONLY"] as const) {
      for (let previous = 0; previous < 10; previous++) {
        for (const exempt of [false, true]) {
          actions.add(focusWarningOutcome({ maxWarnings: 3, onLimit, previousWarnings: previous, exempt }).action);
        }
      }
    }
    expect([...actions].sort()).toEqual(["AUTOSUBMIT", "FLAG_ONLY", "NONE", "WARN"]);
  });

  it("does not count an exempt signal towards the limit at all", () => {
    // Counting it and then declining to act would still end the sitting at
    // warning three, which is the bug this guards.
    for (let previous = 0; previous < 10; previous++) {
      expect(focusWarningOutcome({ ...base, previousWarnings: previous, exempt: true })).toEqual({
        warningNumber: 0,
        atLimit: false,
        action: "NONE",
      });
    }
  });

  it("stays at the limit past it, rather than wrapping back to a warning", () => {
    expect(focusWarningOutcome({ ...base, previousWarnings: 7 }).action).toBe("AUTOSUBMIT");
  });

  it("treats a nonsense limit as at least one", () => {
    expect(focusWarningOutcome({ ...base, maxWarnings: 0, previousWarnings: 0 }).atLimit).toBe(true);
  });
});

describe("overlayBody", () => {
  it("says the timer is still running, which is the thing a candidate most needs to know", () => {
    expect(overlayBody({ warningNumber: 2, maxWarnings: 3, onLimit: "AUTOSUBMIT" })).toContain(
      "Your timer is still running.",
    );
  });

  it("states the consequence plainly under AUTOSUBMIT", () => {
    expect(overlayBody({ warningNumber: 2, maxWarnings: 3, onLimit: "AUTOSUBMIT" })).toBe(
      "Return to full screen to continue. Your timer is still running. This is warning 2 of 3 — at 3 warnings your test is submitted automatically.",
    );
  });

  it("does not promise an automatic submission that will not happen", () => {
    const body = overlayBody({ warningNumber: 2, maxWarnings: 3, onLimit: "FLAG_ONLY" });
    expect(body).not.toContain("submitted automatically");
    expect(body).toContain("recorded for a human to review");
  });

  it("accuses nobody", () => {
    for (const onLimit of ["AUTOSUBMIT", "FLAG_ONLY"] as const) {
      const body = overlayBody({ warningNumber: 3, maxWarnings: 3, onLimit }).toLowerCase();
      expect(body).not.toMatch(/cheat|malpractice|caught|dishonest|violation/);
    }
  });
});

describe("shouldFlush", () => {
  it("sends nothing when there is nothing", () => {
    expect(shouldFlush({ pending: 0, msSinceLastFlush: 60_000, pageHiding: true })).toBe(false);
  });

  it("waits below both thresholds", () => {
    expect(shouldFlush({ pending: 24, msSinceLastFlush: 4_999, pageHiding: false })).toBe(false);
  });

  it("sends on the 25th event", () => {
    expect(shouldFlush({ pending: 25, msSinceLastFlush: 0, pageHiding: false })).toBe(true);
  });

  it("sends on the 5-second tick", () => {
    expect(shouldFlush({ pending: 1, msSinceLastFlush: 5_000, pageHiding: false })).toBe(true);
  });

  it("always sends when the page is going away", () => {
    // The one moment the usual cadence would lose events entirely.
    expect(shouldFlush({ pending: 1, msSinceLastFlush: 0, pageHiding: true })).toBe(true);
  });
});

describe("the wire shape carries no content", () => {
  const ok = { kind: "EXTERNAL_PASTE" as const, clientSeq: 3, atMs: 1_000, size: 120, hash: SHA };

  it("accepts an event of pure shape", () => {
    expect(clientProctorEventSchema.parse(ok)).toEqual(ok);
  });

  it("refuses a field that could carry text", () => {
    for (const extra of [{ text: "secret" }, { content: "x" }, { clipboard: "x" }, { value: "x" }]) {
      expect(() => clientProctorEventSchema.parse({ ...ok, ...extra })).toThrow();
    }
  });

  it("refuses a hash that is not a sha256, so text cannot be smuggled through it", () => {
    expect(() => clientProctorEventSchema.parse({ ...ok, hash: "the pasted text" })).toThrow();
    expect(() => clientProctorEventSchema.parse({ ...ok, hash: SHA.toUpperCase() })).toThrow();
    expect(() => clientProctorEventSchema.parse({ ...ok, hash: `${SHA}a` })).toThrow();
  });

  it("refuses a size past the payload ceiling", () => {
    expect(() => clientProctorEventSchema.parse({ ...ok, size: EVENT_PAYLOAD_MAX_BYTES + 1 })).toThrow();
  });

  it("refuses a negative offset or duration", () => {
    expect(() => clientProctorEventSchema.parse({ ...ok, atMs: -1 })).toThrow();
    expect(() => clientProctorEventSchema.parse({ ...ok, durationMs: -1 })).toThrow();
  });

  it("accepts a batch and rejects an empty one", () => {
    expect(proctorEventBatchSchema.parse({ events: [ok] }).events).toHaveLength(1);
    expect(() => proctorEventBatchSchema.parse({ events: [] })).toThrow();
  });

  it("bounds a batch, so one request cannot carry an attempt's whole budget", () => {
    const many = Array.from({ length: EVENT_FLUSH_COUNT * 4 + 1 }, (_, i) => ({ ...ok, clientSeq: i }));
    expect(() => proctorEventBatchSchema.parse({ events: many })).toThrow();
  });
});

describe("client-reportable kinds", () => {
  it("excludes every kind the server derives from its own facts", () => {
    for (const kind of SERVER_ONLY_EVENT_KINDS) {
      expect(isClientReportableKind(kind)).toBe(false);
      expect(CLIENT_EVENT_KINDS).not.toContain(kind);
    }
  });

  it("includes the kinds a browser can actually observe", () => {
    for (const kind of ["FOCUS_LOSS", "FULLSCREEN_EXIT", "EXTERNAL_PASTE", "COPY", "CONTEXT_MENU"] as const) {
      expect(isClientReportableKind(kind)).toBe(true);
    }
  });

  it("partitions the 25 kinds exactly, with nothing lost or double-counted", () => {
    expect(CLIENT_EVENT_KINDS.length + SERVER_ONLY_EVENT_KINDS.length).toBe(PROCTOR_EVENT_KINDS.length);
    expect([...CLIENT_EVENT_KINDS, ...SERVER_ONLY_EVENT_KINDS].sort()).toEqual([...PROCTOR_EVENT_KINDS].sort());
  });
});

describe("what the engine produces is written down (Phase 11b)", () => {
  /**
   * The audit that produced these lists found seven of twenty-five declared
   * kinds emitted by nothing, with nothing to say so — and a signal a
   * reviewer believes exists and does not is worse than one that was never
   * offered, because its absence reads as evidence.
   *
   * These assertions are what stops that returning: a kind added to the
   * vocabulary now fails here until somebody answers "who emits this?".
   */
  it("partitions the vocabulary: client, server, or reserved with a reason", () => {
    const client = new Set(CLIENT_EMITTED_KINDS);
    const server = new Set(SERVER_DERIVED_KINDS);
    const reserved = new Set(Object.keys(RESERVED_EVENT_KINDS));

    for (const kind of PROCTOR_EVENT_KINDS) {
      const buckets = [client.has(kind), server.has(kind), reserved.has(kind)].filter(Boolean).length;
      expect(buckets, `${kind} is in ${buckets} buckets; it must be in exactly one`).toBe(1);
    }
    expect(client.size + server.size + reserved.size).toBe(PROCTOR_EVENT_KINDS.length);
  });

  it("gives every reserved kind a reason worth reading", () => {
    for (const [kind, reason] of Object.entries(RESERVED_EVENT_KINDS)) {
      expect(PROCTOR_EVENT_KINDS as readonly string[]).toContain(kind);
      expect(reason!.length, `${kind}'s reason is too short to be one`).toBeGreaterThan(60);
    }
  });

  it("keeps the client out of the server's business", () => {
    // A client claiming HEARTBEAT_GAP is broken or lying; either way the
    // server knows that one from its own facts.
    for (const kind of SERVER_DERIVED_KINDS) {
      expect(isClientReportableKind(kind), `${kind} must not be client-reportable`).toBe(false);
    }
    for (const kind of CLIENT_EMITTED_KINDS) {
      expect(isClientReportableKind(kind), `${kind} is emitted by the client and must be reportable`).toBe(true);
    }
  });

  it("does not emit what it reserves", () => {
    for (const kind of Object.keys(RESERVED_EVENT_KINDS)) {
      expect(CLIENT_EMITTED_KINDS as readonly string[]).not.toContain(kind);
      expect(SERVER_DERIVED_KINDS as readonly string[]).not.toContain(kind);
    }
  });
});
