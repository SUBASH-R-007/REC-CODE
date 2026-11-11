import "server-only";
import {
  layoutSection,
  mapOptionsToShown,
  mapOriginalToShown,
  msRemainingInSection,
  patternNotice,
  sectionHasEnded,
  type MockLayoutQuestion,
} from "@recx/shared";
import { db } from "@/lib/db";
import { loadSitting, sectionsOf } from "@/lib/aptitude/sitting";
import { APTITUDE_PUBLIC_SELECT } from "@/server/queries/aptitude-select";

/**
 * What a candidate sees of their own live sitting (Phase 7e).
 *
 * `APTITUDE_PUBLIC_SELECT` only. The key and the working are not merely
 * hidden from the component — they are not selected, so they are not in the
 * page's serialised props either, which is the whole reason
 * `tests/repo/aptitude-answer-exposure.test.ts` requires a named select
 * rather than trusting a component.
 *
 * Options are returned in the candidate's OWN shown order, from the layout's
 * permutation, so the page renders what it is given and the mapping back to
 * the question's own order stays on the server (decision 12).
 */

export interface SittingQuestionView {
  readonly questionId: string;
  readonly index: number;
  readonly displayCode: string;
  readonly kind: "SINGLE_CHOICE" | "MULTI_CHOICE" | "NUMERIC_ENTRY" | "PASSAGE_GROUPED";
  readonly stem: string;
  /** In the order THIS candidate sees them. */
  readonly options: readonly string[];
  readonly numericUnit: string | null;
  readonly passage: { readonly id: string; readonly title: string; readonly body: string } | null;
  /** Their own answer so far, as shown indexes. */
  readonly chosenShownIndexes: readonly number[];
  readonly numericValue: string | null;
  readonly markedForReview: boolean;
  readonly answered: boolean;
}

export interface SittingView {
  readonly attemptId: string;
  readonly patternName: string;
  readonly patternSlug: string;
  readonly notice: string;
  readonly status: "IN_PROGRESS" | "SUBMITTED" | "AUTO_SUBMITTED" | "ABANDONED";
  readonly sectionPosition: number;
  readonly sectionCount: number;
  readonly sectionLabel: string;
  readonly questionCount: number;
  readonly cutoffPercent: number;
  readonly marksPerCorrect: number;
  readonly negativeMarkFraction: number;
  readonly allowBackNavigation: boolean;
  readonly highWaterIndex: number;
  readonly sectionEndsAt: string | null;
  readonly msRemainingInSection: number;
  readonly msRemainingOverall: number;
  readonly sectionClosed: boolean;
  readonly isLastSection: boolean;
  readonly questions: readonly SittingQuestionView[];
}

export async function sittingViewFor(attemptId: string, userId: string, now: Date): Promise<SittingView | null> {
  const sitting = await loadSitting(attemptId, userId);
  const sections = await sectionsOf(attemptId);
  const current = sections.find((section) => section.position === sitting.currentSectionPosition);
  if (!current) return null;

  const pattern = await db.mockPattern.findUniqueOrThrow({
    where: { id: sitting.patternId },
    select: { name: true, slug: true, modelledOnCompany: true },
  });

  const layout = layoutSection(sitting.layout, current.key);
  const served: readonly MockLayoutQuestion[] = layout?.questions ?? [];

  const questions = await db.aptitudeQuestion.findMany({
    where: { id: { in: served.map((question) => question.questionId) } },
    select: { ...APTITUDE_PUBLIC_SELECT, passage: { select: { id: true, title: true, body: true } } },
  });
  const byId = new Map(questions.map((question) => [question.id, question]));

  const answers = await db.mockAttemptAnswer.findMany({
    where: { attemptId, sectionStateId: current.stateId },
    select: { questionId: true, selectedIndexes: true, numericValue: true, markedForReview: true },
  });
  const answerById = new Map(answers.map((answer) => [answer.questionId, answer]));

  const view: SittingQuestionView[] = [];
  for (const slot of served) {
    const question = byId.get(slot.questionId);
    if (!question) continue;
    const answer = answerById.get(slot.questionId);
    view.push({
      questionId: slot.questionId,
      index: slot.index,
      displayCode: question.displayCode,
      kind: question.kind,
      stem: question.stem,
      options: mapOptionsToShown(question.options, slot.optionOrder),
      numericUnit: question.numericUnit,
      passage: question.passage,
      // Stored in the question's own order; shown in this candidate's.
      chosenShownIndexes: answer ? mapOriginalToShown(answer.selectedIndexes, slot.optionOrder) : [],
      numericValue: answer?.numericValue?.toString() ?? null,
      markedForReview: answer?.markedForReview ?? false,
      answered: answer
        ? answer.selectedIndexes.length > 0 || answer.numericValue !== null
        : false,
    });
  }

  return {
    attemptId: sitting.id,
    patternName: pattern.name,
    patternSlug: pattern.slug,
    notice: patternNotice(pattern),
    status: sitting.status,
    sectionPosition: current.position,
    sectionCount: sections.length,
    sectionLabel: current.label,
    questionCount: current.questionCount,
    cutoffPercent: current.cutoffPercent,
    marksPerCorrect: current.marksPerCorrect,
    negativeMarkFraction: current.negativeMarkFraction,
    allowBackNavigation: current.allowBackNavigation,
    highWaterIndex: current.highWaterIndex,
    sectionEndsAt: current.endsAt?.toISOString() ?? null,
    msRemainingInSection: msRemainingInSection(current.endsAt, now),
    msRemainingOverall: Math.max(0, sitting.expiresAt.getTime() - now.getTime()),
    sectionClosed: current.submittedAt !== null || sectionHasEnded(current.endsAt, now),
    isLastSection: current.position === sections.length,
    questions: view,
  };
}

/**
 * The review of a FINALISED sitting: every question, the candidate's answer,
 * the key and the working.
 *
 * The only student path that may select the answer key, and it checks
 * `finalizedAt` BEFORE it selects — the check lives in the read rather than
 * in the component, which is why the fence can allow this one file.
 */
export async function sittingReviewFor(attemptId: string, userId: string) {
  const attempt = await db.mockAttempt.findFirst({
    // Finalised, and theirs. Both in the `where`, so an unfinished sitting
    // reads as "not found" rather than leaking its key.
    where: {
      id: attemptId,
      userId,
      status: { in: ["SUBMITTED", "AUTO_SUBMITTED"] },
      finalizedAt: { not: null },
    },
    select: {
      id: true,
      totalRaw: true,
      totalMax: true,
      percent: true,
      sectionsPassed: true,
      passedOverall: true,
      finalizedAt: true,
      pattern: { select: { name: true, slug: true, modelledOnCompany: true } },
      sectionStates: {
        orderBy: { position: "asc" },
        select: {
          position: true,
          correctCount: true,
          wrongCount: true,
          unansweredCount: true,
          rawScore: true,
          maxScore: true,
          percent: true,
          passedCutoff: true,
          section: { select: { label: true, cutoffPercent: true, negativeMarkFraction: true } },
        },
      },
      answers: {
        orderBy: [{ sectionStateId: "asc" }, { position: "asc" }],
        select: {
          position: true,
          selectedIndexes: true,
          numericValue: true,
          isCorrect: true,
          awarded: true,
          firstSeenAtMs: true,
          answeredAtMs: true,
          sectionState: { select: { position: true } },
          question: {
            select: {
              id: true,
              displayCode: true,
              kind: true,
              topic: true,
              stem: true,
              options: true,
              // Allowed HERE and only here: the sitting is finalised, which
              // the `where` above established before this select ran.
              correctOptionIndexes: true,
              numericAnswer: true,
              numericTolerance: true,
              explanation: true,
              passage: { select: { title: true, body: true } },
            },
          },
        },
      },
    },
  });
  if (!attempt) return null;
  return { ...attempt, notice: patternNotice(attempt.pattern) };
}
