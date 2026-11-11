import "server-only";
import { Prisma } from "@recx/db";
import { db } from "@/lib/db";

/**
 * Both people of a two-person decision are current super-admins: the
 * requester must still be an ACTIVE SUPER_ADMIN when the request is
 * approved. `requesterIsActiveSuperAdmin` is the action's early check (with a
 * clear message); the SQL condition goes into the approve UPDATE itself, so a
 * demotion that commits during the approval is refused too.
 */
export async function requesterIsActiveSuperAdmin(requestedById: string): Promise<boolean> {
  const requester = await db.user.findUnique({ where: { id: requestedById }, select: { role: true, status: true } });
  return requester?.role === "SUPER_ADMIN" && requester.status === "ACTIVE";
}

/** For the approve UPDATE on "PrivilegedOperation". */
export const REQUESTER_IS_ACTIVE_SUPER_ADMIN_SQL = Prisma.sql`EXISTS (
  SELECT 1 FROM "User" r
   WHERE r.id = "PrivilegedOperation"."requestedById" AND r.role = 'SUPER_ADMIN' AND r.status = 'ACTIVE')`;
