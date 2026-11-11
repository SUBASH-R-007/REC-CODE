import type { Db } from "@recx/db";
import {
  applyDecision,
  evaluate,
  loadSweepContext,
  sweepCandidates,
  type AppliedDecision,
  type SweepDecision,
} from "@recx/db/inactivity";
import {
  CAMPUS_TIME_ZONE,
  JUDGE_ENGINES,
  emptyHeldBy,
  type InactivitySweepReport,
} from "@recx/shared";
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
 * That gate has now been read (2026-11-01), and the decision taken from it
 * was to keep the engine reporting. `--dry-run` could not express that:
 * it is a property of the PROCESS, so it would also have stopped the
 * reconciler dispatching and the attempt sweep auto-submitting a paper at
 * its deadline. Phase 12w moves the choice onto the policy —
 * `enforceEnabled`, false by default — so this job can report while every
 * other job in the same process writes normally. `applyDecision()` is where
 * that is enforced; this job counts it and says so in the log.
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

/**
 * What a tick reports, defined ONCE in `@recx/shared` (Phase 12w).
 *
 * This file used to declare the interface and `/super/jobs` used to render
 * nothing, so the shape had one owner and no reader. Now the page parses
 * the stored report with `inactivitySweepReportSchema` before showing a
 * super-admin the figures they decide enforcement from — which makes the
 * shape a contract between the scheduler and the web app, and a contract
 * written down twice is a contract that drifts. The zod schema is the
 * definition; this is that type.
 */
export type { InactivitySweepReport };

const SAMPLE_SIZE = 25;

/**
 * What a live tick's log line says (Phase 12w).
 *
 * There are three modes now, not two, and a reader of this line months
 * later has to be able to tell which one a given night ran in:
 *
 *   --dry-run                 the whole process wrote nothing
 *   report-only policies      this job wrote nothing; the others wrote
 *   enforcing                 the job acted
 *
 * The mixed case is real — policies are per batch and per department, so a
 * college can enforce for final years while still watching the first — and
 * it says so rather than rounding to either end.
 */
function liveMode(report: InactivitySweepReport): string {
  if (report.reportOnlyPolicies === 0) return "inactivity sweep";
  const enforcing = report.escalated + report.cleared > 0;
  if (!enforcing && report.reportOnly === 0) return "inactivity sweep (nothing to write)";
  return enforcing
    ? "inactivity sweep (partly report-only: some policies do not enforce)"
    : "inactivity sweep (report-only: the policy does not enforce, nothing written)";
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
      reportOnly: 0,
      reportOnlyPolicies: 0,
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
      report.reportOnlyPolicies = context.policies.filter((policy) => !policy.enforceEnabled).length;

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
      /**
       * The line said "inactivity sweep (dry run)" unconditionally, which
       * was true in 8c and became a FALSE STATEMENT IN THE OPERATIONAL LOG
       * in 8d: a live run that restricted accounts logged itself as having
       * written nothing, and `docs/RUNBOOK.md` §2.12's incident procedures
       * are read off these lines. The mode is a field now, so a search for
       * what the sweep did on a given night cannot be misread.
       */
      this.log.info(
        { report: { ...report, sample: report.sample.length }, dryRun: this.dryRun },
        this.dryRun ? "inactivity sweep (dry run: nothing written)" : liveMode(report),
      );
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
      // `?? 0` rather than `+= 1`: the shared schema reads a stored report
      // back as a partial record (a row written before a holdback existed
      // simply has no key for it), so the counter has to tolerate one.
      report.heldBy[decision.holdback] = (report.heldBy[decision.holdback] ?? 0) + 1;
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

    /**
     * Report-only (Phase 12w). `applyDecision()` refuses this too — the
     * fence belongs at the only writer — but it is counted here, where the
     * report is being built, and the call is not made at all: a transaction
     * opened only to be refused is a lock taken on a student's row for
     * nothing, 20,000 times a night on a large college.
     */
    if (decision.policy !== null && !decision.policy.enforceEnabled) {
      report.reportOnly += 1;
      return;
    }

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
        // Phase 12k: a job id lives on exactly one of the two engines'
        // queues, and removing it from the other is a no-op. Asking both is
        // cheaper and safer than reading each submission's io mode to find
        // out which one — and a cancelled job left in Redis is picked up,
        // found cancelled and dropped anyway.
        for (const engine of JUDGE_ENGINES) {
          await this.queues.remove(engine, "CONTEST", id).catch((cause: unknown) => {
            this.log.warn({ err: cause, submissionId: id }, "could not drop a cancelled contest job from Redis");
          });
        }
      }
    }
  }

  /**
   * Whether the FLAG lets this instance write. False with `--dry-run`.
   *
   * Not the same question as whether tonight's sweep writes anything: a
   * report-only policy (12w) withholds every write with this true, which is
   * the whole point of it.
   */
  get writes(): boolean {
    return !this.dryRun;
  }

  /** The flag the scheduler was started with, for the status row. */
  get isDryRun(): boolean {
    return this.dryRun;
  }
}
