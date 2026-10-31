"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { audit } from "@/lib/audit";
import { requireAdminScopeAction, requireScopedStudent } from "@/lib/auth/scope";
import { destroyAllSessions } from "@/lib/auth/session";
import { runAction, type ActionResult } from "@/lib/errors";
import { requestIpHash } from "@/lib/ip";

/**
 * /admin/students/[id] mutations. An ADMIN never changes an account's
 * status here — that is super-admin work — so the only mutation is ending
 * every session of an in-scope student ("Sign out everywhere"), audited.
 */

const reasonSchema = z
  .string()
  .trim()
  .min(5, "Give a reason of at least 5 characters — it is recorded in the audit log.")
  .max(500, "Keep the reason under 500 characters.");

const signOutSchema = z.object({
  userId: z.string().trim().min(1).max(64),
  reason: reasonSchema,
});
export type ForceSignOutInput = z.input<typeof signOutSchema>;

export async function forceSignOutStudent(input: ForceSignOutInput): Promise<ActionResult<{ userId: string }>> {
  return runAction(async () => {
    const { user, scope } = await requireAdminScopeAction();
    const parsed = signOutSchema.parse(input);
    const student = await requireScopedStudent(scope, parsed.userId);
    await destroyAllSessions(student.scopedId);
    await audit({
      actorId: user.id,
      action: "student.sessions.revoked",
      entityType: "User",
      entityId: student.scopedId,
      targetUserId: student.scopedId,
      sensitivity: "SENSITIVE",
      metadata: { reason: parsed.reason },
      ipHash: await requestIpHash(),
    });
    revalidatePath(`/admin/students/${student.scopedId}`);
    return { userId: student.scopedId };
  }, "forceSignOutStudent");
}
