import type { Db } from "@recx/db";
import { appendAuditEntries } from "@recx/db/audit";
import type { Logger } from "pino";

/**
 * The 72-hour review SLA (Phase 6e).
 *
 * SPEC §5: "The maximum automatic consequence in the entire system is: flag
 * for review and withhold the result from the public leaderboard, with a
 * 72-hour review SLA after which the result publishes automatically as
 * CLEARED. The 72-hour auto-publish puts the cost of slow review on the
 * institution, not on the student's placement timeline."
 *
 * So this job is not a tidy-up. It is the mechanism that makes the ceiling on
 * automatic consequences real: without it, "withheld pending review" becomes
 * "withheld" for any student whose flag nobody opened, and a review queue
 * nobody staffed would quietly cost people their placements.
 *
 * It CLEARS. It never upholds, never penalises and never writes a score — a
 * deadline passing is not evidence of anything, and the one direction this
 * job may move a flag is the direction that helps the student.
 *
 * Also here: the appeal deadline. SPEC §5 gives an appeal 7 days and two
 * reviewers; an appeal nobody decided in that window resolves the same way,
 * in the student's favour.
 */

export interface IntegritySlaReport {
  /** Flags that reached 72 hours unreviewed and cleared themselves. */
  autoCleared: number;
  /** Appeals that reached 7 days undecided and were overturned. */
  appealsOverturned: number;
  failed: boolean;
  error?: string;
}

/** Bounded, so one tick cannot run long on a backlog. */
const BATCH = 200;

export class IntegritySlaJob {
  private readonly db: Db;
  private readonly log: Logger;
  private readonly dryRun: boolean;

  constructor(options: { db: Db; log: Logger; dryRun: boolean }) {
    this.db = options.db;
    this.log = options.log;
    this.dryRun = options.dryRun;
  }

  async tick(now: Date): Promise<IntegritySlaReport> {
    const report: IntegritySlaReport = { autoCleared: 0, appealsOverturned: 0, failed: false };
    try {
      report.autoCleared = await this.clearOverdueFlags(now);
      report.appealsOverturned = await this.resolveOverdueAppeals(now);
    } catch (cause) {
      report.failed = true;
      report.error = cause instanceof Error ? cause.message : String(cause);
      this.log.error({ err: cause }, "integrity SLA tick failed");
    }
    return report;
  }

  /**
   * Clear every flag whose 72 hours are up.
   *
   * Conditional on `status = 'OPEN'`, so a flag a reviewer resolved in the
   * same second is not re-resolved; the `IntegrityFlag_write_once` trigger
   * refuses a reopen anyway.
   */
  private async clearOverdueFlags(now: Date): Promise<number> {
    const overdue = await this.db.integrityFlag.findMany({
      where: { status: "OPEN", reviewDeadline: { lte: now } },
      orderBy: { reviewDeadline: "asc" },
      take: BATCH,
      select: { id: true, band: true, flaggedAt: true, attempt: { select: { userId: true, id: true } } },
    });
    if (overdue.length === 0) return 0;
    if (this.dryRun) {
      this.log.info({ count: overdue.length }, "would auto-clear overdue integrity flags");
      return overdue.length;
    }

    let cleared = 0;
    for (const flag of overdue) {
      const moved = await this.db.integrityFlag.updateMany({
        where: { id: flag.id, status: "OPEN" },
        data: { status: "AUTO_CLEARED", resolvedAt: now, withheld: false },
      });
      if (moved.count !== 1) continue;
      cleared++;
      await appendAuditEntries(this.db, [
        {
          actorId: null,
          action: "integrity.flag.auto_cleared",
          entityType: "IntegrityFlag",
          entityId: flag.id,
          targetUserId: flag.attempt.userId,
          metadata: {
            attemptId: flag.attempt.id,
            band: flag.band,
            flaggedAt: flag.flaggedAt.toISOString(),
            at: now.toISOString(),
            note:
              "Nobody reviewed this within 72 hours, so the result published automatically as cleared. " +
              "The cost of a slow review falls on the institution, not on the student.",
          },
        },
      ]);
    }
    if (cleared > 0) {
      // Loud on purpose: a rising number here is a staffing problem, and the
      // students it affects never hear about it.
      this.log.warn({ cleared }, "integrity flags auto-cleared at the 72-hour SLA (nobody reviewed them)");
    }
    return cleared;
  }

  /**
   * An appeal nobody decided within 7 days is resolved in the student's
   * favour, and the flag it was about is overturned.
   *
   * The same reasoning as the 72-hour rule: a student who appealed and waited
   * must not be worse off than one who did not, and the institution owns the
   * delay.
   */
  private async resolveOverdueAppeals(now: Date): Promise<number> {
    const overdue = await this.db.integrityAppeal.findMany({
      where: { outcome: "PENDING", decideBy: { lte: now } },
      orderBy: { decideBy: "asc" },
      take: BATCH,
      select: { id: true, flagId: true, studentId: true, submittedAt: true },
    });
    if (overdue.length === 0) return 0;
    if (this.dryRun) {
      this.log.info({ count: overdue.length }, "would resolve overdue appeals in the student's favour");
      return overdue.length;
    }

    let resolved = 0;
    for (const appeal of overdue) {
      // The flag first: an OVERTURNED flag is only reachable from UPHELD, so
      // a flag that has since been cleared another way simply stays cleared
      // and the appeal is recorded as overturned anyway — the student is not
      // left waiting on a row that cannot move.
      await this.db.integrityFlag.updateMany({
        where: { id: appeal.flagId, status: "UPHELD" },
        data: { status: "OVERTURNED", withheld: false, resolvedAt: now },
      });
      const moved = await this.db.integrityAppeal.updateMany({
        where: { id: appeal.id, outcome: "PENDING" },
        data: { outcome: "OVERTURNED", resolvedAt: now },
      });
      if (moved.count !== 1) continue;
      resolved++;
      await appendAuditEntries(this.db, [
        {
          actorId: null,
          action: "integrity.appeal.auto_overturned",
          entityType: "IntegrityAppeal",
          entityId: appeal.id,
          targetUserId: appeal.studentId,
          sensitivity: "SENSITIVE",
          metadata: {
            flagId: appeal.flagId,
            submittedAt: appeal.submittedAt.toISOString(),
            at: now.toISOString(),
            note:
              "Nobody decided this appeal within 7 days, so it resolved in the student's favour. " +
              "A student who appealed and waited must not be worse off than one who did not.",
          },
        },
      ]);
    }
    if (resolved > 0) {
      this.log.warn({ resolved }, "appeals resolved in the student's favour at the 7-day deadline (undecided)");
    }
    return resolved;
  }
}
