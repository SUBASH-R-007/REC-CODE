import os from "node:os";
import type { Db, Prisma } from "@recx/db";
import type { SchedulerJobName } from "@recx/shared";

/**
 * SchedulerJobStatus: one row per job, upserted after every tick of it (never
 * in --dry-run). /super/jobs reads it to show when each job last ran, whether
 * it worked, and how many ticks in a row have failed. Reports hold counts
 * only: no addresses, tokens or credentials.
 */

export interface JobOutcome {
  startedAt: Date;
  finishedAt: Date;
  ok: boolean;
  error?: string | null;
  report?: unknown;
}

/** "host:pid" — which scheduler instance wrote the row. */
export function schedulerInstance(): string {
  return `${os.hostname()}:${process.pid}`;
}

/** A JSON-safe copy of a report (bigints as strings, Dates as ISO strings). */
export function jsonReport(report: unknown): Prisma.InputJsonValue {
  if (report === undefined) return {};
  return JSON.parse(
    JSON.stringify(report, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v)),
  ) as Prisma.InputJsonValue;
}

export async function recordJobStatus(
  db: Db,
  job: SchedulerJobName,
  outcome: JobOutcome,
  dryRun: boolean,
  instance: string = schedulerInstance(),
): Promise<void> {
  if (dryRun) return;
  const error = outcome.ok ? null : (outcome.error ?? "failed").slice(0, 500);
  const report = jsonReport(outcome.report);
  await db.schedulerJobStatus.upsert({
    where: { job },
    create: {
      job,
      instance,
      lastStartedAt: outcome.startedAt,
      lastFinishedAt: outcome.finishedAt,
      lastOk: outcome.ok,
      lastError: error,
      lastReport: report,
      consecutiveFailures: outcome.ok ? 0 : 1,
    },
    update: {
      instance,
      lastStartedAt: outcome.startedAt,
      lastFinishedAt: outcome.finishedAt,
      lastOk: outcome.ok,
      lastError: error,
      lastReport: report,
      consecutiveFailures: outcome.ok ? 0 : { increment: 1 },
    },
  });
}
