import type { Db } from "@recx/db";
import { appendAuditEntriesInTx } from "@recx/db/audit";
import { SECURITY_EMAIL_KIND_PREFIX } from "@recx/shared";
import type { Logger } from "pino";
import { redactMailError, type MailTransport } from "./mail";

/**
 * EmailOutbox drain. Each tick claims up to OUTBOX_BATCH due rows with
 * FOR UPDATE SKIP LOCKED (two scheduler instances never take the same row),
 * leases them for OUTBOX_LEASE_MS, sends, and marks them SENT. A failed send
 * backs off exponentially; after OUTBOX_MAX_ATTEMPTS the row is FAILED, and
 * for security mail ("security.*") that is itself SECURITY-audited. A lease
 * that runs out (the process died mid-send) makes the row claimable again.
 *
 * Every time comparison uses the database clock. The recipient address is
 * read from User at send time and never stored, logged or audited.
 */

export const OUTBOX_BATCH = 20;
export const OUTBOX_MAX_ATTEMPTS = 8;
export const OUTBOX_LEASE_MS = 2 * 60_000;
const BACKOFF_BASE_MS = 30_000;
const BACKOFF_MAX_MS = 6 * 3_600_000;

/** Wait before the next attempt after `attempts` failures: 30 s, 1 min, 2 min, … capped at 6 h. */
export function outboxBackoffMs(attempts: number): number {
  const exponent = Math.max(0, attempts - 1);
  return Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** exponent);
}

/** After this send attempt failed: try again later, or give up. */
export function outboxFailureAction(attempts: number): "retry" | "give-up" {
  return attempts >= OUTBOX_MAX_ATTEMPTS ? "give-up" : "retry";
}

export function isSecurityMail(kind: string): boolean {
  return kind.startsWith(SECURITY_EMAIL_KIND_PREFIX);
}

export interface OutboxReport {
  transport: string;
  dryRun: boolean;
  claimed: number;
  sent: number;
  retried: number;
  failed: number;
  /** Claimed but not tried this tick (the send budget ran out); back to PENDING. */
  deferred: number;
  /** PENDING security mail right now (shown on /super when undelivered). */
  pendingSecurity: number;
}

interface ClaimedRow {
  id: string;
  kind: string;
  toUserId: string;
  subject: string;
  bodyText: string;
  attempts: number;
  entityType: string | null;
  entityId: string | null;
}

/**
 * One tick sends for at most this long; rows it did not try go back to
 * PENDING without spending an attempt. The tick also runs the judge
 * reconciler, so a slow relay must never hold it for long.
 */
export const OUTBOX_SEND_BUDGET_MS = 30_000;

export class OutboxDrainJob {
  constructor(
    private readonly deps: {
      db: Db;
      log: Logger;
      dryRun: boolean;
      transport: MailTransport;
      batch?: number;
      /** Tests shorten it. */
      sendBudgetMs?: number;
      now?: () => number;
    },
  ) {}

  private async pendingSecurity(): Promise<number> {
    return this.deps.db.emailOutbox.count({
      where: { status: { in: ["PENDING", "SENDING"] }, kind: { startsWith: SECURITY_EMAIL_KIND_PREFIX } },
    });
  }

  async tick(): Promise<OutboxReport> {
    const { db, log, dryRun, transport } = this.deps;
    const report: OutboxReport = {
      transport: transport.name,
      dryRun,
      claimed: 0,
      sent: 0,
      retried: 0,
      failed: 0,
      deferred: 0,
      pendingSecurity: 0,
    };
    if (transport.name === "disabled" || dryRun) {
      report.pendingSecurity = await this.pendingSecurity();
      if (report.pendingSecurity > 0 && transport.name === "disabled") {
        log.warn({ pendingSecurity: report.pendingSecurity }, "security email waiting: no mail transport configured");
      }
      return report;
    }

    const batch = this.deps.batch ?? OUTBOX_BATCH;
    const leaseSeconds = Math.round(OUTBOX_LEASE_MS / 1000);
    const claimed = await db.$queryRaw<ClaimedRow[]>`
      UPDATE "EmailOutbox" SET
        status = 'SENDING',
        "lockedUntil" = (now() AT TIME ZONE 'UTC') + make_interval(secs => ${leaseSeconds}),
        attempts = attempts + 1,
        transport = ${transport.name}
      WHERE id IN (
        SELECT id FROM "EmailOutbox"
         WHERE (status = 'PENDING' AND "nextAttemptAt" <= (now() AT TIME ZONE 'UTC'))
            OR (status = 'SENDING' AND "lockedUntil" < (now() AT TIME ZONE 'UTC'))
         ORDER BY "nextAttemptAt", id
         LIMIT ${batch}
         FOR UPDATE SKIP LOCKED)
      RETURNING id, kind, "toUserId", subject, "bodyText", attempts, "entityType", "entityId"`;
    report.claimed = claimed.length;

    // `attempts` is the claim token: every claim increments it, so a row
    // another instance reclaimed after our lease ran out (a slow relay) is
    // never finished by us as well. Every UPDATE below matches it.
    const now = this.deps.now ?? Date.now;
    const deadline = now() + (this.deps.sendBudgetMs ?? OUTBOX_SEND_BUDGET_MS);
    for (const [index, row] of claimed.entries()) {
      if (now() > deadline) {
        const rest = claimed.slice(index);
        for (const r of rest) {
          await db.emailOutbox.updateMany({
            where: { id: r.id, status: "SENDING", attempts: r.attempts },
            data: { status: "PENDING", lockedUntil: null, attempts: { decrement: 1 } },
          });
        }
        report.deferred = rest.length;
        log.warn({ deferred: rest.length }, "outbox send budget used up; the rest waits for the next tick");
        break;
      }
      let error: string | null = null;
      try {
        const user = await db.user.findUnique({ where: { id: row.toUserId }, select: { email: true } });
        if (!user) throw new Error("recipient account not found");
        await transport.send({ to: user.email, subject: row.subject, text: row.bodyText });
      } catch (cause) {
        error = redactMailError(cause);
      }

      if (error === null) {
        await db.emailOutbox.updateMany({
          where: { id: row.id, status: "SENDING", attempts: row.attempts },
          data: { status: "SENT", sentAt: new Date(), lockedUntil: null, lastError: null },
        });
        report.sent++;
        continue;
      }

      if (outboxFailureAction(row.attempts) === "retry") {
        const waitSeconds = Math.round(outboxBackoffMs(row.attempts) / 1000);
        await db.$executeRaw`
          UPDATE "EmailOutbox" SET status = 'PENDING', "lockedUntil" = NULL, "lastError" = ${error},
                 "nextAttemptAt" = (now() AT TIME ZONE 'UTC') + make_interval(secs => ${waitSeconds})
           WHERE id = ${row.id} AND status = 'SENDING' AND attempts = ${row.attempts}`;
        report.retried++;
        log.warn({ outboxId: row.id, kind: row.kind, attempts: row.attempts, error }, "email send failed; will retry");
        continue;
      }

      await db.$transaction(async (tx) => {
        const moved = await tx.emailOutbox.updateMany({
          where: { id: row.id, status: "SENDING", attempts: row.attempts },
          data: { status: "FAILED", lockedUntil: null, lastError: error },
        });
        if (moved.count === 1 && isSecurityMail(row.kind)) {
          await appendAuditEntriesInTx(tx, [
            {
              actorId: null,
              action: "email.delivery_failed",
              entityType: "EmailOutbox",
              entityId: row.id,
              targetUserId: row.toUserId,
              sensitivity: "SECURITY",
              metadata: {
                kind: row.kind,
                attempts: row.attempts,
                transport: transport.name,
                aboutEntityType: row.entityType,
                aboutEntityId: row.entityId,
              },
            },
          ]);
        }
      });
      report.failed++;
      log.error({ outboxId: row.id, kind: row.kind, attempts: row.attempts, error }, "email gave up after the last attempt");
    }
    report.pendingSecurity = await this.pendingSecurity();
    return report;
  }
}
