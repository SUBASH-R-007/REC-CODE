"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requirePlacementAction } from "@/lib/auth/guards";
import { audit } from "@/lib/audit";
import { db } from "@/lib/db";
import { ConflictError, NotFoundError, runAction, type ActionResult } from "@/lib/errors";
import { requestIpHash } from "@/lib/ip";

/**
 * Routing a student to a named mentor (Phase 9e).
 *
 * SPEC §5: "The at-risk list routes to a named mentor for a conversation,
 * never an automated email." So this action records WHO was asked and WHY,
 * and it sends the student nothing at all. That is not an omission:
 *
 *   - a student who receives "you have been flagged as at risk" learns only
 *     that a number somewhere is low, which is the discouragement the whole
 *     phase is arranged to avoid;
 *   - the mentor is a person, and a person deciding how to open the
 *     conversation is the entire value of routing to one.
 *
 * It assigns, and it ends. There is deliberately no action here that
 * restricts an account, withholds XP, or writes anything to the student's
 * record: the maximum consequence of being on the at-risk list is that
 * somebody is asked to talk to you.
 *
 *   assignMentor   placement officer   placement.mentor_assigned
 *   endAssignment  placement officer   placement.mentor_assignment_ended
 */

const reasonSchema = z
  .string()
  .trim()
  .min(10, "Give the mentor at least 10 characters of context. They are about to start a conversation.")
  .max(500);

const assignSchema = z
  .object({
    menteeId: z.string().min(1).max(64),
    mentorId: z.string().min(1).max(64),
    reason: reasonSchema,
  })
  .strict();

const endSchema = z.object({ assignmentId: z.string().min(1).max(64) }).strict();

export async function assignMentor(input: unknown): Promise<ActionResult<{ assignmentId: string }>> {
  return runAction(async () => {
    const actor = await requirePlacementAction();
    const parsed = assignSchema.parse(input);

    /**
     * The database refuses a STUDENT or a PLACEMENT_OFFICER as mentor
     * (`MentorAssignment_mentor_is_not_student_or_officer`), and refuses a
     * second live assignment per mentee
     * (`MentorAssignment_one_active_per_mentee`). Both are checked HERE as
     * well, not because the constraints might fail, but because a
     * constraint violation surfaces as "something went wrong" and an officer
     * typing into a form deserves the actual reason.
     */
    const [mentee, mentor, existing] = await Promise.all([
      db.user.findUnique({ where: { id: parsed.menteeId }, select: { id: true, role: true } }),
      db.user.findUnique({ where: { id: parsed.mentorId }, select: { id: true, role: true } }),
      db.mentorAssignment.findFirst({
        where: { menteeId: parsed.menteeId, endedAt: null },
        select: { id: true, mentor: { select: { firstName: true, lastName: true } } },
      }),
    ]);

    if (!mentee || mentee.role !== "STUDENT") throw new NotFoundError("That student was not found.");
    if (!mentor) throw new NotFoundError("That mentor was not found.");
    if (mentor.role === "STUDENT" || mentor.role === "PLACEMENT_OFFICER") {
      throw new ConflictError(
        "A student or a placement officer cannot be the mentor of record. The point of routing is to send a student towards somebody who teaches them.",
      );
    }
    if (mentee.id === mentor.id) throw new ConflictError("A student cannot be their own mentor.");
    if (existing) {
      const name = `${existing.mentor.firstName} ${existing.mentor.lastName}`.trim();
      throw new ConflictError(
        `${name} is already this student's mentor. End that assignment first — two mentors would each assume the other had spoken to them.`,
      );
    }

    const row = await db.mentorAssignment.create({
      data: {
        menteeId: parsed.menteeId,
        mentorId: parsed.mentorId,
        assignedById: actor.id,
        reason: parsed.reason,
      },
      select: { id: true },
    });

    await audit({
      actorId: actor.id,
      action: "placement.mentor_assigned",
      entityType: "MentorAssignment",
      entityId: row.id,
      targetUserId: parsed.menteeId,
      sensitivity: "SENSITIVE",
      // The reason is in the row; the audit entry records the routing, not
      // the words, so the audit log does not become a second copy of every
      // note an officer has written about a student.
      metadata: { mentorId: parsed.mentorId },
      ipHash: await requestIpHash(),
    });

    revalidatePath("/placement-cell/at-risk");
    revalidatePath("/mentor");
    return { assignmentId: row.id };
  }, "assignMentor");
}

/**
 * End an assignment.
 *
 * Ended, never deleted: `MentorAssignment_immutable` refuses a DELETE, so the
 * history of who was asked to speak to a student survives the re-assignment.
 */
export async function endAssignment(input: unknown): Promise<ActionResult<{ assignmentId: string }>> {
  return runAction(async () => {
    const actor = await requirePlacementAction();
    const parsed = endSchema.parse(input);

    const existing = await db.mentorAssignment.findUnique({
      where: { id: parsed.assignmentId },
      select: { id: true, menteeId: true, endedAt: true },
    });
    if (!existing) throw new NotFoundError("That assignment was not found.");
    if (existing.endedAt) throw new ConflictError("That assignment has already ended.");

    await db.mentorAssignment.update({
      where: { id: existing.id },
      data: { endedAt: new Date(), endedById: actor.id },
    });

    await audit({
      actorId: actor.id,
      action: "placement.mentor_assignment_ended",
      entityType: "MentorAssignment",
      entityId: existing.id,
      targetUserId: existing.menteeId,
      sensitivity: "SENSITIVE",
      ipHash: await requestIpHash(),
    });

    revalidatePath("/placement-cell/at-risk");
    revalidatePath("/mentor");
    return { assignmentId: existing.id };
  }, "endAssignment");
}
