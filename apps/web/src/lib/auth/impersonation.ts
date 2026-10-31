import "server-only";
import type { ImpersonationEndReason } from "@recx/db";
import { IMPERSONATION_MAX_MS } from "@recx/shared";
import { audit } from "@/lib/audit";
import { db } from "@/lib/db";
import { ConflictError } from "@/lib/errors";

/**
 * Read-only impersonation ("view as"): an ImpersonationSession row plus a
 * pointer on the SUPER_ADMIN's own Session row. getCurrentUser()
 * (lib/auth/session.ts) follows the pointer and returns the target user with
 * an `impersonation` context; requireActionUser() refuses every mutation
 * while it is set. The database fixes the 15-minute box, refuses self-
 * impersonation, never reopens or extends a session and never deletes one.
 *
 * Exactly one path writes the end audit: closing is a conditional UPDATE on
 * `endedAt IS NULL`, and only the call whose UPDATE matched audits.
 */

export interface BeginImpersonationInput {
  sessionId: string;
  impersonatorId: string;
  targetUserId: string;
  reason: string;
  now: Date;
}

export async function beginImpersonation(input: BeginImpersonationInput): Promise<{ id: string; expiresAt: Date }> {
  const expiresAt = new Date(input.now.getTime() + IMPERSONATION_MAX_MS);
  return db.$transaction(async (tx) => {
    const sessions = await tx.$queryRaw<{ impersonationId: string | null; userId: string }[]>`
      SELECT "impersonationId", "userId" FROM "Session" WHERE id = ${input.sessionId} FOR UPDATE`;
    const session = sessions[0];
    if (!session || session.userId !== input.impersonatorId) {
      throw new ConflictError("Your session changed. Sign in again and retry.");
    }
    if (session.impersonationId) {
      const open = await tx.impersonationSession.findUnique({
        where: { id: session.impersonationId },
        select: { endedAt: true, expiresAt: true },
      });
      if (open && open.endedAt === null && open.expiresAt.getTime() > input.now.getTime()) {
        throw new ConflictError("This session is already viewing as another user. End that first.");
      }
    }
    const row = await tx.impersonationSession.create({
      data: {
        impersonatorId: input.impersonatorId,
        targetUserId: input.targetUserId,
        reason: input.reason,
        startedAt: input.now,
        expiresAt,
      },
      select: { id: true, expiresAt: true },
    });
    await tx.session.update({ where: { id: input.sessionId }, data: { impersonationId: row.id } });
    return row;
  });
}

interface ClosedRow {
  id: string;
  impersonatorId: string;
  targetUserId: string;
  startedAt: Date;
  expiresAt: Date;
  endedAt: Date;
}

/**
 * End one impersonation (if it is still open) and clear the session pointer.
 * `endedAt` is the database clock, never before `startedAt`. Returns true
 * when THIS call closed it — and only then is `impersonation.ended`
 * (SECURITY) audited.
 */
export async function closeImpersonation(input: {
  impersonationId: string;
  reason: ImpersonationEndReason;
  actorId: string | null;
  ipHash?: string | null;
}): Promise<boolean> {
  const closed = await db.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<ClosedRow[]>`
      UPDATE "ImpersonationSession"
         SET "endedAt" = GREATEST((now() AT TIME ZONE 'UTC'), "startedAt"),
             "endReason" = ${input.reason}::"ImpersonationEndReason"
       WHERE id = ${input.impersonationId} AND "endedAt" IS NULL
       RETURNING id, "impersonatorId", "targetUserId", "startedAt", "expiresAt", "endedAt"`;
    await tx.session.updateMany({
      where: { impersonationId: input.impersonationId },
      data: { impersonationId: null },
    });
    return rows[0] ?? null;
  });
  if (!closed) return false;
  await audit({
    actorId: input.actorId,
    action: "impersonation.ended",
    entityType: "ImpersonationSession",
    entityId: closed.id,
    targetUserId: closed.targetUserId,
    sensitivity: "SECURITY",
    metadata: {
      endReason: input.reason,
      impersonatorId: closed.impersonatorId,
      startedAt: closed.startedAt.toISOString(),
      expiresAt: closed.expiresAt.toISOString(),
      endedAt: closed.endedAt.toISOString(),
    },
    ipHash: input.ipHash ?? null,
  });
  return true;
}

/**
 * End every open impersonation BY the given users (as impersonator) and OF
 * them (as target) — used when an account is disabled, archived or demoted.
 * Returns how many this call closed.
 */
export async function closeImpersonationsOf(
  userIds: string | readonly string[],
  reason: ImpersonationEndReason,
  actorId: string | null = null,
): Promise<number> {
  const ids = typeof userIds === "string" ? [userIds] : [...userIds];
  if (ids.length === 0) return 0;
  const open = await db.impersonationSession.findMany({
    where: { endedAt: null, OR: [{ impersonatorId: { in: ids } }, { targetUserId: { in: ids } }] },
    select: { id: true },
  });
  let closed = 0;
  for (const row of open) {
    if (await closeImpersonation({ impersonationId: row.id, reason, actorId })) closed++;
  }
  return closed;
}
