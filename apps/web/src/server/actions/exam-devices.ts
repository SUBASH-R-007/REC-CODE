"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireAdminScopeAction, scopedStudentWhere } from "@/lib/auth/scope";
import { db } from "@/lib/db";
import { NotFoundError, ValidationError, runAction, type ActionResult } from "@/lib/errors";
import { revokeDevice } from "@/lib/exam/webauthn";

/**
 * Withdrawing an exam device (Phase 6d).
 *
 * SPEC §5: "rebinding is an audited Admin action." So it needs a WRITTEN
 * REASON, like every other staff action in this system — which is also why
 * this is a server action rather than a button that posts an id: the reason
 * is the point, and a path that could omit it would get used.
 *
 * A withdrawal is final. `recx_refuse_device_change` refuses to un-revoke a
 * registration, because un-revoking would make the audit trail a lie. To give
 * a student their device back, enrol it again — which records a new
 * supervisor, a new moment and a new row.
 */

const schema = z
  .object({
    deviceId: z.string().min(1).max(64),
    reason: z
      .string()
      .trim()
      .min(10, "Say why in a sentence — this is recorded, and a student may ask to see it.")
      .max(500),
  })
  .strict();

export async function revokeExamDevice(input: unknown): Promise<ActionResult<{ revoked: true }>> {
  return runAction(async () => {
    const { user, scope } = await requireAdminScopeAction();
    const parsed = schema.parse(input);

    // Scoped through the device's OWNER, in ONE query: a department's
    // administrator must not be able to withdraw another department's
    // student's device by guessing an id, and a device outside the scope has
    // to read as "not found" — the same as one that does not exist — so an
    // id cannot be probed. `scopedStudentWhere` goes in as the `user`
    // relation filter rather than spread, which is the shape
    // `tests/repo/admin-scope.test.ts` requires (and it caught the first
    // draft of this action doing both wrong).
    const device = await db.deviceRegistration.findFirst({
      where: { id: parsed.deviceId, user: scopedStudentWhere(scope) },
      select: { id: true, revokedAt: true },
    });
    if (!device) throw new NotFoundError("That device was not found.");
    if (device.revokedAt !== null) throw new ValidationError("That device has already been withdrawn.");

    const ok = await revokeDevice({ deviceId: device.id, actorId: user.id, reason: parsed.reason });
    if (!ok) throw new ValidationError("That device has already been withdrawn.");

    revalidatePath("/admin/devices");
    return { revoked: true as const };
  }, "revokeExamDevice");
}
