import "server-only";
import {
  ANSWER_REFUSAL_MESSAGE,
  canAdvanceSection,
  canAnswer,
  layoutSection,
  mapSelectionToOriginal,
  msRemainingInSection,
  parseMockLayout,
  sectionAllowances,
  sectionEndsAt,
  sectionHasEnded,
  type MockLayout,
  type MockLayoutSection,
} from "@recx/shared";
import { db } from "@/lib/db";
import { ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { extraTimeFor } from "@/lib/aptitude/accommodation";
import { gradeAndCloseSection } from "@recx/db/mock";

/**
 * One candidate's live sitting: reading the clock, saving an answer, moving on
 * (Phase 7c).
 *
 * Ownership is a `where` clause on `userId` in every function here, never a
 * trusted parameter — `docs/CONVENTIONS.md` golden rule 2. A sitting id in a
 * URL is not authorisation.
 */

export interface LoadedSitting {
  readonly id: string;
  readonly userId: string;
  readonly patternId: string;
  readonly status: "IN_PROGRESS" | "SUBMITTED" | "AUTO_SUBMITTED" | "ABANDONED";
  readonly startedAt: Date;
  readonly expiresAt: Date;
  readonly currentSectionPosition: number;
  readonly layout: MockLayout;
  readonly version: number;
}

/** The sitting, by id, scoped to its owner. */
export async function loadSitting(attemptId: string, userId: string): Promise<LoadedSitting> {
  const row = await db.mockAttempt.findFirst({
    where: { id: attemptId, userId },
    select: {
      id: true,
      userId: true,
      patternId: true,
      status: true,
      startedAt: true,
      expiresAt: true,
      currentSectionPosition: true,
      layout: true,
      version: true,
    },
  });
  // "Not found" rather than "forbidden" for somebody else's sitting: an id
  // that answers differently is an id that can be probed.
  if (!row) throw new NotFoundError("That sitting was not found.");
  return { ...row, layout: parseMockLayout(row.layout) };
}

export interface SectionView {
  readonly stateId: string;
  readonly sectionId: string;
  readonly key: string;
  readonly position: number;
  readonly label: string;
  readonly questionCount: number;
  readonly timeLimitSec: number;
  readonly cutoffPercent: number;
  readonly marksPerCorrect: number;
  readonly negativeMarkFraction: number;
  readonly allowBackNavigation: boolean;
  readonly startedAt: Date | null;
  readonly endsAt: Date | null;
  readonly submittedAt: Date | null;
  readonly highWaterIndex: number;
}

/** Every section of the sitting, in order, with its live state. */
export async function sectionsOf(attemptId: string): Promise<SectionView[]> {
  const rows = await db.mockSectionState.findMany({
    where: { attemptId },
    orderBy: { position: "asc" },
    select: {
      id: true,
      sectionId: true,
      position: true,
      startedAt: true,
      endsAt: true,
      submittedAt: true,
      highWaterIndex: true,
      section: {
        select: {
          key: true,
          label: true,
          questionCount: true,
          timeLimitSec: true,
          cutoffPercent: true,
          marksPerCorrect: true,
          negativeMarkFraction: true,
          allowBackNavigation: true,
        },
      },
    },
  });
  return rows.map((row) => ({
    stateId: row.id,
    sectionId: row.sectionId,
    key: row.section.key,
    position: row.position,
    label: row.section.label,
    questionCount: row.section.questionCount,
    timeLimitSec: row.section.timeLimitSec,
    cutoffPercent: row.section.cutoffPercent,
    marksPerCorrect: row.section.marksPerCorrect,
    negativeMarkFraction: row.section.negativeMarkFraction,
    allowBackNavigation: row.section.allowBackNavigation,
    startedAt: row.startedAt,
    endsAt: row.endsAt,
    submittedAt: row.submittedAt,
    highWaterIndex: row.highWaterIndex,
  }));
}

export interface ClockReading {
  readonly serverNow: string;
  readonly sectionPosition: number;
  readonly sectionEndsAt: string | null;
  readonly msRemainingInSection: number;
  readonly msRemainingOverall: number;
  readonly sectionClosed: boolean;
  readonly attemptStatus: LoadedSitting["status"];
}

/**
 * What the clock route answers.
 *
 * The client renders THIS and never `Date.now()`: a section deadline ENDS
 * something, so an advisory clock is not an option.
 */
export async function readClock(attemptId: string, userId: string, now: Date): Promise<ClockReading> {
  const sitting = await loadSitting(attemptId, userId);
  const sections = await sectionsOf(attemptId);
  const current = sections.find((section) => section.position === sitting.currentSectionPosition) ?? null;
  return {
    serverNow: now.toISOString(),
    sectionPosition: sitting.currentSectionPosition,
    sectionEndsAt: current?.endsAt?.toISOString() ?? null,
    msRemainingInSection: msRemainingInSection(current?.endsAt ?? null, now),
    msRemainingOverall: Math.max(0, sitting.expiresAt.getTime() - now.getTime()),
    sectionClosed: current === null || current.submittedAt !== null || sectionHasEnded(current.endsAt, now),
    attemptStatus: sitting.status,
  };
}

export interface SaveAnswerInput {
  readonly attemptId: string;
  readonly userId: string;
  readonly questionId: string;
  /** The indexes the candidate clicked, in the order they were SHOWN. */
  readonly shownIndexes: readonly number[];
  readonly numericValue: number | null;
  readonly markedForReview: boolean;
  /** Milliseconds from the section's start, clamped server-side. */
  readonly seenAtMs: number;
  readonly answeredAtMs: number | null;
}

/**
 * Save one answer.
 *
 * `canAnswer()` first, always — it is the pure half of SPEC §5's
 * `allowBackNavigation: false` gate, and `recx_refuse_closed_section_write`
 * is the other half. Selections are mapped back through the layout's
 * permutation before they are written, so a stored answer is in the
 * question's own option order and is readable without the layout.
 */
export async function saveAnswer(input: SaveAnswerInput, now: Date): Promise<{ saved: true; index: number }> {
  const sitting = await loadSitting(input.attemptId, input.userId);
  const sections = await sectionsOf(input.attemptId);
  const current = sections.find((section) => section.position === sitting.currentSectionPosition);
  if (!current) throw new ValidationError("That section is not part of this sitting.");

  const layoutForSection = layoutSection(sitting.layout, current.key);
  if (!layoutForSection) throw new ValidationError("That section is not part of this sitting.");

  const served = layoutForSection.questions.find((question) => question.questionId === input.questionId);
  // A question that is not on this candidate's paper is not an error to
  // explain — it is a request about somebody else's paper.
  if (!served) throw new NotFoundError("That question is not on your paper.");

  const decision = canAnswer({
    status: sitting.status,
    attemptExpired: now.getTime() >= sitting.expiresAt.getTime(),
    allowBackNavigation: current.allowBackNavigation,
    index: served.index,
    highWaterIndex: current.highWaterIndex,
    sectionSubmittedAt: current.submittedAt,
    sectionEnded: sectionHasEnded(current.endsAt, now),
  });
  if (!decision.allowed) throw new ForbiddenError(ANSWER_REFUSAL_MESSAGE[decision.reason]);

  const selectedIndexes = mapSelectionToOriginal(input.shownIndexes, served.optionOrder);
  // One response shape per answer; the CHECK says the same.
  const numericValue = selectedIndexes.length > 0 ? null : input.numericValue;
  const firstSeenAtMs = Math.max(0, Math.floor(input.seenAtMs));
  const answeredAtMs =
    input.answeredAtMs === null ? null : Math.max(firstSeenAtMs, Math.floor(input.answeredAtMs));

  await db.mockAttemptAnswer.upsert({
    where: { attemptId_questionId: { attemptId: input.attemptId, questionId: input.questionId } },
    create: {
      attemptId: input.attemptId,
      sectionStateId: current.stateId,
      questionId: input.questionId,
      position: served.index,
      selectedIndexes,
      numericValue,
      markedForReview: input.markedForReview,
      firstSeenAtMs,
      answeredAtMs,
    },
    update: {
      selectedIndexes,
      numericValue,
      markedForReview: input.markedForReview,
      answeredAtMs,
      // Changing an answer is normal and is recorded, not judged: the count
      // goes on the candidate's own pacing view and nowhere else.
      changeCount: { increment: 1 },
    },
  });

  return { saved: true as const, index: served.index };
}

/**
 * Serve the next question, raising the high-water mark.
 *
 * The mark is what makes `allowBackNavigation: false` enforceable, and it is
 * raised HERE — where the server decides what the candidate may see — rather
 * than by the client telling us where it has got to.
 */
export async function serveIndex(args: {
  readonly attemptId: string;
  readonly userId: string;
  readonly index: number;
}): Promise<{ highWaterIndex: number }> {
  const sitting = await loadSitting(args.attemptId, args.userId);
  const sections = await sectionsOf(args.attemptId);
  const current = sections.find((section) => section.position === sitting.currentSectionPosition);
  if (!current) throw new ValidationError("That section is not part of this sitting.");
  if (args.index < 0 || args.index >= current.questionCount) {
    throw new ValidationError("That question is not in this section.");
  }

  const layoutForSection = layoutSection(sitting.layout, current.key);
  const served = layoutForSection?.questions.find((question) => question.index === args.index);
  if (!served) throw new ValidationError("That question is not in this section.");

  // Create the answer row on FIRST serve, blank. Three things come of it:
  // the palette has a row to colour, `firstSeenAtMs` records when the
  // candidate actually saw the question rather than when they answered it,
  // and `@@unique([attemptId, questionId])` makes "first serve" exactly once
  // without a second table to consult.
  const sinceSectionStart =
    current.startedAt === null ? 0 : Math.max(0, Date.now() - current.startedAt.getTime());
  const created = await db.mockAttemptAnswer.createMany({
    data: [
      {
        attemptId: sitting.id,
        sectionStateId: current.stateId,
        questionId: served.questionId,
        position: served.index,
        firstSeenAtMs: Math.min(sinceSectionStart, 24 * 3_600_000),
      },
    ],
    skipDuplicates: true,
  });
  if (created.count === 1) {
    // SERVED, not answered. The two are different events, and
    // `AptitudeQuestionStat_counts_check` (timesAnswered <= timesServed) is
    // protective only because this increment happens HERE — at the moment the
    // server decides what the candidate may see — rather than at finalise.
    await db.aptitudeQuestionStat.upsert({
      where: { questionId: served.questionId },
      create: { questionId: served.questionId, timesServed: 1, lastServedAt: new Date() },
      update: { timesServed: { increment: 1 }, lastServedAt: new Date() },
    });
  }

  const next = Math.max(current.highWaterIndex, args.index);
  if (next !== current.highWaterIndex) {
    // Conditional, so two tabs cannot lower it between the read and the write.
    await db.mockSectionState.updateMany({
      where: { id: current.stateId, highWaterIndex: { lt: next } },
      data: { highWaterIndex: next },
    });
  }
  return { highWaterIndex: next };
}

/**
 * Close the current section and open the next.
 *
 * Grading happens in `finalise.ts`, and it has to happen BEFORE `submittedAt`
 * is set — `recx_refuse_closed_section_write` refuses any answer write to a
 * closed section, grading included. That ordering is a tested invariant, not
 * a convention.
 */
export async function advanceSection(args: {
  readonly attemptId: string;
  readonly userId: string;
  readonly now: Date;
}): Promise<{ position: number; finished: boolean }> {
  const sitting = await loadSitting(args.attemptId, args.userId);
  const sections = await sectionsOf(args.attemptId);
  const current = sections.find((section) => section.position === sitting.currentSectionPosition);
  if (!current) throw new ValidationError("That section is not part of this sitting.");
  const next = sections.find((section) => section.position === current.position + 1) ?? null;

  const decision = canAdvanceSection({
    status: sitting.status,
    attemptExpired: args.now.getTime() >= sitting.expiresAt.getTime(),
    hasNextSection: next !== null,
  });
  if (!decision.allowed) {
    if (next === null) return { position: current.position, finished: true };
    throw new ForbiddenError(ANSWER_REFUSAL_MESSAGE[decision.reason ?? "attempt_finished"]);
  }

  const terms = await extraTimeFor(args.userId);
  // The allowance comes from the sections' DECLARED limits, in order, so a
  // candidate's extra time is distributed over the paper they were given.
  const allowances = sectionAllowances(
    [...sections].sort((a, b) => a.position - b.position).map((section) => section.timeLimitSec),
    terms.extra,
  );
  const allowance = allowances.find((a) => a.position === next!.position);
  const window = sectionEndsAt({
    now: args.now,
    allowedSec: allowance?.allowedSec ?? 0,
    attemptExpiresAt: sitting.expiresAt,
  });

  await db.$transaction(async (tx) => {
    await gradeAndCloseSection(tx, { stateId: current.stateId, at: args.now });
    if (next!.startedAt === null) {
      await tx.mockSectionState.update({
        where: { id: next!.stateId },
        data: { startedAt: args.now, endsAt: window.endsAt },
      });
    }
    await tx.mockAttempt.update({
      where: { id: sitting.id },
      data: { currentSectionPosition: next!.position },
    });
  });

  return { position: next!.position, finished: false };
}

/** The section of the layout a candidate is on, for the sitting page. */
export function currentLayoutSection(sitting: LoadedSitting, sections: readonly SectionView[]): MockLayoutSection | null {
  const current = sections.find((section) => section.position === sitting.currentSectionPosition);
  return current ? layoutSection(sitting.layout, current.key) : null;
}
