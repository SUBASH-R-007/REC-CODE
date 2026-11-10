import "server-only";
import { cache } from "react";
import {
  ANSWER_LANGUAGE_KEY,
  SQL_LANGUAGE_KEY,
  SQL_LANGUAGE_VIEW,
  paperLanguageViews,
  questionLanguages,
  type AttemptLayout,
  type PaperLanguageView,
} from "@recx/shared";
import { db } from "@/lib/db";
import { languagesOfSitting } from "@/lib/exam/language";
import { renderMarkdown } from "@/lib/markdown";
import type { ExamQuestionView } from "@/components/exam/exam-session";

/**
 * The candidate's paper (Phase 6c).
 *
 * The difference from `getProblemWorkspace` is the whole point: that reads a
 * problem's LIVE version, and this reads the exact `ProblemVersion` the
 * attempt's frozen layout pins. A problem edited and republished mid-exam
 * must not change the paper under a candidate — the pin is what makes a
 * disputed answer answerable three months later, and `layout` is in the
 * write-once tuple the `AssessmentAttempt_machine` trigger protects.
 *
 * Only `isSample` test cases are loaded, exactly as on the practice page: a
 * hidden test's blobs never leave the database through this path, and
 * `tests/repo/student-exposure.test.ts` plus the live canary suite keep that
 * true.
 */

export interface ExamPaper {
  readonly questions: ExamQuestionView[];
  /** The multiple-choice half, in the paper's own order (Phase 12r). */
  readonly mcqs: ExamMcqView[];
  /**
   * Every language this sitting may be answered in (Phase 13a), labels
   * already resolved, taken from the attempt's FROZEN set and not from the
   * assessment's current list.
   *
   * The candidate picks one of these per question. One entry is the normal
   * case for a paper a department has restricted to a single language, and
   * the pane shows it as text rather than a dropdown of one.
   */
  readonly languages: PaperLanguageView[];
  /** Questions in the layout whose version could not be read. */
  readonly missing: string[];
}

/**
 * One MCQ, as a candidate's browser is allowed to see it (Phase 12r).
 *
 * `correctIndex` is deliberately absent, and not merely unused: it is
 * never selected on this path. An answer key that reaches the client is an
 * answer key, whatever the component does with it — and a sitting is
 * exactly where somebody will read the page source.
 *
 * `options` is in THIS candidate's order, taken from their layout, so the
 * index they click is the index the save route stores and the marker maps
 * back. The author's order is never sent.
 */
export interface ExamMcqView {
  readonly mcqId: string;
  readonly position: number;
  readonly points: number;
  readonly stemHtml: string;
  readonly options: readonly string[];
}

export const getExamPaper = cache(async (layout: AttemptLayout): Promise<ExamPaper> => {
  const mcqs = await examMcqViews(layout);
  const accepted = await languagesOfSitting(layout);
  const languages = paperLanguageViews(accepted);
  /**
   * What each question narrows the paper to (Phase 13c), resolved once
   * here so the pane renders the question's own list and the routes
   * validate against the same thing.
   */
  const acceptedFor = (questionId: string): string[] => {
    const question = layout.questions.find((q) => q.questionId === questionId);
    return questionLanguages({ question: question?.languages, paper: accepted });
  };
  const versionIds = layout.questions.map((question) => question.problemVersionId);
  if (versionIds.length === 0) return { questions: [], mcqs, languages, missing: [] };

  const versions = await db.problemVersion.findMany({
    where: { id: { in: versionIds } },
    select: {
      id: true,
      title: true,
      statementMd: true,
      starterCodes: { select: { language: true, code: true } },
      testCases: {
        where: { isSample: true },
        orderBy: { index: "asc" },
        select: { input: { select: { inline: true } }, output: { select: { inline: true } } },
      },
    },
  });
  const byId = new Map(versions.map((version) => [version.id, version]));

  /**
   * The language the editor OPENS in (Phase 13a): the first of the frozen
   * set, which for a paper restricted to one language is that language and
   * for an attempt begun before any of this existed is the single frozen
   * one. A candidate who has already worked on a question is put back into
   * the language they were working in -- the attempt page reads that from
   * the last snapshot and the session seeds itself from it.
   */
  const defaultLanguage = accepted[0] ?? "cpp20";

  const questions: ExamQuestionView[] = [];
  const missing: string[] = [];
  for (const question of layout.questions) {
    const version = byId.get(question.problemVersionId);
    if (!version) {
      // Reported rather than skipped silently: a paper short one question is
      // something an invigilator has to know about, not something to hide.
      missing.push(question.questionId);
      continue;
    }
    const starters = new Map(version.starterCodes.map((s) => [s.language, s.code]));
    /**
     * Phase 16f. Read from the FROZEN layout, never from the version's
     * current `ioMode`: a problem republished mid-sitting must not turn a
     * code editor into an answer box under somebody part way through.
     */
    const kind = question.kind ?? "CODE";
    questions.push({
      questionId: question.questionId,
      title: version.title,
      // Sanitised by renderMarkdown, the same pipeline the practice page uses.
      statementHtml: renderMarkdown(version.statementMd),
      points: question.points,
      samples: version.testCases.map((test) => ({
        input: test.input.inline ?? "",
        output: test.output.inline ?? "",
      })),
      /**
       * The starter for EVERY accepted language (Phase 13a), so switching
       * language in the middle of a sitting is instant and needs no
       * request. A problem with no starter in a language gives an empty
       * editor, which is what the practice workspace does too.
       *
       * Only the accepted languages: a paper restricted to Python has no
       * business shipping eleven starters, and the samples beside them are
       * already the bulk of this payload.
       */
      starters:
        kind === "ANSWER"
          ? {}
          : // Phase 16o: a SQL question's one starter, which an author
            // writes as a comment rather than as a program.
            kind === "SQL"
            ? { [SQL_LANGUAGE_KEY]: starters.get(SQL_LANGUAGE_KEY) ?? "" }
            : Object.fromEntries(acceptedFor(question.questionId).map((key) => [key, starters.get(key) ?? ""])),
      /**
       * The languages THIS question accepts (Phase 13c). Usually the
       * paper's own set; fewer when the question narrows it.
       */
      // An ANSWER question has no language to choose, so the picker has
      // nothing to render and the routes accept exactly `answer1`.
      //
      // A SQL question has exactly ONE (Phase 16o), and it is sent rather
      // than left empty: the pane labels the language under the editor and
      // takes the editor's grammar from the same entry, so an empty list
      // would mean a query highlighted as plain text.
      languages: kind === "ANSWER" ? [] : kind === "SQL" ? [SQL_LANGUAGE_VIEW] : paperLanguageViews(acceptedFor(question.questionId)),
      // Named for what it is: the key the routes validate against, which
      // is the language this question OPENS in. Handing the client the
      // editor's highlighting mode under the name `language` is what
      // stopped every sitting saving, running and submitting (12r.2).
      // The language this question OPENS in: the first it accepts, which
      // is the paper's default unless the question narrows past it.
      languageKey:
        kind === "ANSWER"
          ? ANSWER_LANGUAGE_KEY
          : kind === "SQL"
            ? SQL_LANGUAGE_KEY
            : (acceptedFor(question.questionId)[0] ?? defaultLanguage),
      kind,
      // Phase 16g: from the FROZEN layout, like the kind beside it.
      ...(typeof question.editBudget === "number" ? { editBudget: question.editBudget } : {}),
    });
  }
  return { questions, mcqs, languages, missing };
});

/**
 * The paper's MCQs, each one's options re-ordered into the sequence this
 * candidate's layout recorded.
 *
 * An option order in the layout that no longer matches the stored options —
 * an author having edited the question after a sitting began, which the
 * draft rules are meant to prevent — drops that question rather than
 * showing a candidate a shuffle with a hole in it. It is reported through
 * `missing` for the same reason a missing coding question is.
 */
async function examMcqViews(layout: AttemptLayout): Promise<ExamMcqView[]> {
  const laid = layout.mcqs ?? [];
  if (laid.length === 0) return [];
  const rows = await db.assessmentMcq.findMany({
    where: { id: { in: laid.map((m) => m.mcqId) } },
    // No correctIndex. See ExamMcqView.
    select: { id: true, stem: true, options: true },
  });
  const byId = new Map(rows.map((row) => [row.id, row]));
  const views: ExamMcqView[] = [];
  for (const mcq of laid) {
    const row = byId.get(mcq.mcqId);
    if (!row) continue;
    const options = mcq.optionOrder.map((i) => row.options[i]);
    if (options.some((option) => option === undefined)) continue;
    views.push({
      mcqId: mcq.mcqId,
      position: mcq.sourcePosition,
      points: mcq.points,
      // The same sanitising pipeline the statements go through.
      stemHtml: renderMarkdown(row.stem),
      options: options as string[],
    });
  }
  return views;
}
