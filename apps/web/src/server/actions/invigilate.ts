"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { acceptsWork, type AttemptStatus } from "@recx/shared";
import { audit } from "@/lib/audit";
import { requireActionRole } from "@/lib/auth/guards";
import { db } from "@/lib/db";
import { NotFoundError, ValidationError, runAction, type ActionResult } from "@/lib/errors";

/**
 * What an invigilator can do to a live sitting (Phase 6e).
 *
 * SPEC §5 sets the terms for every one of these:
 *
 *   Every invigilator action — message a candidate (modal they must
 *   acknowledge, acknowledgement recorded), issue a formal warning, grant +N
 *   minutes, pause/resume the clock, rebind device, TERMINATE — requires a
 *   free-text reason and writes an AuditLog row. Terminate additionally
 *   requires a second staff confirmation and still does not by itself void
 *   the result.
 *
 * So: no action here is a one-click action, every one carries a written
 * reason, and every one is audited. And the ceiling holds — terminating a
 * sitting ENDS it; it does not void it, does not score it and does not flag
 * it. Only a recorded human verdict can reach a VOIDED status, and the
 * database agrees (VOIDED is reachable only from a finished status).
 *
 * Extra time is granted through `pausedMs`, never by moving `expiresAt`: the
 * deadline is in the write-once tuple the `AssessmentAttempt_machine` trigger
 * freezes, and the trigger's own error message says to do it this way.
 */

const REASON = z
  .string()
  .trim()
  .min(20, "Say why in a sentence — this is recorded, and the student may ask to see it.")
  .max(2_000);

/** An attempt this invigilator may act on: live, and in a hall. */
async function liveAttempt(attemptId: string) {
  const attempt = await db.assessmentAttempt.findUnique({
    where: { id: attemptId },
    select: {
      id: true,
      userId: true,
      status: true,
      version: true,
      pausedMs: true,
      examSessionId: true,
      assessmentId: true,
    },
  });
  if (!attempt) throw new NotFoundError("That sitting was not found.");
  return attempt;
}

// ── Message a candidate ──────────────────────────────────────────────────

const messageSchema = z
  .object({
    attemptId: z.string().min(1).max(64),
    body: z.string().trim().min(1).max(2_000),
    requiresAck: z.boolean().default(true),
  })
  .strict();

/**
 * Send a message the candidate must acknowledge.
 *
 * The body IS the reason here — an invigilator writing "please raise your
 * hand" has said why — so there is no second reason field to fill in. The
 * acknowledgement is recorded and written once (trigger), because SPEC §5
 * wants it recorded and a record that can be rewritten records nothing.
 */
export async function messageCandidate(input: unknown): Promise<ActionResult<{ sent: true }>> {
  return runAction(async () => {
    const staff = await requireActionRole("ADMIN", "SUPER_ADMIN");
    const parsed = messageSchema.parse(input);
    const attempt = await liveAttempt(parsed.attemptId);
    if (!acceptsWork(attempt.status as AttemptStatus)) {
      throw new ValidationError("That sitting has finished; there is nobody to message.");
    }

    const message = await db.invigilatorMessage.create({
      data: {
        attemptId: attempt.id,
        body: parsed.body,
        requiresAck: parsed.requiresAck,
        sentById: staff.id,
      },
      select: { id: true },
    });

    await audit({
      actorId: staff.id,
      action: "invigilate.message_sent",
      entityType: "InvigilatorMessage",
      entityId: message.id,
      targetUserId: attempt.userId,
      metadata: { attemptId: attempt.id, body: parsed.body, requiresAck: parsed.requiresAck },
    });
    revalidateHall(attempt.examSessionId);
    return { sent: true as const };
  }, "messageCandidate");
}

// ── Grant time ───────────────────────────────────────────────────────────

const grantSchema = z
  .object({
    attemptId: z.string().min(1).max(64),
    minutes: z.number().int().min(1).max(120),
    reason: REASON,
  })
  .strict();

/**
 * Grant extra minutes.
 *
 * Added to `pausedMs`, NOT to `expiresAt`. The deadline is write-once in the
 * database, and the trigger's error message says so in as many words: "Grant
 * time with pausedMs instead of moving expiresAt". It also means the grant is
 * visible as a grant rather than disappearing into a changed deadline, which
 * is what a candidate querying their clock afterwards needs.
 */
export async function grantExtraTime(input: unknown): Promise<ActionResult<{ pausedMs: number }>> {
  return runAction(async () => {
    const staff = await requireActionRole("ADMIN", "SUPER_ADMIN");
    const parsed = grantSchema.parse(input);
    const attempt = await liveAttempt(parsed.attemptId);
    if (!acceptsWork(attempt.status as AttemptStatus)) {
      throw new ValidationError("That sitting has finished; its clock cannot be moved.");
    }

    const added = parsed.minutes * 60_000;
    const moved = await db.assessmentAttempt.updateMany({
      where: { id: attempt.id, version: attempt.version },
      data: { pausedMs: { increment: added }, version: { increment: 1 } },
    });
    if (moved.count !== 1) {
      throw new ValidationError("That sitting changed while you were deciding. Reload the hall and try again.");
    }

    await audit({
      actorId: staff.id,
      action: "invigilate.time_granted",
      entityType: "AssessmentAttempt",
      entityId: attempt.id,
      targetUserId: attempt.userId,
      metadata: {
        minutes: parsed.minutes,
        reason: parsed.reason,
        pausedMsBefore: attempt.pausedMs,
        pausedMsAfter: attempt.pausedMs + added,
      },
    });
    revalidateHall(attempt.examSessionId);
    return { pausedMs: attempt.pausedMs + added };
  }, "grantExtraTime");
}

// ── Terminate: two staff ─────────────────────────────────────────────────

const terminateSchema = z
  .object({ attemptId: z.string().min(1).max(64), reason: REASON })
  .strict();

/**
 * ASK to terminate a sitting. Takes effect only once a second staff member
 * confirms (`confirmTermination`).
 *
 * SPEC §5: "Terminate additionally requires a second staff confirmation and
 * still does not by itself void the result." Both halves matter. The second
 * confirmation is a CHECK in the database, not a rule in this file, so a
 * future route cannot forget it; and terminating moves the attempt to
 * TERMINATED, which is a FINISHED status and not a verdict. The work stands
 * and is judged; what it means is a human's decision afterwards.
 */
export async function requestTermination(input: unknown): Promise<ActionResult<{ awaitingConfirmation: true }>> {
  return runAction(async () => {
    const staff = await requireActionRole("ADMIN", "SUPER_ADMIN");
    const parsed = terminateSchema.parse(input);
    const attempt = await liveAttempt(parsed.attemptId);
    if (!acceptsWork(attempt.status as AttemptStatus)) {
      throw new ValidationError("That sitting has already finished.");
    }

    const existing = await db.attemptTermination.findUnique({
      where: { attemptId: attempt.id },
      select: { id: true, confirmedAt: true },
    });
    if (existing) {
      throw new ValidationError(
        existing.confirmedAt
          ? "That sitting has already been terminated."
          : "Someone has already asked to terminate this sitting; it needs a second staff member to confirm.",
      );
    }

    const row = await db.attemptTermination.create({
      data: { attemptId: attempt.id, requestedById: staff.id, reason: parsed.reason },
      select: { id: true },
    });

    await audit({
      actorId: staff.id,
      action: "invigilate.termination_requested",
      entityType: "AttemptTermination",
      entityId: row.id,
      targetUserId: attempt.userId,
      sensitivity: "SENSITIVE",
      metadata: {
        attemptId: attempt.id,
        reason: parsed.reason,
        note: "Awaiting a second staff member. The sitting continues until then.",
      },
    });
    revalidateHall(attempt.examSessionId);
    return { awaitingConfirmation: true as const };
  }, "requestTermination");
}

const confirmSchema = z
  .object({ attemptId: z.string().min(1).max(64), reason: REASON })
  .strict();

/**
 * Confirm a termination, as the second staff member, and end the sitting.
 *
 * The CHECK refuses the requester confirming their own request, so this does
 * not need to re-implement that rule — but it does say so in a sentence a
 * person can act on, because a constraint violation is not an error message.
 */
export async function confirmTermination(input: unknown): Promise<ActionResult<{ terminated: true }>> {
  return runAction(async () => {
    const staff = await requireActionRole("ADMIN", "SUPER_ADMIN");
    const parsed = confirmSchema.parse(input);
    const attempt = await liveAttempt(parsed.attemptId);

    const pending = await db.attemptTermination.findUnique({
      where: { attemptId: attempt.id },
      select: { id: true, requestedById: true, confirmedAt: true },
    });
    if (!pending) throw new NotFoundError("Nobody has asked to terminate that sitting.");
    if (pending.confirmedAt) throw new ValidationError("That termination has already been confirmed.");
    if (pending.requestedById === staff.id) {
      throw new ValidationError(
        "A termination needs a SECOND staff member. Ask a colleague to confirm it — the database refuses your own confirmation.",
      );
    }

    const confirmedAt = new Date();
    const confirmed = await db.attemptTermination.updateMany({
      where: { id: pending.id, confirmedAt: null },
      data: { confirmedById: staff.id, confirmedAt },
    });
    if (confirmed.count !== 1) throw new ValidationError("That termination has already been confirmed.");

    // TERMINATED, not VOIDED. The work stands and is judged; what it means is
    // decided by a human afterwards, with a written rationale.
    if (acceptsWork(attempt.status as AttemptStatus)) {
      await db.assessmentAttempt.updateMany({
        where: { id: attempt.id, status: { in: ["IN_PROGRESS", "DISCONNECTED"] } },
        data: { status: "TERMINATED", version: { increment: 1 } },
      });
    }

    await audit({
      actorId: staff.id,
      action: "invigilate.termination_confirmed",
      entityType: "AttemptTermination",
      entityId: pending.id,
      targetUserId: attempt.userId,
      sensitivity: "SENSITIVE",
      metadata: {
        attemptId: attempt.id,
        requestedById: pending.requestedById,
        reason: parsed.reason,
        at: confirmedAt.toISOString(),
        note: "The sitting is ended. It is NOT voided: the work stands and a human decides what it means.",
      },
    });
    revalidateHall(attempt.examSessionId);
    return { terminated: true as const };
  }, "confirmTermination");
}

function revalidateHall(examSessionId: string | null): void {
  if (examSessionId) revalidatePath(`/admin/invigilate/${examSessionId}`);
  revalidatePath("/admin/invigilate");
}
