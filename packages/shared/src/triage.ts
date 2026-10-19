import type { ProctorEventKind } from "./proctor";

/**
 * Triage banding (Phase 6e). Pure: points in, a band out. No I/O, and
 * structurally no way to reach a score.
 *
 * SPEC §5 titles this section "Triage banding — structurally unable to touch
 * a score", and means it:
 *
 *   Severity points, used only to order the review queue [...]
 *
 *   Bands: 0–14 NONE (no review); 15–34 LOW (bulk-cleared with a mandatory
 *   10% random human sample); 35–69 MEDIUM (one reviewer); 70+ HIGH (two
 *   independent reviewers). DEVTOOLS_HEURISTIC, MULTI_MONITOR and
 *   AUTOMATION_HINT are context-only and must be structurally incapable of
 *   lifting an attempt above NONE on their own.
 *
 *   The maximum automatic consequence in the entire system is: flag for
 *   review and withhold the result from the public leaderboard, with a
 *   72-hour review SLA after which the result publishes automatically as
 *   CLEARED. [...] Scores are written by the judge; no code path from the
 *   banding engine reaches a score column.
 *
 *   Never display a band or an "integrity score" to students or recruiters —
 *   it invites exactly the misreading we are preventing, and penalises the
 *   honest student with the bad laptop while the competent cheater scores a
 *   clean 0.
 *
 * "Structurally incapable" is the part that shapes the code. The three
 * context-only kinds together score 5 + 3 + 10 = 18, which would be LOW — so
 * they cannot simply be added up. The band is computed from SUBSTANTIVE
 * points alone; context points only order the queue within a band and are
 * shown to a reviewer as context. There is then no arithmetic by which a
 * second monitor and an open devtools window put a candidate in front of a
 * reviewer.
 */

export const TRIAGE_BANDS = ["NONE", "LOW", "MEDIUM", "HIGH"] as const;
export type TriageBand = (typeof TRIAGE_BANDS)[number];

/** The band boundaries, from SPEC §5. Inclusive lower bounds. */
export const BAND_FLOOR: Readonly<Record<TriageBand, number>> = Object.freeze({
  NONE: 0,
  LOW: 15,
  MEDIUM: 35,
  HIGH: 70,
});

/** How many independent reviewers a band needs. */
export const BAND_REVIEWERS: Readonly<Record<TriageBand, number>> = Object.freeze({
  NONE: 0,
  LOW: 0, // Bulk-cleared, with a mandatory random sample (see SAMPLE_RATE).
  MEDIUM: 1,
  HIGH: 2,
});

/**
 * The share of LOW-band attempts a human must look at anyway.
 *
 * SPEC §5: "bulk-cleared with a mandatory 10% random human sample". The
 * sample is what stops LOW becoming a rubber stamp — without it, the band
 * that holds most flagged attempts would never be read by anybody, and the
 * thresholds that put attempts there would never be corrected.
 */
export const LOW_BAND_SAMPLE_RATE = 0.1;

/**
 * The review SLA. SPEC §5: "a 72-hour review SLA after which the result
 * publishes automatically as CLEARED. The 72-hour auto-publish puts the cost
 * of slow review on the institution, not on the student's placement
 * timeline."
 */
export const REVIEW_SLA_HOURS = 72;

/** The three kinds that are context only and can never raise a band. */
export const CONTEXT_ONLY_KINDS: readonly ProctorEventKind[] = Object.freeze([
  "DEVTOOLS_HEURISTIC",
  "MULTI_MONITOR",
  "AUTOMATION_HINT",
]);

export function isContextOnly(kind: ProctorEventKind): boolean {
  return CONTEXT_ONLY_KINDS.includes(kind);
}

/** What the banding engine is given. Counts and sizes — never content. */
export interface TriageInput {
  /** EXTERNAL_PASTE events of 200 characters or more. */
  readonly bigExternalPastes: number;
  /** EXTERNAL_PASTE events of 40–199 characters. */
  readonly mediumExternalPastes: number;
  /** PROGRAMMATIC_INSERT events of 80 characters or more. */
  readonly programmaticInserts: number;
  /** FOCUS_LOSS events longer than 5 seconds. */
  readonly focusLossesOver5s: number;
  /** True if any single FOCUS_LOSS exceeded 120 seconds. */
  readonly anyFocusLossOver120s: boolean;
  /** FULLSCREEN_EXIT events after the first warning. */
  readonly fullscreenExitsAfterFirst: number;
  /** Server-derived SNAPSHOT_JUMP events. */
  readonly snapshotJumps: number;
  /** True if peer containment reached 0.8 for this submission. */
  readonly peerContainmentHigh: boolean;
  /** True if corpus containment reached 0.75. */
  readonly corpusContainmentHigh: boolean;
  readonly devtoolsHeuristics: number;
  readonly multiMonitor: number;
  readonly automationHints: number;
  /**
   * Signals this candidate is exempt from (an accommodation). An exempt
   * signal scores ZERO — not a reduced amount — because the exemption says
   * the signal means nothing for this candidate, and a reduced score still
   * orders them ahead of someone with none.
   */
  readonly exemptSignals?: readonly ProctorEventKind[];
}

export interface TriageContribution {
  readonly kind: ProctorEventKind | "PEER_SIMILARITY" | "CORPUS_SIMILARITY";
  readonly points: number;
  /** Context-only: counted for ordering, never for the band. */
  readonly contextOnly: boolean;
  /** Zeroed by an accommodation. */
  readonly exempt: boolean;
  /** Human-readable, for the reviewer's own screen. */
  readonly note: string;
}

export interface TriageResult {
  /** Points that decide the band. */
  readonly substantivePoints: number;
  /** Context-only points: ordering and a reviewer's context, never the band. */
  readonly contextPoints: number;
  /** substantive + context, which is only ever used to ORDER a queue. */
  readonly queuePoints: number;
  readonly band: TriageBand;
  readonly reviewersRequired: number;
  readonly contributions: readonly TriageContribution[];
}

const cap = (each: number, count: number, ceiling: number) => Math.min(each * Math.max(0, count), ceiling);

/**
 * Score an attempt and band it.
 *
 * Every number here is the spec's, and every cap is the spec's: the caps are
 * what stop one noisy signal dominating. A candidate on a flaky hostel
 * connection can produce dozens of focus losses, and without the cap of 32
 * they would out-score a wholesale paste.
 */
export function triage(input: TriageInput): TriageResult {
  const exempt = new Set(input.exemptSignals ?? []);
  const contributions: TriageContribution[] = [];

  const add = (
    kind: TriageContribution["kind"],
    points: number,
    note: string,
    options: { contextOnly?: boolean; signal?: ProctorEventKind } = {},
  ) => {
    if (points <= 0) return;
    const isExempt = options.signal !== undefined && exempt.has(options.signal);
    contributions.push({
      kind,
      // Zero, not reduced: the exemption says this signal means nothing for
      // this candidate, and a reduced score still orders them ahead of
      // someone with none.
      points: isExempt ? 0 : points,
      contextOnly: options.contextOnly === true,
      exempt: isExempt,
      note,
    });
  };

  add("EXTERNAL_PASTE", cap(25, input.bigExternalPastes, 75), `${input.bigExternalPastes} paste(s) of 200+ characters from outside the exam`);
  add("EXTERNAL_PASTE", cap(8, input.mediumExternalPastes, 32), `${input.mediumExternalPastes} paste(s) of 40–199 characters from outside the exam`);
  add("PROGRAMMATIC_INSERT", cap(20, input.programmaticInserts, 60), `${input.programmaticInserts} insertion(s) of 80+ characters that were not typed`, { signal: "PROGRAMMATIC_INSERT" });
  add("FOCUS_LOSS", cap(4, input.focusLossesOver5s, 32), `${input.focusLossesOver5s} focus loss(es) over 5 seconds`, { signal: "FOCUS_LOSS" });
  add("FOCUS_LOSS", input.anyFocusLossOver120s ? 15 : 0, "a single focus loss over 2 minutes", { signal: "FOCUS_LOSS" });
  add("FULLSCREEN_EXIT", cap(6, input.fullscreenExitsAfterFirst, 18), `${input.fullscreenExitsAfterFirst} fullscreen exit(s) after the first warning`, { signal: "FULLSCREEN_EXIT" });
  add("SNAPSHOT_JUMP", cap(30, input.snapshotJumps, 30), "code appeared while the instrumentation was blind", { signal: "SNAPSHOT_JUMP" });
  add("PEER_SIMILARITY", input.peerContainmentHigh ? 40 : 0, "high similarity to another candidate's submission");
  add("CORPUS_SIMILARITY", input.corpusContainmentHigh ? 30 : 0, "high similarity to a published solution");

  // Context only. Each is weighted near zero by the spec, and none of them
  // can raise a band however many there are.
  add("DEVTOOLS_HEURISTIC", cap(5, input.devtoolsHeuristics, 5), "developer tools may have been open", { contextOnly: true });
  add("MULTI_MONITOR", cap(3, input.multiMonitor, 3), "a second screen was attached", { contextOnly: true });
  add("AUTOMATION_HINT", cap(10, input.automationHints, 10), "the browser reported itself as automated", { contextOnly: true });

  let substantivePoints = 0;
  let contextPoints = 0;
  for (const contribution of contributions) {
    if (contribution.contextOnly) contextPoints += contribution.points;
    else substantivePoints += contribution.points;
  }

  // The band comes from SUBSTANTIVE points alone. This is the structural half
  // of "context-only signals must be incapable of lifting an attempt above
  // NONE on their own" — not a rule applied afterwards, but an input the
  // band computation never sees.
  const band = bandFor(substantivePoints);

  return {
    substantivePoints,
    contextPoints,
    queuePoints: substantivePoints + contextPoints,
    band,
    reviewersRequired: BAND_REVIEWERS[band],
    contributions,
  };
}

export function bandFor(substantivePoints: number): TriageBand {
  if (substantivePoints >= BAND_FLOOR.HIGH) return "HIGH";
  if (substantivePoints >= BAND_FLOOR.MEDIUM) return "MEDIUM";
  if (substantivePoints >= BAND_FLOOR.LOW) return "LOW";
  return "NONE";
}

/** Does this band mean a result is withheld from the public leaderboard? */
export function withholdsFromLeaderboard(band: TriageBand): boolean {
  // NONE is not a flag at all. Everything else is withheld until a human
  // says otherwise or the 72-hour SLA publishes it as CLEARED — which is the
  // MAXIMUM automatic consequence anywhere in this system (SPEC §0).
  return band !== "NONE";
}

/**
 * When a flag auto-publishes as CLEARED if nobody has reviewed it.
 *
 * SPEC §5: "The 72-hour auto-publish puts the cost of slow review on the
 * institution, not on the student's placement timeline." So this is not a
 * convenience — it is the mechanism that stops a slow review becoming a
 * student's problem.
 */
export function reviewDeadline(flaggedAt: Date): Date {
  return new Date(flaggedAt.getTime() + REVIEW_SLA_HOURS * 3_600_000);
}

export function reviewOverdue(flaggedAt: Date, now: Date): boolean {
  return now.getTime() >= reviewDeadline(flaggedAt).getTime();
}

/**
 * Is this LOW-band attempt in the mandatory human sample?
 *
 * Deterministic from the attempt's own id rather than random, so the same
 * attempt is always either in the sample or not: a reviewer who reloads the
 * queue must not see it appear and disappear, and an appeal has to be able
 * to establish whether this attempt was sampled.
 */
export function inLowBandSample(attemptId: string, rate = LOW_BAND_SAMPLE_RATE): boolean {
  let hash = 2_166_136_261;
  for (let i = 0; i < attemptId.length; i++) {
    hash ^= attemptId.charCodeAt(i);
    hash = Math.imul(hash, 16_777_619) >>> 0;
  }
  return hash / 4_294_967_296 < rate;
}
