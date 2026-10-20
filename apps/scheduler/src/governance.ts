import type { Db, PrivilegedOperationKind, PrivilegedOperationStatus } from "@recx/db";
import { appendAuditEntriesInTx, type AuditEntryInput } from "@recx/db/audit";
import { PRIVILEGED_EXECUTION_STALE_MS } from "@recx/shared";
import type { Logger } from "pino";

/**
 * Governance sweep, every tick:
 *
 *   1. PENDING privileged operations past expiresAt → EXPIRED
 *      (audit privileged.expired, NORMAL; the requester gets a notification);
 *   2. operations stuck EXECUTING for more than 15 minutes → FAILED
 *      (audit privileged.failed; the process running them stopped);
 *   3. impersonations past expiresAt and still open → ended EXPIRED, the
 *      session pointer cleared (audit impersonation.ended, SECURITY).
 *
 * Rows are chosen IN SQL against the database clock with the same predicate
 * the database triggers check, so a row the trigger considers not yet
 * expired can never abort the batch. Each category is one transaction whose
 * UPDATE … RETURNING and audit rows commit together: exactly one path (this
 * sweep, or the web app's closeImpersonation, both conditional on the row
 * still being open) writes each end audit.
 */

const STALE_SECONDS = Math.round(PRIVILEGED_EXECUTION_STALE_MS / 1000);
const STALE_ERROR =
  "Execution did not finish within 15 minutes (the process running it probably stopped). Request it again if it is still needed.";

export type SweepAction = "expire" | "fail-stale" | "keep";

/** Pure mirror of the SQL predicates (dry-run reporting and tests). */
export function classifyPrivilegedOperation(
  row: { status: PrivilegedOperationStatus; expiresAt: Date; executionStartedAt: Date | null },
  now: Date,
): SweepAction {
  if (row.status === "PENDING" && row.expiresAt.getTime() <= now.getTime()) return "expire";
  if (
    row.status === "EXECUTING" &&
    row.executionStartedAt !== null &&
    now.getTime() - row.executionStartedAt.getTime() > PRIVILEGED_EXECUTION_STALE_MS
  ) {
    return "fail-stale";
  }
  return "keep";
}

export interface GovernanceReport {
  dryRun: boolean;
  expired: number;
  failedStale: number;
  impersonationsClosed: number;
}

export class GovernanceSweepJob {
  constructor(private readonly deps: { db: Db; log: Logger; dryRun: boolean }) {}

  async tick(): Promise<GovernanceReport> {
    const { db, log, dryRun } = this.deps;
    if (dryRun) {
      const [expired, failedStale, impersonationsClosed] = await Promise.all([
        db.$queryRaw<{ n: bigint }[]>`
          SELECT count(*) AS n FROM "PrivilegedOperation" WHERE status = 'PENDING' AND "expiresAt" <= now()`,
        db.$queryRaw<{ n: bigint }[]>`
          SELECT count(*) AS n FROM "PrivilegedOperation"
           WHERE status = 'EXECUTING'
             AND "executionStartedAt" < (now() AT TIME ZONE 'UTC') - make_interval(secs => ${STALE_SECONDS})`,
        db.$queryRaw<{ n: bigint }[]>`
          SELECT count(*) AS n FROM "ImpersonationSession"
           WHERE "endedAt" IS NULL AND "expiresAt" <= (now() AT TIME ZONE 'UTC')`,
      ]);
      return {
        dryRun,
        expired: Number(expired[0]?.n ?? 0),
        failedStale: Number(failedStale[0]?.n ?? 0),
        impersonationsClosed: Number(impersonationsClosed[0]?.n ?? 0),
      };
    }

    const expired = await db.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<
        { id: string; kind: PrivilegedOperationKind; requestedById: string; summary: string; expiresAt: Date }[]
      >`
        UPDATE "PrivilegedOperation" SET status = 'EXPIRED'
         WHERE status = 'PENDING' AND "expiresAt" <= now()
        RETURNING id, kind, "requestedById", summary, "expiresAt"`;
      if (rows.length === 0) return 0;
      await tx.notification.createMany({
        data: rows.map((r) => ({
          userId: r.requestedById,
          kind: "privileged.expired",
          title: "Privileged request expired",
          body: `No second super-admin decided within 24 hours: ${r.summary}`.slice(0, 200),
          link: "/super",
        })),
      });
      await appendAuditEntriesInTx(
        tx,
        rows.map(
          (r): AuditEntryInput => ({
            actorId: null,
            action: "privileged.expired",
            entityType: "PrivilegedOperation",
            entityId: r.id,
            sensitivity: "NORMAL",
            metadata: { kind: r.kind, summary: r.summary, expiresAt: r.expiresAt.toISOString() },
          }),
        ),
      );
      return rows.length;
    });

    const failedStale = await db.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ id: string; kind: PrivilegedOperationKind; summary: string }[]>`
        UPDATE "PrivilegedOperation"
           SET status = 'FAILED', "executedAt" = (now() AT TIME ZONE 'UTC'), error = ${STALE_ERROR}
         WHERE status = 'EXECUTING'
           AND "executionStartedAt" < (now() AT TIME ZONE 'UTC') - make_interval(secs => ${STALE_SECONDS})
        RETURNING id, kind, summary`;
      if (rows.length === 0) return 0;
      await appendAuditEntriesInTx(
        tx,
        rows.map(
          (r): AuditEntryInput => ({
            actorId: null,
            action: "privileged.failed",
            entityType: "PrivilegedOperation",
            entityId: r.id,
            sensitivity: r.kind === "PII_EXPORT" ? "SECURITY" : "SENSITIVE",
            metadata: { kind: r.kind, summary: r.summary, error: STALE_ERROR, via: "governance-sweep" },
          }),
        ),
      );
      return rows.length;
    });

    const impersonationsClosed = await db.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<
        { id: string; impersonatorId: string; targetUserId: string; startedAt: Date; expiresAt: Date; endedAt: Date }[]
      >`
        UPDATE "ImpersonationSession"
           SET "endedAt" = GREATEST((now() AT TIME ZONE 'UTC'), "startedAt"), "endReason" = 'EXPIRED'
         WHERE "endedAt" IS NULL AND "expiresAt" <= (now() AT TIME ZONE 'UTC')
        RETURNING id, "impersonatorId", "targetUserId", "startedAt", "expiresAt", "endedAt"`;
      if (rows.length === 0) return 0;
      const ids = rows.map((r) => r.id);
      await tx.session.updateMany({ where: { impersonationId: { in: ids } }, data: { impersonationId: null } });
      await appendAuditEntriesInTx(
        tx,
        rows.map(
          (r): AuditEntryInput => ({
            actorId: null,
            action: "impersonation.ended",
            entityType: "ImpersonationSession",
            entityId: r.id,
            targetUserId: r.targetUserId,
            sensitivity: "SECURITY",
            metadata: {
              endReason: "EXPIRED",
              impersonatorId: r.impersonatorId,
              startedAt: r.startedAt.toISOString(),
              expiresAt: r.expiresAt.toISOString(),
              endedAt: r.endedAt.toISOString(),
            },
          }),
        ),
      );
      return rows.length;
    });

    const report: GovernanceReport = { dryRun, expired, failedStale, impersonationsClosed };
    if (expired + failedStale + impersonationsClosed > 0) log.info({ report }, "governance sweep");
    return report;
  }
}
