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
 *      (audit privileged.failed; the process running them stopped), and
 *      operations APPROVED more than 15 minutes ago that never started →
 *      EXECUTING → FAILED in one transaction (the process died between the
 *      approval and the claim; nothing else can move an APPROVED row);
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
const UNSTARTED_ERROR =
  "Approved but never started within 15 minutes (the process stopped before running it). Request it again if it is still needed.";

export type SweepAction = "expire" | "fail-stale" | "fail-unstarted" | "keep";

/** Pure mirror of the SQL predicates (dry-run reporting and tests). */
export function classifyPrivilegedOperation(
  row: { status: PrivilegedOperationStatus; expiresAt: Date; executionStartedAt: Date | null; decidedAt?: Date | null },
  now: Date,
  staleMs: number = PRIVILEGED_EXECUTION_STALE_MS,
): SweepAction {
  if (row.status === "PENDING" && row.expiresAt.getTime() <= now.getTime()) return "expire";
  if (row.status === "APPROVED" && row.decidedAt && now.getTime() - row.decidedAt.getTime() > staleMs) return "fail-unstarted";
  if (
    row.status === "EXECUTING" &&
    row.executionStartedAt !== null &&
    now.getTime() - row.executionStartedAt.getTime() > staleMs
  ) {
    return "fail-stale";
  }
  return "keep";
}

export interface GovernanceReport {
  dryRun: boolean;
  expired: number;
  failedStale: number;
  failedUnstarted: number;
  impersonationsClosed: number;
}

export class GovernanceSweepJob {
  constructor(
    private readonly deps: {
      db: Db;
      log: Logger;
      dryRun: boolean;
      /** How long an APPROVED row may wait for its claim (tests shorten it; default 15 minutes). */
      unstartedAfterMs?: number;
    },
  ) {}

  async tick(): Promise<GovernanceReport> {
    const { db, log, dryRun } = this.deps;
    const unstartedSeconds = (this.deps.unstartedAfterMs ?? PRIVILEGED_EXECUTION_STALE_MS) / 1000;
    if (dryRun) {
      const [expired, failedStale, failedUnstarted, impersonationsClosed] = await Promise.all([
        db.$queryRaw<{ n: bigint }[]>`
          SELECT count(*) AS n FROM "PrivilegedOperation" WHERE status = 'PENDING' AND "expiresAt" <= now()`,
        db.$queryRaw<{ n: bigint }[]>`
          SELECT count(*) AS n FROM "PrivilegedOperation"
           WHERE status = 'EXECUTING'
             AND "executionStartedAt" < (now() AT TIME ZONE 'UTC') - make_interval(secs => ${STALE_SECONDS})`,
        db.$queryRaw<{ n: bigint }[]>`
          SELECT count(*) AS n FROM "PrivilegedOperation"
           WHERE status = 'APPROVED'
             AND "decidedAt" < (now() AT TIME ZONE 'UTC') - make_interval(secs => ${unstartedSeconds})`,
        db.$queryRaw<{ n: bigint }[]>`
          SELECT count(*) AS n FROM "ImpersonationSession"
           WHERE "endedAt" IS NULL AND "expiresAt" <= (now() AT TIME ZONE 'UTC')`,
      ]);
      return {
        dryRun,
        expired: Number(expired[0]?.n ?? 0),
        failedStale: Number(failedStale[0]?.n ?? 0),
        failedUnstarted: Number(failedUnstarted[0]?.n ?? 0),
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

    // The trigger lets an APPROVED row out only to EXECUTING (executionStartedAt
    // set once), and an EXECUTING row out to FAILED (executedAt and error set
    // once): two UPDATEs, one transaction. The web app's claim
    // (APPROVED → EXECUTING) is conditional, so a late claim simply finds the
    // row gone and reports a conflict.
    const failedUnstarted = await db.$transaction(async (tx) => {
      const claimed = await tx.$queryRaw<{ id: string }[]>`
        UPDATE "PrivilegedOperation"
           SET status = 'EXECUTING', "executionStartedAt" = (now() AT TIME ZONE 'UTC')
         WHERE status = 'APPROVED'
           AND "decidedAt" < (now() AT TIME ZONE 'UTC') - make_interval(secs => ${unstartedSeconds})
        RETURNING id`;
      if (claimed.length === 0) return 0;
      const ids = claimed.map((r) => r.id);
      const rows = await tx.$queryRaw<{ id: string; kind: PrivilegedOperationKind; summary: string }[]>`
        UPDATE "PrivilegedOperation"
           SET status = 'FAILED', "executedAt" = (now() AT TIME ZONE 'UTC'), error = ${UNSTARTED_ERROR}
         WHERE id = ANY(${ids}::text[]) AND status = 'EXECUTING'
        RETURNING id, kind, summary`;
      await appendAuditEntriesInTx(
        tx,
        rows.map(
          (r): AuditEntryInput => ({
            actorId: null,
            action: "privileged.failed",
            entityType: "PrivilegedOperation",
            entityId: r.id,
            sensitivity: r.kind === "PII_EXPORT" ? "SECURITY" : "SENSITIVE",
            metadata: { kind: r.kind, summary: r.summary, error: UNSTARTED_ERROR, via: "governance-sweep" },
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

    const report: GovernanceReport = { dryRun, expired, failedStale, failedUnstarted, impersonationsClosed };
    if (expired + failedStale + failedUnstarted + impersonationsClosed > 0) log.info({ report }, "governance sweep");
    return report;
  }
}
