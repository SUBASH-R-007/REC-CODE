import type { Db } from "@recx/db";
import { dueMockAttempts, finaliseMock, recomputePatternStats } from "@recx/db/mock";
import { MOCK_PERCENTILE_MIN_ATTEMPTS } from "@recx/shared";
import type { Logger } from "pino";

/**
 * The mock sweep (Phase 7c). Two passes.
 *
 * Both exist because the design depends on them and the models would be
 * nonsense without them:
 *
 *   * `MockAttemptStatus.AUTO_SUBMITTED` is only reachable from here. A
 *     candidate who closes the laptop with twenty minutes left must not be
 *     left IN_PROGRESS for ever, holding a `@@unique([patternId, userId,
 *     attemptNumber])` slot they cannot use and a result page that never
 *     arrives.
 *   * `MockPattern.medianPercent` and `finalizedAttemptCount` are what
 *     decide whether the mock XP percentile term is meaningful yet
 *     (`MOCK_PERCENTILE_MIN_ATTEMPTS`). Nothing else maintains them, and a
 *     denormalised column nobody maintains drifts.
 *
 * Finalising at a deadline is a DEADLINE, not a penalty — the same character
 * as Phase 6b's auto-submit. This job scores the work the candidate has; it
 * cannot void it, flag it or mark it, and `MockAttemptStatus` has no VOIDED
 * value to reach.
 *
 * Safe with two scheduler instances: `dueMockAttempts` claims rows with FOR
 * UPDATE SKIP LOCKED and `finaliseMock`'s status move is conditional on
 * IN_PROGRESS, so a sitting another instance is finalising is passed over
 * rather than scored twice.
 */

/** Every 30 seconds. A practice mock's deadline is not an exam's, and the lazy check on the sitting page catches it sooner. */
export const MOCK_SWEEP_INTERVAL_MS = 30_000;
export const MOCK_SWEEP_BATCH = 100;

/**
 * The statistics pass is nightly, not per tick: a median that moves between
 * two candidates' finalises would make two identical papers pay different XP
 * for no reason either of them could see.
 */
export const MOCK_STATS_INTERVAL_MS = 24 * 3_600_000;

export interface MockSweepReport {
  /** Sittings finalised at their deadline. */
  autoSubmitted: number;
  /** Patterns whose cohort statistics were recomputed. */
  patternsRestated: number;
  /** Patterns that now have enough of a cohort for the percentile term. */
  patternsWithCohort: number;
  /**
   * The worst lateness in this batch, in milliseconds. A number that keeps
   * climbing means the sweep is not keeping up, which is a capacity signal
   * and not a student's problem.
   */
  worstLatenessMs: number;
  failed: boolean;
  error?: string;
}

export class MockSweepJob {
  private readonly db: Db;
  private readonly log: Logger;
  private readonly dryRun: boolean;
  private lastStatsAt: number | null = null;

  constructor(options: { db: Db; log: Logger; dryRun: boolean }) {
    this.db = options.db;
    this.log = options.log;
    this.dryRun = options.dryRun;
  }

  async tick(now: Date): Promise<MockSweepReport> {
    const report: MockSweepReport = {
      autoSubmitted: 0,
      patternsRestated: 0,
      patternsWithCohort: 0,
      worstLatenessMs: 0,
      failed: false,
    };
    try {
      const swept = await this.finaliseOverdue(now);
      report.autoSubmitted = swept.finalised;
      report.worstLatenessMs = swept.worstLatenessMs;

      if (this.statsAreDue(now)) {
        const stats = await this.restatePatterns(now);
        report.patternsRestated = stats.restated;
        report.patternsWithCohort = stats.withCohort;
      }
    } catch (cause) {
      report.failed = true;
      report.error = cause instanceof Error ? cause.message : String(cause);
      this.log.error({ err: cause }, "mock sweep tick failed");
    }
    return report;
  }

  private async finaliseOverdue(now: Date): Promise<{ finalised: number; worstLatenessMs: number }> {
    const due = await dueMockAttempts(this.db, MOCK_SWEEP_BATCH);
    if (due.length === 0) return { finalised: 0, worstLatenessMs: 0 };
    if (this.dryRun) {
      this.log.info({ count: due.length }, "would finalise overdue mock sittings");
      return { finalised: due.length, worstLatenessMs: 0 };
    }

    let finalised = 0;
    let worstLatenessMs = 0;
    for (const attemptId of due) {
      const before = await this.db.mockAttempt.findUnique({
        where: { id: attemptId },
        select: { expiresAt: true },
      });
      const result = await finaliseMock(this.db, { attemptId, userId: null, at: now, auto: true });
      if (!result || result.alreadyFinalised) continue;
      finalised++;
      if (before) {
        worstLatenessMs = Math.max(worstLatenessMs, now.getTime() - before.expiresAt.getTime());
      }
    }
    if (finalised > 0) {
      this.log.info({ finalised, worstLatenessMs }, "finalised overdue mock sittings at their deadline");
    }
    return { finalised, worstLatenessMs };
  }

  private statsAreDue(now: Date): boolean {
    if (this.lastStatsAt === null) return true;
    return now.getTime() - this.lastStatsAt >= MOCK_STATS_INTERVAL_MS;
  }

  private async restatePatterns(now: Date): Promise<{ restated: number; withCohort: number }> {
    if (this.dryRun) {
      this.log.info("would recompute mock pattern statistics");
      return { restated: 0, withCohort: 0 };
    }
    const stats = await recomputePatternStats(this.db);
    // The clock the tick was GIVEN, never Date.now(): a job that mixes the
    // two is a job whose cadence cannot be tested and whose behaviour
    // depends on how long its own queries took.
    this.lastStatsAt = now.getTime();
    const withCohort = stats.filter((row) => row.finalizedAttemptCount >= MOCK_PERCENTILE_MIN_ATTEMPTS).length;
    this.log.info({ restated: stats.length, withCohort }, "recomputed mock pattern statistics");
    return { restated: stats.length, withCohort };
  }
}
