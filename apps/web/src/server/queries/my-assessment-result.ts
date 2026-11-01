import "server-only";
import {
  parseAttemptLayout,
  scoreAttempt,
  type AttemptResult,
  type CodingMarkingInput,
  type Verdict,
} from "@recx/shared";
import { db } from "@/lib/db";

/**
 * A candidate's own result, once staff have released it (Phase 12y).
 *
 * In its own module, away from the admin reads, for the reason
 * `sitting-report.ts` gives: `tests/repo/admin-scope.test.ts` treats a file
 * that mentions ADMIN and calls a guard as admin code and then wants every
 * student query in it shaped with `scopedStudentWhere`. That is the wrong
 * tool here — this query is scoped by `userId`, the viewer's own, which is
 * stronger than any department grant.
 *
 * Two rules, and the whole feature is in them:
 *
 *   - **Nothing at all before release.** `resultsPublishedAt` is the gate,
 *     and it is in the WHERE clause rather than checked afterwards, so an
 *     unreleased paper cannot leak through a caller that forgot to look.
 *   - **Their own, and only their own.** No rank, no cohort position, no
 *     other candidate, no average. A mark a student can compare with their
 *     neighbour's is a different product, and this one does not do it
 *     because being 41st of 60 is not information a student can act on.
 *
 * And nothing about integrity: no band, no "integrity score", not even a
 * flag. SPEC §5 is explicit, and the student's own report
 * (`sitting-report.ts`) is where a flagged sitting is explained in words.
 */

export interface MyQuestionResult {
  readonly kind: "mcq" | "coding";
  readonly position: number;
  readonly label: string;
  readonly outcome: string;
  readonly points: number;
  readonly maxPoints: number;
}

export interface MyAssessmentResult {
  readonly attemptId: string;
  readonly assessmentTitle: string;
  readonly slug: string;
  readonly attemptNumber: number;
  readonly submittedAt: Date | null;
  readonly releasedAt: Date;
  readonly points: number;
  readonly maxPoints: number;
  readonly percent: number | null;
  readonly provisional: boolean;
  readonly questions: readonly MyQuestionResult[];
}

/** What a candidate is shown about their own sitting, or null if there is nothing to show. */
export async function myAssessmentResult(args: {
  readonly userId: string;
  readonly slug: string;
}): Promise<MyAssessmentResult | null> {
  const attempt = await db.assessmentAttempt.findFirst({
    where: {
      userId: args.userId,
      assessment: {
        slug: args.slug,
        // The gate, in the query. An unreleased paper has no row to find.
        resultsPublishedAt: { not: null },
      },
      status: { in: ["SUBMITTED", "AUTO_SUBMITTED", "TERMINATED", "EXPIRED"] },
    },
    // Their latest sitting: the one they will be asking about.
    orderBy: { attemptNumber: "desc" },
    select: {
      id: true,
      attemptNumber: true,
      submittedAt: true,
      layout: true,
      mcqAnswers: { select: { mcqId: true, chosenIndex: true } },
      assessment: {
        select: {
          title: true,
          slug: true,
          resultsPublishedAt: true,
          problems: {
            orderBy: { position: "asc" },
            select: {
              id: true,
              position: true,
              points: true,
              problemVersionId: true,
              problemVersion: { select: { title: true, problem: { select: { displayCode: true } } } },
            },
          },
          mcqs: { orderBy: { position: "asc" }, select: { id: true, position: true, points: true, correctIndex: true } },
        },
      },
    },
  });
  const releasedAt = attempt?.assessment.resultsPublishedAt ?? null;
  // Narrowed here rather than trusted from the WHERE clause: the query says
  // `not: null` and the type still says `Date | null`, and a page that cast
  // it would be asserting the filter rather than reading it.
  if (!attempt || releasedAt === null) return null;

  const submissions = await db.submission.findMany({
    where: { assessmentAttemptId: attempt.id, userId: args.userId },
    orderBy: { createdAt: "desc" },
    select: { problemVersionId: true, verdict: true, score: true, maxScore: true, status: true },
  });
  const latest = new Map<string, (typeof submissions)[number]>();
  for (const submission of submissions) {
    if (!latest.has(submission.problemVersionId)) latest.set(submission.problemVersionId, submission);
  }

  const paper = attempt.assessment;
  const mcqById = new Map(paper.mcqs.map((m) => [m.id, m]));
  const chosen = new Map(attempt.mcqAnswers.map((a) => [a.mcqId, a.chosenIndex]));

  let laid: ReadonlyArray<{ mcqId: string; optionOrder: readonly number[] }> = [];
  try {
    laid = parseAttemptLayout(attempt.layout).mcqs ?? [];
  } catch {
    laid = [];
  }

  const mcqs = laid.flatMap((entry) => {
    const row = mcqById.get(entry.mcqId);
    if (row === undefined) return [];
    return [
      {
        mcqId: entry.mcqId,
        points: row.points,
        optionOrder: entry.optionOrder,
        correctIndex: row.correctIndex,
        chosenShownIndex: chosen.get(entry.mcqId) ?? null,
      },
    ];
  });

  const coding: CodingMarkingInput[] = paper.problems.map((problem) => {
    const submission = latest.get(problem.problemVersionId);
    return {
      questionId: problem.id,
      points: problem.points,
      submission:
        submission === undefined
          ? null
          : {
              verdict: (submission.verdict as Verdict | null) ?? null,
              score: submission.score,
              maxScore: submission.maxScore,
              terminal: submission.status === "DONE" || submission.status === "INTERNAL_ERROR",
            },
    };
  });

  const result: AttemptResult = scoreAttempt({ mcqs, coding });
  const mcqPosition = new Map(paper.mcqs.map((m) => [m.id, m.position]));

  /**
   * The breakdown names the OUTCOME, never the right answer. A student
   * reading "wrong" learns what they need to; a student reading which
   * option was correct is holding the key to a question the department
   * will very likely ask the next cohort.
   */
  const questions: MyQuestionResult[] = [
    ...result.mcq.marks.map((mark) => ({
      kind: "mcq" as const,
      position: mcqPosition.get(mark.mcqId) ?? 0,
      label: `Question ${mcqPosition.get(mark.mcqId) ?? "?"}`,
      outcome: mark.outcome,
      points: mark.points,
      maxPoints: mark.maxPoints,
    })),
    ...result.coding.marks.map((mark) => {
      const problem = paper.problems.find((p) => p.id === mark.questionId);
      return {
        kind: "coding" as const,
        position: problem?.position ?? 0,
        label: problem ? problem.problemVersion.title : "A coding question",
        outcome: mark.outcome,
        points: mark.points,
        maxPoints: mark.maxPoints,
      };
    }),
  ].sort((a, b) => a.position - b.position);

  return {
    attemptId: attempt.id,
    assessmentTitle: paper.title,
    slug: paper.slug,
    attemptNumber: attempt.attemptNumber,
    submittedAt: attempt.submittedAt,
    releasedAt,
    points: result.points,
    maxPoints: result.maxPoints,
    percent: result.percent,
    provisional: result.provisional,
    questions,
  };
}
