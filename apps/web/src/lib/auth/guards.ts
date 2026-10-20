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
 *   Phase 9: requirePlacementPage/Action(), requireMentorPage/Action()
 */

export function homeForRole(role: Role): string {
  switch (role) {
    case "SUPER_ADMIN":
    case "ADMIN":
      return "/admin";
    // Phase 9d. A mentor's home is their mentee list: the role exists to
    // have a conversation with a named student, and the list is the only
    // place that names them.
    case "TA_MENTOR":
      return "/mentor";
    case "PLACEMENT_OFFICER":
    case "STUDENT":
    default:
      // The placement cell's own home arrives with the cohort dashboard in
      // Phase 9e; until that page exists, sending an officer to it would be
      // a redirect into a 404.
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

/**
 * Each of the four composite guards below AWAITS its base guard and returns
 * the result, rather than `return requireActionRole(...)`. Not style: the
 * guard analyser in tests/repo/action-guards.test.ts reads a composite's
 * first statement to prove it delegates to a base guard — which is what
 * makes delegating safe, since the signed-in check and the impersonation
 * refusal live in the base. A tail call with no await is invisible to it.
 */

/**
 * The placement cell (Phase 9d).
 *
 * PLACEMENT_OFFICER and SUPER_ADMIN, and deliberately NOT ADMIN: an
 * `AdminScope` is a department-and-batch slice, and the cohort dashboard is a
 * whole-college instrument. Giving every scoped admin the college-wide
 * readiness distribution would quietly undo the scope.
 *
 * The officer role gains no authoring, no moderation, no role change and no
 * account-status power. SPEC §4's reasoning, carried across: the three roles
 * the college asked for would have handed every placement officer
 * problem-deletion and role-change power, and five roles with clean
 * boundaries is barely more work and far safer.
 */
export async function requirePlacementPage(): Promise<User> {
  const user = await requirePageRole("PLACEMENT_OFFICER", "SUPER_ADMIN");
  return user;
}

export async function requirePlacementAction(): Promise<User> {
  const user = await requireActionRole("PLACEMENT_OFFICER", "SUPER_ADMIN");
  return user;
}

/**
 * The mentor of record (Phase 9d).
 *
 * TA_MENTOR, ADMIN and SUPER_ADMIN. ADMIN is here because a department
 * admin is already trusted with that department's students and is often the
 * person who ends up having the conversation; the per-mentee check in
 * lib/auth/mentor-scope.ts is what actually limits what any of them can
 * read, and it fails closed — no active assignment, no students.
 *
 * PLACEMENT_OFFICER is NOT here. The at-risk list exists to route a student
 * away from the analytics surface and towards somebody who teaches them, so
 * the person it routes to must not be the one reading the dashboard. The
 * database refuses an officer as mentor as well
 * (`MentorAssignment_mentor_is_not_student_or_officer`).
 */
export async function requireMentorPage(): Promise<User> {
  const user = await requirePageRole("TA_MENTOR", "ADMIN", "SUPER_ADMIN");
  return user;
}

export async function requireMentorAction(): Promise<User> {
  const user = await requireActionRole("TA_MENTOR", "ADMIN", "SUPER_ADMIN");
  return user;
}

export function isStaff(role: Role): boolean {
  return role === "ADMIN" || role === "SUPER_ADMIN";
}
