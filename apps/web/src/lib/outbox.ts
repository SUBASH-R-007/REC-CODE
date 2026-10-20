import "server-only";
import type { DbTx } from "@recx/db";

/**
 * Transactional outbox for security email (EmailOutbox), drained by
 * apps/scheduler (src/outbox.ts). Enqueue in the SAME transaction as the
 * change the mail reports, so a committed change always has its mail queued
 * and a rolled-back one never sends. Rows name the recipient by user id; the
 * address is resolved at send time and is never stored here or logged.
 */

/** Every ACTIVE SUPER_ADMIN (the recipients of security mail). */
export async function activeSuperAdminIds(tx: DbTx): Promise<string[]> {
  const rows = await tx.user.findMany({
    where: { role: "SUPER_ADMIN", status: "ACTIVE" },
    select: { id: true },
    orderBy: { id: "asc" },
  });
  return rows.map((r) => r.id);
}

export interface EnqueueEmailInput {
  /** e.g. "security.break_glass". Kinds starting "security." are SECURITY-audited when delivery finally fails. */
  kind: string;
  toUserIds: readonly string[];
  subject: string;
  bodyText: string;
  entityType?: string;
  entityId?: string;
}

/** Queue one email per recipient. Returns the number of rows queued. */
export async function enqueueEmail(tx: DbTx, input: EnqueueEmailInput): Promise<number> {
  const recipients = [...new Set(input.toUserIds)];
  if (recipients.length === 0) return 0;
  const created = await tx.emailOutbox.createMany({
    data: recipients.map((toUserId) => ({
      kind: input.kind,
      toUserId,
      subject: input.subject.slice(0, 200),
      bodyText: input.bodyText,
      entityType: input.entityType ?? null,
      entityId: input.entityId ?? null,
    })),
  });
  return created.count;
}
