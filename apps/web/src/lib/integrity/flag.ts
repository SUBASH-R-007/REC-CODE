import "server-only";
import {
  reviewDeadline,
  triage,
  withholdsFromLeaderboard,
  suggestedExemptSignals,
  type AccommodationKind,
  type TriageInput,
  type TriageResult,
} from "@recx/shared";
import { audit } from "@/lib/audit";
import { db } from "@/lib/db";

/**
 * Turning a finished sitting's events into a flag (Phase 6e).
 *
 * This module is the banding engine, and SPEC §5 is emphatic about what it
 * may not do:
 *
 *   Triage banding — structurally unable to touch a score [...] Scores are
 *   written by the judge; no code path from the banding engine reaches a
 *   score column. Add a unit test that fails if the integrity module imports
 *   or writes to anything in the scoring path.
 *
 * That test is `tests/repo/integrity-isolation.test.ts`. This module writes
 * `IntegrityFlag` and nothing else, and it reads `ProctorEvent`,
 * `AttemptSnapshot` counts and the attempt's own counters. It never touches
 * `Submission`, `SubmissionTest`, `totalScore`, `maxScore`, `XpEvent`,
 * `ContestStanding` or `UserProblemStatus`.
 *
 * The one consequence it produces is `withheld = true`, which keeps a result
 * off the PUBLIC leaderboard until a human says otherwise or the 72-hour SLA
 * publishes it as CLEARED. SPEC §0's ceiling, exactly.
 */

/** Thresholds the banding engine counts by. From SPEC §5's points table. */
const BIG_PASTE_CHARS = 200;
const MEDIUM_PASTE_MIN_CHARS = 40;
const LONG_FOCUS_LOSS_MS = 5_000;
const VERY_LONG_FOCUS_LOSS_MS = 120_000;

export interface FlagResult {
  readonly flagged: boolean;
  readonly triage: TriageResult;
  readonly flagId?: string;
}

/**
 * Read an attempt's recorded events and band it.
 *
 * Counts only. The events themselves carry shape and never content (SPEC
 * §5), so there is nothing here that could become evidence of what a
 * candidate wrote — only how much appeared, when, and whether anything was
 * recorded alongside it.
 */
export async function assessAttempt(attemptId: string): Promise<TriageInput> {
  const attempt = await db.assessmentAttempt.findUniqueOrThrow({
    where: { id: attemptId },
    select: { accommodationFlags: true, startedAt: true },
  });

  const events = await db.proctorEvent.findMany({
    where: { attemptId },
    select: { kind: true, size: true, durationMs: true },
  });

  let bigExternalPastes = 0;
  let mediumExternalPastes = 0;
  let programmaticInserts = 0;
  let focusLossesOver5s = 0;
  let anyFocusLossOver120s = false;
  let fullscreenExits = 0;
  let snapshotJumps = 0;
  let devtoolsHeuristics = 0;
  let multiMonitor = 0;
  let automationHints = 0;

  for (const event of events) {
    switch (event.kind) {
      case "EXTERNAL_PASTE": {
        const size = event.size ?? 0;
        if (size >= BIG_PASTE_CHARS) bigExternalPastes++;
        else if (size >= MEDIUM_PASTE_MIN_CHARS) mediumExternalPastes++;
        // Under 40 characters scores nothing at all: a student pasting a
        // variable name or a sample value is not a signal about anything.
        break;
      }
      case "PROGRAMMATIC_INSERT":
        programmaticInserts++;
        break;
      case "FOCUS_LOSS": {
        const duration = event.durationMs ?? 0;
        if (duration > LONG_FOCUS_LOSS_MS) focusLossesOver5s++;
        if (duration > VERY_LONG_FOCUS_LOSS_MS) anyFocusLossOver120s = true;
        break;
      }
      case "FULLSCREEN_EXIT":
        fullscreenExits++;
        break;
      case "SNAPSHOT_JUMP":
        snapshotJumps++;
        break;
      case "DEVTOOLS_HEURISTIC":
        devtoolsHeuristics++;
        break;
      case "MULTI_MONITOR":
        multiMonitor++;
        break;
      case "AUTOMATION_HINT":
        automationHints++;
        break;
      default:
        // Every other kind is context a reviewer reads on the timeline and
        // scores nothing: COPY, CUT, CONTEXT_MENU, IDLE_GAP, HEARTBEAT_GAP,
        // IP_CHANGED, SEQUENCE_GAP and the rest. SPEC §5's points table is a
        // closed list, and adding to it is a product decision.
        break;
    }
  }

  return {
    bigExternalPastes,
    mediumExternalPastes,
    programmaticInserts,
    focusLossesOver5s,
    anyFocusLossOver120s,
    // "after the first warning": the first exit is the warning itself.
    fullscreenExitsAfterFirst: Math.max(0, fullscreenExits - 1),
    snapshotJumps,
    // Similarity detection runs after the assessment closes and updates the
    // flag then; a sitting is banded on its own telemetry first so a reviewer
    // is not waiting on a background job.
    peerContainmentHigh: false,
    corpusContainmentHigh: false,
    devtoolsHeuristics,
    multiMonitor,
    automationHints,
    exemptSignals: suggestedExemptSignals(attempt.accommodationFlags as AccommodationKind[]),
  };
}

/**
 * Band a finished sitting and, if it bands above NONE, flag it.
 *
 * Idempotent: one flag per attempt by unique constraint, and a second call
 * returns the existing one rather than racing. A sitting is banded once —
 * re-banding after a reviewer has read it would change what their verdict
 * was a verdict about, and the database refuses it anyway.
 */
export async function flagAttemptIfNeeded(attemptId: string): Promise<FlagResult> {
  const existing = await db.integrityFlag.findUnique({
    where: { attemptId },
    select: { id: true, band: true, substantivePoints: true, contextPoints: true },
  });
  const input = await assessAttempt(attemptId);
  const result = triage(input);

  if (existing) return { flagged: true, triage: result, flagId: existing.id };
  if (result.band === "NONE") return { flagged: false, triage: result };

  const flaggedAt = new Date();
  const attempt = await db.assessmentAttempt.findUniqueOrThrow({
    where: { id: attemptId },
    select: { userId: true, assessmentId: true },
  });

  const flag = await db.integrityFlag.create({
    data: {
      attemptId,
      band: result.band,
      substantivePoints: result.substantivePoints,
      contextPoints: result.contextPoints,
      // The contributions as a reviewer reads them: counts, sizes and a
      // sentence each. Never content.
      signals: result.contributions as never,
      flaggedAt,
      reviewDeadline: reviewDeadline(flaggedAt),
      reviewersRequired: result.reviewersRequired,
      withheld: withholdsFromLeaderboard(result.band),
    },
    select: { id: true },
  });

  await audit({
    actorId: null,
    action: "integrity.flag.raised",
    entityType: "IntegrityFlag",
    entityId: flag.id,
    targetUserId: attempt.userId,
    metadata: {
      attemptId,
      assessmentId: attempt.assessmentId,
      band: result.band,
      substantivePoints: result.substantivePoints,
      contextPoints: result.contextPoints,
      reviewersRequired: result.reviewersRequired,
      reviewDeadline: reviewDeadline(flaggedAt).toISOString(),
      // Said in the row itself, because this is the automatic action a
      // student is most likely to ask about.
      note:
        "Withheld from the public leaderboard pending a human review. Not a finding, and not a penalty. " +
        "If nobody reviews it within 72 hours it publishes automatically as cleared.",
    },
  });

  return { flagged: true, triage: result, flagId: flag.id };
}
