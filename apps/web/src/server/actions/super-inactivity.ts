"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import {
  AUTO_DISABLE_CONFIRMATION,
  AUTO_DISABLE_FLOOR_DAYS,
  ENFORCE_CONFIRMATION,
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
 *   setEnforceEnabled       lets the job write at all             SECURITY
 *   setAutoDisableEnabled   the one act that can end in a lockout  SECURITY
 *
 * Saving is cheap and reversible, because a policy nobody can draft is a
 * policy nobody tunes. The two switches are not: each is audited at
 * SECURITY, each requires a typed confirmation to turn ON and nothing at all
 * to turn off, and the argument against each is on the screen above it.
 *
 * `setEnforceEnabled` is Phase 12w, and it exists because the alternative
 * was the scheduler's `--dry-run` flag — which is a property of the process
 * and would also have stopped assessments auto-submitting at their deadline.
 * A policy that reports without acting is now something a super-admin can
 * choose, which is what the Phase 8 manual gate's answer ("keep reporting")
 * actually needed.
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
 * Re-draft a version with one or two flags changed (Phase 12w).
 *
 * Both switches work by writing a NEW version, because the row is immutable
 * — and both have to copy every other column. Two copies of that list is
 * how a column added later ends up carried by one switch and silently reset
 * to its default by the other, which for `enforceEnabled` would mean a
 * super-admin turning auto-disable off and quietly switching enforcement on.
 * So there is one copy of the list, here.
 */
type PolicyRow = NonNullable<Awaited<ReturnType<typeof db.inactivityPolicy.findUnique>>>;

async function redraft(
  tx: Parameters<Parameters<typeof db.$transaction>[0]>[0],
  current: PolicyRow,
  actorId: string,
  overrides: { readonly enforceEnabled?: boolean; readonly autoDisableEnabled?: boolean },
): Promise<{ version: number }> {
  const next = await tx.inactivityPolicy.create({
    data: {
      isActive: current.isActive,
      batchYear: current.batchYear,
      departmentCode: current.departmentCode,
      nudgeAfterDays: current.nudgeAfterDays,
      warnAfterDays: current.warnAfterDays,
      softRestrictAfterDays: current.softRestrictAfterDays,
      disableAfterDays: current.disableAfterDays,
      enforceEnabled: overrides.enforceEnabled ?? current.enforceEnabled,
      autoDisableEnabled: overrides.autoDisableEnabled ?? current.autoDisableEnabled,
      graceDays: current.graceDays,
      countsAsActivity: countsAsActivitySchema.parse(current.countsAsActivity) as never,
      minActivityPerDay: current.minActivityPerDay,
      excludeNonWorkingDays: current.excludeNonWorkingDays,
      excludeApprovedLeave: current.excludeApprovedLeave,
      notifyMentor: current.notifyMentor,
      notifyParentEmail: false,
      createdById: actorId,
    },
    select: { version: true },
  });
  // One active row per scope: the old version steps down in the same
  // transaction that the new one steps up, or the index refuses the write.
  if (current.isActive) {
    await tx.inactivityPolicy.update({ where: { version: current.version }, data: { isActive: false } });
  }
  return next;
}

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
    /**
     * A draft never enforces (Phase 12w). Enforcement is turned on by its
     * own switch, on an existing version, with its own typed confirmation —
     * so a tightened threshold cannot arrive and start acting in the same
     * click, which is the whole asymmetry this module is built around.
     */
    if (policy.enforceEnabled) {
      throw new ValidationError(
        "A version saved here never enforces. Save it, make it live, then turn enforcement on with its own switch — that way the thresholds and the decision to act on them are two separate acts.",
      );
    }

    const created = await db.inactivityPolicy.create({
      data: {
        isActive: false,
        batchYear: policy.batchYear,
        departmentCode: policy.departmentCode,
        nudgeAfterDays: policy.nudgeAfterDays,
        warnAfterDays: policy.warnAfterDays,
        softRestrictAfterDays: policy.softRestrictAfterDays,
        disableAfterDays: policy.disableAfterDays,
        enforceEnabled: false,
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

    const created = await db.$transaction((tx) =>
      redraft(tx, current, actor.id, { autoDisableEnabled: enabled }),
    );

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
        // What it actually means tonight: with enforcement off, this
        // switch changes nothing a student can feel (12w).
        enforceEnabled: current.enforceEnabled,
      },
      ipHash: await requestIpHash(),
    });

    revalidatePath("/super/settings/inactivity");
    return { version: created.version, enabled };
  }, "setAutoDisableEnabled");
}

/**
 * Let the nightly job act on this policy at all, or stop it (Phase 12w).
 *
 * With enforcement off the sweep reads the whole roster, works out what the
 * policy says about every student and writes none of it: no stage move, no
 * notification, no review item, no counters. `applyDecision()` is where that
 * is enforced, so no caller can skip it.
 *
 * Turning it ON is the act that lets a scheduled job move an account with
 * nobody in the room, so it is audited at SECURITY and needs the typed
 * confirmation. Turning it OFF needs nothing: a college that wants to go
 * back to watching should be able to do it in one click at any hour.
 *
 * It does NOT clear the restrictions already written. They are stage moves
 * with evidence behind them and a student's own history cites them; undoing
 * one is `/admin/inactivity`'s job, with a person's name on it.
 */
export async function setEnforceEnabled(
  input: unknown,
): Promise<ActionResult<{ version: number; enabled: boolean }>> {
  return runAction(async () => {
    const actor = await requireSuperAdmin();
    const { version, enabled, confirmation } = switchSchema.parse(input);

    const current = await db.inactivityPolicy.findUnique({ where: { version } });
    if (!current) throw new NotFoundError("That policy version does not exist.");
    if (current.enforceEnabled === enabled) {
      throw new ConflictError(
        enabled
          ? "That version already enforces."
          : "That version is already report-only — the sweep reads it and writes nothing.",
      );
    }
    if (enabled && confirmation !== ENFORCE_CONFIRMATION) {
      throw new ValidationError(
        `Turning on enforcement needs you to type ${ENFORCE_CONFIRMATION}. Read the paragraph above the switch first, and read the last report the sweep produced — it says exactly who this will reach.`,
      );
    }
    if (
      enabled &&
      current.nudgeAfterDays === null &&
      current.warnAfterDays === null &&
      current.softRestrictAfterDays === null &&
      current.disableAfterDays === null
    ) {
      throw new ValidationError(
        "Every rung on this version is empty, so enforcing it would do nothing. Set a threshold first.",
      );
    }

    const created = await db.$transaction((tx) => redraft(tx, current, actor.id, { enforceEnabled: enabled }));

    await audit({
      actorId: actor.id,
      action: "inactivity.enforce_changed",
      entityType: "InactivityPolicy",
      entityId: String(created.version),
      sensitivity: "SECURITY",
      metadata: {
        fromVersion: current.version,
        toVersion: created.version,
        enabled,
        batchYear: current.batchYear,
        departmentCode: current.departmentCode,
        isActive: current.isActive,
        nudgeAfterDays: current.nudgeAfterDays,
        warnAfterDays: current.warnAfterDays,
        softRestrictAfterDays: current.softRestrictAfterDays,
        disableAfterDays: current.disableAfterDays,
        // The pair that decides whether an account can be CLOSED rather
        // than paused: enforcement on and auto-disable on, together.
        autoDisableEnabled: current.autoDisableEnabled,
        canCloseAccounts: enabled && current.autoDisableEnabled && current.disableAfterDays !== null,
      },
      ipHash: await requestIpHash(),
    });

    revalidatePath("/super/settings/inactivity");
    return { version: created.version, enabled };
  }, "setEnforceEnabled");
}
