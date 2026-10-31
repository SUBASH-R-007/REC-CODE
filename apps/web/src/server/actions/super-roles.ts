"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { Prisma, type AccountStatus, type Role } from "@recx/db";
import { planRoleChange } from "@/lib/accounts/status";
import { countActiveSuperAdminsLocked } from "@/lib/accounts/super-admins";
import { audit } from "@/lib/audit";
import { requireSuperAdmin } from "@/lib/auth/guards";
import { closeImpersonationsOf } from "@/lib/auth/impersonation";
import { db } from "@/lib/db";
import { ConflictError, NotFoundError, ValidationError, runAction, type ActionResult } from "@/lib/errors";
import { requestIpHash } from "@/lib/ip";
import { ROLE_VALUES } from "@/lib/privileged/payloads";

/**
 * Roles and AdminScope, SUPER_ADMIN only (capability "roles.manage"). Every
 * change is SECURITY-audited.
 *
 *   setUserRole       account.role_changed   never yourself; at least one ACTIVE super-admin stays;
 *                                            leaving ADMIN revokes that admin's scopes
 *   grantAdminScope   admin_scope.granted    ADMIN accounts only; an identical active grant is refused
 *   revokeAdminScope  admin_scope.revoked    sets revokedAt + revokedById; rows are never deleted
 *
 * AdminScope is fail-closed: an ADMIN with no active grant sees no students
 * (read side: lib/auth/scope-where.ts, owned by the admin surface).
 */

const idSchema = z.string().trim().min(1).max(64);
const reasonSchema = z
  .string()
  .trim()
  .min(10, "Give a reason of at least 10 characters. It is recorded in the audit log.")
  .max(500, "Keep the reason under 500 characters.");

const roleSchema = z.object({ userId: idSchema, role: z.enum(ROLE_VALUES), reason: reasonSchema });
export type SetUserRoleInput = z.input<typeof roleSchema>;

export async function setUserRole(input: SetUserRoleInput): Promise<ActionResult<{ userId: string; role: Role }>> {
  return runAction(async () => {
    const actor = await requireSuperAdmin();
    const parsed = roleSchema.parse(input);
    const outcome = await db.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<{ id: string; role: Role; status: AccountStatus }[]>`
        SELECT id, role::text AS role, status::text AS status FROM "User" WHERE id = ${parsed.userId} FOR UPDATE`;
      const target = locked[0];
      if (!target) throw new NotFoundError("That account was not found.");
      const activeSuperAdmins = await countActiveSuperAdminsLocked(tx);
      const plan = planRoleChange(parsed.role, { actorId: actor.id, target, activeSuperAdmins });
      if (!plan.ok) throw new ValidationError(plan.reason);
      await tx.user.update({ where: { id: target.id }, data: { role: parsed.role } });
      let scopesRevoked = 0;
      if (plan.dropsScopes) {
        const revoked = await tx.adminScope.updateMany({
          where: { adminId: target.id, revokedAt: null },
          data: { revokedAt: new Date(), revokedById: actor.id },
        });
        scopesRevoked = revoked.count;
      }
      return { from: target.role, scopesRevoked };
    });
    if (outcome.from === "SUPER_ADMIN" || parsed.role === "SUPER_ADMIN") {
      // A former super-admin cannot keep viewing as someone, and nobody may view as a super-admin.
      await closeImpersonationsOf(parsed.userId, "REVOKED", actor.id);
    }
    await audit({
      actorId: actor.id,
      action: "account.role_changed",
      entityType: "User",
      entityId: parsed.userId,
      targetUserId: parsed.userId,
      sensitivity: "SECURITY",
      metadata: { from: outcome.from, to: parsed.role, reason: parsed.reason, scopesRevoked: outcome.scopesRevoked },
      ipHash: await requestIpHash(),
    });
    revalidatePath("/super/roles");
    return { userId: parsed.userId, role: parsed.role };
  }, "setUserRole");
}

const optionalDepartment = z.preprocess(
  (v) => (typeof v === "string" && v.trim() === "" ? null : v),
  z
    .string()
    .trim()
    .max(16, "Department codes are at most 16 characters.")
    .regex(/^[A-Za-z0-9-]+$/, "Department codes are letters, digits and hyphens.")
    .transform((v) => v.toUpperCase())
    .nullable()
    .optional(),
);
const optionalBatch = z.preprocess(
  (v) => (v === "" || v === undefined || v === null ? null : typeof v === "string" ? Number(v) : v),
  z
    .number({ invalid_type_error: "The batch must be a year." })
    .int("The batch must be a year.")
    .min(2000, "The batch must be a year.")
    .max(2100, "The batch must be a year.")
    .nullable(),
);

const grantSchema = z.object({
  adminId: idSchema,
  departmentCode: optionalDepartment,
  batchYear: optionalBatch,
  reason: reasonSchema,
});
export type GrantAdminScopeInput = z.input<typeof grantSchema>;

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

export async function grantAdminScope(input: GrantAdminScopeInput): Promise<ActionResult<{ id: string }>> {
  return runAction(async () => {
    const actor = await requireSuperAdmin();
    const parsed = grantSchema.parse(input);
    const departmentCode = parsed.departmentCode ?? null;
    const batchYear = parsed.batchYear ?? null;
    const admin = await db.user.findUnique({
      where: { id: parsed.adminId },
      select: { id: true, role: true, status: true, collegeId: true },
    });
    if (!admin) throw new NotFoundError("That account was not found.");
    if (admin.role !== "ADMIN") throw new ValidationError("Scopes are granted to ADMIN accounts only.");
    if (admin.status !== "ACTIVE") throw new ValidationError("Scopes are granted to active accounts only.");
    let row: { id: string };
    try {
      // The partial unique index AdminScope_active_grant_key (nulls equal)
      // refuses a second identical active grant, also under a race.
      row = await db.adminScope.create({
        data: { adminId: admin.id, departmentCode, batchYear, reason: parsed.reason, grantedById: actor.id },
        select: { id: true },
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictError("This admin already has exactly that scope.");
      throw error;
    }
    await audit({
      actorId: actor.id,
      action: "admin_scope.granted",
      entityType: "AdminScope",
      entityId: row.id,
      targetUserId: admin.id,
      sensitivity: "SECURITY",
      metadata: { collegeId: admin.collegeId, departmentCode, batchYear, reason: parsed.reason },
      ipHash: await requestIpHash(),
    });
    revalidatePath("/super/roles");
    return { id: row.id };
  }, "grantAdminScope");
}

const revokeSchema = z.object({ scopeId: idSchema, reason: reasonSchema });
export type RevokeAdminScopeInput = z.input<typeof revokeSchema>;

export async function revokeAdminScope(input: RevokeAdminScopeInput): Promise<ActionResult<{ id: string }>> {
  return runAction(async () => {
    const actor = await requireSuperAdmin();
    const parsed = revokeSchema.parse(input);
    const scope = await db.adminScope.findUnique({
      where: { id: parsed.scopeId },
      select: { id: true, adminId: true, departmentCode: true, batchYear: true, revokedAt: true },
    });
    if (!scope) throw new NotFoundError("That scope was not found.");
    if (scope.revokedAt) throw new ValidationError("This scope is already revoked.");
    const moved = await db.adminScope.updateMany({
      where: { id: scope.id, revokedAt: null },
      data: { revokedAt: new Date(), revokedById: actor.id },
    });
    if (moved.count !== 1) throw new ConflictError("This scope was revoked a moment ago.");
    await audit({
      actorId: actor.id,
      action: "admin_scope.revoked",
      entityType: "AdminScope",
      entityId: scope.id,
      targetUserId: scope.adminId,
      sensitivity: "SECURITY",
      metadata: { departmentCode: scope.departmentCode, batchYear: scope.batchYear, reason: parsed.reason },
      ipHash: await requestIpHash(),
    });
    revalidatePath("/super/roles");
    return { id: scope.id };
  }, "revokeAdminScope");
}
