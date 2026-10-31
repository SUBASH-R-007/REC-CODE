import type { Db } from "@recx/db";
import {
  buildCohorts,
  loadReadinessSources,
  snapshotFor,
  writeSnapshots,
  type CohortPopulations,
  type ReadinessSources,
  type SnapshotRow,
} from "@recx/db/readiness";
import { CAMPUS_TIME_ZONE, MIN_PERCENTILE_COHORT, READINESS_RULES_VERSION, cohortKeyFor } from "@recx/shared";
import type { Logger } from "pino";

/**
 * The nightly readiness run (Phase 9).
 *
 * SPEC §5: `ReadinessSnapshot`, nightly, retaining the component breakdown.
 * One run per campus day, and `ReadinessRun.computedOn` is the primary key,
 * so "one run per day" is a property of the schema rather than of this
 * clock check — which only saves the work.
 *
 * **A dry run writes nothing.** Not a `dryRun` column and a filter: the job
 * computes, reports and returns, and the report is what the manual gate
 * reads. The same shape Phase 8c shipped, for the same reason — a column
 * plus a filter is an invitation to forget the filter in one query.
 *
 * It runs at 02:30 campus time, AFTER the Phase 8 inactivity sweep at 02:00.
 * The order matters: `consistency` and `lastActiveOn` are read from
 * `ActivityDay`, and a readiness figure computed before the sweep had
 * finished would be computed against a cohort half of whose restrictions
 * were a day stale. Half an hour is ample for a 5,000-student sweep and
 * cheap insurance either way.
 */

export const READINESS_HOUR_IST = 2;
export const READINESS_MINUTE_IST = 30;
/** Students per write batch, so one tick cannot hold a transaction open long. */
export const READINESS_BATCH = 500;

export interface ReadinessReport {
  evaluationDay: string | null;
  ran: boolean;
  skipped?: "not-the-hour" | "already-run-today" | "no-students";
  /** Whether anything was written. False for every dry run, by construction. */
  wrote: boolean;
  studentsEvaluated: number;
  snapshotsWritten: number;
  /** Cohorts too small to rank in, which is a fact an administrator acts on. */
  cohortsTooSmall: string[];
  /** How many students had each tier unmeasurable — the honesty counter. */
  unmeasurable: { service: number; product: number; top: number };
  /** A readable sample for the manual gate. College ids and numbers only. */
  sample: Array<{
    collegeId: string;
    cohort: string;
    service: string;
    product: string;
    top: string;
    limitingTopicProduct: string | null;
  }>;
  failed: boolean;
  error?: string;
}

const SAMPLE_SIZE = 20;

/** Campus-time hour and minute, whatever the server's own zone. */
function campusHourMinute(at: Date): { hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: CAMPUS_TIME_ZONE,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(at);
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? "-1");
  return { hour: get("hour"), minute: get("minute") };
}

export class ReadinessJob {
  private readonly db: Db;
  private readonly log: Logger;
  private readonly dryRun: boolean;
  /**
   * The last campus day this instance ran. In-memory and deliberately NOT
   * the authority: `ReadinessRun.computedOn` is the primary key, so a second
   * run is a unique violation rather than a second set of numbers.
   */
  private lastEvaluationDay: string | null = null;

  constructor(options: { db: Db; log: Logger; dryRun: boolean }) {
    this.db = options.db;
    this.log = options.log;
    this.dryRun = options.dryRun;
  }

  /** Visible for tests: pretend this instance has already run today. */
  markRun(day: string): void {
    this.lastEvaluationDay = day;
  }

  /** Whether this instance writes. False with `--dry-run`. */
  get writes(): boolean {
    return !this.dryRun;
  }

  async tick(now: Date): Promise<ReadinessReport> {
    const report: ReadinessReport = {
      evaluationDay: null,
      ran: false,
      wrote: false,
      studentsEvaluated: 0,
      snapshotsWritten: 0,
      cohortsTooSmall: [],
      unmeasurable: { service: 0, product: 0, top: 0 },
      sample: [],
      failed: false,
    };

    try {
      const { hour, minute } = campusHourMinute(now);
      if (hour !== READINESS_HOUR_IST || minute < READINESS_MINUTE_IST) {
        report.skipped = "not-the-hour";
        return report;
      }

      const sources = await loadReadinessSources(this.db, now);
      report.evaluationDay = sources.evaluationDay;

      if (this.lastEvaluationDay === sources.evaluationDay) {
        report.skipped = "already-run-today";
        return report;
      }
      if (sources.students.length === 0) {
        report.skipped = "no-students";
        this.lastEvaluationDay = sources.evaluationDay;
        return report;
      }

      const cohorts = buildCohorts(sources);
      report.cohortsTooSmall = [...cohorts.values()]
        .filter((cohort) => cohort.size < MIN_PERCENTILE_COHORT)
        .map((cohort) => `${cohort.cohortKey} (${cohort.size})`)
        .sort();
      report.ran = true;

      const runStartedAt = now;
      if (!this.dryRun) await this.openRun(sources, cohorts, runStartedAt);

      let batch: SnapshotRow[] = [];
      for (const student of sources.students) {
        const cohort = cohorts.get(cohortKeyFor(student.batchYear));
        if (!cohort) continue;
        const row = snapshotFor(student, sources, cohort);
        this.account(report, student.collegeId, cohort, row);
        batch.push(row);
        if (batch.length >= READINESS_BATCH) {
          report.snapshotsWritten += await this.flush(batch, sources.evaluationDay);
          batch = [];
        }
      }
      report.snapshotsWritten += await this.flush(batch, sources.evaluationDay);

      if (!this.dryRun) {
        await this.closeRun(sources.evaluationDay, report, new Date());
        report.wrote = true;
      }
      this.lastEvaluationDay = sources.evaluationDay;
      this.log.info(
        { report: { ...report, sample: report.sample.length } },
        this.dryRun ? "readiness run (dry run — nothing written)" : "readiness run",
      );
    } catch (cause) {
      report.failed = true;
      report.error = cause instanceof Error ? cause.message : String(cause);
      this.log.error({ err: cause }, "readiness run failed");
      // A run that failed half way has an open ReadinessRun row with ok =
      // false. That is the honest state: the dashboard reads "the newest run
      // with ok = true", so a half-finished night is invisible to it rather
      // than half-shown.
      if (!this.dryRun && report.evaluationDay) {
        await this.noteFailure(report.evaluationDay, report.error ?? "unknown").catch(() => undefined);
      }
    }
    return report;
  }

  private async flush(batch: readonly SnapshotRow[], computedOn: string): Promise<number> {
    if (this.dryRun || batch.length === 0) return 0;
    return writeSnapshots(this.db, batch, { computedOn, rulesVersion: READINESS_RULES_VERSION });
  }

  /**
   * Open the run row BEFORE the snapshots, because a snapshot has a foreign
   * key to it. `ok` stays false until the last batch lands, so a crash
   * leaves a run the dashboard will not read rather than a partial cohort it
   * will.
   */
  private async openRun(
    sources: ReadinessSources,
    cohorts: Map<string, CohortPopulations>,
    startedAt: Date,
  ): Promise<void> {
    const computedOn = new Date(`${sources.evaluationDay}T00:00:00.000Z`);
    const cohortStats = Object.fromEntries([...cohorts.values()].map((cohort) => [cohort.cohortKey, cohort.stats]));
    await this.db.readinessRun.upsert({
      where: { computedOn },
      create: {
        computedOn,
        rulesVersion: READINESS_RULES_VERSION,
        startedAt,
        cohortStats: cohortStats as never,
      },
      // A re-run of the same day re-opens it: ok goes back to false until
      // this attempt finishes, so a dashboard reading mid-rerun sees the
      // previous night rather than a half-rewritten one.
      update: { rulesVersion: READINESS_RULES_VERSION, startedAt, finishedAt: null, ok: false, cohortStats: cohortStats as never },
    });
  }

  private async closeRun(computedOn: string, report: ReadinessReport, finishedAt: Date): Promise<void> {
    await this.db.readinessRun.update({
      where: { computedOn: new Date(`${computedOn}T00:00:00.000Z`) },
      data: {
        finishedAt,
        ok: true,
        studentsEvaluated: report.studentsEvaluated,
        notes:
          report.cohortsTooSmall.length > 0
            ? `Cohorts too small to rank in: ${report.cohortsTooSmall.join(", ")}`
            : null,
      },
    });
  }

  private async noteFailure(computedOn: string, error: string): Promise<void> {
    await this.db.readinessRun.update({
      where: { computedOn: new Date(`${computedOn}T00:00:00.000Z`) },
      data: { ok: false, notes: error.slice(0, 500) },
    });
  }

  /** Fold one student into the report. */
  private account(
    report: ReadinessReport,
    collegeId: string,
    cohort: CohortPopulations,
    row: SnapshotRow,
  ): void {
    report.studentsEvaluated += 1;
    if (row.serviceScore === null) report.unmeasurable.service += 1;
    if (row.productScore === null) report.unmeasurable.product += 1;
    if (row.topScore === null) report.unmeasurable.top += 1;

    if (report.sample.length < SAMPLE_SIZE) {
      /**
       * Every figure in the sample carries its denominator. A bare "70" in a
       * report a human reads is the exact mistake the whole phase is
       * arranged to avoid: with `mockInterviewScore` unsourced, a 70 on TOP
       * is 70 out of 85.
       */
      const show = (score: number | null, available: number) =>
        score === null ? "—" : `${score}/${available}`;
      report.sample.push({
        collegeId,
        cohort: `${cohort.cohortKey} (n=${cohort.size})`,
        service: show(row.serviceScore, row.serviceAvailableWeight),
        product: show(row.productScore, row.productAvailableWeight),
        top: show(row.topScore, row.topAvailableWeight),
        limitingTopicProduct: row.limitingTopicProduct,
      });
    }
  }
}
