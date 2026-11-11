import "server-only";
import {
  WRITTEN_REFUSALS,
  rubricScore,
  type WrittenAnswerStatus,
  type WrittenKind,
  type WrittenPromptStatus,
} from "@recx/shared";
import { db } from "@/lib/db";
import { renderMarkdown, renderUntrustedMarkdown } from "@/lib/markdown";

/**
 * Reading written questions and answers (Phase 12i).
 *
 * Two rules hold across every read here. A student sees their own answer
 * and nobody else's — there is no "model answer" surface and no browsing
 * of other people's work, because an answer is coursework rather than a
 * post. And a question's markdown is a TA's, rendered with the trusted
 * renderer; an ANSWER's markdown is a student's, rendered with the
 * untrusted one, which is the same line the discussion board draws.
 */

const PERSON = { select: { firstName: true, lastName: true } } as const;
const name = (p: { firstName: string; lastName: string }) => `${p.firstName} ${p.lastName}`.trim();

export interface CriterionView {
  id: string;
  label: string;
  guidance: string | null;
  weight: number;
}

export interface PromptCardView {
  id: string;
  slug: string;
  kind: WrittenKind;
  title: string;
  timeBoxMinutes: number;
  status: WrittenPromptStatus;
  /** The viewer's own answer, if they have started one. */
  mine: { status: WrittenAnswerStatus; percent: number | null } | null;
}

export interface MarkView {
  criterionId: string;
  points: number;
  note: string | null;
}

export interface AnswerView {
  id: string;
  status: WrittenAnswerStatus;
  bodyMd: string;
  submittedAt: Date | null;
  handBackNote: string | null;
  grade: {
    points: number;
    outOf: number;
    percent: number;
    html: string;
    at: Date;
    grader: string;
    marks: MarkView[];
  } | null;
}

export interface PromptView {
  id: string;
  slug: string;
  kind: WrittenKind;
  title: string;
  html: string;
  timeBoxMinutes: number;
  status: WrittenPromptStatus;
  author: string;
  criteria: CriterionView[];
  /** The weighted marks available, so the rubric adds up on the page. */
  outOf: number;
}

const PROMPT_SELECT = {
  id: true,
  slug: true,
  kind: true,
  title: true,
  promptMd: true,
  timeBoxMinutes: true,
  status: true,
  author: PERSON,
  criteria: {
    orderBy: { order: "asc" },
    select: { id: true, label: true, guidance: true, weight: true },
  },
} as const;

function promptViewOf(row: {
  id: string;
  slug: string;
  kind: WrittenKind;
  title: string;
  promptMd: string;
  timeBoxMinutes: number;
  status: WrittenPromptStatus;
  author: { firstName: string; lastName: string };
  criteria: CriterionView[];
}): PromptView {
  return {
    id: row.id,
    slug: row.slug,
    kind: row.kind,
    title: row.title,
    html: renderMarkdown(row.promptMd),
    timeBoxMinutes: row.timeBoxMinutes,
    status: row.status,
    author: name(row.author),
    criteria: row.criteria,
    outOf: rubricScore(row.criteria, []).outOf,
  };
}

/** The questions a student can answer, with where they are on each. */
export async function loadOpenPrompts(userId: string): Promise<PromptCardView[]> {
  const rows = await db.writtenPrompt.findMany({
    where: {
      OR: [
        { status: "PUBLISHED" },
        // A retired question stays on the list of somebody who answered
        // it: their work did not disappear when it was withdrawn.
        { status: "RETIRED", answers: { some: { authorId: userId } } },
      ],
    },
    orderBy: [{ status: "asc" }, { publishedAt: "desc" }],
    take: 60,
    select: {
      id: true,
      slug: true,
      kind: true,
      title: true,
      timeBoxMinutes: true,
      status: true,
      answers: {
        where: { authorId: userId },
        select: { status: true, points: true, outOf: true },
      },
    },
  });

  return rows.map((row) => {
    const mine = row.answers[0];
    return {
      id: row.id,
      slug: row.slug,
      kind: row.kind,
      title: row.title,
      timeBoxMinutes: row.timeBoxMinutes,
      status: row.status,
      mine: mine
        ? {
            status: mine.status,
            percent:
              mine.points !== null && mine.outOf !== null && mine.outOf > 0
                ? Math.round((mine.points / mine.outOf) * 100)
                : null,
          }
        : null,
    };
  });
}

/**
 * One question and the viewer's own answer to it.
 *
 * `null` for a question that does not exist, and for a draft the viewer
 * did not write: an unpublished question is not theirs to read.
 */
export async function loadPromptForStudent(
  userId: string,
  slug: string,
): Promise<{ prompt: PromptView; answer: AnswerView | null } | null> {
  const row = await db.writtenPrompt.findUnique({ where: { slug }, select: PROMPT_SELECT });
  if (!row) return null;
  if (row.status === "DRAFT") return null;

  const answer = await db.writtenAnswer.findUnique({
    where: { promptId_authorId: { promptId: row.id, authorId: userId } },
    select: ANSWER_SELECT,
  });
  // A retired question can still be read by somebody who answered it, and
  // by nobody else.
  if (row.status === "RETIRED" && !answer) return null;

  return { prompt: promptViewOf(row), answer: answer ? answerViewOf(answer) : null };
}

const ANSWER_SELECT = {
  id: true,
  status: true,
  bodyMd: true,
  submittedAt: true,
  handBackNote: true,
  gradedAt: true,
  overallMd: true,
  points: true,
  outOf: true,
  grader: PERSON,
  marks: { select: { criterionId: true, points: true, note: true } },
} as const;

type AnswerRow = {
  id: string;
  status: WrittenAnswerStatus;
  bodyMd: string;
  submittedAt: Date | null;
  handBackNote: string | null;
  gradedAt: Date | null;
  overallMd: string | null;
  points: number | null;
  outOf: number | null;
  grader: { firstName: string; lastName: string } | null;
  marks: MarkView[];
};

function answerViewOf(row: AnswerRow): AnswerView {
  return {
    id: row.id,
    status: row.status,
    bodyMd: row.bodyMd,
    submittedAt: row.submittedAt,
    handBackNote: row.handBackNote,
    grade:
      row.gradedAt && row.overallMd && row.points !== null && row.outOf !== null
        ? {
            points: row.points,
            outOf: row.outOf,
            percent: row.outOf > 0 ? Math.round((row.points / row.outOf) * 100) : 0,
            html: renderMarkdown(row.overallMd),
            at: row.gradedAt,
            grader: row.grader ? name(row.grader) : "a TA",
            marks: row.marks,
          }
        : null,
  };
}

// ── The mentor's side ───────────────────────────────────────────────────

export interface QueueRow {
  answerId: string;
  promptTitle: string;
  promptSlug: string;
  kind: WrittenKind;
  student: string;
  submittedAt: Date;
  words: number;
}

/**
 * The marking queue: oldest first, because the student who has waited
 * longest is the one waiting.
 */
export async function loadGradingQueue(graderId: string): Promise<QueueRow[]> {
  const rows = await db.writtenAnswer.findMany({
    where: { status: "SUBMITTED", authorId: { not: graderId } },
    orderBy: { submittedAt: "asc" },
    take: 50,
    select: {
      id: true,
      bodyMd: true,
      submittedAt: true,
      author: PERSON,
      prompt: { select: { title: true, slug: true, kind: true } },
    },
  });
  return rows.map((row) => ({
    answerId: row.id,
    promptTitle: row.prompt.title,
    promptSlug: row.prompt.slug,
    kind: row.prompt.kind,
    student: name(row.author),
    submittedAt: row.submittedAt ?? new Date(0),
    words: row.bodyMd.trim().split(/\s+/).filter(Boolean).length,
  }));
}

export interface GradingView {
  answerId: string;
  student: string;
  submittedAt: Date;
  /** The student's own markdown, rendered with the untrusted renderer. */
  html: string;
  prompt: PromptView;
}

export type GradingResult = { ok: true; view: GradingView } | { ok: false; status: number; error: string };

/**
 * One answer, for the person about to mark it.
 *
 * The grader sees the student's name: this is coursework, not the
 * discussion board, and a TA writing "you have described the API and not
 * the storage" is writing to somebody. The student is told so on the page
 * before they hand anything in.
 */
export async function loadForGrading(graderId: string, answerId: string): Promise<GradingResult> {
  const row = await db.writtenAnswer.findUnique({
    where: { id: answerId },
    select: {
      id: true,
      status: true,
      authorId: true,
      bodyMd: true,
      submittedAt: true,
      author: PERSON,
      prompt: { select: PROMPT_SELECT },
    },
  });
  if (!row) return { ok: false, status: 404, error: "That answer was not found." };
  if (row.authorId === graderId) return { ok: false, status: 403, error: WRITTEN_REFUSALS.ownAnswer };
  if (row.status !== "SUBMITTED") {
    return {
      ok: false,
      status: 409,
      error: row.status === "GRADED" ? WRITTEN_REFUSALS.alreadyGraded : WRITTEN_REFUSALS.notSubmitted,
    };
  }

  return {
    ok: true,
    view: {
      answerId: row.id,
      student: name(row.author),
      submittedAt: row.submittedAt ?? new Date(0),
      html: renderUntrustedMarkdown(row.bodyMd),
      prompt: promptViewOf(row.prompt),
    },
  };
}

export interface AuthoredPrompt {
  id: string;
  slug: string;
  title: string;
  kind: WrittenKind;
  status: WrittenPromptStatus;
  criteria: number;
  answers: number;
  waiting: number;
}

/** The questions this TA wrote, and how much marking each has waiting. */
export async function loadAuthoredPrompts(authorId: string): Promise<AuthoredPrompt[]> {
  const rows = await db.writtenPrompt.findMany({
    where: { authorId },
    orderBy: { createdAt: "desc" },
    take: 50,
    select: {
      id: true,
      slug: true,
      title: true,
      kind: true,
      status: true,
      _count: { select: { criteria: true, answers: true } },
      answers: { where: { status: "SUBMITTED" }, select: { id: true } },
    },
  });
  return rows.map((row) => ({
    id: row.id,
    slug: row.slug,
    title: row.title,
    kind: row.kind,
    status: row.status,
    criteria: row._count.criteria,
    answers: row._count.answers,
    waiting: row.answers.length,
  }));
}
