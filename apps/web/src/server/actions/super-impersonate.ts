"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { IMPERSONATION_REASON_MAX, IMPERSONATION_REASON_MIN } from "@recx/shared";
import { audit } from "@/lib/audit";
import { homeForRole, requireImpersonator, requireSuperAdmin } from "@/lib/auth/guards";
import { beginImpersonation, closeImpersonation } from "@/lib/auth/impersonation";
import { currentSessionId } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { ForbiddenError, NotFoundError, UnauthorizedError, ValidationError, runAction, type ActionResult } from "@/lib/errors";
import { isFeatureEnabled } from "@/lib/flags";
import { requestIpHash } from "@/lib/ip";

/**
 * Read-only impersonation ("view as"), capability "users.impersonate".
 *
 *   startImpersonation  impersonation.started (SECURITY)  requireSuperAdmin
 *   endImpersonation    impersonation.ended (SECURITY)    requireImpersonator (the ONE action that
 *                                                         works while impersonating)
 *
 * Rules: the impersonation flag is on; the target is not the caller, not a
 * SUPER_ADMIN, and ACTIVE or SOFT_RESTRICTED; a reason of 20–500
 * characters; one live impersonation per session; 15 minutes, no
 * extension. While it lasts every other action is refused
 * (ImpersonationReadOnlyError in requireActionUser).
 */

const startSchema = z.object({
  targetUserId: z.string().trim().min(1).max(64),
  reason: z
    .string()
    .trim()
    .min(IMPERSONATION_REASON_MIN, `Give a reason of at least ${IMPERSONATION_REASON_MIN} characters.`)
    .max(IMPERSONATION_REASON_MAX, `Keep the reason under ${IMPERSONATION_REASON_MAX} characters.`),
});
export type StartImpersonationInput = z.input<typeof startSchema>;

/** Start viewing as the target; on success the browser is redirected to the target's home. */
export async function startImpersonation(input: StartImpersonationInput): Promise<ActionResult<never>> {
  return runAction(async () => {
    const actor = await requireSuperAdmin();
    const parsed = startSchema.parse(input);
    if (!(await isFeatureEnabled("impersonation"))) {
      throw new ForbiddenError("Impersonation is switched off (Super-admin → Flags).");
    }
    if (parsed.targetUserId === actor.id) throw new ValidationError("You cannot impersonate yourself.");
    const target = await db.user.findUnique({
      where: { id: parsed.targetUserId },
      select: { id: true, role: true, status: true, collegeId: true },
    });
    if (!target) throw new NotFoundError("That account was not found.");
    if (target.role === "SUPER_ADMIN") throw new ValidationError("A super-admin cannot be impersonated.");
    if (target.status !== "ACTIVE" && target.status !== "SOFT_RESTRICTED") {
      throw new ValidationError("Only an active (or soft-restricted) account can be impersonated.");
    }
    const sessionId = await currentSessionId();
    if (!sessionId) throw new UnauthorizedError();
    const now = new Date();
    const started = await beginImpersonation({
      sessionId,
      impersonatorId: actor.id,
      targetUserId: target.id,
      reason: parsed.reason,
      now,
    });
    await audit({
      actorId: actor.id,
      action: "impersonation.started",
      entityType: "ImpersonationSession",
      entityId: started.id,
      targetUserId: target.id,
      sensitivity: "SECURITY",
      metadata: {
        collegeId: target.collegeId,
        targetRole: target.role,
        reason: parsed.reason,
        expiresAt: started.expiresAt.toISOString(),
      },
      ipHash: await requestIpHash(),
    });
    redirect(homeForRole(target.role));
  }, "startImpersonation");
}

/**
 * End the impersonation on this session (works without JavaScript: the
 * banner posts a plain form here). Back to /super/impersonate.
 */
export async function endImpersonation(_form?: FormData): Promise<void> {
  const { actorId, impersonation } = await requireImpersonator();
  await closeImpersonation({
    impersonationId: impersonation.id,
    reason: "ENDED",
    actorId,
    ipHash: await requestIpHash(),
  });
  redirect("/super/impersonate");
}
