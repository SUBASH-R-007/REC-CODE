"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { AI_HELPER_SETTING_KEY, aiHelperSettingSchema, effectiveAiHelperSetting, type AiHelperSetting } from "@recx/shared";
import { audit } from "@/lib/audit";
import { requireSuperAdmin } from "@/lib/auth/guards";
import { db } from "@/lib/db";
import { ValidationError, runAction, type ActionResult } from "@/lib/errors";
import { requestIpHash } from "@/lib/ip";

/**
 * The AI helper's configuration (PlatformSetting "ai-helper"), SUPER_ADMIN
 * only (capability "settings.write").
 *
 * Switching it on sends students' draft code to whichever model is chosen,
 * so the change is audited with a reason like the governance kill switches,
 * and SECURITY-sensitivity because the decision is about what leaves the
 * college rather than about a number.
 *
 * The API key is never written here. It is `AI_API_KEY` in the server
 * environment (`apps/web/src/lib/env.ts`), and this surface deliberately
 * cannot set, read or clear it.
 */

const inputSchema = aiHelperSettingSchema.extend({
  reason: z
    .string()
    .trim()
    .min(10, "Give a reason of at least 10 characters. It is recorded in the audit log.")
    .max(500, "Keep the reason under 500 characters."),
});
export type UpdateAiHelperInput = z.input<typeof inputSchema>;

export async function updateAiHelper(input: UpdateAiHelperInput): Promise<ActionResult<AiHelperSetting>> {
  return runAction(async () => {
    const actor = await requireSuperAdmin();
    const { reason, ...wanted } = inputSchema.parse(input);

    const before = await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"setting:" + AI_HELPER_SETTING_KEY}))`;
      const row = await tx.platformSetting.findUnique({ where: { key: AI_HELPER_SETTING_KEY } });
      const current = effectiveAiHelperSetting(row?.value);
      if (
        current.enabled === wanted.enabled &&
        current.modelId === wanted.modelId &&
        current.dailyPerStudent === wanted.dailyPerStudent &&
        current.maxOutputTokens === wanted.maxOutputTokens
      ) {
        throw new ValidationError("Nothing would change. Edit a value first.");
      }
      await tx.platformSetting.upsert({
        where: { key: AI_HELPER_SETTING_KEY },
        create: { key: AI_HELPER_SETTING_KEY, value: wanted, updatedById: actor.id },
        update: { value: wanted, updatedById: actor.id },
      });
      return current;
    });

    await audit({
      actorId: actor.id,
      action: "settings.ai_helper_changed",
      entityType: "PlatformSetting",
      entityId: AI_HELPER_SETTING_KEY,
      sensitivity: "SECURITY",
      metadata: { from: before, to: wanted, reason },
      ipHash: await requestIpHash(),
    });
    revalidatePath("/super/settings/ai");
    return wanted;
  }, "updateAiHelper");
}
