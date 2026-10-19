import "server-only";
import type { Prisma, ProctorEventKind } from "@recx/db";
import {
  MAX_RAW_EVENTS_PER_ATTEMPT,
  clampAtMs,
  elapsedMs,
  focusWarningOutcome,
  isExemptSignal,
  isNoiseFocusLoss,
  isClientReportableKind,
  overlayBody,
  suggestedExemptSignals,
  type AccommodationKind,
  type ClientProctorEvent,
  type FocusLimitAction,
  type ProctorEventBatchResponse,
} from "@recx/shared";
import { db } from "@/lib/db";
import type { AttemptGuardOk } from "@/lib/exam/attempt";

/**
 * Ingesting client telemetry (Phase 6c).
 *
 * Everything a browser reports is a claim. This module turns claims into
 * rows, and the shape of the work is "trust the kind, distrust the numbers":
 *
 *   - the kind must be one a browser can actually observe. A client claiming
 *     HEARTBEAT_GAP or CONCURRENT_SESSION is either broken or polluting its
 *     own record, and the server already knows those from its own facts;
 *   - `atMs` is clamped into [0, elapsed + 5s] (SPEC §5), so nothing is
 *     recorded before the attempt began or after the reviewer's window;
 *   - a focus loss under 1.5 seconds is dropped as UI noise;
 *   - past 2,000 raw rows only the counters move, so one misbehaving client
 *     cannot fill a partition.
 *
 * And the ceiling SPEC §0 sets holds here as everywhere: the worst this can
 * produce is an auto-submit plus a flag for a human. It writes no
 * integrityScore, no IntegrityFlag and no verdict.
 */

/** Which attempt counter a kind increments, if any. */
const COUNTER_OF: Partial<Record<ProctorEventKind, "blurEventCount" | "fullscreenExitCount" | "pasteEventCount">> = {
  FOCUS_LOSS: "blurEventCount",
  FULLSCREEN_EXIT: "fullscreenExitCount",
  EXTERNAL_PASTE: "pasteEventCount",
  INTERNAL_PASTE: "pasteEventCount",
};

/** The two kinds the covering overlay is about. */
const FOCUS_KINDS: readonly ProctorEventKind[] = ["FOCUS_LOSS", "FULLSCREEN_EXIT"];

/**
 * Severity is for ORDERING a review queue and nothing else (SPEC §5's triage
 * banding is "structurally unable to touch a score"). A paste of a few
 * characters is INFO; a large unannotated insertion is the most probative
 * thing a client can report, and still only MEDIUM, because the only
 * artefact that survives tampering is the snapshot timeline.
 */
function severityOf(event: ClientProctorEvent): "INFO" | "LOW" | "MEDIUM" {
  switch (event.kind) {
    case "PROGRAMMATIC_INSERT":
      return "MEDIUM";
    case "EXTERNAL_PASTE":
      return (event.size ?? 0) >= 200 ? "MEDIUM" : "LOW";
    case "FULLSCREEN_EXIT":
      return "LOW";
    case "FOCUS_LOSS":
      return (event.durationMs ?? 0) > 120_000 ? "MEDIUM" : "LOW";
    case "CADENCE_BURST":
    case "AUTOMATION_HINT":
      return "LOW";
    default:
      // COPY, CUT, CONTEXT_MENU, WINDOW_RESIZE, MULTI_MONITOR,
      // DEVTOOLS_HEURISTIC, IDLE_GAP, FIRST_KEYSTROKE, NETWORK_DROP,
      // CLIENT_SCRIPT_ERROR, INTERNAL_PASTE — context, not findings.
      return "INFO";
  }
}

export interface IngestResult extends ProctorEventBatchResponse {
  /** Set when the policy's limit was reached and the sitting must end. */
  readonly autoSubmit: boolean;
}

/**
 * Record a batch.
 *
 * One transaction: the rows and the counters move together, so a reviewer
 * never sees a counter that disagrees with the timeline. The attempt update
 * is conditional on the version the guard read, and a lost race is NOT
 * retried — the client's next flush is five seconds away and carries the
 * same events, and a retry loop here is how one slow attempt becomes a
 * thundering herd during a college-wide sitting.
 */
export async function ingestProctorEvents(
  guard: AttemptGuardOk,
  events: readonly ClientProctorEvent[],
  assessment: { readonly maxFocusWarnings: number; readonly onLimit: FocusLimitAction },
): Promise<IngestResult> {
  const { attempt, now } = guard;
  const elapsed = elapsedMs(attempt.startedAt, now);

  /**
   * Which signals this candidate is exempt from, derived from the
   * accommodation kinds FROZEN onto the attempt at start. Frozen on purpose:
   * what counts against a candidate must not change mid-sitting.
   *
   * It is derived rather than stored per-signal, which means a super-admin's
   * hand-edited `Accommodation.exemptSignals` is not honoured here — see
   * docs/OPEN-QUESTIONS.md. The derivation is the generous direction (it
   * exempts at least what the accommodation implies), which is the right way
   * for this to be wrong.
   */
  const exemptSignals = suggestedExemptSignals(attempt.accommodationFlags as AccommodationKind[]);

  const existingRaw = await db.proctorEvent.count({ where: { attemptId: attempt.id } });
  let rawBudget = Math.max(0, MAX_RAW_EVENTS_PER_ATTEMPT - existingRaw);
  const aggregatesOnly = rawBudget === 0;

  const rows: Prisma.ProctorEventCreateManyInput[] = [];
  const counters = { blurEventCount: 0, fullscreenExitCount: 0, pasteEventCount: 0 };
  let dropped = 0;
  let focusEventsThisBatch = 0;

  for (const event of events) {
    // A kind only the server can know is not a claim a client gets to make.
    if (!isClientReportableKind(event.kind)) {
      dropped++;
      continue;
    }
    // A focus flicker is not a signal.
    if (event.kind === "FOCUS_LOSS" && isNoiseFocusLoss(event.durationMs ?? 0)) {
      dropped++;
      continue;
    }

    // Counters move even past the raw cap — that is what "increment
    // aggregates only" means — and they count everything recorded, exempt or
    // not, because a reviewer wants the whole timeline next to the note that
    // these signals are discounted for this candidate.
    const counter = COUNTER_OF[event.kind];
    if (counter) counters[counter]++;
    if (FOCUS_KINDS.includes(event.kind) && !isExemptSignal(event.kind, exemptSignals)) {
      focusEventsThisBatch++;
    }

    if (rawBudget === 0) {
      dropped++;
      continue;
    }
    rawBudget--;
    rows.push({
      attemptId: attempt.id,
      kind: event.kind,
      source: "CLIENT",
      severity: severityOf(event),
      clientSeq: event.clientSeq,
      atMs: clampAtMs(event.atMs, elapsed),
      durationMs: event.durationMs ?? null,
      size: event.size ?? null,
      hash: event.hash ?? null,
      meta: {
        ...(event.chars !== undefined ? { chars: event.chars } : {}),
        ...(event.windowMs !== undefined ? { windowMs: event.windowMs } : {}),
        ...(event.questionPosition !== undefined ? { questionPosition: event.questionPosition } : {}),
      },
      occurredAt: now,
    });
  }

  // ── The focus-warning policy ───────────────────────────────────────────
  // Warnings already recorded are the attempt's own counters, so no new
  // column is needed. When the signal is exempt for this candidate the count
  // is zero by construction: every focus event of that kind is exempt, so
  // none of them ever reached `focusEventsThisBatch`.
  const previousWarnings = isExemptSignal("FOCUS_LOSS", exemptSignals) && isExemptSignal("FULLSCREEN_EXIT", exemptSignals)
    ? 0
    : attempt.blurEventCount + attempt.fullscreenExitCount;
  const outcome =
    focusEventsThisBatch > 0
      ? focusWarningOutcome({
          previousWarnings,
          maxWarnings: assessment.maxFocusWarnings,
          onLimit: assessment.onLimit,
          exempt: false,
        })
      : null;

  const data: Prisma.AssessmentAttemptUpdateManyMutationInput = { version: { increment: 1 } };
  if (counters.blurEventCount > 0) data.blurEventCount = { increment: counters.blurEventCount };
  if (counters.fullscreenExitCount > 0) data.fullscreenExitCount = { increment: counters.fullscreenExitCount };
  if (counters.pasteEventCount > 0) data.pasteEventCount = { increment: counters.pasteEventCount };

  // The rows and the counters in ONE transaction. This is also what makes
  // the overlay honest: when this resolves, the event IS recorded, and only
  // then may the client let the candidate carry on.
  const [, written] = await db.$transaction([
    rows.length > 0
      ? db.proctorEvent.createMany({ data: rows })
      : db.proctorEvent.count({ where: { attemptId: attempt.id, atMs: -1 } }),
    db.assessmentAttempt.updateMany({ where: { id: attempt.id, version: attempt.version }, data }),
  ]);

  if (written.count !== 1) {
    // Another writer (a heartbeat, another flush) moved the row first. The
    // events above are already persisted; only the counters are behind, and
    // the next flush carries them. Not retried — see the doc comment.
    console.warn(`[exam] attempt ${attempt.id}: event counters lost a race (version ${attempt.version})`);
  }

  return {
    accepted: rows.length,
    dropped,
    focusWarning:
      outcome === null
        ? null
        : {
            warningNumber: outcome.warningNumber,
            maxWarnings: Math.max(1, assessment.maxFocusWarnings),
            atLimit: outcome.atLimit,
            action: outcome.action,
            body: overlayBody({
              warningNumber: outcome.warningNumber,
              maxWarnings: Math.max(1, assessment.maxFocusWarnings),
              onLimit: assessment.onLimit,
            }),
          },
    aggregatesOnly,
    autoSubmit: outcome?.action === "AUTOSUBMIT",
  };
}
