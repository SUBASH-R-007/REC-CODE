"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import {
  CALENDAR_DAY_KINDS,
  INACTIVITY_AUDIT_ACTIONS,
  campusDay,
  countInactiveDays,
  daysInclusive,
} from "@recx/shared";
import {
  activityInWindow,
  approvedLeavesInWindow,
  calendarWindow,
  activePolicies,
  reverseForLeave,
  SWEEP_WINDOW_DAYS,
} from "@recx/db/inactivity";
import { calendarLookup, resolveInactivityPolicy } from "@recx/shared";
import { requireSuperAdmin } from "@/lib/auth/guards";
import { audit } from "@/lib/audit";
import { db } from "@/lib/db";
import { ConflictError, NotFoundError, ValidationError, runAction, type ActionResult } from "@/lib/errors";
import { requestIpHash } from "@/lib/ip";
import { dayToDate } from "@/server/queries/calendar";

/**
 * Editing the academic calendar, and deciding a leave request (Phase 8a).
 *
 * SUPER_ADMIN only, under `calendar.manage`. The spec puts the calendar and
 * MEDICAL leave approval here for a reason worth keeping in mind while
 * reading this file: these rows decide whether a student's fortnight away
 * counts against them, so the power to write them is the power to restrict an
 * account at one remove.
 *
 *   upsertCalendarDay     SUPER_ADMIN   calendar.day_written
 *   markCalendarRange     SUPER_ADMIN   calendar.range_written
 *   decideLeaveException  SUPER_ADMIN   leave.decided
 */

const dayString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "a campus day is yyyy-MM-dd")
  .refine((value) => !Number.isNaN(Date.parse(`${value}T00:00:00Z`)), "not a real date")
  // Round-trips: "2026-02-30" parses in some engines and is not a day.
  .refine((value) => new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value, "not a real date");

const kind = z.enum(CALENDAR_DAY_KINDS);

const daySchema = z
  .object({
    date: dayString,
    kind,
    isWorkingDay: z.boolean(),
    label: z.string().trim().min(1).max(120),
  })
  .strict();

const rangeSchema = z
  .object({
    fromDay: dayString,
    toDay: dayString,
    kind,
    isWorkingDay: z.boolean(),
    label: z.string().trim().min(1).max(120),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.toDay < value.fromDay) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["toDay"], message: "the last day is before the first" });
    }
    // A term, not a decade. The cap is what keeps a slipped keystroke from
    // writing ten thousand immutable rows.
    if (daysInclusive(value.fromDay, value.toDay).length > 120) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["toDay"], message: "at most 120 days in one go" });
    }
  });

const decisionSchema = z
  .object({
    leaveId: z.string().min(1).max(64),
    decision: z.enum(["APPROVED", "REJECTED"]),
    note: z.string().trim().max(1000).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.decision === "REJECTED" && (value.note ?? "").length < 10) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["note"],
        message: "a refusal a student can read needs at least 10 characters",
      });
    }
  });

/**
 * Write or correct one day.
 *
 * A past day is refused HERE as well as by the trigger, so the operator reads
 * a sentence rather than a constraint name. The trigger is still the
 * authority: this check is a courtesy, and a courtesy is not a guard.
 */
export async function upsertCalendarDay(input: unknown): Promise<ActionResult<{ date: string }>> {
  return runAction(async () => {
    const actor = await requireSuperAdmin();
    const parsed = daySchema.parse(input);
    const today = campusDay(new Date());
    if (parsed.date < today) {
      throw new ValidationError(
        "That day is in the past and the calendar does not rewrite history. If a student was wrongly counted, approve a leave covering those dates instead.",
      );
    }

    const existing = await db.calendarDay.findUnique({
      where: { date: dayToDate(parsed.date) },
      select: { kind: true, isWorkingDay: true, label: true },
    });

    await db.calendarDay.upsert({
      where: { date: dayToDate(parsed.date) },
      create: {
        date: dayToDate(parsed.date),
        kind: parsed.kind,
        isWorkingDay: parsed.isWorkingDay,
        label: parsed.label,
        createdById: actor.id,
      },
      update: { kind: parsed.kind, isWorkingDay: parsed.isWorkingDay, label: parsed.label },
    });

    await audit({
      actorId: actor.id,
      action: "calendar.day_written",
      entityType: "CalendarDay",
      entityId: parsed.date,
      sensitivity: "SENSITIVE",
      metadata: { from: existing ?? null, to: { kind: parsed.kind, isWorkingDay: parsed.isWorkingDay, label: parsed.label } },
      ipHash: await requestIpHash(),
    });

    revalidatePath("/super/calendar");
    return { date: parsed.date };
  }, "upsertCalendarDay");
}

/**
 * Mark a run of days at once — a holiday week, an exam week, a break.
 *
 * Entered day by day a term takes two hundred clicks, and a calendar nobody
 * finishes entering is a calendar the counter refuses to escalate from. So
 * this exists to make the complete calendar the easy one.
 *
 * Days already in the past are SKIPPED rather than refusing the whole range:
 * somebody entering "the October break" in the middle of it should get the
 * rest of it written, with a report of what was left alone.
 */
export async function markCalendarRange(
  input: unknown,
): Promise<ActionResult<{ written: number; skippedPast: number }>> {
  return runAction(async () => {
    const actor = await requireSuperAdmin();
    const parsed = rangeSchema.parse(input);
    const today = campusDay(new Date());
    const all = daysInclusive(parsed.fromDay, parsed.toDay);
    const writable = all.filter((day) => day >= today);
    if (writable.length === 0) {
      throw new ValidationError(
        "Every day in that range is already in the past, and the calendar does not rewrite history.",
      );
    }

    for (const day of writable) {
      await db.calendarDay.upsert({
        where: { date: dayToDate(day) },
        create: {
          date: dayToDate(day),
          kind: parsed.kind,
          isWorkingDay: parsed.isWorkingDay,
          label: parsed.label,
          createdById: actor.id,
        },
        update: { kind: parsed.kind, isWorkingDay: parsed.isWorkingDay, label: parsed.label },
      });
    }

    await audit({
      actorId: actor.id,
      action: "calendar.range_written",
      entityType: "CalendarDay",
      entityId: `${parsed.fromDay}..${parsed.toDay}`,
      sensitivity: "SENSITIVE",
      metadata: {
        kind: parsed.kind,
        isWorkingDay: parsed.isWorkingDay,
        label: parsed.label,
        written: writable.length,
        skippedPast: all.length - writable.length,
      },
      ipHash: await requestIpHash(),
    });

    revalidatePath("/super/calendar");
    return { written: writable.length, skippedPast: all.length - writable.length };
  }, "markCalendarRange");
}

/**
 * Approve or refuse a leave.
 *
 * The two-person rule is a CHECK, not a line of TypeScript — but it is
 * checked here too so the refusal reads as a sentence. An approval whose
 * dates overlap another approved leave is refused by the gist EXCLUDE
 * constraint, and that one is translated rather than re-implemented: the
 * database knows the real answer and a second copy of the rule would be a
 * second thing to keep in step.
 */
export async function decideLeaveException(
  input: unknown,
): Promise<ActionResult<{ id: string; status: "APPROVED" | "REJECTED"; reversal: string | null }>> {
  return runAction(async () => {
    const actor = await requireSuperAdmin();
    const parsed = decisionSchema.parse(input);

    const leave = await db.leaveException.findUnique({
      where: { id: parsed.leaveId },
      select: { id: true, userId: true, status: true, requestedById: true, kind: true, startDate: true, endDate: true },
    });
    if (!leave) throw new NotFoundError("That leave request no longer exists.");
    if (leave.status !== "REQUESTED") {
      throw new ConflictError(`That request is already ${leave.status.toLowerCase()}. Nothing was changed.`);
    }
    if (leave.requestedById === actor.id) {
      throw new ValidationError(
        "A leave is never decided by whoever raised it. Ask another super-admin to look at this one.",
      );
    }

    const decidedAt = new Date();
    try {
      await db.leaveException.update({
        where: { id: leave.id },
        data: {
          status: parsed.decision,
          decidedById: actor.id,
          decidedAt,
          decisionNote: parsed.note && parsed.note.length > 0 ? parsed.note : null,
        },
      });
    } catch (error) {
      // 23P01 is the gist EXCLUDE constraint: an overlapping approved leave.
      if (String(error).includes("LeaveException_no_overlapping_approved")) {
        throw new ConflictError(
          "This student already has an approved leave covering some of those dates. Cancel that one first, or ask them to re-raise this for the days it does not cover.",
        );
      }
      throw error;
    }

    await audit({
      actorId: actor.id,
      action: "leave.decided",
      entityType: "LeaveException",
      entityId: leave.id,
      targetUserId: leave.userId,
      sensitivity: "SENSITIVE",
      metadata: {
        decision: parsed.decision,
        kind: leave.kind,
        startDate: leave.startDate.toISOString().slice(0, 10),
        endDate: leave.endDate.toISOString().slice(0, 10),
      },
      ipHash: await requestIpHash(),
    });

    /**
     * A leave approved after the fact may undo a restriction (Phase 8e).
     *
     * SPEC §5 asks for exactly this: a retroactive approved leave reverses a
     * disable, the counted days drop below the threshold, the account returns
     * to its prior status, and a reversal event is written citing the leave.
     *
     * It RECOUNTS rather than assuming. A leave covering days that were not
     * the days that counted reverses nothing, and says so — so the approver
     * learns that the student is still over the threshold rather than
     * believing they have fixed it. And it is the one path besides a
     * super-admin that may take an account out of DISABLED, deliberately:
     * the student did not become inactive retroactively, the platform was
     * wrong about them, and a correction needing a second approval would mean
     * the platform's mistake cost them a wait.
     *
     * Outside the decision transaction on purpose. The approval is the
     * decision and must commit; the reversal is a consequence of it, and a
     * recount that failed must not undo somebody's approval.
     */
    let reversal: string | null = null;
    if (parsed.decision === "APPROVED") {
      reversal = await reverseIfLeaveClears(leave.userId, leave.id, decidedAt);
    }

    revalidatePath("/super/calendar");
    revalidatePath("/account/leave");
    revalidatePath("/dashboard");
    return { id: leave.id, status: parsed.decision, reversal };
  }, "decideLeaveException");
}

/**
 * Recount a student after a leave is approved, and reverse their restriction
 * if the excused days take them back under the threshold.
 *
 * Returns a sentence for the approver, or null when there was nothing to
 * reverse. Never throws: the approval has already committed, and a failed
 * recount must not be reported as a failed approval.
 */
async function reverseIfLeaveClears(userId: string, leaveId: string, now: Date): Promise<string | null> {
  try {
    const restriction = await db.accountRestriction.findUnique({
      where: { userId },
      select: { stage: true },
    });
    if (!restriction || restriction.stage === "NONE") return null;

    const student = await db.user.findUnique({
      where: { id: userId },
      select: { batchYear: true, departmentCode: true, lastActiveAt: true },
    });
    if (!student) return null;

    const policy = resolveInactivityPolicy(await activePolicies(db), {
      batchYear: student.batchYear,
      departmentCode: student.departmentCode,
    });
    if (!policy) return null;

    const evaluationDay = campusDay(now);
    const start = new Date(`${evaluationDay}T00:00:00.000Z`);
    start.setUTCDate(start.getUTCDate() - SWEEP_WINDOW_DAYS);
    const windowStartDay = start.toISOString().slice(0, 10);

    const [days, leaves, activity] = await Promise.all([
      calendarWindow(db, windowStartDay, evaluationDay),
      approvedLeavesInWindow(db, [userId], windowStartDay, evaluationDay),
      activityInWindow(db, [userId], windowStartDay, evaluationDay),
    ]);

    const count = countInactiveDays({
      lastActiveDay: student.lastActiveAt ? campusDay(student.lastActiveAt) : null,
      evaluationDay,
      cal: calendarLookup(days),
      leaves: leaves.get(userId) ?? [],
      activity: activity.get(userId) ?? [],
      policy,
      windowStartDay,
    });

    const result = await reverseForLeave(db, { userId, leaveId, now, evaluationDay, count, policy });
    if (!result.cleared) return result.refusal ?? null;

    await audit({
      actorId: null,
      action: INACTIVITY_AUDIT_ACTIONS.leaveReversed,
      entityType: "LeaveException",
      entityId: leaveId,
      targetUserId: userId,
      sensitivity: "SENSITIVE",
      metadata: {
        fromStage: result.fromStage,
        countedInactiveDays: count.countedInactiveDays,
        excludedDays: count.excludedDates.length,
        policyVersion: policy.version,
        statusRestored: result.statusRestored,
      },
    });

    return `Their restriction has been lifted: ${count.countedInactiveDays} counted days remain, which is under the threshold.`;
  } catch (cause) {
    // The approval stands. Logged loudly, because a reversal that silently
    // did not happen is a student still restricted for days somebody excused.
    console.error("[inactivity] a leave approval did not reverse a restriction", { userId, leaveId }, cause);
    return null;
  }
}
