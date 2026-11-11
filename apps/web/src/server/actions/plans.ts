"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import type { StudyPlanKind } from "@recx/db";
import { requireActionUser } from "@/lib/auth/guards";
import { db } from "@/lib/db";
import { NotFoundError, runAction, type ActionResult } from "@/lib/errors";
import { PLAN_KINDS } from "@/components/plans/kinds";

/**
 * Study-plan enrolment (/sheets, /learn).
 *
 *   enrollInPlan      enrol (idempotent), counting progress in one query
 *   leavePlan         leave (idempotent; progress lives in UserProblemStatus,
 *                     so re-enrolling later restores it)
 *   changeEnrollment  the <form> entry point for both (useActionState; also
 *                     works before hydration)
 *
 * On enrolment itemsTotal and itemsDone are computed from the plan's items
 * and the viewer's UserProblemStatus (status = SOLVED) in a single
 * INSERT … SELECT … ON CONFLICT statement; from then on the progress engine
 * keeps itemsDone current. Enrolment is personal, reversible and not
 * sensitive, so it is not audited (the enrolment row is the record). The
 * user id always comes from the session.
 */

const planIdSchema = z
  .string({ invalid_type_error: "Choose a study plan.", required_error: "Choose a study plan." })
  .trim()
  .min(1, "Choose a study plan.")
  .max(64, "That study plan id is not valid.");

const planInputSchema = z.object({ planId: planIdSchema });
export type PlanEnrollmentInput = z.input<typeof planInputSchema>;

const enrollmentFormSchema = z.object({
  planId: planIdSchema,
  intent: z.enum(["enroll", "leave"], {
    errorMap: () => ({ message: "Choose whether to enroll or leave." }),
  }),
});

export interface EnrollmentState {
  enrolled: boolean;
  itemsTotal: number;
  itemsDone: number;
}

interface CountedEnrollment {
  itemsTotal: number;
  itemsDone: number;
}

function revalidatePlan(kind: StudyPlanKind, slug: string) {
  const base = PLAN_KINDS[kind].basePath;
  revalidatePath(base);
  revalidatePath(`${base}/${slug}`);
}

async function enroll(userId: string, planId: string): Promise<EnrollmentState> {
  const plan = await db.studyPlan.findFirst({
    where: { id: planId, published: true },
    select: { id: true, slug: true, kind: true },
  });
  if (!plan) throw new NotFoundError("That study plan is not available.");

  // One statement: count the plan's items and the viewer's solved ones, and
  // create (or refresh) the enrolment with those counters. An aggregate with
  // no GROUP BY always yields one row, so an empty plan enrols at 0 of 0.
  // completedAt is set once, when every item is solved, and never cleared.
  const [row] = await db.$queryRaw<CountedEnrollment[]>`
    INSERT INTO "StudyPlanEnrollment" ("userId", "planId", "itemsTotal", "itemsDone", "enrolledAt", "completedAt")
    SELECT ${userId}, ${plan.id}, count(*)::int, count(ups."userId")::int, now(),
      CASE WHEN count(*) > 0 AND count(ups."userId") = count(*) THEN now() END
    FROM "StudyPlanItem" i
    LEFT JOIN "UserProblemStatus" ups
      ON ups."problemId" = i."problemId" AND ups."userId" = ${userId} AND ups.status = 'SOLVED'
    WHERE i."planId" = ${plan.id}
    ON CONFLICT ("userId", "planId") DO UPDATE SET
      "itemsTotal" = EXCLUDED."itemsTotal",
      "itemsDone" = EXCLUDED."itemsDone",
      "completedAt" = COALESCE("StudyPlanEnrollment"."completedAt", EXCLUDED."completedAt")
    RETURNING "itemsTotal", "itemsDone"`;

  revalidatePlan(plan.kind, plan.slug);
  return { enrolled: true, itemsTotal: row?.itemsTotal ?? 0, itemsDone: row?.itemsDone ?? 0 };
}

async function leave(userId: string, planId: string): Promise<EnrollmentState> {
  // Leaving is allowed even if the plan has since been unpublished.
  await db.studyPlanEnrollment.deleteMany({ where: { userId, planId } });
  const plan = await db.studyPlan.findUnique({ where: { id: planId }, select: { slug: true, kind: true } });
  if (plan) revalidatePlan(plan.kind, plan.slug);
  return { enrolled: false, itemsTotal: 0, itemsDone: 0 };
}

export async function enrollInPlan(input: PlanEnrollmentInput): Promise<ActionResult<EnrollmentState>> {
  return runAction(async () => {
    const user = await requireActionUser();
    const { planId } = planInputSchema.parse(input);
    return enroll(user.id, planId);
  }, "enrollInPlan");
}

export async function leavePlan(input: PlanEnrollmentInput): Promise<ActionResult<EnrollmentState>> {
  return runAction(async () => {
    const user = await requireActionUser();
    const { planId } = planInputSchema.parse(input);
    return leave(user.id, planId);
  }, "leavePlan");
}

/** `<form action>` entry point: fields `planId` and `intent` ("enroll" | "leave"). The previous state is ignored. */
export async function changeEnrollment(
  _previous: ActionResult<EnrollmentState> | null,
  formData: FormData,
): Promise<ActionResult<EnrollmentState>> {
  return runAction(async () => {
    const user = await requireActionUser();
    const { planId, intent } = enrollmentFormSchema.parse({
      planId: formData.get("planId"),
      intent: formData.get("intent"),
    });
    return intent === "enroll" ? enroll(user.id, planId) : leave(user.id, planId);
  }, "changeEnrollment");
}
