import "server-only";
import { cache } from "react";
import {
  isFinished,
  normalisePaperLanguages,
  paperLanguageViews,
  paperQuestionCount,
  type AttemptStatus,
  type PaperLanguageView,
} from "@recx/shared";
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
  /**
   * Phase 12y: staff have released the marks, so this candidate can read
   * their own. A paper they never sat has nothing to show, so the list
   * only offers the link when both are true.
   */
  readonly resultReleased: boolean;
  /** What the student can do about it right now. */
  readonly action: "start" | "resume" | "finished" | "upcoming" | "closed" | "no_attempts_left";
  /**
   * Which languages a coding question on this paper may be answered in
   * (Phase 13j), with their labels resolved here -- the catalog carries
   * every compiler argv for eleven toolchains and has no business in a
   * candidate's bundle.
   *
   * It is the one thing a candidate wants to know before a coding paper
   * and the list never said it: a paper restricted to C is a different
   * evening's revision from one that takes Python. Empty means the paper
   * restricts nothing, and the page says so rather than showing a blank.
   * The per-question narrowing is not here: it is frozen into each
   * attempt and shown in the sitting, and listing it before the paper
   * would describe questions the candidate has not been shown.
   */
  readonly languages: readonly PaperLanguageView[];
  /** Phase 13j: which group the page files it under. */
  readonly group: "open" | "upcoming" | "past";
}

/**
 * Which heading a paper belongs under (Phase 13j).
 *
 * From what the candidate can DO, not from the window alone: a paper
 * whose attempts are used up is in the past whatever its clock says, and
 * one being sat right now is open even if it technically closed a minute
 * ago -- the resume link has to stay reachable.
 */
function groupFor(action: AssessmentListItem["action"]): AssessmentListItem["group"] {
  if (action === "start" || action === "resume") return "open";
  if (action === "upcoming") return "upcoming";
  return "past";
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
      /**
       * DRAFT is never visible to a student. ARCHIVED was excluded too —
       * "ARCHIVED is history" — and that was right while this list was
       * only a way IN to a paper: nobody needs to see a paper they can no
       * longer sit.
       *
       * Phase 12y.5: it is also the way to a RESULT, and a department
       * archives a paper as soon as it is done with it. So a released
       * result vanished from the student's list the moment the paper was
       * filed away — which is exactly when they go looking for it.
       * (Reported from use: "when the results are published, it is not
       * visible to the students". Both released papers on the development
       * database were ARCHIVED.)
       *
       * An archived paper is listed only when this student SAT it: their
       * own history, not a filing cabinet of papers that were never
       * theirs.
       */
      OR: [
        { status: { in: ["PUBLISHED", "OPEN", "CLOSED"] } },
        { status: "ARCHIVED", attempts: { some: { userId: user.id } } },
      ],
      AND: [
        { OR: [{ audienceBatchYear: null }, { audienceBatchYear: user.batchYear }] },
        { OR: [{ audienceDepartmentCode: null }, { audienceDepartmentCode: user.departmentCode }] },
        { OR: [{ audienceSection: null }, { audienceSection: user.section }] },
      ],
    },
    orderBy: [{ opensAt: "desc" }],
    /**
     * Phase 13j: 50 was a silent cap. A student in their fourth year has
     * sat more papers than that, and the ones it dropped were the oldest
     * -- which is where a released result somebody is looking for lives.
     * 300 is above any real student's total, and the page groups the
     * list, so the finished ones are out of the way rather than in front
     * of the paper opening this afternoon.
     */
    take: 300,
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
      resultsPublishedAt: true,
      /**
       * BOTH kinds (Phase 12v). The sixth place this was counted from the
       * coding questions alone: the list a student picks a paper from told
       * them a paper of multiple-choice questions had none.
       */
      _count: { select: { problems: true, mcqs: true } },
      // Phase 13j: what a candidate may answer the programs in.
      allowedLanguages: true,
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
    const action = actionFor({
      now,
      opensAt: row.opensAt,
      closesAt: row.closesAt,
      status: row.status,
      maxAttempts: row.maxAttempts,
      attempt,
    });
    return {
      slug: row.slug,
      title: row.title,
      opensAt: row.opensAt,
      closesAt: row.closesAt,
      durationSec: row.durationSec,
      questionCount: paperQuestionCount({
        problems: { length: row._count.problems },
        mcqs: { length: row._count.mcqs },
      }),
      proctorMode: row.proctorMode,
      affectsPlacementEligibility: row.affectsPlacementEligibility,
      maxAttempts: row.maxAttempts,
      attempt,
      resultReleased: row.resultsPublishedAt !== null && attempt !== null && attempt.status !== "IN_PROGRESS",
      action,
      languages: paperLanguageViews(normalisePaperLanguages(row.allowedLanguages)),
      group: groupFor(action),
    };
  });
});
