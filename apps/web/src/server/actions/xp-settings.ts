"use server";

import { z } from "zod";
import { XP_RULES_VERSION, xpRulesOverrideSchema, type XpRulesOverride } from "@recx/shared";
import { audit } from "@/lib/audit";
import { requireSuperAdmin } from "@/lib/auth/guards";
import { db } from "@/lib/db";
import { runAction, type ActionResult } from "@/lib/errors";
import { requestIpHash } from "@/lib/ip";
import { XP_SETTING_KEY } from "@/lib/progress/xp-config";

/** The editable part of the override; the version is assigned here. */
const updateSchema = z.object({
  rules: xpRulesOverrideSchema.omit({ version: true }),
  reason: z.string().trim().min(10, "Give a reason of at least 10 characters.").max(500),
});

/**
 * Super-admin only: replace the XP override (PlatformSetting "xp"). Each save
 * gets the next rules version, which every later XpEvent records; earlier
 * events keep theirs. Audited with the previous and new values.
 */
export async function updateXpRules(input: unknown): Promise<ActionResult<{ version: number }>> {
  return runAction(async () => {
    const actor = await requireSuperAdmin();
    const { rules, reason } = updateSchema.parse(input);
    const result = await db.$transaction(async (tx) => {
      const existing = await tx.platformSetting.findUnique({ where: { key: XP_SETTING_KEY } });
      const previous = existing ? xpRulesOverrideSchema.safeParse(existing.value) : null;
      const version = Math.max(XP_RULES_VERSION, previous?.success ? previous.data.version : XP_RULES_VERSION) + 1;
      const value: XpRulesOverride = xpRulesOverrideSchema.parse({ ...rules, version });
      await tx.platformSetting.upsert({
        where: { key: XP_SETTING_KEY },
        create: { key: XP_SETTING_KEY, value, updatedById: actor.id },
        update: { value, updatedById: actor.id },
      });
      return { version, previous: existing?.value ?? null, value };
    });
    await audit({
      actorId: actor.id,
      action: "settings.xp.updated",
      entityType: "PlatformSetting",
      entityId: XP_SETTING_KEY,
      sensitivity: "SENSITIVE",
      metadata: { reason, previous: result.previous, next: result.value },
      ipHash: await requestIpHash(),
    });
    return { version: result.version };
  }, "updateXpRules");
}
