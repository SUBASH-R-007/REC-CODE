import "server-only";
import {
  EXAM_BROWSER_SIGNAL_BATCH_MAX,
  EXAM_BROWSER_SIGNAL_KINDS,
  EXAM_BROWSER_SIGNAL_MAX_DISPLAYS,
  EXAM_BROWSER_SIGNAL_MAX_MS,
  EXAM_BROWSER_SIGNAL_SITTING_MAX,
} from "@recx/shared/exam-browser";
import { clampAtMs, isNoiseFocusLoss } from "@recx/shared";
import { z } from "zod";
import { db } from "@/lib/db";

/**
 * Signals the exam browser reports about itself (Phase 15a).
 *
 * Everything the server knew about a candidate's window until now was the
 * page's own account of it, and `docs/PROCTORING.md` section 2 is explicit
 * that a page's report of its focus, its fullscreen state and its monitor
 * count is falsifiable -- the exam page is the one place in this product a
 * candidate can run their own JavaScript. The browser's main process signs
 * with a key the page never sees, so what it says can be neither forged
 * nor, more importantly, SUPPRESSED by a script in the window.
 *
 * Three rules make this safe to add to a pipeline that already works:
 *
 *   1. **Same kinds, different source.** A reviewer sees one timeline with
 *      the witness named beside each line, not two timelines to reconcile.
 *   2. **No counter moves.** The attempt's `blurEventCount` and
 *      `fullscreenExitCount` drive the focus-warning policy, which can end
 *      a paper. The page reports the same alt-tab, so counting both would
 *      quietly halve every assessment's configured limit -- and a new code
 *      path must not change what an existing paper does to a candidate.
 *      `docs/PROCTORING.md` section 3 is unchanged: this is evidence a
 *      human reads.
 *   3. **No clientSeq.** These are not part of the page's monotonic
 *      sequence, and a gap in that sequence means something specific
 *      (`SEQUENCE_GAP`) that must go on meaning it. The database says so
 *      too: `CHECK (("source" = 'CLIENT') = ("clientSeq" IS NOT NULL))`.
 *
 * The useful thing a reviewer gets is not any single line. It is the
 * COMPARISON: a paper where the browser saw seven focus losses and the
 * page reported none is a paper where the page's instrumentation was
 * interfered with, and that is visible here for the first time.
 */

export const examBrowserSignalSchema = z.object({
  kind: z.enum(EXAM_BROWSER_SIGNAL_KINDS),
  atMs: z.number().int().min(0).max(EXAM_BROWSER_SIGNAL_MAX_MS),
  durationMs: z.number().int().min(0).max(EXAM_BROWSER_SIGNAL_MAX_MS).optional(),
  displays: z.number().int().min(1).max(EXAM_BROWSER_SIGNAL_MAX_DISPLAYS).optional(),
});

export const examBrowserSignalBatchSchema = z.object({
  signals: z.array(examBrowserSignalSchema).min(1).max(EXAM_BROWSER_SIGNAL_BATCH_MAX),
});

export type ExamBrowserSignalInput = z.infer<typeof examBrowserSignalSchema>;

export interface SignalTarget {
  readonly attemptId: string;
  readonly sittingId: string;
  /** Milliseconds the attempt has been running, for clamping. */
  readonly elapsedMs: number;
}

/**
 * The live attempt this sitting is bound to, or null.
 *
 * Looked up by the sitting id the request CLAIMS, before the signature has
 * been checked -- which is safe and is the only possible order, because
 * the key the signature is checked against is derived from that id. The
 * lookup leaks nothing: it returns a row or it does not, and the caller
 * refuses either way unless the signature then verifies.
 *
 * Only a sitting that has not ended, and only an attempt still in
 * progress. A finished paper takes no more evidence; whatever the browser
 * has left to say about a window after the clock stopped is not about the
 * paper.
 */
export async function signalTargetOf(claimedSittingId: string, now: Date): Promise<SignalTarget | null> {
  if (claimedSittingId === "" || claimedSittingId.length > 64) return null;
  const attempt = await db.assessmentAttempt.findFirst({
    where: {
      examBrowserSittingId: claimedSittingId,
      status: "IN_PROGRESS",
      examBrowserSitting: { endedAt: null },
    },
    select: { id: true, startedAt: true },
  });
  if (!attempt?.startedAt) return null;
  return {
    attemptId: attempt.id,
    sittingId: claimedSittingId,
    elapsedMs: Math.max(0, now.getTime() - attempt.startedAt.getTime()),
  };
}

export interface SignalIngestResult {
  /** Written to the database. */
  readonly recorded: number;
  /** Refused: noise, or past the sitting's ceiling. */
  readonly dropped: number;
  /** True when the sitting has said as much as it is allowed to. */
  readonly ceilingReached: boolean;
}

/**
 * The severity of an attested signal.
 *
 * Matched to the client path's `severityOf` on purpose rather than raised
 * for being attested. Severity describes WHAT HAPPENED; how much the
 * witness is worth is the `source` column beside it, and a reviewer
 * reading a timeline should not have to mentally subtract a bonus somebody
 * added here.
 */
function severityOf(signal: ExamBrowserSignalInput): "INFO" | "LOW" | "MEDIUM" {
  switch (signal.kind) {
    case "FOCUS_LOSS":
      return (signal.durationMs ?? 0) > 120_000 ? "MEDIUM" : "LOW";
    case "FULLSCREEN_EXIT":
      return "LOW";
    default:
      // MULTI_MONITOR: context, not a finding -- the same as the client
      // path, and the same as it was when the readiness check asked.
      return "INFO";
  }
}

/**
 * Record a batch. Returns what was written and what was not.
 *
 * Best-effort in one respect only: the ceiling. Everything else either
 * writes or throws, because a signal silently dropped is worse than an
 * error a candidate's browser retries.
 */
export async function recordExamBrowserSignals(args: {
  readonly target: SignalTarget;
  readonly signals: readonly ExamBrowserSignalInput[];
  readonly now: Date;
}): Promise<SignalIngestResult> {
  const already = await db.proctorEvent.count({
    where: { attemptId: args.target.attemptId, source: "EXAM_BROWSER" },
  });
  let budget = Math.max(0, EXAM_BROWSER_SIGNAL_SITTING_MAX - already);

  let dropped = 0;
  const rows = [];
  for (const signal of args.signals) {
    /**
     * The same noise floor the page's events get. A window that loses and
     * regains focus inside a few hundred milliseconds is a notification
     * or a tooltip, not a candidate looking somewhere else, and a
     * timeline full of those is a timeline nobody reads to the end.
     */
    if (signal.kind === "FOCUS_LOSS" && isNoiseFocusLoss(signal.durationMs ?? 0)) {
      dropped++;
      continue;
    }
    if (budget === 0) {
      dropped++;
      continue;
    }
    budget--;
    rows.push({
      attemptId: args.target.attemptId,
      kind: signal.kind,
      source: "EXAM_BROWSER" as const,
      severity: severityOf(signal),
      // Never a clientSeq: see the note at the top of this file, and the
      // CHECK constraint that enforces it.
      clientSeq: null,
      atMs: clampAtMs(signal.atMs, args.target.elapsedMs),
      durationMs: signal.durationMs ?? null,
      size: null,
      hash: null,
      meta: signal.displays === undefined ? {} : { displays: signal.displays },
      occurredAt: args.now,
    });
  }

  if (rows.length > 0) {
    // `skipDuplicates`, because the browser retries a batch it did not get
    // an answer to and the unique index would otherwise turn a flaky
    // network into a 500 on a candidate's machine mid-paper.
    await db.proctorEvent.createMany({ data: rows, skipDuplicates: true });
  }

  return { recorded: rows.length, dropped, ceilingReached: budget === 0 && already + rows.length >= EXAM_BROWSER_SIGNAL_SITTING_MAX };
}
