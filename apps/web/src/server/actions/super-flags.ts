"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { FEATURE_FLAG_KEYS, FLAGS_SETTING_KEY, effectiveFeatureFlags, type FeatureFlagKey } from "@recx/shared";
import { audit } from "@/lib/audit";
import { requireSuperAdmin } from "@/lib/auth/guards";
import { db } from "@/lib/db";
import { ValidationError, runAction, type ActionResult } from "@/lib/errors";
import { requestIpHash } from "@/lib/ip";

/**
 * Governance kill switches, SUPER_ADMIN only (capability "settings.write").
 * The registry is closed (packages/shared/src/governance.ts); the stored
 * value only ever holds registry keys.
 */

const flagSchema = z.object({
  key: z.enum(FEATURE_FLAG_KEYS as [FeatureFlagKey, ...FeatureFlagKey[]]),
  enabled: z.boolean(),
  reason: z
    .string()
    .trim()
    .min(10, "Give a reason of at least 10 characters. It is recorded in the audit log.")
    .max(500, "Keep the reason under 500 characters."),
});
export type SetFeatureFlagInput = z.input<typeof flagSchema>;

export async function setFeatureFlag(
  input: SetFeatureFlagInput,
): Promise<ActionResult<{ key: FeatureFlagKey; enabled: boolean }>> {
  return runAction(async () => {
    const actor = await requireSuperAdmin();
    const parsed = flagSchema.parse(input);
    const from = await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"setting:" + FLAGS_SETTING_KEY}))`;
      const row = await tx.platformSetting.findUnique({ where: { key: FLAGS_SETTING_KEY } });
      const current = effectiveFeatureFlags(row?.value);
      if (current[parsed.key] === parsed.enabled) {
        throw new ValidationError(`This flag is already ${parsed.enabled ? "on" : "off"}.`);
      }
      const value = { ...current, [parsed.key]: parsed.enabled };
      await tx.platformSetting.upsert({
        where: { key: FLAGS_SETTING_KEY },
        create: { key: FLAGS_SETTING_KEY, value, updatedById: actor.id },
        update: { value, updatedById: actor.id },
      });
      return current[parsed.key];
    });
    await audit({
      actorId: actor.id,
      action: "settings.flag_changed",
      entityType: "PlatformSetting",
      entityId: FLAGS_SETTING_KEY,
      sensitivity: "SECURITY",
      metadata: { flag: parsed.key, from, to: parsed.enabled, reason: parsed.reason },
      ipHash: await requestIpHash(),
    });
    revalidatePath("/super/flags");
    return { key: parsed.key, enabled: parsed.enabled };
  }, "setFeatureFlag");
}
