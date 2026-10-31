import "server-only";
import type { Prisma } from "@recx/db";
import { db } from "@/lib/db";
import { loadQueueDepths } from "@/server/queries/admin-judge";
import { JOB_STALE_AFTER_MS, toOperationViews } from "@/server/queries/super-dashboard";

/**
 * Reads for /super/jobs (SUPER_ADMIN; the page guards itself): queue depths
 * (Redis), judge backlog counters on indexed shapes, the scheduler's
 * per-job status rows, the email outbox and privileged operations that are
 * running or failed. Counts only: no student is named here.
 */

const STUCK_QUEUED_MS = 2 * 60_000;
const DAY_MS = 86_400_000;

export interface SchedulerJobRow {
  job: string;
  instance: string;
  lastStartedAt: Date;
  lastFinishedAt: Date | null;
  lastOk: boolean;
  lastError: string | null;
  consecutiveFailures: number;
  lastReport: Prisma.JsonValue;
  stale: boolean;
}

export async function loadJobsPage(now: Date) {
  const [depths, expiredLeases, queuedLong, ieToday, jobRows, outboxByStatus, oldestPending, ops] = await Promise.all([
    loadQueueDepths(),
    db.submission.count({ where: { status: "JUDGING", leaseExpiresAt: { lt: now } } }),
    db.submission.count({ where: { judgeState: { in: ["PENDING", "DISPATCHED"] }, queuedAt: { lt: new Date(now.getTime() - STUCK_QUEUED_MS) } } }),
    db.submission.count({ where: { status: "INTERNAL_ERROR", createdAt: { gte: new Date(now.getTime() - DAY_MS) } } }),
    db.schedulerJobStatus.findMany({ orderBy: { job: "asc" } }),
    db.emailOutbox.groupBy({ by: ["status"], _count: { _all: true } }),
    db.emailOutbox.findFirst({
      where: { status: { in: ["PENDING", "SENDING"] } },
      orderBy: { createdAt: "asc" },
      select: { createdAt: true },
    }),
    db.privilegedOperation.findMany({
      where: { status: { in: ["EXECUTING", "FAILED"] } },
      orderBy: { requestedAt: "desc" },
      take: 20,
      select: {
        id: true,
        kind: true,
        status: true,
        summary: true,
        reason: true,
        affectedCount: true,
        payloadSha256: true,
        requestedById: true,
        requestedAt: true,
        expiresAt: true,
        decidedById: true,
        decidedAt: true,
        breakGlass: true,
        error: true,
      },
    }),
  ]);
  const jobs: SchedulerJobRow[] = jobRows.map((r) => ({
    job: r.job,
    instance: r.instance,
    lastStartedAt: r.lastStartedAt,
    lastFinishedAt: r.lastFinishedAt,
    lastOk: r.lastOk,
    lastError: r.lastError,
    consecutiveFailures: r.consecutiveFailures,
    lastReport: r.lastReport,
    stale: now.getTime() - (r.lastFinishedAt ?? r.lastStartedAt).getTime() > JOB_STALE_AFTER_MS,
  }));
  const outbox = Object.fromEntries(outboxByStatus.map((g) => [g.status, g._count._all])) as Partial<
    Record<"PENDING" | "SENDING" | "SENT" | "FAILED", number>
  >;
  return {
    depths,
    backlog: { expiredLeases, queuedLong, ieToday },
    jobs,
    outbox,
    oldestPendingAt: oldestPending?.createdAt ?? null,
    operations: await toOperationViews(ops),
  };
}
