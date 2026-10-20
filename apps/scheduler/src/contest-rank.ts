import { CONTEST_RANK_INTERVAL_MS, rankStandings } from "@recx/shared";
import type { Logger } from "pino";
import type { Db } from "@recx/db";

/**
 * The contest rank job (Phase 5).
 *
 * SPEC §4e: "rank is recomputed by ONE job every 15 seconds, never per
 * submission (5,000 rank renumberings per minute is a deadlock generator)".
 * The judge-finalise transaction writes the student's own score, penalty and
 * solved count; this is the only writer of `rank`.
 *
 * It reads ContestStanding (already materialised from the authoritative
 * attempts) rather than recomputing from attempts, so the pass is one query
 * plus one UPDATE per row whose rank actually moved. The order and the tie
 * rule come from @recx/shared, so this and `rebuild-standings` cannot
 * disagree.
 *
 * Safe with two scheduler instances: every write is an idempotent
 * "set rank to this value", so two instances racing converge on the same
 * board rather than corrupting it. Running it twice changes nothing.
 */

export interface ContestRankReport {
  /** Contests considered (RUNNING, or FINISHED but not yet rated). */
  contests: number;
  /** Rows whose rank changed. */
  reranked: number;
  /** Contests skipped because nothing moved. */
  unchanged: number;
  failed: boolean;
  error?: string;
}

export class ContestRankJob {
  private readonly db: Db;
  private readonly log: Logger;
  private readonly dryRun: boolean;
  /**
   * Last run, so the tick can honour the 15-second cadence inside a 10 s
   * loop. -Infinity, not 0, so "never run" is unambiguous whatever the
   * clock reads — 0 would mean "ran at the epoch" and leaves the first tick
   * undecided for any clock inside the first 15 seconds of 1970.
   */
  private lastRunMs = Number.NEGATIVE_INFINITY;

  constructor(options: { db: Db; log: Logger; dryRun: boolean }) {
    this.db = options.db;
    this.log = options.log;
    this.dryRun = options.dryRun;
  }

  /** True when enough time has passed for another pass. */
  due(now: Date): boolean {
    return now.getTime() - this.lastRunMs >= CONTEST_RANK_INTERVAL_MS;
  }

  async tick(now: Date): Promise<ContestRankReport> {
    const report: ContestRankReport = { contests: 0, reranked: 0, unchanged: 0, failed: false };
    if (!this.due(now)) return report;
    this.lastRunMs = now.getTime();

    try {
      // A board is worth ranking while the contest is live, and once more
      // after it ends so the final board is right before rating. A RATED
      // contest is finished with everybody already placed.
      const contests = await this.db.contest.findMany({
        where: { status: { in: ["RUNNING", "FINISHED"] } },
        select: { id: true, kind: true, slug: true },
      });
      report.contests = contests.length;

      for (const contest of contests) {
        const rows = await this.db.contestStanding.findMany({
          where: { contestId: contest.id },
          select: { userId: true, score: true, penalty: true, solved: true, lastAcceptedAt: true, rank: true },
        });
        if (rows.length === 0) {
          report.unchanged++;
          continue;
        }

        const ranked = rankStandings(
          rows.map((r) => ({
            userId: r.userId,
            score: r.score,
            penalty: r.penalty,
            solved: r.solved,
            lastAcceptedMinutes: r.lastAcceptedAt ? r.lastAcceptedAt.getTime() : null,
          })),
          contest.kind,
        );
        const current = new Map(rows.map((r) => [r.userId, r.rank]));
        const moved = ranked.filter((row) => current.get(row.userId) !== row.rank);

        if (moved.length === 0) {
          report.unchanged++;
          continue;
        }
        if (this.dryRun) {
          report.reranked += moved.length;
          continue;
        }

        await this.db.$transaction([
          ...moved.map((row) =>
            this.db.contestStanding.update({
              where: { contestId_userId: { contestId: contest.id, userId: row.userId } },
              data: { rank: row.rank },
            }),
          ),
          this.db.contest.update({
            where: { id: contest.id },
            data: { standingsVersion: { increment: 1 } },
          }),
        ]);
        report.reranked += moved.length;
        this.log.debug({ contest: contest.slug, moved: moved.length }, "contest board reranked");
      }
    } catch (error) {
      report.failed = true;
      report.error = error instanceof Error ? error.message : String(error);
      this.log.error({ err: error }, "contest rank job failed");
    }
    return report;
  }
}
