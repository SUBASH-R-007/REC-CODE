import type { Db } from "@recx/db";
import {
  applyDecision,
  evaluate,
  loadSweepContext,
  sweepCandidates,
  type AppliedDecision,
  type SweepDecision,
} from "@recx/db/inactivity";
import { CAMPUS_TIME_ZONE, SWEEP_HOLDBACKS, type SweepHoldback } from "@recx/shared";
import type { Logger } from "pino";
import type { JudgeQueuePort } from "./queues";

/**
 * The inactivity sweep (Phases 8c and 8d).
 *
 * SPEC §5 asks for a dry-run mode "shipped first", and it was: slice 8c shipped
 * this job reporting and writing nothing, with its own gate. Slice 8d adds
 * the writes — through the SAME `evaluate()` the report is built from, so a
 * dry run cannot describe a decision the live run would not make. That is the
 * only reason a dry run is worth having.
 *
 * `--dry-run` still reports without writing, and the last block of
 * `inactivity-sweep.test.ts` asserts that as a property: a fake database
 * records every method touched and the set must contain no mutation. The
 * manual gate for the phase is a human reading that report over seeded data
 * covering holidays, exam weeks, approved leave, partial activity, an open
 * attempt, a pending appeal, an assessment 48 hours out and a student with no
 * activity — before the live job goes near a real roster.
 *
 * It runs once per campus day at 02:00 Asia/Kolkata, and the gate is in the
 * data as well: `AccountStatusEvent_sweep_once_per_day` makes a second run
 * for one evaluation date a unique violation on one row rather than a second
 * transition for the cohort. The clock check here is what stops it doing the
 * work twice, not what stops it mattering twice.
 */

/** 02:00 campus time, which is when nobody is sitting anything. */
export const SWEEP_HOUR_IST = 2;
/** The scheduler ticks far more often than this; the hour gate is the real schedule. */
export const INACTIVITY_SWEEP_INTERVAL_MS = 60_000;
/** Students per batch. Bounded so one tick cannot run long on a large college. */
export const INACTIVITY_SWEEP_BATCH = 500;
/** Batches per tick, so a 20,000-student college finishes in one night. */
export const INACTIVITY_SWEEP_MAX_BATCHES = 80;

export interface InactivitySweepReport {
  /** The campus day evaluated, or null when the hour gate said not yet. */
  evaluationDay: string | null;
  ran: boolean;
  /** Why it did not run, when it did not. */
  skipped?: "not-the-hour" | "already-run-today" | "no-active-policy";
  considered: number;
  /** What it WOULD do, by kind. Nothing is written in this slice. */
  wouldEscalate: number;
  wouldClear: number;
  held: number;
  /** Held back, by reason — the number an administrator acts on. */
  heldBy: Record<SweepHoldback, number>;
  /** Students the job would stop at SOFT_RESTRICTED and hand to a human. */
  adminReview: number;
  /** Actually written. Zero in dry-run mode, by construction. */
  escalated: number;
  cleared: number;
  /** Another writer got there first: a solve, a staff member, or the other instance. */
  racedAway: number;
  mentorsNotified: number;
  contestSubmissionsCancelled: number;
  /** True when the calendar did not cover the window for anybody at all. */
  calendarIncomplete: boolean;
  /** A readable sample, for the report a human reads. Counts and codes only. */
  sample: Array<{
    collegeId: string;
    stage: string;
    toStage: string;
    kind: string;
    countedInactiveDays: number;
    excludedDays: number;
    holdback: SweepHoldback | null;
    reason: string;
  }>;
  failed: boolean;
  error?: string;
}

const SAMPLE_SIZE = 25;

function emptyHeldBy(): Record<SweepHoldback, number> {
  return Object.fromEntries(SWEEP_HOLDBACKS.map((key) => [key, 0])) as Record<SweepHoldback, number>;
}

/** The hour in campus time, whatever the server's own zone. */
function campusHour(at: Date): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: CAMPUS_TIME_ZONE,
    hour: "2-digit",
    hour12: false,
  }).formatToParts(at);
  return Number(parts.find((part) => part.type === "hour")?.value ?? "-1");
}

export class InactivitySweepJob {
  private readonly db: Db;
  private readonly log: Logger;
  private readonly dryRun: boolean;
  /** Only used to drop a cancelled contest job from Redis, best-effort. */
  private readonly queues?: JudgeQueuePort;
  /**
   * The last campus day this instance evaluated.
   *
   * In-memory, and deliberately NOT the authority: two scheduler instances
   * each keep their own, and what actually makes a second run harmless is the
   * per-day unique index in the database. This only saves the work.
   */
  private lastEvaluationDay: string | null = null;

  constructor(options: { db: Db; log: Logger; dryRun: boolean; queues?: JudgeQueuePort }) {
    this.db = options.db;
    this.log = options.log;
    this.dryRun = options.dryRun;
    this.queues = options.queues;
  }

  /** Visible for tests: pretend this instance has already run today. */
  markRun(day: string): void {
    this.lastEvaluationDay = day;
  }

  async tick(now: Date): Promise<InactivitySweepReport> {
    const report: InactivitySweepReport = {
      evaluationDay: null,
      ran: false,
      considered: 0,
      wouldEscalate: 0,
      wouldClear: 0,
      held: 0,
      heldBy: emptyHeldBy(),
      adminReview: 0,
      escalated: 0,
      cleared: 0,
      racedAway: 0,
      mentorsNotified: 0,
      contestSubmissionsCancelled: 0,
      calendarIncomplete: false,
      sample: [],
      failed: false,
    };

    try {
      if (campusHour(now) !== SWEEP_HOUR_IST) {
        report.skipped = "not-the-hour";
        return report;
      }

      // One batch's context tells us the campus day; ask for it first so the
      // "already run" check reads the same day the evidence would cite.
      const first = await sweepCandidates(this.db, { now, limit: INACTIVITY_SWEEP_BATCH });
      const context = await loadSweepContext(this.db, first, now);
      report.evaluationDay = context.evaluationDay;

      if (this.lastEvaluationDay === context.evaluationDay) {
        report.skipped = "already-run-today";
        return report;
      }
      if (context.policies.length === 0) {
        // Not a failure. A college that has configured no policy has chosen
        // for this engine to do nothing, and inventing a default would mean
        // restricting students under rules nobody chose.
        report.skipped = "no-active-policy";
        this.lastEvaluationDay = context.evaluationDay;
        return report;
      }

      report.ran = true;
      let batch = first;
      let batches = 0;
      let after: string | undefined;

      while (batch.length > 0 && batches < INACTIVITY_SWEEP_MAX_BATCHES) {
        const batchContext = batches === 0 ? context : await loadSweepContext(this.db, batch, now);
        for (const candidate of batch) {
          const decision = evaluate(candidate, batchContext);
          this.account(report, decision);
          if (!this.dryRun) await this.perform(report, decision, batchContext.evaluationDay, now);
        }
        after = batch.at(-1)?.userId;
        batches += 1;
        if (batch.length < INACTIVITY_SWEEP_BATCH || after === undefined) break;
        batch = await sweepCandidates(this.db, { now, limit: INACTIVITY_SWEEP_BATCH, afterUserId: after });
      }

      if (batches >= INACTIVITY_SWEEP_MAX_BATCHES && batch.length === INACTIVITY_SWEEP_BATCH) {
        // Said out loud rather than silently truncated: a report that stopped
        // early and did not say so would read as "these are all of them".
        this.log.warn(
          { batches, batchSize: INACTIVITY_SWEEP_BATCH },
          "inactivity sweep hit its batch ceiling; the rest of the roster was not considered this tick",
        );
      }

      this.lastEvaluationDay = context.evaluationDay;
      this.log.info({ report: { ...report, sample: report.sample.length } }, "inactivity sweep (dry run)");
    } catch (cause) {
      report.failed = true;
      report.error = cause instanceof Error ? cause.message : String(cause);
      this.log.error({ err: cause }, "inactivity sweep tick failed");
    }
    return report;
  }

  /** Fold one decision into the report. */
  private account(report: InactivitySweepReport, decision: SweepDecision): void {
    report.considered += 1;
    if (decision.count.calendarIncomplete) report.calendarIncomplete = true;
    if (decision.plan.raisesAdminReview) report.adminReview += 1;

    if (decision.holdback !== null) {
      report.held += 1;
      report.heldBy[decision.holdback] += 1;
    } else if (decision.plan.kind === "escalate") {
      report.wouldEscalate += 1;
    } else if (decision.plan.kind === "clear") {
      report.wouldClear += 1;
    } else {
      report.held += 1;
    }

    // The sample is what a human reads at the manual gate, so it leads with
    // the rows that would MOVE — a page of "nothing changed" tells nobody
    // anything. College id and counts only: no names, no addresses.
    const interesting = decision.plan.kind !== "hold" || decision.plan.raisesAdminReview;
    if (interesting && report.sample.length < SAMPLE_SIZE) {
      report.sample.push({
        collegeId: decision.candidate.collegeId,
        stage: decision.candidate.stage,
        toStage: decision.plan.toStage,
        kind: decision.plan.kind,
        countedInactiveDays: decision.count.countedInactiveDays,
        excludedDays: decision.count.excludedDates.length,
        holdback: decision.holdback,
        reason: decision.plan.reason,
      });
    }
  }

  /**
   * Perform one decision, and clean up after it outside the transaction.
   *
   * One student failing must not cost the rest of the night's work. Every
   * refusal that can reach here is a guard saying "not this student, not
   * now" — a mid-attempt escalation the trigger catches, a same-day row the
   * unique index catches, a stage that moved under us — so each is caught,
   * counted as a race and logged, and the sweep carries on.
   */
  private async perform(
    report: InactivitySweepReport,
    decision: SweepDecision,
    evaluationDay: string,
    now: Date,
  ): Promise<void> {
    if (decision.plan.kind === "hold" && !decision.plan.raisesAdminReview) return;
    let applied: AppliedDecision;
    try {
      applied = await applyDecision(this.db, decision, { now, evaluationDay });
    } catch (cause) {
      report.racedAway += 1;
      this.log.warn(
        { err: cause, collegeId: decision.candidate.collegeId, toStage: decision.plan.toStage },
        "inactivity sweep could not apply one decision",
      );
      return;
    }

    if (applied.skipped === "already-moved") {
      report.racedAway += 1;
      return;
    }
    if (applied.eventId === null) return;

    if (decision.plan.kind === "escalate") report.escalated += 1;
    if (decision.plan.kind === "clear") report.cleared += 1;
    if (applied.notifiedMentor) report.mentorsNotified += 1;
    report.contestSubmissionsCancelled += applied.cancelledSubmissionIds.length;

    /**
     * Redis, after the commit and best-effort.
     *
     * It cannot be inside the transaction: a Redis call does not roll back.
     * And it does not need to be — the row is already CANCELLED, so a job
     * left in the queue is picked up, found cancelled and dropped. Every
     * other enqueue in this codebase works the same way round.
     */
    if (this.queues && applied.cancelledSubmissionIds.length > 0) {
      for (const id of applied.cancelledSubmissionIds) {
        await this.queues.remove("CONTEST", id).catch((cause: unknown) => {
          this.log.warn({ err: cause, submissionId: id }, "could not drop a cancelled contest job from Redis");
        });
      }
    }
  }

  /** Whether this instance writes. False with `--dry-run`. */
  get writes(): boolean {
    return !this.dryRun;
  }

  /** The flag the scheduler was started with, for the status row. */
  get isDryRun(): boolean {
    return this.dryRun;
  }
}
