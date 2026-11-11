import type { AccountStatus, AuditSensitivity, Role } from "@recx/db";

/**
 * Pure rules for SUPER_ADMIN account-status and role changes
 * (server/actions/super-users.ts, super-roles.ts and the BULK_STATUS_CHANGE
 * executor). No database access: callers pass what they read under a lock.
 */

export interface AccountTarget {
  id: string;
  role: Role;
  status: AccountStatus;
}

export interface ChangeContext {
  actorId: string;
  target: AccountTarget;
  /** ACTIVE SUPER_ADMIN accounts right now, the target included if it is one. */
  activeSuperAdmins: number;
}

/** Account states that may hold a session (lib/auth/session-token.ts). */
const SIGN_IN_STATUSES: ReadonlySet<AccountStatus> = new Set<AccountStatus>(["ACTIVE", "SOFT_RESTRICTED"]);
const SECURITY_STATUSES: ReadonlySet<AccountStatus> = new Set<AccountStatus>(["DISABLED", "ARCHIVED"]);

export const STATUS_LABEL: Readonly<Record<AccountStatus, string>> = {
  ACTIVE: "Active",
  SOFT_RESTRICTED: "Soft-restricted",
  DISABLED: "Disabled",
  GRADUATED: "Graduated",
  ARCHIVED: "Archived",
};

export const ROLE_LABEL: Readonly<Record<Role, string>> = {
  STUDENT: "Student",
  TA_MENTOR: "TA / mentor",
  ADMIN: "Admin",
  PLACEMENT_OFFICER: "Placement officer",
  SUPER_ADMIN: "Super-admin",
};

function removesLastSuperAdmin(ctx: ChangeContext): boolean {
  return ctx.target.role === "SUPER_ADMIN" && ctx.target.status === "ACTIVE" && ctx.activeSuperAdmins <= 1;
}

export type StatusPlan =
  | { ok: true; from: AccountStatus; endsSessions: boolean; sensitivity: AuditSensitivity }
  | { ok: false; reason: string };

export function planStatusChange(to: AccountStatus, ctx: ChangeContext): StatusPlan {
  const { target } = ctx;
  if (target.id === ctx.actorId) return { ok: false, reason: "You cannot change your own account's status." };
  if (target.status === to) return { ok: false, reason: `This account is already ${STATUS_LABEL[to].toLowerCase()}.` };
  if (to !== "ACTIVE" && removesLastSuperAdmin(ctx)) {
    return { ok: false, reason: "This is the last active super-admin. Keep at least one active super-admin." };
  }
  const sensitivity: AuditSensitivity =
    SECURITY_STATUSES.has(target.status) || SECURITY_STATUSES.has(to) || target.role !== "STUDENT"
      ? "SECURITY"
      : "SENSITIVE";
  return { ok: true, from: target.status, endsSessions: !SIGN_IN_STATUSES.has(to), sensitivity };
}

export type RolePlan = { ok: true; dropsScopes: boolean } | { ok: false; reason: string };

export function planRoleChange(to: Role, ctx: ChangeContext): RolePlan {
  const { target } = ctx;
  if (target.id === ctx.actorId) return { ok: false, reason: "You cannot change your own role." };
  if (target.role === to) return { ok: false, reason: `This account is already ${ROLE_LABEL[to]}.` };
  if (to !== "SUPER_ADMIN" && removesLastSuperAdmin(ctx)) {
    return { ok: false, reason: "This is the last active super-admin. Keep at least one active super-admin." };
  }
  if ((to === "ADMIN" || to === "SUPER_ADMIN") && target.status !== "ACTIVE") {
    return { ok: false, reason: "Only an active account can be given a staff role." };
  }
  return { ok: true, dropsScopes: target.role === "ADMIN" && to !== "ADMIN" };
}
