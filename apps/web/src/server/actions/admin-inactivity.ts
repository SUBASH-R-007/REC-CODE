"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import {
  ACCOUNT_STATUS_FOR_STAGE,
  INACTIVITY_AUDIT_ACTIONS,
  INACTIVITY_NOTIFICATION_KIND,
  canStaffClear,
  stageMessage,
} from "@recx/shared";
import { requireAdminScopeAction, requireScopedStudent } from "@/lib/auth/scope";
import { audit } from "@/lib/audit";
import { db } from "@/lib/db";
import { ConflictError, ForbiddenError, NotFoundError, runAction, type ActionResult } from "@/lib/errors";
import { requestIpHash } from "@/lib/ip";

/**
 * Clearing an inactivity restriction by hand, and closing a review item
 * (Phase 8d).
 *
 * Staff, scoped: `requireAdminScopeAction()` means an ADMIN acts only on
 * students their `AdminScope` covers, and an ADMIN with no grant acts on
 * nobody.
 *
 * Clearing is only ever a DE-ESCALATION — straight to NONE, never up a rung.
 * There is deliberately no staff action in this file that restricts anybody:
 * the sweep does that from the policy, with evidence, and a staff member who
 * wants somebody restricted sooner changes the policy rather than reaching
 * past it.
 *
 * And `DISABLED` is refused here, three times over: `canStaffClear()` returns
 * false, this action throws before it writes, and
 * `AccountStatusEvent_undisable_check` refuses a `MANUAL_ADMIN` row leaving
 * DISABLED. The spec says "DISABLED → ACTIVE is Super-admin only", and that
 * is the kind of rule worth saying in three places.
 *
 *   clearRestriction     staff (scoped)   inactivity.staff_cleared
 *   dismissReviewItem    staff (scoped)   inactivity.admin_review_raised
 */

const reasonSchema = z
  .string()
  .trim()
  .min(10, "Give a reason of at least 10 characters. The student can read it in their own history.")
  .max(500);

const clearSchema = z.object({ userId: z.string().min(1).max(64), reason: reasonSchema }).strict();

/**
 * Lift a nudge, a warning or a pause, with a reason the student can read.
 *
 * The student is told, because a restriction lifted silently is a restriction
 * they go on believing in — and the point of the whole phase is that nobody
 * is left unsure where they stand.
 */
export async function clearRestriction(input: unknown): Promise<ActionResult<{ userId: string }>> {
  return runAction(async () => {
    const { user: actor, scope } = await requireAdminScopeAction();
    const parsed = clearSchema.parse(input);
    const student = await requireScopedStudent(scope, parsed.userId);
    // Named `scopedId`, and used as the key at every call site below: the
    // AdminScope fence (R4) reads the identifier, so an id that went through
    // `requireScopedStudent` is visible as such in the query itself rather
    // than three lines above it.
    const scopedId = student.scopedId;

    const current = await db.accountRestriction.findUnique({
      where: { userId: scopedId },
      select: { stage: true, ownsAccountStatus: true, adminReviewOpenedAt: true },
    });
    if (!current) throw new NotFoundError("That student has no inactivity restriction.");
    if (current.stage === "NONE") throw new ConflictError("Nothing is restricted for that student.");
    if (!canStaffClear(current.stage)) {
      throw new ForbiddenError(
        "A paused account can only be reopened by a super-admin. Ask the placement cell — this is deliberately not something department staff can do alone.",
      );
    }

    const now = new Date();

    await db.$transaction(async (tx) => {
      await tx.accountStatusEvent.create({
        data: {
          userId: scopedId,
          fromStage: current.stage,
          toStage: "NONE",
          fromStatus: student.status,
          // Only lower the status if the engine was the thing holding it
          // down. An account a human suspended for something else keeps that
          // status, and this clear is about the inactivity stage alone.
          toStatus: current.ownsAccountStatus ? ACCOUNT_STATUS_FOR_STAGE.NONE : student.status,
          source: "MANUAL_ADMIN",
          evidence: { clearedBy: actor.id, clearedAt: now.toISOString(), note: parsed.reason },
          triggeredBySystem: false,
          actorId: actor.id,
          reason: parsed.reason,
        },
      });

      await tx.accountRestriction.update({
        where: { userId: scopedId },
        data: {
          stage: "NONE",
          stageEnteredAt: now,
          graceEndsAt: null,
          countedInactiveDays: 0,
          ownsAccountStatus: false,
          lastEvaluatedAt: now,
          adminReviewClearedAt: current.adminReviewOpenedAt ? now : null,
        },
      });

      if (current.ownsAccountStatus) {
        await tx.user.update({ where: { id: scopedId }, data: { status: "ACTIVE" } });
      }

      const message = stageMessage("NONE", 0);
      await tx.notification.create({
        data: {
          userId: scopedId,
          kind: INACTIVITY_NOTIFICATION_KIND,
          title: message.title,
          body: `${message.body} ${parsed.reason}`,
          link: message.link,
          createdAt: now,
        },
      });
    });

    await audit({
      actorId: actor.id,
      action: INACTIVITY_AUDIT_ACTIONS.staffCleared,
      entityType: "AccountRestriction",
      entityId: scopedId,
      targetUserId: scopedId,
      sensitivity: "SENSITIVE",
      metadata: { fromStage: current.stage, reason: parsed.reason, statusRestored: current.ownsAccountStatus },
      ipHash: await requestIpHash(),
    });

    revalidatePath("/admin/inactivity");
    return { userId: scopedId };
  }, "clearRestriction");
}

const dismissSchema = z.object({ userId: z.string().min(1).max(64), note: reasonSchema }).strict();

/**
 * Close a review item without lifting the restriction.
 *
 * This is the honest other half of a review queue. A human who looks and
 * decides the restriction is right needs somewhere to say "I looked" —
 * otherwise the item sits there, the queue grows, and eventually nobody reads
 * any of it, which is the failure mode that makes a review queue worse than
 * none.
 */
export async function dismissReviewItem(input: unknown): Promise<ActionResult<{ userId: string }>> {
  return runAction(async () => {
    const { user: actor, scope } = await requireAdminScopeAction();
    const parsed = dismissSchema.parse(input);
    const student = await requireScopedStudent(scope, parsed.userId);
    // Named `scopedId`, and used as the key at every call site below: the
    // AdminScope fence (R4) reads the identifier, so an id that went through
    // `requireScopedStudent` is visible as such in the query itself rather
    // than three lines above it.
    const scopedId = student.scopedId;

    const current = await db.accountRestriction.findUnique({
      where: { userId: scopedId },
      select: { adminReviewOpenedAt: true, adminReviewClearedAt: true, stage: true },
    });
    if (!current?.adminReviewOpenedAt) throw new NotFoundError("There is no open review item for that student.");
    if (current.adminReviewClearedAt) throw new ConflictError("Somebody has already closed that review item.");

    const now = new Date();
    await db.accountRestriction.update({ where: { userId: scopedId }, data: { adminReviewClearedAt: now } });

    await audit({
      actorId: actor.id,
      action: INACTIVITY_AUDIT_ACTIONS.reviewRaised,
      entityType: "AccountRestriction",
      entityId: scopedId,
      targetUserId: scopedId,
      sensitivity: "SENSITIVE",
      metadata: { closed: true, stage: current.stage, note: parsed.note },
      ipHash: await requestIpHash(),
    });

    revalidatePath("/admin/inactivity");
    return { userId: scopedId };
  }, "dismissReviewItem");
}
