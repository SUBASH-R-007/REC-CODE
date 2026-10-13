import "server-only";
import { redirect } from "next/navigation";
import type { Role, User } from "@recx/db";
import { getCurrentUser, type ImpersonationContext } from "@/lib/auth/session";
import { ForbiddenError, ImpersonationReadOnlyError, UnauthorizedError } from "@/lib/errors";

/**
 * The one guards module. RBAC is enforced server-side in every page guard and
 * every action — never by hiding a nav link.
 *
 *   Pages:   requireUser(), requirePageRole(...roles), requireSuperAdminPage()
 *   Actions: requireActionUser(), requireActionRole(...roles), requireSuperAdmin()
 */

export function homeForRole(role: Role): string {
  switch (role) {
    case "SUPER_ADMIN":
    case "ADMIN":
      return "/admin";
    case "TA_MENTOR":
    case "PLACEMENT_OFFICER":
    case "STUDENT":
    default:
      // Mentor and placement-officer homes arrive with Phase 9.
      return "/dashboard";
  }
}

/** Page guard: redirects to /login when unauthenticated. */
export async function requireUser(): Promise<User> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  return user;
}

/** Page guard: redirects to the user's own home when the role doesn't match. */
export async function requirePageRole(...roles: Role[]): Promise<User> {
  const user = await requireUser();
  if (!roles.includes(user.role)) redirect(homeForRole(user.role));
  return user;
}

/** Page guard for the /super tree. */
export async function requireSuperAdminPage(): Promise<User> {
  return requirePageRole("SUPER_ADMIN");
}

/**
 * Action / route-handler guard: throws instead of redirecting. While a
 * SUPER_ADMIN views as another user (read-only impersonation) it refuses
 * every mutation — requireActionRole and requireSuperAdmin go through here,
 * so no action can write as the target, or as the super-admin, until the
 * impersonation ends.
 */
export async function requireActionUser(): Promise<User> {
  const user = await getCurrentUser();
  if (!user) throw new UnauthorizedError();
  if (user.impersonation) throw new ImpersonationReadOnlyError();
  return user;
}

/**
 * The one guard that passes DURING an impersonation: ending it
 * (server/actions/super-impersonate.ts#endImpersonation). Returns the
 * super-admin's own id, never the target's.
 */
export async function requireImpersonator(): Promise<{ actorId: string; impersonation: ImpersonationContext }> {
  const user = await getCurrentUser();
  if (!user) throw new UnauthorizedError();
  if (!user.impersonation) throw new ForbiddenError("You are not viewing as another user.");
  return { actorId: user.impersonation.impersonator.id, impersonation: user.impersonation };
}

export async function requireActionRole(...roles: Role[]): Promise<User> {
  const user = await requireActionUser();
  if (!roles.includes(user.role)) throw new ForbiddenError();
  return user;
}

/** Guard for every SUPER_ADMIN-exclusive capability (see src/lib/auth/capabilities.ts). */
export async function requireSuperAdmin(): Promise<User> {
  return requireActionRole("SUPER_ADMIN");
}

export function isStaff(role: Role): boolean {
  return role === "ADMIN" || role === "SUPER_ADMIN";
}
