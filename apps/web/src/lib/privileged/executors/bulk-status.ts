import "server-only";
import type { AccountStatus, Role } from "@recx/db";
import { planStatusChange } from "@/lib/accounts/status";
import { auditMany, type AuditInput } from "@/lib/audit";
import { closeImpersonationsOf } from "@/lib/auth/impersonation";
import { db } from "@/lib/db";
import { EXECUTOR_BATCH, type Executor } from "@/lib/privileged/types";

/**
 * BULK_STATUS_CHANGE (26–5,000 accounts, two-person approved). Each account
 * is re-checked with planStatusChange under a row lock, so the rules that
 * guard a single change (never yourself, never the last active
 * super-admin) hold here too; an account that fails them is skipped and
 * listed in the result. Accounts leaving ACTIVE/SOFT_RESTRICTED lose every
 * session, and impersonations by or of them are revoked. One
 * `account.status_changed` audit row per account.
 */
export const executeBulkStatusChange: Executor<"BULK_STATUS_CHANGE"> = async (op, actor) => {
  const { userIds, toStatus } = op.payload;
  let changed = 0;
  const skipped: { userId: string; reason: string }[] = [];
  const ended: string[] = [];

  for (let i = 0; i < userIds.length; i += EXECUTOR_BATCH) {
    const batch = userIds.slice(i, i + EXECUTOR_BATCH);
    const { entries, endSessionsOf } = await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "User" WHERE id = ANY(${batch}::text[]) ORDER BY id FOR UPDATE`;
      const users = await tx.user.findMany({
        where: { id: { in: batch } },
        select: { id: true, role: true, status: true },
      });
      let activeSuperAdmins = await tx.user.count({ where: { role: "SUPER_ADMIN", status: "ACTIVE" } });
      const found = new Map(users.map((u) => [u.id, u]));
      const byFrom = new Map<AccountStatus, string[]>();
      const audits: AuditInput[] = [];
      const endIds: string[] = [];
      for (const userId of batch) {
        const target = found.get(userId) as { id: string; role: Role; status: AccountStatus } | undefined;
        if (!target) {
          skipped.push({ userId, reason: "not found" });
          continue;
        }
        const plan = planStatusChange(toStatus, { actorId: op.requestedById, target, activeSuperAdmins });
        if (!plan.ok) {
          skipped.push({ userId, reason: plan.reason });
          continue;
        }
        if (target.role === "SUPER_ADMIN" && target.status === "ACTIVE") activeSuperAdmins--;
        byFrom.set(plan.from, [...(byFrom.get(plan.from) ?? []), userId]);
        if (plan.endsSessions) endIds.push(userId);
        audits.push({
          actorId: actor.id,
          action: "account.status_changed",
          entityType: "User",
          entityId: userId,
          targetUserId: userId,
          sensitivity: plan.sensitivity,
          metadata: { from: plan.from, to: toStatus, via: "privileged", operationId: op.id },
          ipHash: actor.ipHash,
        });
      }
      for (const [from, ids] of byFrom) {
        const moved = await tx.user.updateMany({ where: { id: { in: ids }, status: from }, data: { status: toStatus } });
        changed += moved.count;
      }
      if (endIds.length > 0) await tx.session.deleteMany({ where: { userId: { in: endIds } } });
      return { entries: audits, endSessionsOf: endIds };
    });
    if (endSessionsOf.length > 0) {
      await closeImpersonationsOf(endSessionsOf, "REVOKED", actor.id);
      ended.push(...endSessionsOf);
    }
    await auditMany(entries);
  }

  return {
    result: {
      toStatus,
      requested: userIds.length,
      changed,
      sessionsEnded: ended.length,
      skipped: skipped.length,
      skippedSample: skipped.slice(0, 50),
    },
  };
};
