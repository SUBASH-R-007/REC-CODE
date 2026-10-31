import "server-only";
import { RETENTION_SETTING_KEY, retentionSettingSchema, type RetentionSetting } from "@recx/shared";
import type { DbTx } from "@recx/db";
import { db } from "@/lib/db";

/**
 * The retention setting (PlatformSetting "retention"). Like the scheduler's
 * classifyRetention, an unreadable value is treated as a hold: deleting is
 * irreversible, keeping is not.
 */
export async function readRetention(client: Pick<DbTx, "platformSetting"> = db): Promise<{
  setting: RetentionSetting;
  legalHold: boolean;
  valid: boolean;
}> {
  const row = await client.platformSetting.findUnique({ where: { key: RETENTION_SETTING_KEY }, select: { value: true } });
  if (!row) return { setting: {}, legalHold: false, valid: true };
  const parsed = retentionSettingSchema.safeParse(row.value);
  if (!parsed.success) return { setting: {}, legalHold: true, valid: false };
  return { setting: parsed.data, legalHold: parsed.data.legalHold === true, valid: true };
}

export const LEGAL_HOLD_MESSAGE =
  "A legal hold is in force (Super-admin → Settings → Policy). Nothing may be purged until it is lifted.";
