import "server-only";
import { cache } from "react";
import { isFinished, type AttemptStatus } from "@recx/shared";
import { db } from "@/lib/db";

/**
 * A student's own assessments (Phase 6c).
 *
 * Audience scoping is done in the WHERE clause rather than filtered in
 * TypeScript afterwards: a null audience dimension means "every value of that
 * dimension", so the query asks for assessments whose audience is either
 * unset or equal to this student's. Doing it in SQL means an assessment set
 * for another department is never loaded in the first place, which is the
 * shape `tests/repo/student-exposure.test.ts` expects of every student query.
 *
 * Nothing here reveals a question, a test or a frozen version. The list is
 * titles, windows and the student's own attempt state.
 */

export interface AssessmentListItem {
  readonly slug: string;
  readonly title: string;
  readonly opensAt: Date;
  readonly closesAt: Date;
  readonly durationSec: number;
  readonly questionCount: number;
  readonly proctorMode: string;
  readonly affectsPlacementEligibility: boolean;
  readonly maxAttempts: number;
  /** The student's own latest sitting, if any. */
  readonly attempt: { readonly status: AttemptStatus; readonly attemptNumber: number } | null;
  /** What the student can do about it right now. */
  readonly action: "start" | "resume" | "finished" | "upcoming" | "closed" | "no_attempts_left";
}

function actionFor(args: {
  now: Date;
  opensAt: Date;
  closesAt: Date;
  status: string;
  maxAttempts: number;
  attempt: { status: AttemptStatus; attemptNumber: number } | null;
}): AssessmentListItem["action"] {
  if (args.attempt && !isFinished(args.attempt.status)) return "resume";
  if (args.attempt && isFinished(args.attempt.status)) {
    return args.attempt.attemptNumber >= args.maxAttempts ? "finished" : "start";
  }
  if (args.now < args.opensAt) return "upcoming";
  if (args.now >= args.closesAt || args.status !== "OPEN") return "closed";
  return "start";
}

export const listMyAssessments = cache(async (user: {
  id: string;
  batchYear: number | null;
  departmentCode: string | null;
  section: string | null;
}): Promise<AssessmentListItem[]> => {
  const now = new Date();
  const rows = await db.assessment.findMany({
    where: {
      // DRAFT is never visible to a student; ARCHIVED is history.
      status: { in: ["PUBLISHED", "OPEN", "CLOSED"] },
      AND: [
        { OR: [{ audienceBatchYear: null }, { audienceBatchYear: user.batchYear }] },
        { OR: [{ audienceDepartmentCode: null }, { audienceDepartmentCode: user.departmentCode }] },
        { OR: [{ audienceSection: null }, { audienceSection: user.section }] },
      ],
    },
    orderBy: [{ opensAt: "desc" }],
    take: 50,
    select: {
      slug: true,
      title: true,
      status: true,
      opensAt: true,
      closesAt: true,
      durationSec: true,
      proctorMode: true,
      affectsPlacementEligibility: true,
      maxAttempts: true,
      _count: { select: { problems: true } },
      attempts: {
        where: { userId: user.id },
        orderBy: { attemptNumber: "desc" },
        take: 1,
        select: { status: true, attemptNumber: true },
      },
    },
  });

  return rows.map((row) => {
    const attempt = row.attempts[0]
      ? { status: row.attempts[0].status as AttemptStatus, attemptNumber: row.attempts[0].attemptNumber }
      : null;
    return {
      slug: row.slug,
      title: row.title,
      opensAt: row.opensAt,
      closesAt: row.closesAt,
      durationSec: row.durationSec,
      questionCount: row._count.problems,
      proctorMode: row.proctorMode,
      affectsPlacementEligibility: row.affectsPlacementEligibility,
      maxAttempts: row.maxAttempts,
      attempt,
      action: actionFor({
        now,
        opensAt: row.opensAt,
        closesAt: row.closesAt,
        status: row.status,
        maxAttempts: row.maxAttempts,
        attempt,
      }),
    };
  });
});
