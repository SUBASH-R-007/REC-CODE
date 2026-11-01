import "server-only";
import {
  parseAttemptLayout,
  scoreAttempt,
  type AttemptResult,
  type CodingMarkingInput,
  type Verdict,
} from "@recx/shared";
import { scopedStudentWhere, type StudentScope } from "@/lib/auth/scope";
import { db } from "@/lib/db";

/**
 * What a paper came to, for the people who set it (Phase 12y).
 *
 * `/admin/assessments/[id]` has shown the terms, the questions and the halls
 * since Phase 12a, and `/admin/invigilate` shows the room while it is being
 * sat. Between the two there was nothing: once the clock ran out, no staff
 * screen in this product said who had sat the paper or what they scored.
 * `AssessmentAttempt.totalScore` has existed since Phase 6b with no writer,
 * the multiple-choice half has been markable since 12r and was marked
 * nowhere a human could read, and the coding half's verdicts sat on
 * `Submission` rows that nothing added up.
 *
 * Computed on READ, as 12r decided for the marking it added: every input is
 * immutable once the sitting is over — the layout the candidate was shown,
 * the answers they left, the correct indexes, and the judged submissions —
 * so a stored total would be a second copy of something derivable, and the
 * first thing to go stale when a result is corrected or a question rejudged.
 *
 * SCOPED, like every other staff read of students: an ADMIN with a grant
 * over one department sees that department's candidates and no one else's,
 * and an ADMIN with no grant sees nobody rather than an empty-looking paper.
 */

export interface AttemptResultRow {
  readonly attemptId: string;
  readonly userId: string;
  readonly collegeId: string;
  readonly name: string;
  readonly batchYear: number | null;
  readonly departmentCode: string | null;
  readonly attemptNumber: number;
  readonly status: string;
  readonly startedAt: Date;
  readonly submittedAt: Date | null;
  readonly hall: string | null;
  readonly seatLabel: string | null;
  /** Null for a sitting still in progress: an unfinished paper has no result. */
  readonly result: AttemptResult | null;
  /** The stored paper would not parse, so the choice half is unmarked and a person must look. */
  readonly layoutUnreadable: boolean;
}

export interface QuestionStat {
  readonly kind: "mcq" | "coding";
  readonly position: number;
  readonly label: string;
  readonly maxPoints: number;
  /** Of the finished sittings, how many earned full marks on this question. */
  readonly fullMarks: number;
  readonly partial: number;
  readonly zero: number;
  readonly blank: number;
  /** Pending or unjudged: not a score, and the reason a total is provisional. */
  readonly open: number;
}

export interface AssessmentResults {
  readonly rows: readonly AttemptResultRow[];
  readonly questions: readonly QuestionStat[];
  readonly maxPoints: number;
  /** Finished sittings only — the denominator every average below uses. */
  readonly finished: number;
  readonly inProgress: number;
  readonly provisional: number;
  readonly needsAttention: number;
  readonly averagePercent: number | null;
  readonly medianPercent: number | null;
}

/** A sitting that is over: its result is worth computing and showing. */
/**
 * A sitting that is over: its result is worth computing and showing.
 *
 * VOIDED is deliberately absent — a voided sitting is one a human decided
 * does not count, and giving it a mark on this page would invite somebody
 * to read it as one. NOT_STARTED and DISCONNECTED are not over at all.
 */
const FINISHED: readonly string[] = ["SUBMITTED", "AUTO_SUBMITTED", "TERMINATED", "EXPIRED"];

export async function getAssessmentResults(
  scope: StudentScope,
  assessmentId: string,
): Promise<AssessmentResults> {
  const [paper, attempts] = await Promise.all([
    db.assessment.findUnique({
      where: { id: assessmentId },
      select: {
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
    }),
    db.assessmentAttempt.findMany({
      where: { assessmentId, user: scopedStudentWhere(scope) },
      orderBy: [{ startedAt: "asc" }],
      take: 1_000,
      select: {
        id: true,
        userId: true,
        attemptNumber: true,
        status: true,
        startedAt: true,
        submittedAt: true,
        seatLabel: true,
        layout: true,
        user: {
          select: { collegeId: true, firstName: true, lastName: true, batchYear: true, departmentCode: true },
        },
        examSession: { select: { label: true } },
        mcqAnswers: { select: { mcqId: true, chosenIndex: true } },
      },
    }),
  ]);

  if (!paper) return empty();

  /**
   * The submissions in one query, not one per sitting.
   *
   * `Submission.assessmentAttemptId` is a plain column with no Prisma
   * relation on it, so there is nothing to `include`; a paper sat by two
   * hundred candidates would otherwise be two hundred round trips. The
   * index `[assessmentAttemptId, problemVersionId, createdAt desc]` is
   * exactly this read.
   *
   * Scoped AGAIN on the student, although every attempt id above came from
   * a scoped query. `tests/repo/admin-scope.test.ts` asked for it and the
   * fence is right to: an id list carries no evidence of where it came
   * from, so a later edit that widened the attempt query — or passed ids
   * in from somewhere else — would widen this one silently. Saying it
   * twice costs an index lookup and removes the possibility.
   */
  const submissions =
    attempts.length === 0
      ? []
      : await db.submission.findMany({
          where: {
            assessmentAttemptId: { in: attempts.map((a) => a.id) },
            user: scopedStudentWhere(scope),
          },
          orderBy: { createdAt: "desc" },
          select: {
            assessmentAttemptId: true,
            problemVersionId: true,
            verdict: true,
            score: true,
            maxScore: true,
            status: true,
          },
        });
  const byAttempt = new Map<string, SubmissionRow[]>();
  for (const submission of submissions) {
    const key = submission.assessmentAttemptId;
    if (key === null) continue;
    const list = byAttempt.get(key);
    if (list) list.push(submission);
    else byAttempt.set(key, [submission]);
  }

  const mcqById = new Map(paper.mcqs.map((m) => [m.id, m]));
  const rows: AttemptResultRow[] = [];

  for (const attempt of attempts) {
    const finished = FINISHED.includes(attempt.status);
    const scored = finished
      ? resultOf(
          { layout: attempt.layout, mcqAnswers: attempt.mcqAnswers },
          byAttempt.get(attempt.id) ?? [],
          paper,
          mcqById,
        )
      : null;
    rows.push({
      attemptId: attempt.id,
      userId: attempt.userId,
      collegeId: attempt.user.collegeId,
      name: `${attempt.user.firstName} ${attempt.user.lastName}`.trim(),
      batchYear: attempt.user.batchYear,
      departmentCode: attempt.user.departmentCode,
      attemptNumber: attempt.attemptNumber,
      status: attempt.status,
      startedAt: attempt.startedAt,
      submittedAt: attempt.submittedAt,
      hall: attempt.examSession?.label ?? null,
      seatLabel: attempt.seatLabel,
      result: scored?.result ?? null,
      layoutUnreadable: scored?.layoutUnreadable ?? false,
    });
  }

  return summarise(rows, paper);
}

interface Paper {
  readonly problems: ReadonlyArray<{
    readonly id: string;
    readonly position: number;
    readonly points: number;
    readonly problemVersionId: string;
    readonly problemVersion: { readonly title: string; readonly problem: { readonly displayCode: string } };
  }>;
  readonly mcqs: ReadonlyArray<{
    readonly id: string;
    readonly position: number;
    readonly points: number;
    readonly correctIndex: number;
  }>;
}

interface SubmissionRow {
  readonly assessmentAttemptId: string | null;
  readonly problemVersionId: string;
  readonly verdict: string | null;
  readonly score: number | null;
  readonly maxScore: number | null;
  readonly status: string;
}

interface AttemptAnswers {
  readonly layout: unknown;
  readonly mcqAnswers: ReadonlyArray<{ readonly mcqId: string; readonly chosenIndex: number }>;
}

/**
 * One sitting's result, from the rows that cannot change now.
 *
 * The LAYOUT is what makes the multiple-choice half markable: options are
 * shuffled per candidate, so the stored answer is an index into the order
 * that candidate was shown and has to be mapped back before it is compared.
 * A layout that will not parse is not guessed at — those questions are left
 * out of the marking, exactly as `markAttemptMcqs` drops one whose row is
 * gone, rather than charging somebody for a broken record.
 */
function resultOf(
  attempt: AttemptAnswers,
  submissions: readonly SubmissionRow[],
  paper: Paper,
  mcqById: Map<string, { correctIndex: number; points: number }>,
): { readonly result: AttemptResult; readonly layoutUnreadable: boolean } {
  let laid: ReadonlyArray<{ mcqId: string; optionOrder: readonly number[] }> = [];
  let layoutUnreadable = false;
  try {
    laid = parseAttemptLayout(attempt.layout).mcqs ?? [];
  } catch {
    /**
     * A layout that will not parse is a broken record, not a blank paper,
     * so its multiple-choice half is left unmarked rather than marked
     * zero — and SAID, through `layoutUnreadable`. The first draft only
     * swallowed it, and the database test caught what that costs: a
     * fixture whose layout was one field short scored the coding half,
     * reported 10 out of 14, and looked like a candidate who had simply
     * got the choice wrong. A silently short result is worse than a loud
     * one, because nobody goes looking for it.
     */
    layoutUnreadable = true;
    laid = [];
  }
  const chosen = new Map(attempt.mcqAnswers.map((a) => [a.mcqId, a.chosenIndex]));

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

  // Newest first from the query, so the first hit per version is the one
  // that counts: a sitting creates one submission per answered question,
  // and if that ever changes, the last word is the candidate's last word.
  const latest = new Map<string, SubmissionRow>();
  for (const submission of submissions) {
    if (!latest.has(submission.problemVersionId)) latest.set(submission.problemVersionId, submission);
  }

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

  return { result: scoreAttempt({ mcqs, coding }), layoutUnreadable };
}

function summarise(rows: readonly AttemptResultRow[], paper: Paper): AssessmentResults {
  const done = rows.filter((r) => r.result !== null);
  const percents = done
    .map((r) => r.result?.percent)
    .filter((p): p is number => typeof p === "number")
    .sort((a, b) => a - b);

  const questions: QuestionStat[] = [
    ...paper.mcqs.map((mcq) => {
      const marks = done.flatMap((r) => r.result?.mcq.marks.filter((m) => m.mcqId === mcq.id) ?? []);
      return {
        kind: "mcq" as const,
        position: mcq.position,
        label: `Q${mcq.position}`,
        maxPoints: mcq.points,
        fullMarks: marks.filter((m) => m.outcome === "correct").length,
        partial: 0,
        zero: marks.filter((m) => m.outcome === "wrong").length,
        blank: marks.filter((m) => m.outcome === "blank").length,
        open: marks.filter((m) => m.outcome === "corrupt").length,
      };
    }),
    ...paper.problems.map((problem) => {
      const marks = done.flatMap((r) => r.result?.coding.marks.filter((m) => m.questionId === problem.id) ?? []);
      return {
        kind: "coding" as const,
        position: problem.position,
        label: `${problem.problemVersion.problem.displayCode} · ${problem.problemVersion.title}`,
        maxPoints: problem.points,
        fullMarks: marks.filter((m) => m.outcome === "accepted").length,
        partial: marks.filter((m) => m.outcome === "partial").length,
        zero: marks.filter((m) => m.outcome === "rejected").length,
        blank: marks.filter((m) => m.outcome === "blank").length,
        open: marks.filter((m) => m.outcome === "pending" || m.outcome === "unjudged").length,
      };
    }),
  ].sort((a, b) => a.position - b.position || a.kind.localeCompare(b.kind));

  const maxPoints =
    paper.mcqs.reduce((sum, m) => sum + m.points, 0) + paper.problems.reduce((sum, p) => sum + p.points, 0);

  return {
    rows,
    questions,
    maxPoints,
    finished: done.length,
    inProgress: rows.length - done.length,
    provisional: done.filter((r) => r.result?.provisional).length,
    needsAttention: done.reduce(
      (sum, r) => sum + (r.result?.needsAttention ?? 0) + (r.layoutUnreadable ? 1 : 0),
      0,
    ),
    averagePercent: percents.length > 0 ? percents.reduce((a, b) => a + b, 0) / percents.length : null,
    medianPercent: median(percents),
  };
}

/** The middle of an even-sized field is the mean of the two middle marks. */
function median(sorted: readonly number[]): number | null {
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] ?? null;
  const low = sorted[mid - 1];
  const high = sorted[mid];
  return low === undefined || high === undefined ? null : (low + high) / 2;
}

function empty(): AssessmentResults {
  return {
    rows: [],
    questions: [],
    maxPoints: 0,
    finished: 0,
    inProgress: 0,
    provisional: 0,
    needsAttention: 0,
    averagePercent: null,
    medianPercent: null,
  };
}
