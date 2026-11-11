import type { Db } from "@recx/db";
import { appendAuditEntries } from "@recx/db/audit";
import { autoSubmitExpired, markDisconnectedAttempts } from "@recx/db/attempt";
import { endExamBrowserSittings, examBrowserSittingsOfAttempts } from "@recx/db/exam-browser";
import {
  ATTEMPT_AUTO_SUBMIT_BATCH,
  ATTEMPT_AUTO_SUBMIT_INTERVAL_MS,
  DISCONNECTED_AFTER_SECONDS,
} from "@recx/shared";
import type { Logger } from "pino";

/**
 * The attempt sweep (Phase 6b). Two passes, every 15 seconds.
 *
 * SPEC §5: "Auto-submit: a 15s worker finalising status = IN_PROGRESS AND
 * expiresAt <= now() inside SELECT ... FOR UPDATE SKIP LOCKED, plus a lazy
 * expiry check in the attempt guard on every exam request, so a dead worker
 * cannot grant anyone extra time. The server force-submits on its own
 * schedule — closing the laptop never banks time."
 *
 * And: "Missing heartbeats for 45s -> DISCONNECTED, amber on the invigilator
 * dashboard" — which no request can do, because the absence of a request is
 * the thing being detected.
 *
 * Auto-submit is the ONLY automatic action in the system (SPEC §5), and it is
 * a deadline, not a penalty. This job never writes a flag, never touches
 * `integrityScore`, and cannot reach VOIDED — the database trigger would
 * refuse it, because VOIDED is reachable only from a finished status and only
 * ever by a recorded human verdict (§0).
 *
 * Safe with two scheduler instances: both passes claim rows with FOR UPDATE
 * SKIP LOCKED and are conditional on the status they expect, so a row another
 * instance is finalising is passed over rather than finalised twice.
 *
 * The SQL lives in @recx/db/attempt because apps/web's attempt guard runs the
 * same auto-submit as the lazy check, and two copies of "the deadline has
 * passed" would eventually disagree.
 */

export interface AttemptSweepReport {
  /** REC Exam Browser sittings ended with them (Phase 14h). */
  examBrowserSittingsEnded?: number;
  /** Sittings force-submitted at their deadline. */
  autoSubmitted: number;
  /** Sittings moved to DISCONNECTED for going quiet. */
  disconnected: number;
  /**
   * The worst lateness in this batch, in milliseconds. A number that keeps
   * climbing means the sweep is behind and candidates are being finalised
   * after their deadline — exactly the symptom the lazy guard covers for, and
   * worth an alert of its own (docs/CAPACITY.md).
   */
  worstLateMs: number;
  /** True when the batch filled, so there is more waiting for the next tick. */
  capped: boolean;
  failed: boolean;
  error?: string;
}

export class AttemptSweepJob {
  private readonly db: Db;
  private readonly log: Logger;
  private readonly dryRun: boolean;
  /** -Infinity, not 0, so "never run" is unambiguous whatever the clock reads. */
  private lastRunMs = Number.NEGATIVE_INFINITY;

  constructor(options: { db: Db; log: Logger; dryRun: boolean }) {
    this.db = options.db;
    this.log = options.log;
    this.dryRun = options.dryRun;
  }

  /** True when enough time has passed for another pass. */
  due(now: Date): boolean {
    return now.getTime() - this.lastRunMs >= ATTEMPT_AUTO_SUBMIT_INTERVAL_MS;
  }

  async tick(now: Date): Promise<AttemptSweepReport> {
    const report: AttemptSweepReport = {
      autoSubmitted: 0,
      examBrowserSittingsEnded: 0,
      disconnected: 0,
      worstLateMs: 0,
      capped: false,
      failed: false,
    };
    if (!this.due(now)) return report;
    this.lastRunMs = now.getTime();

    try {
      // Expiry first. A sitting that is both past its deadline and silent
      // should be finalised, not parked in DISCONNECTED on the way there.
      const submitted = await autoSubmitExpired(this.db, {
        limit: ATTEMPT_AUTO_SUBMIT_BATCH,
        dryRun: this.dryRun,
      });
      report.autoSubmitted = submitted.length;
      report.capped = submitted.length >= ATTEMPT_AUTO_SUBMIT_BATCH;
      for (const row of submitted) report.worstLateMs = Math.max(report.worstLateMs, row.lateMs);

      /**
       * The exam browsers that were sitting them (Phase 14h).
       *
       * This path closes an attempt with no request from the browser at all,
       * so nothing else would ever end these sittings: the candidate who ran
       * out of time and walked away would be left with a signed-in kiosk
       * window on their own machine until its session expired on the clock.
       *
       * Asked BEFORE the sittings are ended, because ending one clears the
       * column this reads. Behind a catch because a sweeper that throws here
       * would stop the presence pass below, and a sitting whose session
       * outlives it by a few hours is a smaller problem than a hall whose
       * invigilator dashboard stops updating.
       */
      if (submitted.length > 0 && !this.dryRun) {
        try {
          const sittingIds = await examBrowserSittingsOfAttempts(
            this.db,
            submitted.map((row) => row.id),
          );
          const ended = await endExamBrowserSittings(this.db, sittingIds);
          report.examBrowserSittingsEnded = ended.sittingsEnded;
          if (ended.sittingsEnded > 0) {
            this.log.info(
              { sittings: ended.sittingsEnded, sessions: ended.sessionsRevoked },
              "exam browser sittings ended with the attempts they were sitting",
            );
          }
        } catch (error) {
          this.log.error({ err: error }, "could not end the exam browser sittings of auto-submitted attempts");
        }
      }

      if (submitted.length > 0 && !this.dryRun) {
        // One audit row per sitting. Auto-submit is the one thing the server
        // does to a candidate's attempt without a human asking, so it is the
        // one thing that most needs to be answerable afterwards.
        await appendAuditEntries(
          this.db,
          submitted.map((row) => ({
            actorId: null,
            action: "assessment.attempt.auto_submitted",
            entityType: "AssessmentAttempt",
            entityId: row.id,
            targetUserId: row.userId,
            metadata: {
              by: "sweeper",
              previousStatus: row.previousStatus,
              expiresAt: row.expiresAt.toISOString(),
              pausedMs: row.pausedMs,
              lateMs: Math.round(row.lateMs),
            },
          })),
        );
        this.log.info(
          { count: submitted.length, worstLateMs: Math.round(report.worstLateMs) },
          "attempts auto-submitted at their deadline",
        );
      }

      // Then presence. DISCONNECTED is a presence state and never a flag
      // (SPEC §5), so this writes a status and nothing else — no event, no
      // counter, no audit row. The reconnecting heartbeat records the gap it
      // can measure exactly from the bitmap.
      const quiet = await markDisconnectedAttempts(this.db, {
        silentAfterSeconds: DISCONNECTED_AFTER_SECONDS,
        limit: ATTEMPT_AUTO_SUBMIT_BATCH,
        dryRun: this.dryRun,
      });
      report.disconnected = quiet.length;
      if (quiet.length > 0) {
        this.log.info({ count: quiet.length }, "attempts marked disconnected (amber on the invigilator dashboard)");
      }
    } catch (cause) {
      report.failed = true;
      report.error = cause instanceof Error ? cause.message : String(cause);
      this.log.error({ err: cause }, "attempt sweep failed");
    }
    return report;
  }
}
