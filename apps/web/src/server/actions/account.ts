"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { INACTIVITY_AUDIT_ACTIONS, LEAVE_KINDS, campusDay, daysInclusive } from "@recx/shared";
import { selfClearRestriction as clearOwnRestriction } from "@recx/db/inactivity";
import { requireActionUser } from "@/lib/auth/guards";
import { audit } from "@/lib/audit";
import { db } from "@/lib/db";
import {
  ConflictError,
  NotFoundError,
  RateLimitError,
  ValidationError,
  runAction,
  type ActionResult,
} from "@/lib/errors";
import { requestIpHash } from "@/lib/ip";
import { hitRateLimit } from "@/lib/rate-limit";
import { dayToDate, termKeyOn } from "@/server/queries/calendar";

/**
 * A student's own account: asking for a leave, and calling one off (Phase 8a).
 *
 * `requireActionUser()` and nothing stronger, and every write carries
 * `userId: user.id` rather than accepting one. This is the file that must stay
 * reachable to a restricted account in Phase 8e — the route out of a
 * restriction cannot be behind the restriction — so its import closure is
 * deliberately thin: the guard, the db, the errors, and the pure arithmetic.
 *
 *   requestLeaveException  any signed-in user   leave.requested
 *   cancelLeaveException   any signed-in user   leave.cancelled
 *
 * A request excuses nothing until a super-admin approves it. That is stated
 * on the form, because a student who thinks asking is enough will stop
 * practising and be counted idle for it.
 */

const dayString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Give the date as yyyy-MM-dd.")
  .refine(
    (value) => new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value,
    "That is not a real date.",
  );

const requestSchema = z
  .object({
    kind: z.enum(LEAVE_KINDS),
    startDate: dayString,
    endDate: dayString,
    reason: z.string().trim().min(10, "Say a little more — ten characters at least.").max(1000),
    evidenceFileId: z.string().min(1).max(64).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.endDate < value.startDate) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["endDate"], message: "The last day is before the first." });
      return;
    }
    if (daysInclusive(value.startDate, value.endDate).length > 181) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["endDate"],
        message: "That is longer than six months. Talk to the placement cell rather than raising it here.",
      });
    }
  });

/**
 * Raise a leave request for yourself.
 *
 * Deliberately NOT limited to the future. A student asks for medical leave
 * after the illness, with the certificate they were given on discharge —
 * refusing a backdated request would refuse the only shape this request ever
 * takes. The far past is still capped, because a request for 2019 is a
 * mistyped year rather than a claim anybody can check.
 */
export async function requestLeaveException(input: unknown): Promise<ActionResult<{ id: string }>> {
  return runAction(async () => {
    const user = await requireActionUser();
    const parsed = requestSchema.parse(input);
    const today = campusDay(new Date());

    const oldest = new Date(`${today}T00:00:00.000Z`);
    oldest.setUTCDate(oldest.getUTCDate() - 365);
    if (parsed.startDate < oldest.toISOString().slice(0, 10)) {
      throw new ValidationError("That start date is over a year ago. Check the year.");
    }

    // One open request at a time per set of dates, so the queue does not fill
    // with duplicates of the same week while a student waits.
    const duplicate = await db.leaveException.findFirst({
      where: {
        userId: user.id,
        status: "REQUESTED",
        startDate: { lte: dayToDate(parsed.endDate) },
        endDate: { gte: dayToDate(parsed.startDate) },
      },
      select: { id: true },
    });
    if (duplicate) {
      throw new ConflictError(
        "You already have a request waiting that covers some of those days. It is in the queue — adding another will not make it quicker.",
      );
    }

    const created = await db.leaveException.create({
      data: {
        userId: user.id,
        kind: parsed.kind,
        startDate: dayToDate(parsed.startDate),
        endDate: dayToDate(parsed.endDate),
        reason: parsed.reason,
        evidenceFileId: parsed.evidenceFileId ?? null,
        requestedById: user.id,
      },
      select: { id: true },
    });

    await audit({
      actorId: user.id,
      action: "leave.requested",
      entityType: "LeaveException",
      entityId: created.id,
      targetUserId: user.id,
      sensitivity: "SENSITIVE",
      metadata: { kind: parsed.kind, startDate: parsed.startDate, endDate: parsed.endDate },
      ipHash: await requestIpHash(),
    });

    revalidatePath("/account/leave");
    revalidatePath("/super/calendar");
    return { id: created.id };
  }, "requestLeaveException");
}

/**
 * Call off your own leave — before or after it was approved.
 *
 * No approval needed to withdraw: a student who recovers early and wants
 * their days to count again should not have to ask permission to be counted.
 * The approval stays on the record, which is why the decision-pair CHECK is
 * written the way it is.
 */
export async function cancelLeaveException(input: unknown): Promise<ActionResult<{ id: string }>> {
  return runAction(async () => {
    const user = await requireActionUser();
    const { leaveId } = z.object({ leaveId: z.string().min(1).max(64) }).strict().parse(input);

    // Ownership is a where clause. Somebody else's leave reads as not found,
    // so an id cannot be probed.
    const leave = await db.leaveException.findFirst({
      where: { id: leaveId, userId: user.id },
      select: { id: true, status: true, kind: true },
    });
    if (!leave) throw new NotFoundError("That request is not one of yours.");
    if (leave.status === "CANCELLED") return { id: leave.id };
    if (leave.status === "REJECTED") {
      throw new ConflictError("That request was already refused, so there is nothing to call off.");
    }

    await db.leaveException.update({ where: { id: leave.id }, data: { status: "CANCELLED" } });

    await audit({
      actorId: user.id,
      action: "leave.cancelled",
      entityType: "LeaveException",
      entityId: leave.id,
      targetUserId: user.id,
      sensitivity: "SENSITIVE",
      metadata: { kind: leave.kind, wasStatus: leave.status },
      ipHash: await requestIpHash(),
    });

    revalidatePath("/account/leave");
    revalidatePath("/super/calendar");
    return { id: leave.id };
  }, "cancelLeaveException");
}

/**
 * Restore your own account — one click, no approval (Phase 8e).
 *
 * SPEC §7 says plainly: "do not require admin approval to clear a soft
 * restriction." The reason matters more than the rule — anything requiring
 * approval turns a ten-day lapse into a permanent exit, because the
 * administrator is busy and the student gives up.
 *
 * So the guard is `requireActionUser()` and NOTHING stronger, and it acts
 * only on the caller's own row: the id is never a parameter. If somebody
 * later "hardens" this to a staff guard they will have removed the route out
 * of a restriction, which is the one thing this phase must not do.
 *
 * Rate-limited, because it is still a write path reachable by anybody signed
 * in. Clicking twice is fine: the second call is an ordinary no-op.
 */
export async function selfClearRestriction(): Promise<ActionResult<{ cleared: boolean; message: string }>> {
  return runAction(async () => {
    const user = await requireActionUser();
    const hit = await hitRateLimit(`self-clear:${user.id}`, { limit: 5, windowMs: 60_000 });
    if (!hit.allowed) throw new RateLimitError();

    const now = new Date();
    const termKey = await termKeyOn(campusDay(now));
    const result = await db.$transaction(async (tx) =>
      clearOwnRestriction(tx, { userId: user.id, termKey, now }),
    );

    if (!result.cleared) {
      /**
       * Not an error. "You have already restored it once this term" and
       * "nothing is paused" are both ordinary answers, and a red failure
       * banner for either would read as a punishment for asking.
       */
      return { cleared: false, message: result.refusal ?? "Nothing is paused." };
    }

    await audit({
      actorId: user.id,
      action: INACTIVITY_AUDIT_ACTIONS.selfCleared,
      entityType: "AccountRestriction",
      entityId: user.id,
      targetUserId: user.id,
      sensitivity: "SENSITIVE",
      metadata: { fromStage: result.fromStage, termKey, statusRestored: result.statusRestored },
      ipHash: await requestIpHash(),
    });

    revalidatePath("/account/reactivate");
    revalidatePath("/dashboard");
    return { cleared: true, message: "Done. Your account is active and you are back on the leaderboard." };
  }, "selfClearRestriction");
}
