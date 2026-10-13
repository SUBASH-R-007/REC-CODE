import "server-only";
import type { DbTx } from "@recx/db";
import { effectiveXpRules, xpRulesOverrideSchema, type XpRules } from "@recx/shared";

/** PlatformSetting key holding the super-admin XP override. */
export const XP_SETTING_KEY = "xp";

/**
 * The XP rules in force: the defaults in @recx/shared merged with the
 * super-admin override, read inside the finalise transaction so a change
 * applies to the very next award. An invalid stored override is ignored
 * (defaults apply) and logged — a bad setting must never stop judging.
 */
export async function loadXpRules(tx: DbTx): Promise<{ rules: XpRules; version: number }> {
  const row = await tx.platformSetting.findUnique({ where: { key: XP_SETTING_KEY }, select: { value: true } });
  if (!row) return effectiveXpRules(null);
  const parsed = xpRulesOverrideSchema.safeParse(row.value);
  if (!parsed.success) {
    console.error("[progress] !!! PlatformSetting 'xp' is invalid and ignored:", parsed.error.issues[0]?.message);
    return effectiveXpRules(null);
  }
  return effectiveXpRules(parsed.data);
}
