import { describe, expect, it } from "vitest";
import {
  BAND_FLOOR,
  BAND_REVIEWERS,
  CONTEXT_ONLY_KINDS,
  LOW_BAND_SAMPLE_RATE,
  REVIEW_SLA_HOURS,
  TRIAGE_BANDS,
  bandFor,
  inLowBandSample,
  isContextOnly,
  reviewDeadline,
  reviewOverdue,
  triage,
  withholdsFromLeaderboard,
  type TriageInput,
} from "../src/triage";

const none: TriageInput = {
  bigExternalPastes: 0,
  mediumExternalPastes: 0,
  programmaticInserts: 0,
  focusLossesOver5s: 0,
  anyFocusLossOver120s: false,
  fullscreenExitsAfterFirst: 0,
  snapshotJumps: 0,
  peerContainmentHigh: false,
  corpusContainmentHigh: false,
  devtoolsHeuristics: 0,
  multiMonitor: 0,
  automationHints: 0,
};

const input = (over: Partial<TriageInput> = {}): TriageInput => ({ ...none, ...over });

describe("the bands are the spec's", () => {
  it("has the four bands at the stated boundaries", () => {
    expect(TRIAGE_BANDS).toEqual(["NONE", "LOW", "MEDIUM", "HIGH"]);
    expect(BAND_FLOOR).toEqual({ NONE: 0, LOW: 15, MEDIUM: 35, HIGH: 70 });
  });

  it("bands each boundary exactly", () => {
    expect(bandFor(0)).toBe("NONE");
    expect(bandFor(14)).toBe("NONE");
    expect(bandFor(15)).toBe("LOW");
    expect(bandFor(34)).toBe("LOW");
    expect(bandFor(35)).toBe("MEDIUM");
    expect(bandFor(69)).toBe("MEDIUM");
    expect(bandFor(70)).toBe("HIGH");
    expect(bandFor(999)).toBe("HIGH");
  });

  it("needs one reviewer at MEDIUM and two at HIGH", () => {
    expect(BAND_REVIEWERS).toEqual({ NONE: 0, LOW: 0, MEDIUM: 1, HIGH: 2 });
  });

  it("samples a tenth of the LOW band, and gives it a 72-hour SLA", () => {
    expect(LOW_BAND_SAMPLE_RATE).toBe(0.1);
    expect(REVIEW_SLA_HOURS).toBe(72);
  });
});

describe("the points are the spec's", () => {
  it("scores a big external paste at 25, capped at 75", () => {
    expect(triage(input({ bigExternalPastes: 1 })).substantivePoints).toBe(25);
    expect(triage(input({ bigExternalPastes: 3 })).substantivePoints).toBe(75);
    expect(triage(input({ bigExternalPastes: 50 })).substantivePoints).toBe(75);
  });

  it("scores a medium external paste at 8, capped at 32", () => {
    expect(triage(input({ mediumExternalPastes: 1 })).substantivePoints).toBe(8);
    expect(triage(input({ mediumExternalPastes: 4 })).substantivePoints).toBe(32);
    expect(triage(input({ mediumExternalPastes: 99 })).substantivePoints).toBe(32);
  });

  it("scores a programmatic insert at 20, capped at 60", () => {
    expect(triage(input({ programmaticInserts: 1 })).substantivePoints).toBe(20);
    expect(triage(input({ programmaticInserts: 9 })).substantivePoints).toBe(60);
  });

  it("scores a focus loss at 4, capped at 32 — so a flaky connection cannot out-score a paste", () => {
    expect(triage(input({ focusLossesOver5s: 1 })).substantivePoints).toBe(4);
    expect(triage(input({ focusLossesOver5s: 8 })).substantivePoints).toBe(32);
    // A candidate on a bad hostel connection, against one wholesale paste.
    expect(triage(input({ focusLossesOver5s: 200 })).substantivePoints).toBeLessThan(
      triage(input({ bigExternalPastes: 2 })).substantivePoints,
    );
  });

  it("adds 15 for a single focus loss over two minutes", () => {
    expect(triage(input({ anyFocusLossOver120s: true })).substantivePoints).toBe(15);
  });

  it("scores a fullscreen exit after the first at 6, capped at 18", () => {
    expect(triage(input({ fullscreenExitsAfterFirst: 1 })).substantivePoints).toBe(6);
    expect(triage(input({ fullscreenExitsAfterFirst: 5 })).substantivePoints).toBe(18);
  });

  it("scores a snapshot jump at 30, and does not multiply it", () => {
    expect(triage(input({ snapshotJumps: 1 })).substantivePoints).toBe(30);
    expect(triage(input({ snapshotJumps: 4 })).substantivePoints).toBe(30);
  });

  it("scores peer similarity at 40 and corpus similarity at 30", () => {
    expect(triage(input({ peerContainmentHigh: true })).substantivePoints).toBe(40);
    expect(triage(input({ corpusContainmentHigh: true })).substantivePoints).toBe(30);
  });

  it("scores nothing for an attempt with nothing on it", () => {
    const result = triage(none);
    expect(result).toMatchObject({ substantivePoints: 0, contextPoints: 0, band: "NONE", reviewersRequired: 0 });
    expect(result.contributions).toEqual([]);
  });
});

describe("context-only signals cannot lift an attempt above NONE", () => {
  it("names the three the spec names, and the two Phase 11b added", () => {
    /**
     * The spec's three are the ones the banding arithmetic has to exclude
     * (they have points and must not reach a band). Phase 11b added two
     * that score nothing at all and are listed anyway, so that the
     * classification is a decision in one place rather than a consequence
     * of `triage()` not happening to read them: an invigilator's note and a
     * submission-rate anomaly are a reviewer's context, and if either ever
     * acquires points it must still be unable to accuse anybody.
     */
    expect([...CONTEXT_ONLY_KINDS].sort()).toEqual([
      "AUTOMATION_HINT",
      "DEVTOOLS_HEURISTIC",
      "INVIGILATOR_NOTE",
      "MULTI_MONITOR",
      "SUBMISSION_RATE_ANOMALY",
    ]);
    for (const kind of CONTEXT_ONLY_KINDS) expect(isContextOnly(kind)).toBe(true);
    expect(isContextOnly("EXTERNAL_PASTE")).toBe(false);
  });

  it("bands all three together as NONE, even though they total 18", () => {
    // 5 + 3 + 10 = 18, which WOULD be LOW if they were simply added up. This
    // is the test the implementation is shaped around.
    const result = triage(input({ devtoolsHeuristics: 1, multiMonitor: 1, automationHints: 1 }));
    expect(result.contextPoints).toBe(18);
    expect(result.substantivePoints).toBe(0);
    expect(result.band).toBe("NONE");
    expect(result.reviewersRequired).toBe(0);
  });

  it("bands them as NONE however many there are", () => {
    const result = triage(input({ devtoolsHeuristics: 99, multiMonitor: 99, automationHints: 99 }));
    expect(result.band).toBe("NONE");
  });

  it("still counts them for queue order and for a reviewer's context", () => {
    const quiet = triage(input({ focusLossesOver5s: 4 }));
    const noisy = triage(input({ focusLossesOver5s: 4, automationHints: 1 }));
    expect(noisy.band).toBe(quiet.band);
    expect(noisy.queuePoints).toBeGreaterThan(quiet.queuePoints);
  });

  it("never lets context points change a band, over every substantive total", () => {
    for (let focus = 0; focus <= 8; focus++) {
      for (let jumps = 0; jumps <= 1; jumps++) {
        const bare = triage(input({ focusLossesOver5s: focus, snapshotJumps: jumps }));
        const withContext = triage(
          input({ focusLossesOver5s: focus, snapshotJumps: jumps, devtoolsHeuristics: 1, multiMonitor: 1, automationHints: 1 }),
        );
        expect(withContext.band, `focus=${focus} jumps=${jumps}`).toBe(bare.band);
      }
    }
  });
});

describe("accommodations zero a signal rather than reducing it", () => {
  it("scores an exempt signal at zero", () => {
    // A reduced score would still order this candidate ahead of someone with
    // no signals at all, which is exactly what the exemption denies.
    const result = triage(input({ focusLossesOver5s: 8, exemptSignals: ["FOCUS_LOSS"] }));
    expect(result.substantivePoints).toBe(0);
    expect(result.band).toBe("NONE");
  });

  it("still shows the exempt signal to a reviewer, marked", () => {
    const result = triage(input({ focusLossesOver5s: 8, exemptSignals: ["FOCUS_LOSS"] }));
    const focus = result.contributions.find((c) => c.kind === "FOCUS_LOSS");
    expect(focus).toBeDefined();
    expect(focus!.exempt).toBe(true);
    expect(focus!.points).toBe(0);
  });

  it("exempts only what is listed", () => {
    const result = triage(
      input({ focusLossesOver5s: 8, bigExternalPastes: 1, exemptSignals: ["FOCUS_LOSS"] }),
    );
    expect(result.substantivePoints).toBe(25);
  });

  it("zeroes a screen-reader candidate's focus and fullscreen signals together", () => {
    const result = triage(
      input({
        focusLossesOver5s: 20,
        anyFocusLossOver120s: true,
        fullscreenExitsAfterFirst: 5,
        exemptSignals: ["FOCUS_LOSS", "FULLSCREEN_EXIT"],
      }),
    );
    expect(result.substantivePoints).toBe(0);
    expect(result.band).toBe("NONE");
  });

  it("zeroes a speech-input candidate's inserted text", () => {
    const result = triage(input({ programmaticInserts: 3, exemptSignals: ["PROGRAMMATIC_INSERT"] }));
    expect(result.substantivePoints).toBe(0);
  });
});

describe("realistic attempts", () => {
  it("bands an honest student with a bad laptop as NONE", () => {
    // Six focus losses from OS notifications, a second monitor at home.
    const result = triage(input({ focusLossesOver5s: 3, multiMonitor: 1 }));
    expect(result.band).toBe("NONE");
  });

  it("bands a student who alt-tabbed a few times as LOW", () => {
    const result = triage(input({ focusLossesOver5s: 5, fullscreenExitsAfterFirst: 1 }));
    expect(result.substantivePoints).toBe(26);
    expect(result.band).toBe("LOW");
  });

  it("bands one wholesale paste as MEDIUM", () => {
    const result = triage(input({ bigExternalPastes: 1, focusLossesOver5s: 3 }));
    expect(result.substantivePoints).toBe(37);
    expect(result.band).toBe("MEDIUM");
    expect(result.reviewersRequired).toBe(1);
  });

  it("bands suppressed telemetry plus high similarity as HIGH, needing two reviewers", () => {
    const result = triage(input({ snapshotJumps: 1, peerContainmentHigh: true }));
    expect(result.substantivePoints).toBe(70);
    expect(result.band).toBe("HIGH");
    expect(result.reviewersRequired).toBe(2);
  });
});

describe("withholdsFromLeaderboard", () => {
  it("withholds nothing at NONE", () => {
    expect(withholdsFromLeaderboard("NONE")).toBe(false);
  });

  it("withholds at every other band — the maximum automatic consequence", () => {
    for (const band of ["LOW", "MEDIUM", "HIGH"] as const) {
      expect(withholdsFromLeaderboard(band)).toBe(true);
    }
  });
});

describe("the 72-hour SLA", () => {
  const flaggedAt = new Date("2026-10-19T10:00:00Z");

  it("falls 72 hours after the flag", () => {
    expect(reviewDeadline(flaggedAt).toISOString()).toBe("2026-10-22T10:00:00.000Z");
  });

  it("is not overdue before the deadline, and is at it", () => {
    expect(reviewOverdue(flaggedAt, new Date("2026-10-22T09:59:59Z"))).toBe(false);
    expect(reviewOverdue(flaggedAt, new Date("2026-10-22T10:00:00Z"))).toBe(true);
  });

  it("puts the cost of a slow review on the institution, not the student", () => {
    // The point of the rule: at the deadline the result publishes as CLEARED
    // whatever the reviewers did, so nobody's placement waits on a queue.
    expect(reviewOverdue(flaggedAt, new Date("2026-11-01T00:00:00Z"))).toBe(true);
  });
});

describe("inLowBandSample", () => {
  it("is deterministic for an attempt", () => {
    // A reviewer who reloads the queue must not see an attempt appear and
    // disappear, and an appeal has to establish whether it was sampled.
    for (const id of ["att_1", "att_abcdef", "cmvex5rkn001rllpgbmpl7rwu"]) {
      expect(inLowBandSample(id)).toBe(inLowBandSample(id));
    }
  });

  it("samples roughly a tenth over many attempts", () => {
    const n = 20_000;
    let sampled = 0;
    for (let i = 0; i < n; i++) if (inLowBandSample(`cmv${i}xyz`)) sampled++;
    const rate = sampled / n;
    expect(rate).toBeGreaterThan(0.08);
    expect(rate).toBeLessThan(0.12);
  });

  it("samples everything at a rate of 1 and nothing at 0", () => {
    for (const id of ["a", "b", "c"]) {
      expect(inLowBandSample(id, 1)).toBe(true);
      expect(inLowBandSample(id, 0)).toBe(false);
    }
  });
});
