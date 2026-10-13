"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import type { AccountStatus, Role } from "@recx/db";
import { BULK_STATUS_DIRECT_MAX, BULK_STATUS_MAX } from "@recx/shared";
import { planStatusChange, STATUS_LABEL } from "@/lib/accounts/status";
import { audit, auditMany, type AuditInput } from "@/lib/audit";
import { requireSuperAdmin } from "@/lib/auth/guards";
import { closeImpersonationsOf } from "@/lib/auth/impersonation";
import { db } from "@/lib/db";
import { NotFoundError, ValidationError, runAction, type ActionResult } from "@/lib/errors";
import { requestIpHash } from "@/lib/ip";
import { createPrivilegedOperation } from "@/lib/privileged/operations";
import { ACCOUNT_STATUSES, userFilterSchema, userFilterWhere } from "@/lib/privileged/payloads";
import { bulkStatusRoute } from "@/lib/privileged/policy";
import { enforcePrivilegedRequestRate } from "@/lib/privileged/rate";

/**
 * Account status, SUPER_ADMIN only (capability "accounts.status"):
 *
 *   setAccountStatus         one account                    account.status_changed
 *   bulkSetAccountStatus     2–25 accounts, all or nothing  account.status_changed ×N + account.status_bulk
 *   requestBulkStatusChange  26–5,000 accounts              privileged.requested (two-person approval)
 *
 * The rules (never yourself, never the last active super-admin) are
 * lib/accounts/status.ts. An account leaving ACTIVE / SOFT_RESTRICTED loses
 * every session at once and any impersonation by or of it is revoked.
 * Sensitivity: SECURITY when DISABLED or ARCHIVED is involved or the
 * account is staff, SENSITIVE otherwise.
 */

const idSchema = z.string().trim().min(1).max(64);
const reasonSchema = z
  .string()
  .trim()
  .min(10, "Give a reason of at least 10 characters. It is recorded in the audit log.")
  .max(500, "Keep the reason under 500 characters.");
const statusSchema = z.enum(ACCOUNT_STATUSES);

interface Applied {
  entries: AuditInput[];
  endSessions: string[];
}

/** Apply one status to the given accounts inside one transaction, all or nothing. */
async function applyStatus(
  actorId: string,
  userIds: readonly string[],
  toStatus: AccountStatus,
  reason: string,
  ipHash: string | null,
  via: "direct" | "bulk",
): Promise<Applied> {
  return db.$transaction(async (tx) => {
    const ids = [...userIds];
    await tx.$queryRaw`SELECT id FROM "User" WHERE id = ANY(${ids}::text[]) ORDER BY id FOR UPDATE`;
    const users = await tx.user.findMany({
      where: { id: { in: ids } },
      select: { id: true, role: true, status: true, collegeId: true },
    });
    if (users.length !== ids.length) throw new NotFoundError("One or more of those accounts no longer exist.");
    let activeSuperAdmins = await tx.user.count({ where: { role: "SUPER_ADMIN", status: "ACTIVE" } });
    const entries: AuditInput[] = [];
    const endSessions: string[] = [];
    const refused: string[] = [];
    for (const target of users) {
      const plan = planStatusChange(toStatus, {
        actorId,
        target: target as { id: string; role: Role; status: AccountStatus },
        activeSuperAdmins,
      });
      if (!plan.ok) {
        refused.push(`${target.collegeId}: ${plan.reason}`);
        continue;
      }
      if (target.role === "SUPER_ADMIN" && target.status === "ACTIVE") activeSuperAdmins--;
      const moved = await tx.user.updateMany({
        where: { id: target.id, status: plan.from },
        data: { status: toStatus },
      });
      if (moved.count !== 1) refused.push(`${target.collegeId}: changed a moment ago`);
      if (plan.endsSessions) endSessions.push(target.id);
      entries.push({
        actorId,
        action: "account.status_changed",
        entityType: "User",
        entityId: target.id,
        targetUserId: target.id,
        sensitivity: plan.sensitivity,
        metadata: { from: plan.from, to: toStatus, reason, via },
        ipHash,
      });
    }
    if (refused.length > 0) {
      // All or nothing: throwing rolls the whole transaction back.
      throw new ValidationError(`Nothing was changed. ${refused.slice(0, 5).join("; ")}${refused.length > 5 ? " …" : ""}`);
    }
    if (endSessions.length > 0) await tx.session.deleteMany({ where: { userId: { in: endSessions } } });
    return { entries, endSessions };
  });
}

const setStatusSchema = z.object({ userId: idSchema, toStatus: statusSchema, reason: reasonSchema });
export type SetAccountStatusInput = z.input<typeof setStatusSchema>;

export async function setAccountStatus(
  input: SetAccountStatusInput,
): Promise<ActionResult<{ userId: string; status: AccountStatus }>> {
  return runAction(async () => {
    const actor = await requireSuperAdmin();
    const parsed = setStatusSchema.parse(input);
    const ipHash = await requestIpHash();
    const applied = await applyStatus(actor.id, [parsed.userId], parsed.toStatus, parsed.reason, ipHash, "direct");
    if (applied.endSessions.length > 0) await closeImpersonationsOf(applied.endSessions, "REVOKED", actor.id);
    for (const entry of applied.entries) await audit(entry);
    revalidatePath("/super/users");
    return { userId: parsed.userId, status: parsed.toStatus };
  }, "setAccountStatus");
}

const bulkSchema = z.object({
  userIds: z
    .array(idSchema)
    .min(1, "Select at least one account.")
    .max(BULK_STATUS_DIRECT_MAX, `More than ${BULK_STATUS_DIRECT_MAX} accounts needs a second super-admin's approval.`)
    .refine((ids) => new Set(ids).size === ids.length, "Each account may appear only once."),
  toStatus: statusSchema,
  reason: reasonSchema,
});
export type BulkSetAccountStatusInput = z.input<typeof bulkSchema>;

export async function bulkSetAccountStatus(
  input: BulkSetAccountStatusInput,
): Promise<ActionResult<{ changed: number }>> {
  return runAction(async () => {
    const actor = await requireSuperAdmin();
    const parsed = bulkSchema.parse(input);
    const ipHash = await requestIpHash();
    const applied = await applyStatus(actor.id, parsed.userIds, parsed.toStatus, parsed.reason, ipHash, "bulk");
    if (applied.endSessions.length > 0) await closeImpersonationsOf(applied.endSessions, "REVOKED", actor.id);
    await auditMany([
      ...applied.entries,
      {
        actorId: actor.id,
        action: "account.status_bulk",
        entityType: "User",
        sensitivity: "SENSITIVE",
        metadata: { to: parsed.toStatus, count: applied.entries.length, reason: parsed.reason },
        ipHash,
      },
    ]);
    revalidatePath("/super/users");
    return { changed: applied.entries.length };
  }, "bulkSetAccountStatus");
}

const requestBulkSchema = z
  .object({
    userIds: z.array(idSchema).max(BULK_STATUS_MAX).optional(),
    filter: userFilterSchema.optional(),
    toStatus: statusSchema,
    reason: reasonSchema,
  })
  .refine((v) => (v.userIds ? !v.filter : !!v.filter), "Give either a list of accounts or a filter.");
export type RequestBulkStatusChangeInput = z.input<typeof requestBulkSchema>;

/**
 * More than 25 accounts: resolve the exact id list now (a filter becomes
 * ids; accounts already in the target status drop out), so the approver
 * approves a fixed set.
 */
export async function requestBulkStatusChange(
  input: RequestBulkStatusChangeInput,
): Promise<ActionResult<{ id: string; expiresAt: string; count: number }>> {
  return runAction(async () => {
    const actor = await requireSuperAdmin();
    const parsed = requestBulkSchema.parse(input);
    await enforcePrivilegedRequestRate(actor.id);
    const where = parsed.userIds ? { id: { in: parsed.userIds } } : userFilterWhere(parsed.filter ?? {});
    const rows = await db.user.findMany({
      where: { AND: [where, { status: { not: parsed.toStatus } }, { id: { not: actor.id } }] },
      select: { id: true },
      orderBy: { id: "asc" },
      take: BULK_STATUS_MAX + 1,
    });
    const route = bulkStatusRoute(rows.length);
    if (rows.length === 0) throw new ValidationError("No account matches (or every match already has that status).");
    if (route === "direct") {
      throw new ValidationError(
        `Only ${rows.length} account(s) would change. Change up to ${BULK_STATUS_DIRECT_MAX} directly instead.`,
      );
    }
    if (route === "too-large") {
      throw new ValidationError(`More than ${BULK_STATUS_MAX.toLocaleString("en-IN")} accounts match. Narrow the filter.`);
    }
    const userIds = rows.map((r) => r.id);
    const op = await createPrivilegedOperation({
      kind: "BULK_STATUS_CHANGE",
      payload: { userIds, toStatus: parsed.toStatus },
      summary: `Set ${userIds.length} accounts to ${STATUS_LABEL[parsed.toStatus]}`,
      affectedCount: userIds.length,
      reason: parsed.reason,
      actor,
    });
    revalidatePath("/super");
    return { id: op.id, expiresAt: op.expiresAt.toISOString(), count: userIds.length };
  }, "requestBulkStatusChange");
}
