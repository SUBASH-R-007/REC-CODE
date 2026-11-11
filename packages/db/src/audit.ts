import type { AuditSensitivity, Prisma } from "@prisma/client";
import { chainDayOf, genesisHash, linkHash, type ChainEntry } from "./audit-chain";
import type { Db, DbTx } from "./index";

/**
 * Append rows to the AuditLog per-UTC-day hash chain. Shared by apps/web
 * (src/lib/audit.ts keeps its never-throwing audit()/auditMany() API on top
 * of this) and apps/scheduler (impersonation expiry, privileged-operation
 * expiry, failed security email).
 *
 * Rule for every caller: metadata holds ISO strings, never Date objects (see
 * audit-chain.ts), and never secrets, tokens, passwords, email addresses or
 * disability labels.
 */
export interface AuditEntryInput {
  actorId: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  targetUserId?: string | null;
  sensitivity?: AuditSensitivity;
  metadata?: Prisma.InputJsonValue;
  ipHash?: string | null;
}

/**
 * Inside an existing transaction: take the per-day advisory lock, read the
 * day's last hash and insert the entries as consecutive chain links with one
 * createMany (ids are assigned in array order). Throws.
 */
export async function appendAuditEntriesInTx(
  tx: DbTx,
  entries: readonly AuditEntryInput[],
  createdAt: Date = new Date(),
): Promise<void> {
  if (entries.length === 0) return;
  const chainDay = chainDayOf(createdAt);
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"audit:" + chainDay}))`;
  const last = await tx.auditLog.findFirst({
    where: { chainDay },
    orderBy: { id: "desc" },
    select: { hash: true },
  });
  let prevHash = last?.hash ?? genesisHash(chainDay);
  const rows: Prisma.AuditLogCreateManyInput[] = [];
  for (const entry of entries) {
    const chainEntry: ChainEntry = {
      actorId: entry.actorId,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId ?? null,
      targetUserId: entry.targetUserId ?? null,
      sensitivity: entry.sensitivity ?? "NORMAL",
      metadata: entry.metadata ?? {},
      ipHash: entry.ipHash ?? null,
      chainDay,
      createdAt: createdAt.toISOString(),
    };
    const hash = linkHash(prevHash, chainEntry);
    rows.push({
      actorId: chainEntry.actorId,
      action: chainEntry.action,
      entityType: chainEntry.entityType,
      entityId: chainEntry.entityId,
      targetUserId: chainEntry.targetUserId,
      sensitivity: entry.sensitivity ?? "NORMAL",
      metadata: entry.metadata ?? {},
      ipHash: chainEntry.ipHash,
      chainDay,
      prevHash,
      hash,
      createdAt,
    });
    prevHash = hash;
  }
  await tx.auditLog.createMany({ data: rows });
}

/** One transaction, one advisory lock per chain day, one createMany. Throws; callers decide. */
export async function appendAuditEntries(client: Db, entries: readonly AuditEntryInput[]): Promise<void> {
  if (entries.length === 0) return;
  await client.$transaction(async (tx) => appendAuditEntriesInTx(tx, entries));
}
