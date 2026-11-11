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
      /**
       * Chosen by the CLOCK, not by `Contest.status` (Phase 12x).
       *
       * This query asked for `status IN (RUNNING, FINISHED)` — and nothing
       * in the product has ever written either one. `publishContest` sets
       * PUBLISHED and that is where a contest stays for ever; the student
       * pages compute upcoming / running / finished from `startsAt` and
       * `endsAt` through `phaseOf()`, and never read those two states. So
       * this job's own query matched nothing, on every tick, since Phase 5:
       * `rank` was null on every `ContestStanding` row ever written, and
       * `rateContest` — which refuses a contest that is not FINISHED, and
       * refuses again if any row is unranked — could never run at all.
       *
       * The manual gate for Phase 5 passed because `contest-sim.ts` writes
       * `status: "RUNNING"` itself and sets FINISHED at the end. The
       * simulation created a state the product cannot.
       *
       * Two readings were available: teach the product to advance the
       * lifecycle, or treat the clock as the authority it already is
       * everywhere a student can see. The second is the narrower one and
       * the one that does not break anything: `findLiveContestEntry`
       * decides whether a submission belongs to a contest by
       * `status: "PUBLISHED"` plus the window, so a job that moved a live
       * contest to RUNNING would have stopped submissions counting the
       * moment it started — the exact bug 12q.3 fixed, reintroduced from
       * the other end. RUNNING and FINISHED stay in the enum for the
       * simulation and for rows that already carry them.
       *
       * A board is worth ranking while the contest is live, and after it
       * ends until everybody on it has a rank. The second half is a
       * relation filter rather than a time window, so an ended board
       * settles once and then drops out of this query for good instead of
       * being re-read every fifteen seconds for ever.
       */
      const contests = await this.db.contest.findMany({
        where: {
          status: { in: ["PUBLISHED", "RUNNING", "FINISHED"] },
          startsAt: { lte: now },
          OR: [{ endsAt: { gt: now } }, { standings: { some: { rank: null } } }],
        },
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
