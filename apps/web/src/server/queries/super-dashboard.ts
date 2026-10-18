import "server-only";
import type { PrivilegedOperationKind, PrivilegedOperationStatus } from "@recx/db";
import { RECONCILER_INTERVAL_MS, SCHEDULER_JOB_NAMES, SECURITY_EMAIL_KIND_PREFIX } from "@recx/shared";
import { chainDayOf } from "@/lib/audit-chain";
import { db } from "@/lib/db";
import { getFeatureFlags } from "@/lib/flags";
import { privilegedPayloadSchemas } from "@/lib/privileged/payloads";
import { readRetention } from "@/lib/privileged/retention";
import { terminalHashOf } from "@/server/queries/super-audit";

/** Reads for /super (the overview). The page guards itself. */

export interface OperationView {
  id: string;
  kind: PrivilegedOperationKind;
  status: PrivilegedOperationStatus;
  summary: string;
  reason: string;
  affectedCount: number;
  payloadSha256: string;
  requestedById: string;
  requestedBy: string;
  requestedAt: Date;
  expiresAt: Date;
  decidedBy: string | null;
  decidedAt: Date | null;
  breakGlass: boolean;
  error: string | null;
  /**
   * A PENDING bulk status change: who is in the approved id list, so the
   * approver can see what they approve (accounts by role, and every
   * non-student named). Null for other kinds and decided requests.
   */
  targets: BulkTargets | null;
}

export interface BulkTargets {
  byRole: { role: string; count: number }[];
  /** Every staff or super-admin account in the set, "First Last (roll)". */
  staff: string[];
  /** Ids in the payload that no longer match an account. */
  missing: number;
}

export async function namesOf(ids: readonly string[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter(Boolean))];
  if (unique.length === 0) return new Map();
  const users = await db.user.findMany({
    where: { id: { in: unique } },
    select: { id: true, firstName: true, lastName: true, collegeId: true },
  });
  return new Map(users.map((u) => [u.id, `${u.firstName} ${u.lastName} (${u.collegeId})`]));
}

const OP_SELECT = {
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
} as const;

type OpRow = {
  /** Only the PENDING lists select it (to resolve a bulk change's targets). */
  payload?: unknown;
  id: string;
  kind: PrivilegedOperationKind;
  status: PrivilegedOperationStatus;
  summary: string;
  reason: string;
  affectedCount: number;
  payloadSha256: string;
  requestedById: string;
  requestedAt: Date;
  expiresAt: Date;
  decidedById: string | null;
  decidedAt: Date | null;
  breakGlass: boolean;
  error: string | null;
};

async function bulkTargets(row: OpRow): Promise<BulkTargets | null> {
  if (row.kind !== "BULK_STATUS_CHANGE" || row.status !== "PENDING" || row.payload === undefined) return null;
  const parsed = privilegedPayloadSchemas.BULK_STATUS_CHANGE.safeParse(row.payload);
  if (!parsed.success) return null;
  const users = await db.user.findMany({
    where: { id: { in: parsed.data.userIds } },
    select: { role: true, firstName: true, lastName: true, collegeId: true },
    orderBy: { collegeId: "asc" },
  });
  const counts = new Map<string, number>();
  for (const u of users) counts.set(u.role, (counts.get(u.role) ?? 0) + 1);
  return {
    byRole: [...counts].map(([role, count]) => ({ role, count })).sort((a, b) => b.count - a.count),
    staff: users.filter((u) => u.role !== "STUDENT").map((u) => `${u.firstName} ${u.lastName} (${u.collegeId})`),
    missing: parsed.data.userIds.length - users.length,
  };
}

export async function toOperationViews(rows: readonly OpRow[]): Promise<OperationView[]> {
  const names = await namesOf(rows.flatMap((r) => [r.requestedById, r.decidedById ?? ""]));
  const targets = await Promise.all(rows.map(bulkTargets));
  return rows.map((r, i) => ({
    id: r.id,
    kind: r.kind,
    status: r.status,
    summary: r.summary,
    reason: r.reason,
    affectedCount: r.affectedCount,
    payloadSha256: r.payloadSha256,
    requestedById: r.requestedById,
    requestedBy: names.get(r.requestedById) ?? "unknown account",
    requestedAt: r.requestedAt,
    expiresAt: r.expiresAt,
    decidedBy: r.decidedById ? (names.get(r.decidedById) ?? "unknown account") : null,
    decidedAt: r.decidedAt,
    breakGlass: r.breakGlass,
    error: r.error,
    targets: targets[i] ?? null,
  }));
}

export interface JobHealth {
  job: string;
  lastStartedAt: Date | null;
  lastOk: boolean | null;
  lastError: string | null;
  consecutiveFailures: number;
  stale: boolean;
}

/** A job is stale when it has not finished a tick in 3 reconciler intervals. */
export const JOB_STALE_AFTER_MS = 3 * RECONCILER_INTERVAL_MS;

export async function loadJobHealth(now: Date): Promise<JobHealth[]> {
  const rows = await db.schedulerJobStatus.findMany();
  const byJob = new Map(rows.map((r) => [r.job, r]));
  return SCHEDULER_JOB_NAMES.map((job) => {
    const r = byJob.get(job);
    const last = r?.lastFinishedAt ?? r?.lastStartedAt ?? null;
    return {
      job,
      lastStartedAt: r?.lastStartedAt ?? null,
      lastOk: r ? r.lastOk : null,
      lastError: r?.lastError ?? null,
      consecutiveFailures: r?.consecutiveFailures ?? 0,
      stale: !last || now.getTime() - last.getTime() > JOB_STALE_AFTER_MS,
    };
  });
}

export interface MailHealth {
  transport: string | null;
  pendingSecurity: number;
  failedSecurity: number;
  oldestPendingAt: Date | null;
}

export async function loadMailHealth(): Promise<MailHealth> {
  const security = { startsWith: SECURITY_EMAIL_KIND_PREFIX };
  const [status, pendingSecurity, failedSecurity, oldest] = await Promise.all([
    db.schedulerJobStatus.findUnique({ where: { job: "outbox" }, select: { lastReport: true } }),
    db.emailOutbox.count({ where: { status: { in: ["PENDING", "SENDING"] }, kind: security } }),
    db.emailOutbox.count({ where: { status: "FAILED", kind: security } }),
    db.emailOutbox.findFirst({
      where: { status: { in: ["PENDING", "SENDING"] } },
      orderBy: { createdAt: "asc" },
      select: { createdAt: true },
    }),
  ]);
  const report = status?.lastReport;
  const transport =
    report && typeof report === "object" && !Array.isArray(report) && typeof report.transport === "string"
      ? report.transport
      : null;
  return { transport, pendingSecurity, failedSecurity, oldestPendingAt: oldest?.createdAt ?? null };
}

export async function loadSuperDashboard(actorId: string, now: Date) {
  const today = chainDayOf(now);
  const [awaiting, mine, recent, liveImpersonations, retention, mail, jobs, chain, flags] = await Promise.all([
    db.privilegedOperation.findMany({
      where: { status: "PENDING", expiresAt: { gt: now }, requestedById: { not: actorId } },
      orderBy: { requestedAt: "asc" },
      take: 50,
      select: { ...OP_SELECT, payload: true },
    }),
    db.privilegedOperation.findMany({
      where: { status: "PENDING", expiresAt: { gt: now }, requestedById: actorId },
      orderBy: { requestedAt: "asc" },
      take: 50,
      select: { ...OP_SELECT, payload: true },
    }),
    db.privilegedOperation.findMany({
      where: { status: { not: "PENDING" } },
      orderBy: { requestedAt: "desc" },
      take: 15,
      select: OP_SELECT,
    }),
    db.impersonationSession.count({ where: { endedAt: null, expiresAt: { gt: now } } }),
    readRetention(),
    loadMailHealth(),
    loadJobHealth(now),
    terminalHashOf(db, today),
    getFeatureFlags(),
  ]);
  return {
    awaiting: await toOperationViews(awaiting),
    mine: await toOperationViews(mine),
    recent: await toOperationViews(recent),
    liveImpersonations,
    retention,
    mail,
    jobs,
    chain: { day: today, ...chain },
    flags,
  };
}
