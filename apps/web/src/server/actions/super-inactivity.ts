"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import {
  AUTO_DISABLE_CONFIRMATION,
  AUTO_DISABLE_FLOOR_DAYS,
  countsAsActivitySchema,
  inactivityPolicySchema,
} from "@recx/shared";
import { requireSuperAdmin } from "@/lib/auth/guards";
import { audit } from "@/lib/audit";
import { db } from "@/lib/db";
import { ConflictError, NotFoundError, ValidationError, runAction, type ActionResult } from "@/lib/errors";
import { requestIpHash } from "@/lib/ip";

/**
 * Writing the inactivity policy (Phase 8b).
 *
 * SPEC §5: "Every threshold is a Super-admin-configurable, audit-logged
 * setting rather than a constant, so the policy can be tightened without a
 * deploy." So there is no constant to edit — only new versions of a row.
 *
 * Three acts, and the asymmetry between them is the point:
 *
 *   saveInactivityPolicy    writes a NEW version, inactive      SENSITIVE
 *   activateInactivityPolicy  makes a version the live one       SENSITIVE
 *   setAutoDisableEnabled   the one act that can end in a lockout  SECURITY
 *
 * Saving is cheap and reversible, because a policy nobody can draft is a
 * policy nobody tunes. Turning on automatic disabling is not: it is audited
 * at SECURITY, it is the only act here that requires a typed confirmation,
 * and the argument against it is on the screen above the switch.
 */

const schema = inactivityPolicySchema;

/**
 * A threshold under a fortnight is accepted — the database has no floor, for
 * the reason in `AUTO_DISABLE_FLOOR_REASON` — but only when the person typing
 * it has read why and said so. The confirmation is required only where it
 * bites: with `autoDisableEnabled` off, no threshold disables anybody.
 */
function requireFloorConfirmation(
  policy: { autoDisableEnabled: boolean; disableAfterDays: number | null },
  confirmation: string | undefined,
): void {
  if (!policy.autoDisableEnabled) return;
  if (policy.disableAfterDays === null) return;
  if (policy.disableAfterDays >= AUTO_DISABLE_FLOOR_DAYS) return;
  if (confirmation === AUTO_DISABLE_CONFIRMATION) return;
  throw new ValidationError(
    `A ${policy.disableAfterDays}-day automatic disable will reach a student who was simply ill. To set it anyway, type ${AUTO_DISABLE_CONFIRMATION} in the confirmation box.`,
  );
}

const saveSchema = z
  .object({ policy: schema, confirmation: z.string().trim().max(64).optional() })
  .strict();

/**
 * Draft a new version. Always INACTIVE: writing and activating are separate
 * acts, so a half-considered edit cannot start restricting a cohort the
 * moment it is saved.
 */
export async function saveInactivityPolicy(input: unknown): Promise<ActionResult<{ version: number }>> {
  return runAction(async () => {
    const actor = await requireSuperAdmin();
    const { policy, confirmation } = saveSchema.parse(input);
    requireFloorConfirmation(policy, confirmation);

    const created = await db.inactivityPolicy.create({
      data: {
        isActive: false,
        batchYear: policy.batchYear,
        departmentCode: policy.departmentCode,
        nudgeAfterDays: policy.nudgeAfterDays,
        warnAfterDays: policy.warnAfterDays,
        softRestrictAfterDays: policy.softRestrictAfterDays,
        disableAfterDays: policy.disableAfterDays,
        autoDisableEnabled: policy.autoDisableEnabled,
        graceDays: policy.graceDays,
        countsAsActivity: policy.countsAsActivity as never,
        minActivityPerDay: policy.minActivityPerDay,
        excludeNonWorkingDays: policy.excludeNonWorkingDays,
        excludeApprovedLeave: policy.excludeApprovedLeave,
        notifyMentor: policy.notifyMentor,
        notifyParentEmail: false,
        createdById: actor.id,
      },
      select: { version: true },
    });

    await audit({
      actorId: actor.id,
      action: "inactivity.policy_drafted",
      entityType: "InactivityPolicy",
      entityId: String(created.version),
      // SECURITY rather than SENSITIVE when the draft can disable: the act of
      // writing it down is the decision, even before it is activated.
      sensitivity: policy.autoDisableEnabled ? "SECURITY" : "SENSITIVE",
      metadata: {
        batchYear: policy.batchYear,
        departmentCode: policy.departmentCode,
        nudgeAfterDays: policy.nudgeAfterDays,
        warnAfterDays: policy.warnAfterDays,
        softRestrictAfterDays: policy.softRestrictAfterDays,
        disableAfterDays: policy.disableAfterDays,
        autoDisableEnabled: policy.autoDisableEnabled,
        graceDays: policy.graceDays,
        minActivityPerDay: policy.minActivityPerDay,
        belowFloor: policy.autoDisableEnabled && (policy.disableAfterDays ?? 0) < AUTO_DISABLE_FLOOR_DAYS,
      },
      ipHash: await requestIpHash(),
    });

    revalidatePath("/super/settings/inactivity");
    return { version: created.version };
  }, "saveInactivityPolicy");
}

const activateSchema = z.object({ version: z.number().int().positive() }).strict();

/**
 * Make a version the live one for its scope.
 *
 * The previous version at the same scope is retired in the SAME transaction,
 * because `InactivityPolicy_active_scope_key` allows exactly one active row
 * per scope — two statements outside a transaction would leave the window
 * where either both or neither is active, and "neither" means the sweep
 * silently stops reaching that cohort.
 */
export async function activateInactivityPolicy(
  input: unknown,
): Promise<ActionResult<{ version: number; retired: number | null }>> {
  return runAction(async () => {
    const actor = await requireSuperAdmin();
    const { version } = activateSchema.parse(input);

    const target = await db.inactivityPolicy.findUnique({
      where: { version },
      select: {
        version: true,
        isActive: true,
        batchYear: true,
        departmentCode: true,
        autoDisableEnabled: true,
        disableAfterDays: true,
      },
    });
    if (!target) throw new NotFoundError("That policy version does not exist.");
    if (target.isActive) throw new ConflictError("That version is already the live one.");

    const retired = await db.$transaction(async (tx) => {
      const previous = await tx.inactivityPolicy.findFirst({
        where: { isActive: true, batchYear: target.batchYear, departmentCode: target.departmentCode },
        select: { version: true },
      });
      if (previous) {
        await tx.inactivityPolicy.update({ where: { version: previous.version }, data: { isActive: false } });
      }
      await tx.inactivityPolicy.update({ where: { version: target.version }, data: { isActive: true } });
      return previous?.version ?? null;
    });

    await audit({
      actorId: actor.id,
      action: "inactivity.policy_activated",
      entityType: "InactivityPolicy",
      entityId: String(target.version),
      sensitivity: target.autoDisableEnabled ? "SECURITY" : "SENSITIVE",
      metadata: {
        version: target.version,
        retired,
        batchYear: target.batchYear,
        departmentCode: target.departmentCode,
        autoDisableEnabled: target.autoDisableEnabled,
        disableAfterDays: target.disableAfterDays,
      },
      ipHash: await requestIpHash(),
    });

    revalidatePath("/super/settings/inactivity");
    return { version: target.version, retired };
  }, "activateInactivityPolicy");
}

const switchSchema = z
  .object({
    version: z.number().int().positive(),
    enabled: z.boolean(),
    confirmation: z.string().trim().max(64).optional(),
  })
  .strict();

/**
 * Turn automatic disabling on or off — by drafting a new version, because the
 * row itself is immutable.
 *
 * This is the only act in Phase 8 that can end in a student losing access
 * without a human deciding it, so it is the only one that is audited at
 * SECURITY unconditionally and the only one whose "on" direction requires a
 * typed confirmation whatever the threshold. Turning it OFF needs nothing:
 * nobody has ever needed to be slowed down on the way to under-enforcing.
 */
export async function setAutoDisableEnabled(
  input: unknown,
): Promise<ActionResult<{ version: number; enabled: boolean }>> {
  return runAction(async () => {
    const actor = await requireSuperAdmin();
    const { version, enabled, confirmation } = switchSchema.parse(input);

    const current = await db.inactivityPolicy.findUnique({ where: { version } });
    if (!current) throw new NotFoundError("That policy version does not exist.");
    if (current.autoDisableEnabled === enabled) {
      throw new ConflictError(
        enabled ? "Automatic disabling is already on for that version." : "Automatic disabling is already off.",
      );
    }
    if (enabled && confirmation !== AUTO_DISABLE_CONFIRMATION) {
      throw new ValidationError(
        `Turning on automatic disabling needs you to type ${AUTO_DISABLE_CONFIRMATION}. Read the paragraph above the switch first — it is the argument against doing this.`,
      );
    }
    if (enabled && current.disableAfterDays === null) {
      throw new ValidationError(
        "Set a disable threshold first. A switch with no threshold is a policy that cannot be evaluated.",
      );
    }

    const counts = countsAsActivitySchema.parse(current.countsAsActivity);
    const created = await db.$transaction(async (tx) => {
      const next = await tx.inactivityPolicy.create({
        data: {
          isActive: current.isActive,
          batchYear: current.batchYear,
          departmentCode: current.departmentCode,
          nudgeAfterDays: current.nudgeAfterDays,
          warnAfterDays: current.warnAfterDays,
          softRestrictAfterDays: current.softRestrictAfterDays,
          disableAfterDays: current.disableAfterDays,
          autoDisableEnabled: enabled,
          graceDays: current.graceDays,
          countsAsActivity: counts as never,
          minActivityPerDay: current.minActivityPerDay,
          excludeNonWorkingDays: current.excludeNonWorkingDays,
          excludeApprovedLeave: current.excludeApprovedLeave,
          notifyMentor: current.notifyMentor,
          notifyParentEmail: false,
          createdById: actor.id,
        },
        select: { version: true },
      });
      // One active row per scope: the old version steps down in the same
      // transaction that the new one steps up, or the index refuses the write.
      if (current.isActive) {
        await tx.inactivityPolicy.update({ where: { version: current.version }, data: { isActive: false } });
      }
      return next;
    });

    await audit({
      actorId: actor.id,
      action: "inactivity.auto_disable_changed",
      entityType: "InactivityPolicy",
      entityId: String(created.version),
      sensitivity: "SECURITY",
      metadata: {
        fromVersion: current.version,
        toVersion: created.version,
        enabled,
        disableAfterDays: current.disableAfterDays,
        belowFloor: enabled && (current.disableAfterDays ?? 0) < AUTO_DISABLE_FLOOR_DAYS,
        batchYear: current.batchYear,
        departmentCode: current.departmentCode,
      },
      ipHash: await requestIpHash(),
    });

    revalidatePath("/super/settings/inactivity");
    return { version: created.version, enabled };
  }, "setAutoDisableEnabled");
}
