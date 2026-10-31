import "server-only";
import { cache } from "react";
import { LANGUAGE_CATALOG, type AttemptLayout } from "@recx/shared";
import { db } from "@/lib/db";
import { examPaperLanguage } from "@/lib/exam/language";
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
  const versionIds = layout.questions.map((question) => question.problemVersionId);
  if (versionIds.length === 0) return { questions: [], mcqs, missing: [] };

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

  // One language for the whole exam surface in 6c: the candidate's editor
  // language per question arrives with the submit path, and the starter code
  // is keyed by language, so the first enabled language is the default.
  // Derived in lib/exam/language.ts, because the Run route has to agree.
  const defaultLanguage = await examPaperLanguage();

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
      starter: starters.get(defaultLanguage) ?? "",
      // Both, and named for what they are: the key the routes validate
      // against, and the editor's highlighting mode. Handing the client only
      // the second one under the name `language` is what stopped every
      // sitting saving, running and submitting (Phase 12r.2).
      languageKey: defaultLanguage,
      editorLanguage: LANGUAGE_CATALOG[defaultLanguage].editorLanguage,
    });
  }
  return { questions, mcqs, missing };
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
