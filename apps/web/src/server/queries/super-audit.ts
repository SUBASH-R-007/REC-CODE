import "server-only";
import type { AuditSensitivity, Db, Prisma } from "@recx/db";
import { createChainVerifier, genesisHash, type ChainRow } from "@/lib/audit-chain";

/**
 * Reads for /super/audit (SUPER_ADMIN; the page guards itself). Only the
 * indexed shapes: [chainDay, id], [sensitivity, createdAt] and
 * [targetUserId, createdAt]. Actor and action filters apply only within one
 * day, so they never scan the whole table.
 */

export const AUDIT_PAGE_SIZE = 50;
const VERIFY_PAGE = 1_000;

export interface AuditFilters {
  day?: string;
  sensitivity?: AuditSensitivity;
  targetUserId?: string;
  actorId?: string;
  action?: string;
  /** Keyset: rows with id below this (newest first). */
  before?: bigint;
}

export interface AuditRowView {
  id: string;
  createdAt: Date;
  actorId: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  targetUserId: string | null;
  sensitivity: AuditSensitivity;
  metadata: Prisma.JsonValue;
  chainDay: string;
  hash: string;
}

export async function listAuditRows(
  db: Db,
  filters: AuditFilters,
): Promise<{ rows: AuditRowView[]; nextBefore: string | null }> {
  const where: Prisma.AuditLogWhereInput = {};
  if (filters.day) {
    where.chainDay = filters.day;
    if (filters.actorId) where.actorId = filters.actorId;
    if (filters.action) where.action = filters.action;
  }
  if (filters.sensitivity) where.sensitivity = filters.sensitivity;
  if (filters.targetUserId) where.targetUserId = filters.targetUserId;
  if (filters.before !== undefined) where.id = { lt: filters.before };
  const rows = await db.auditLog.findMany({
    where,
    orderBy: { id: "desc" },
    take: AUDIT_PAGE_SIZE + 1,
    select: {
      id: true,
      createdAt: true,
      actorId: true,
      action: true,
      entityType: true,
      entityId: true,
      targetUserId: true,
      sensitivity: true,
      metadata: true,
      chainDay: true,
      hash: true,
    },
  });
  const page = rows.slice(0, AUDIT_PAGE_SIZE);
  return {
    rows: page.map((r) => ({ ...r, id: r.id.toString() })),
    nextBefore: rows.length > AUDIT_PAGE_SIZE ? page[page.length - 1]!.id.toString() : null,
  };
}

/** The last link of a day (what is exported off-box), or the genesis hash for an empty day. */
export async function terminalHashOf(db: Db, day: string): Promise<{ hash: string; rows: number }> {
  const [last, rows] = await Promise.all([
    db.auditLog.findFirst({ where: { chainDay: day }, orderBy: { id: "desc" }, select: { hash: true } }),
    db.auditLog.count({ where: { chainDay: day } }),
  ]);
  return { hash: last?.hash ?? genesisHash(day), rows };
}

export interface ChainDayVerdict {
  day: string;
  rows: number;
  intact: boolean;
  /** AuditLog.id of the first row whose link fails, or null when intact. */
  firstBadId: string | null;
  terminalHash: string;
}

/** Recompute a day's chain in id order, a page at a time. */
export async function verifyAuditDay(db: Db, day: string): Promise<ChainDayVerdict> {
  const verifier = createChainVerifier(day);
  let cursor: bigint | null = null;
  let firstBadId: string | null = null;
  for (;;) {
    const page: Array<{
      id: bigint;
      actorId: string | null;
      action: string;
      entityType: string;
      entityId: string | null;
      targetUserId: string | null;
      sensitivity: AuditSensitivity;
      metadata: Prisma.JsonValue;
      ipHash: string | null;
      chainDay: string;
      createdAt: Date;
      prevHash: string;
      hash: string;
    }> = await db.auditLog.findMany({
      where: { chainDay: day, ...(cursor !== null ? { id: { gt: cursor } } : {}) },
      orderBy: { id: "asc" },
      take: VERIFY_PAGE,
    });
    for (const row of page) {
      const chainRow: ChainRow = {
        actorId: row.actorId,
        action: row.action,
        entityType: row.entityType,
        entityId: row.entityId,
        targetUserId: row.targetUserId,
        sensitivity: row.sensitivity,
        metadata: row.metadata,
        ipHash: row.ipHash,
        chainDay: row.chainDay,
        createdAt: row.createdAt.toISOString(),
        prevHash: row.prevHash,
        hash: row.hash,
      };
      if (!verifier.push(chainRow) && firstBadId === null) firstBadId = row.id.toString();
    }
    if (page.length < VERIFY_PAGE) break;
    cursor = page[page.length - 1]!.id;
  }
  return {
    day,
    rows: verifier.count,
    intact: verifier.firstBadIndex === -1,
    firstBadId,
    terminalHash: verifier.terminalHash,
  };
}
