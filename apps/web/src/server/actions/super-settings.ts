"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import type { Prisma } from "@recx/db";
import { RETENTION_SETTING_KEY, retentionSettingSchema } from "@recx/shared";
import { audit } from "@/lib/audit";
import { requireSuperAdmin } from "@/lib/auth/guards";
import { db } from "@/lib/db";
import { ValidationError, runAction, type ActionResult } from "@/lib/errors";
import { requestIpHash } from "@/lib/ip";

/**
 * Retention policy, SUPER_ADMIN only (capability "settings.write"). The
 * retention durations are fixed in code and shown read-only; the one
 * editable control is the legal hold, which suspends every purge (the
 * scheduler's retention job and the SUBMISSION_PURGE executor both read it).
 * Other keys of the stored value are kept as they are.
 */

const legalHoldSchema = z.object({
  enabled: z.boolean(),
  reason: z
    .string()
    .trim()
    .min(10, "Give a reason of at least 10 characters. It is recorded in the audit log.")
    .max(500, "Keep the reason under 500 characters."),
});
export type SetLegalHoldInput = z.input<typeof legalHoldSchema>;

export async function setLegalHold(input: SetLegalHoldInput): Promise<ActionResult<{ legalHold: boolean }>> {
  return runAction(async () => {
    const actor = await requireSuperAdmin();
    const parsed = legalHoldSchema.parse(input);
    const changedAt = new Date().toISOString();
    const previous = await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"setting:" + RETENTION_SETTING_KEY}))`;
      const row = await tx.platformSetting.findUnique({ where: { key: RETENTION_SETTING_KEY } });
      // An unreadable stored value is replaced, never merged into.
      const current = row ? retentionSettingSchema.safeParse(row.value) : null;
      const base = current?.success ? current.data : {};
      if ((base.legalHold === true) === parsed.enabled) {
        throw new ValidationError(parsed.enabled ? "A legal hold is already in force." : "No legal hold is in force.");
      }
      const value = retentionSettingSchema.parse({
        ...base,
        legalHold: parsed.enabled,
        legalHoldReason: parsed.reason,
        legalHoldChangedAt: changedAt,
        legalHoldChangedById: actor.id,
      }) as Prisma.InputJsonObject;
      await tx.platformSetting.upsert({
        where: { key: RETENTION_SETTING_KEY },
        create: { key: RETENTION_SETTING_KEY, value, updatedById: actor.id },
        update: { value, updatedById: actor.id },
      });
      return { legalHold: base.legalHold === true, valid: current ? current.success : true };
    });
    await audit({
      actorId: actor.id,
      action: "settings.retention.legal_hold",
      entityType: "PlatformSetting",
      entityId: RETENTION_SETTING_KEY,
      sensitivity: "SECURITY",
      metadata: {
        from: previous.legalHold,
        to: parsed.enabled,
        previousValueReadable: previous.valid,
        reason: parsed.reason,
        changedAt,
      },
      ipHash: await requestIpHash(),
    });
    revalidatePath("/super/settings/policy");
    revalidatePath("/super");
    return { legalHold: parsed.enabled };
  }, "setLegalHold");
}
