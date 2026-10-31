import "server-only";
import { cache } from "react";
import { LANGUAGE_CATALOG, isLanguageKey, type AttemptLayout } from "@recx/shared";
import { db } from "@/lib/db";
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
  /** Questions in the layout whose version could not be read. */
  readonly missing: string[];
}

export const getExamPaper = cache(async (layout: AttemptLayout): Promise<ExamPaper> => {
  const versionIds = layout.questions.map((question) => question.problemVersionId);
  if (versionIds.length === 0) return { questions: [], missing: [] };

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
  const configs = await db.languageConfig.findMany({
    where: { enabled: true, isCurrent: true },
    select: { key: true },
    orderBy: { key: "asc" },
  });
  const defaultLanguage = configs.map((c) => c.key).find(isLanguageKey) ?? "cpp20";

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
      language: LANGUAGE_CATALOG[defaultLanguage].editorLanguage,
    });
  }
  return { questions, missing };
});
