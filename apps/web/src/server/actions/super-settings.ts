"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import type { Prisma } from "@recx/db";
import { RETENTION_SETTING_KEY, parseSebKey, retentionSettingSchema, sebSettingKey } from "@recx/shared";
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

const collegeSebSchema = z
  .object({
    configKey: z.string().max(200),
    browserExamKey: z.string().max(200),
  })
  .strict();
export type SetCollegeSebKeysInput = z.input<typeof collegeSebSchema>;

/**
 * The college-wide Safe Exam Browser pair (Phase 13d).
 *
 * A kiosk paper verifies `sha256(url + key)` on every request against the
 * keys for the hall a candidate is sitting in; `sebKeysFor` falls back to
 * this pair when a hall has none of its own. Phase 12z gave the halls a
 * screen and recorded that this one had none: the setting was read and
 * nothing in the product ever wrote it, so a department that wanted one
 * default for every hall needed a hand-written SQL statement.
 *
 * **Here and not on the assessment page**, which is the fence doing its
 * job. `PlatformSetting` is the super-admin's table -- capability
 * `settings.write`, five allowlisted action files -- and
 * `tests/repo/platform-setting-writes.test.ts` refused the first draft of
 * the hall keys for writing it from a STAFF action. A hall's key belongs
 * to whoever runs the hall; a college-wide default belongs to whoever
 * runs the college.
 *
 * Audited at SECURITY, recording WHETHER each key was set and never
 * which: an audit row carrying the key would be a second copy of it in a
 * table more people can read.
 */
export async function setCollegeSebKeys(
  input: SetCollegeSebKeysInput,
): Promise<ActionResult<{ configKey: boolean; browserExamKey: boolean }>> {
  return runAction(async () => {
    const actor = await requireSuperAdmin();
    const parsed = collegeSebSchema.parse(input);

    const config = parseSebKey(parsed.configKey);
    const browser = parseSebKey(parsed.browserExamKey);
    if (!config.ok || !browser.ok) {
      throw new ValidationError(
        "A key is the hex digest Safe Exam Browser shows in its Config Tool — 64 characters of 0-9 and a-f. Copy it exactly, or leave the box empty to clear it.",
      );
    }

    const key = sebSettingKey(null);
    const value = {
      ...(config.key === null ? {} : { configKey: config.key }),
      ...(browser.key === null ? {} : { browserExamKey: browser.key }),
    } as Prisma.InputJsonObject;
    await db.platformSetting.upsert({
      where: { key },
      create: { key, value, updatedById: actor.id },
      update: { value, updatedById: actor.id },
    });

    await audit({
      actorId: actor.id,
      action: "settings.seb_keys_changed",
      entityType: "PlatformSetting",
      entityId: key,
      sensitivity: "SECURITY",
      metadata: {
        scope: "college",
        // Whether, never which.
        configKeySet: config.key !== null,
        browserExamKeySet: browser.key !== null,
      },
      ipHash: await requestIpHash(),
    });

    revalidatePath("/super/settings/integrations");
    return { configKey: config.key !== null, browserExamKey: browser.key !== null };
  }, "setCollegeSebKeys");
}
