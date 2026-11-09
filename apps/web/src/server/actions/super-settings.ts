"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import type { Prisma } from "@recx/db";
import { CONSENT_SETTING_KEY, RETENTION_SETTING_KEY, parseSebKey, retentionSettingSchema, sebSettingKey } from "@recx/shared";
import { audit } from "@/lib/audit";
import { requireSuperAdmin } from "@/lib/auth/guards";
import { db } from "@/lib/db";
import { ValidationError, runAction, type ActionResult } from "@/lib/errors";
import {
  EXAM_BROWSER_SETTING_KEY,
  examBrowserSettingSchema,
  type ExamBrowserSetting,
} from "@/lib/exam/exam-browser-setting";
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
/**
 * The named contact SPEC §6 asks to be on screen beside the consent points
 * (Phase 16e). A setting rather than a constant because it is a person at a
 * college, and a person who leaves must be replaceable without a deploy.
 *
 * The name and the address ARE the audited values here, unlike the SEB keys
 * above where only "whether" is recorded: this is a published contact, not
 * a secret, and the question a reader will have later is who it was.
 */
export async function setConsentContact(input: unknown): Promise<ActionResult<{ name: string }>> {
  return runAction(async () => {
    const actor = await requireSuperAdmin();
    const { parseConsentContact } = await import("@/lib/exam/consent");
    const saved = parseConsentContact(input);
    await db.platformSetting.upsert({
      where: { key: CONSENT_SETTING_KEY },
      create: { key: CONSENT_SETTING_KEY, value: saved, updatedById: actor.id },
      update: { value: saved, updatedById: actor.id },
    });
    await audit({
      actorId: actor.id,
      action: "settings.consent_contact_changed",
      entityType: "PlatformSetting",
      entityId: CONSENT_SETTING_KEY,
      sensitivity: "NORMAL",
      metadata: { name: saved.name, email: saved.email },
      ipHash: await requestIpHash(),
    });
    revalidatePath("/super/settings/policy");
    return { name: saved.name };
  }, "setConsentContact");
}

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


/**
 * The lowest REC Exam Browser version this deployment accepts (Phase 14f).
 *
 * The same situation the Safe Exam Browser pair was in before 13d: the
 * value lived in a `PlatformSetting` row with no screen, so the only way
 * to cut off a bad build was a hand-written SQL statement against a
 * production database, at nine in the morning, with a hall waiting. That
 * is not a control anybody would use.
 *
 * Raising it is the emergency lever: a build with a flaw stops being
 * usable the day it is known, because `checkContainment` refuses an
 * attestation presenting a lower version. It is therefore also a lever
 * that locks candidates out of their exam if it is set above what they
 * have installed -- which is why the audit row records both the previous
 * value and the new one, and why clearing it is one obvious action rather
 * than a field somebody has to blank.
 */
/**
 * Read, change and write the exam-browser setting under one lock
 * (Phase 14i).
 *
 * It became necessary the moment the setting had two fields. The floor's
 * action used to replace the whole stored value with `{ minVersion }`,
 * which was correct while that was the only field and would have silently
 * cleared the download switch the first time somebody edited the floor.
 * Two controls on one JSON row have to merge, and they have to merge
 * inside the advisory lock, or two super-admins on the same screen lose
 * one of the two changes.
 *
 * An unreadable stored value is REPLACED rather than merged into, the same
 * way the retention setting above does it: merging into something that
 * does not parse means carrying its mistake forward for ever.
 */
async function changeExamBrowserSetting(
  change: (current: ExamBrowserSetting) => ExamBrowserSetting,
): Promise<{ previous: ExamBrowserSetting; next: ExamBrowserSetting }> {
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"setting:" + EXAM_BROWSER_SETTING_KEY}))`;
    const row = await tx.platformSetting.findUnique({ where: { key: EXAM_BROWSER_SETTING_KEY } });
    const parsed = row ? examBrowserSettingSchema.safeParse(row.value) : null;
    const previous: ExamBrowserSetting = parsed?.success ? parsed.data : {};
    const next = change(previous);
    const value = next as Prisma.InputJsonValue;
    await tx.platformSetting.upsert({
      where: { key: EXAM_BROWSER_SETTING_KEY },
      create: { key: EXAM_BROWSER_SETTING_KEY, value },
      update: { value },
    });
    return { previous, next };
  });
}

const versionFloorSchema = z.object({
  /** Empty clears the floor, which is how a hall gets unstuck in a hurry. */
  minVersion: z.string().trim().max(32, "That is not a version."),
});
export type SetExamBrowserFloorInput = z.input<typeof versionFloorSchema>;

export async function setExamBrowserVersionFloor(
  input: SetExamBrowserFloorInput,
): Promise<ActionResult<{ minVersion: string | null }>> {
  return runAction(async () => {
    const actor = await requireSuperAdmin();
    const { minVersion } = versionFloorSchema.parse(input);
    // Validated before the lock is taken: a bad version should be a message
    // on the screen, not a transaction that opens and rolls back.
    const checked = minVersion === "" ? undefined : examBrowserSettingSchema.parse({ minVersion }).minVersion;

    const { previous, next } = await changeExamBrowserSetting((current) => {
      const merged = { ...current };
      if (checked === undefined) delete merged.minVersion;
      else merged.minVersion = checked;
      return merged;
    });

    await audit({
      actorId: actor.id,
      action: "settings.exam_browser_floor_set",
      entityType: "PlatformSetting",
      entityId: EXAM_BROWSER_SETTING_KEY,
      sensitivity: "SECURITY",
      /**
       * Both values, because this is a lever that can lock a hall out of
       * an exam, and "what was it before" is the first question anybody
       * asks when it does. Neither is a secret: a version number is
       * printed on the public page at /exam-browser.
       */
      metadata: {
        previous: previous.minVersion ?? null,
        minVersion: next.minVersion ?? null,
        ipHash: await requestIpHash(),
      },
    });

    revalidatePath("/super/settings/integrations");
    revalidatePath("/exam-browser");
    return { minVersion: next.minVersion ?? null };
  }, "setExamBrowserVersionFloor");
}

const downloadsSchema = z.object({ enabled: z.boolean() });
export type SetExamBrowserDownloadsInput = z.input<typeof downloadsSchema>;

/**
 * Whether `/exam-browser` hands out the installer (Phase 14i).
 *
 * A switch over the DOWNLOAD and not over the button: the route reads this
 * on every request, so turning it off takes the file away from anybody who
 * kept the link, which is the only version of this control worth having.
 *
 * Audited at SECURITY, like the floor beside it, for a different reason.
 * The floor can stop a hall sitting; this one decides whether a college is
 * publishing an executable from its own hostname, and "who turned that on"
 * is a question somebody will eventually ask.
 */
export async function setExamBrowserDownloads(
  input: SetExamBrowserDownloadsInput,
): Promise<ActionResult<{ enabled: boolean }>> {
  return runAction(async () => {
    const actor = await requireSuperAdmin();
    const { enabled } = downloadsSchema.parse(input);

    const { previous, next } = await changeExamBrowserSetting((current) => ({
      ...current,
      downloadsEnabled: enabled,
    }));

    await audit({
      actorId: actor.id,
      action: "settings.exam_browser_downloads_set",
      entityType: "PlatformSetting",
      entityId: EXAM_BROWSER_SETTING_KEY,
      sensitivity: "SECURITY",
      metadata: {
        previous: previous.downloadsEnabled ?? false,
        enabled: next.downloadsEnabled ?? false,
        ipHash: await requestIpHash(),
      },
    });

    revalidatePath("/super/settings/integrations");
    revalidatePath("/exam-browser");
    return { enabled: next.downloadsEnabled ?? false };
  }, "setExamBrowserDownloads");
}
