import "server-only";
import { unstable_noStore as noStore } from "next/cache";
import {
  markCoding,
  markMcq,
  normalisePaperLanguages,
  paperLanguageViews,
  parseAttemptLayout,
  questionLanguages,
  type CodingOutcome,
  type McqOutcome,
  type PaperLanguageView,
  type QuestionModeration,
  type Verdict,
} from "@recx/shared";
import { audit } from "@/lib/audit";
import { db } from "@/lib/db";
import { requestIpHash } from "@/lib/ip";
import { scopedStudentWhere, type StudentScope } from "@/lib/auth/scope-where";

/**
 * One candidate's answer script (Phase 13h.1).
 *
 * The gap this fills: `/admin/assessments/[id]/results` has shown what a
 * paper came to since 12y, and `.../[attemptId]` everything that was
 * WATCHED during the sitting since 12y.4 — and nothing anywhere in the
 * product showed what the candidate actually wrote. An examiner could read
 * that a question was answered wrong, that a judge failed on it, or that
 * "the answer recorded was not one of the options shown", and had no way to
 * look at the answer. The results page's own advice for that last case is
 * "correct the paper", which is not something anybody can do without
 * seeing what happened.
 *
 * So this is the marked paper: for each question in the candidate's own
 * numbering, what they were asked, what they answered, and what it earned.
 *
 * Three decisions in it, none of them defaults:
 *
 *   - **Only once the sitting is over.** A paper still being sat has no
 *     script here at all — not the code, not the choices. Reading a
 *     candidate's editor while the clock runs is invigilation, it belongs
 *     on `/admin/invigilate`, and a surface that would serve it to anyone
 *     with the results link is a surface that can leak an answer back into
 *     a hall. VOIDED is included: a voided sitting is precisely one a
 *     human has to be able to look at.
 *   - **The candidate's numbering, not the author's.** The palette a
 *     candidate worked through is the coding questions in the order their
 *     layout shuffled them, then the multiple-choice questions in the
 *     paper's order (`exam-session.tsx`). An examiner discussing "question
 *     three" with a candidate has to mean the same question they do, so
 *     the script is built in that order and also carries the authored
 *     position, which is the one the results table's statistics use.
 *   - **Every read is audited before it happens.** A script is the most
 *     revealing staff read in the product, so one `AuditLog` row at
 *     SENSITIVE with the candidate as `targetUserId` goes in BEFORE the
 *     rows are fetched — the order matters, because a log written
 *     afterwards is missing exactly the reads that failed.
 *
 * On reading `submissionSource`: `tests/repo/admin-scope.test.ts` R5 keeps
 * every other piece of admin code out of it, and that is right — a
 * student's practice code is theirs. An exam answer handed in for marks is
 * a different object: it is the script, and an examiner who may award the
 * marks may read what they are awarding them for. The exemption is named in
 * the fence with an exact count, so this stays the only place it can
 * happen, and it is reached only for a finished sitting of an in-scope
 * candidate, after the audit row.
 */

export interface ScriptOption {
  readonly text: string;
  /** The candidate picked this one. */
  readonly chosen: boolean;
  /** The author's answer. */
  readonly correct: boolean;
}

export interface ScriptMcq {
  readonly kind: "mcq";
  /** The candidate's own numbering, shared with their palette. */
  readonly position: number;
  /** The author's numbering, which the results statistics use. */
  readonly sourcePosition: number;
  readonly stem: string;
  /** In the order THIS candidate was shown them. */
  readonly options: readonly ScriptOption[];
  readonly outcome: McqOutcome;
  readonly points: number;
  readonly maxPoints: number;
  readonly explanation: string | null;
  /** Phase 13i: decided after the paper, with the reason staff wrote. */
  readonly moderation: QuestionModeration;
  readonly moderationReason: string | null;
}

export interface ScriptCoding {
  readonly kind: "coding";
  readonly position: number;
  readonly sourcePosition: number;
  readonly title: string;
  readonly displayCode: string;
  readonly slug: string;
  readonly outcome: CodingOutcome;
  readonly verdict: Verdict | null;
  readonly points: number;
  readonly maxPoints: number;
  /** What they answered it in, or null for a blank question. */
  readonly language: PaperLanguageView | null;
  /** What this question would have accepted (Phase 13a/13c). */
  readonly accepted: readonly PaperLanguageView[];
  readonly passedCases: number;
  readonly totalCases: number;
  readonly handedInAt: Date | null;
  /** How many times they handed this question in. */
  readonly handedIn: number;
  readonly compileOutput: string | null;
  /** Their program, or null when the source has been purged. */
  readonly source: string | null;
  readonly sourceBytes: number;
  readonly purged: boolean;
  /** Phase 13i: decided after the paper, with the reason staff wrote. */
  readonly moderation: QuestionModeration;
  readonly moderationReason: string | null;
}

export type ScriptAnswer = ScriptMcq | ScriptCoding;

export interface AttemptScript {
  readonly attemptId: string;
  readonly assessmentId: string;
  readonly assessmentTitle: string;
  readonly collegeId: string;
  readonly name: string;
  readonly attemptNumber: number;
  readonly status: string;
  readonly startedAt: Date;
  readonly submittedAt: Date | null;
  readonly hall: string | null;
  readonly seatLabel: string | null;
  /**
   * False while the paper is still being sat, in which case `answers` is
   * empty and the page says why rather than showing a half-written script.
   */
  readonly finished: boolean;
  /** The stored paper would not parse: nothing can be laid out from it. */
  readonly layoutUnreadable: boolean;
  readonly answers: readonly ScriptAnswer[];
  readonly points: number;
  readonly maxPoints: number;
}

/** A sitting that is over, and whose script is therefore worth showing. */
const FINISHED: readonly string[] = ["SUBMITTED", "AUTO_SUBMITTED", "TERMINATED", "EXPIRED", "VOIDED"];

/** At most this much of one program, so a pathological paste cannot hang a page. */
export const SOURCE_RENDER_LIMIT = 200_000;

export async function getAttemptScript(
  actorId: string,
  scope: StudentScope,
  attemptId: string,
): Promise<AttemptScript | null> {
  noStore();

  const attempt = await db.assessmentAttempt.findFirst({
    where: { id: attemptId, user: scopedStudentWhere(scope) },
    select: {
      id: true,
      userId: true,
      attemptNumber: true,
      status: true,
      startedAt: true,
      submittedAt: true,
      seatLabel: true,
      layout: true,
      user: { select: { collegeId: true, firstName: true, lastName: true } },
      examSession: { select: { label: true } },
      assessment: { select: { id: true, title: true, allowedLanguages: true } },
      mcqAnswers: { select: { mcqId: true, chosenIndex: true } },
    },
  });
  if (!attempt) return null;

  // Before the rows, deliberately. See the module comment.
  await audit({
    actorId,
    action: "assessment.script.read",
    entityType: "AssessmentAttempt",
    entityId: attempt.id,
    targetUserId: attempt.userId,
    sensitivity: "SENSITIVE",
    metadata: { assessmentId: attempt.assessment.id, status: attempt.status },
    ipHash: await requestIpHash(),
  });

  const head = {
    attemptId: attempt.id,
    assessmentId: attempt.assessment.id,
    assessmentTitle: attempt.assessment.title,
    collegeId: attempt.user.collegeId,
    name: `${attempt.user.firstName} ${attempt.user.lastName}`.trim(),
    attemptNumber: attempt.attemptNumber,
    status: attempt.status,
    startedAt: attempt.startedAt,
    submittedAt: attempt.submittedAt,
    hall: attempt.examSession?.label ?? null,
    seatLabel: attempt.seatLabel,
  };
  const nothing = { ...head, answers: [], points: 0, maxPoints: 0 };

  if (!FINISHED.includes(attempt.status)) {
    return { ...nothing, finished: false, layoutUnreadable: false };
  }

  let layout;
  try {
    layout = parseAttemptLayout(attempt.layout);
  } catch {
    // A broken record, not a blank paper: said rather than guessed at, the
    // same way the marking reports it (`admin-assessment-results.ts`).
    return { ...nothing, finished: true, layoutUnreadable: true };
  }

  const paperLanguages = normalisePaperLanguages(attempt.assessment.allowedLanguages);
  const [questions, mcqs] = await Promise.all([
    db.assessmentProblem.findMany({
      where: { assessmentId: attempt.assessment.id },
      select: {
        id: true,
        position: true,
        points: true,
        problemVersionId: true,
        allowedLanguages: true,
        moderation: true,
        moderationReason: true,
        problemVersion: {
          select: { title: true, problem: { select: { displayCode: true, slug: true } } },
        },
      },
    }),
    db.assessmentMcq.findMany({
      where: { assessmentId: attempt.assessment.id },
      select: {
        id: true,
        position: true,
        points: true,
        stem: true,
        options: true,
        correctIndex: true,
        explanation: true,
        moderation: true,
        moderationReason: true,
      },
    }),
  ]);
  const questionById = new Map(questions.map((q) => [q.id, q]));
  const mcqById = new Map(mcqs.map((m) => [m.id, m]));

  /**
   * Their submissions, newest first, scoped AGAIN on the student.
   *
   * The attempt id above came from a scoped query, and an id list carries
   * no evidence of where it came from — the same argument
   * `admin-assessment-results.ts` makes, and the same one
   * `tests/repo/admin-scope.test.ts` asks for.
   */
  const submissions = await db.submission.findMany({
    where: { assessmentAttemptId: attempt.id, user: scopedStudentWhere(scope) },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      problemVersionId: true,
      verdict: true,
      score: true,
      maxScore: true,
      status: true,
      language: true,
      passedCases: true,
      totalCases: true,
      compileOutput: true,
      sourceBytes: true,
      createdAt: true,
    },
  });
  const latest = new Map<string, (typeof submissions)[number]>();
  const handedIn = new Map<string, number>();
  for (const submission of submissions) {
    if (!latest.has(submission.problemVersionId)) latest.set(submission.problemVersionId, submission);
    handedIn.set(submission.problemVersionId, (handedIn.get(submission.problemVersionId) ?? 0) + 1);
  }

  /**
   * The programs themselves — the one read of `submissionSource` in all of
   * the admin code, exempted by name in the fence. Only the submissions
   * that count, so a candidate who handed a question in nine times costs
   * one row rather than nine.
   */
  const wanted = [...latest.values()].map((s) => s.id);
  const sources =
    wanted.length === 0
      ? []
      : await db.submissionSource.findMany({
          where: { submissionId: { in: wanted } },
          select: { submissionId: true, source: true, archivedAt: true },
        });
  const sourceById = new Map(sources.map((row) => [row.submissionId, row]));

  const answers: ScriptAnswer[] = [];

  // The candidate's palette order: programs as their layout shuffled them,
  // then the choice questions in the paper's order (exam-session.tsx).
  for (const laid of layout.questions) {
    const question = questionById.get(laid.questionId);
    if (question === undefined) continue;
    const submission = latest.get(question.problemVersionId) ?? null;
    const mark = markCoding({
      questionId: question.id,
      points: question.points,
      moderation: question.moderation,
      submission:
        submission === null
          ? null
          : {
              verdict: (submission.verdict as Verdict | null) ?? null,
              score: submission.score,
              maxScore: submission.maxScore,
              terminal: submission.status === "DONE" || submission.status === "INTERNAL_ERROR",
              language: submission.language,
            },
    });
    const stored = submission === null ? null : (sourceById.get(submission.id) ?? null);
    const purged = submission !== null && (stored === null || stored.archivedAt !== null);
    answers.push({
      kind: "coding",
      position: answers.length + 1,
      sourcePosition: question.position,
      title: question.problemVersion.title,
      displayCode: question.problemVersion.problem.displayCode,
      slug: question.problemVersion.problem.slug,
      outcome: mark.outcome,
      verdict: mark.verdict,
      points: mark.points,
      maxPoints: mark.maxPoints,
      moderation: question.moderation,
      moderationReason: question.moderationReason,
      language: mark.language === null ? null : (paperLanguageViews([mark.language])[0] ?? null),
      /**
       * What the question accepted, read from the FROZEN layout first: an
       * edit to the paper or the question since the sitting must not
       * change what this candidate was told. `questionLanguages` is the
       * one place that narrowing is decided, including its "narrowed to
       * nothing means the paper's set" rule.
       */
      accepted: paperLanguageViews(
        questionLanguages({ question: laid.languages ?? question.allowedLanguages, paper: paperLanguages }),
      ),
      passedCases: submission?.passedCases ?? 0,
      totalCases: submission?.totalCases ?? 0,
      handedInAt: submission?.createdAt ?? null,
      handedIn: handedIn.get(question.problemVersionId) ?? 0,
      compileOutput: submission?.compileOutput ?? null,
      source: purged ? null : (stored?.source.slice(0, SOURCE_RENDER_LIMIT) ?? null),
      sourceBytes: submission?.sourceBytes ?? 0,
      purged,
    });
  }

  const chosen = new Map(attempt.mcqAnswers.map((a) => [a.mcqId, a.chosenIndex]));
  for (const laid of layout.mcqs ?? []) {
    const mcq = mcqById.get(laid.mcqId);
    if (mcq === undefined) continue;
    const chosenShownIndex = chosen.get(laid.mcqId) ?? null;
    const mark = markMcq({
      mcqId: mcq.id,
      points: mcq.points,
      moderation: mcq.moderation,
      optionOrder: laid.optionOrder,
      correctIndex: mcq.correctIndex,
      chosenShownIndex,
    });
    answers.push({
      kind: "mcq",
      position: answers.length + 1,
      sourcePosition: mcq.position,
      stem: mcq.stem,
      // The order they were shown, which is the only order their answer
      // means anything in.
      options: laid.optionOrder.flatMap((storedIndex, shownIndex) => {
        const text = mcq.options[storedIndex];
        if (text === undefined) return [];
        return [{ text, chosen: chosenShownIndex === shownIndex, correct: storedIndex === mcq.correctIndex }];
      }),
      outcome: mark.outcome,
      points: mark.points,
      maxPoints: mark.maxPoints,
      explanation: mcq.explanation,
      moderation: mcq.moderation,
      moderationReason: mcq.moderationReason,
    });
  }

  return {
    ...head,
    finished: true,
    layoutUnreadable: false,
    answers,
    points: answers.reduce((sum, a) => sum + a.points, 0),
    maxPoints: answers.reduce((sum, a) => sum + a.maxPoints, 0),
  };
}
