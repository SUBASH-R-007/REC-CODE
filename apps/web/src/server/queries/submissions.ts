import "server-only";
import type { Prisma, Role } from "@recx/db";
import { LANGUAGE_CATALOG, isLanguageKey, type JobKind, type VerdictDisplay } from "@recx/shared";
import { isStaff } from "@/lib/auth/guards";
import { db } from "@/lib/db";
import { renderMarkdown } from "@/lib/markdown";
import {
  displayFor,
  toStudentView,
  type RunStudentView,
  type SampleCase,
  type StudentView,
  type SubmissionStudentView,
} from "@/lib/judge/view";

/** Who is asking. Owners see their own rows; ADMIN / SUPER_ADMIN see any. */
export interface Viewer {
  id: string;
  role: Role;
}

function canView(viewer: Viewer, ownerId: string): boolean {
  return viewer.id === ownerId || isStaff(viewer.role);
}

/** Sample cases of a pinned version. Never hidden ones: `isSample: true` only. */
async function sampleCases(problemVersionId: string): Promise<SampleCase[]> {
  const rows = await db.testCase.findMany({
    where: { problemVersionId, isSample: true },
    orderBy: { index: "asc" },
    select: { index: true, input: { select: { inline: true } }, output: { select: { inline: true } } },
  });
  return rows.map((r) => ({ index: r.index, input: r.input.inline, expected: r.output.inline }));
}

const SUBMISSION_SELECT = {
  id: true,
  userId: true,
  problemVersionId: true,
  status: true,
  verdict: true,
  language: true,
  passedCases: true,
  totalCases: true,
  maxTimeMs: true,
  maxMemoryKb: true,
  compileOutput: true,
  testResults: true,
  score: true,
  maxScore: true,
  subtaskResults: true,
  createdAt: true,
  judgedAt: true,
  languageConfig: { select: { label: true } },
  problemVersion: {
    select: {
      scoringMode: true,
      compareMode: true,
      functionSignature: true,
      // Index, points and subtask only — never test content.
      testCases: { select: { index: true, points: true, subtaskIndex: true, isSample: true }, orderBy: { index: "asc" } },
    },
  },
  details: {
    select: { testIndex: true, input: true, expected: true, stdout: true, stderr: true },
  },
} as const satisfies Prisma.SubmissionSelect;

type SubmissionRow = Prisma.SubmissionGetPayload<{ select: typeof SUBMISSION_SELECT }>;

async function submissionViewOf(row: SubmissionRow): Promise<SubmissionStudentView> {
  return toStudentView({
    kind: "submission",
    id: row.id,
    status: row.status,
    verdict: row.verdict,
    language: row.language,
    languageLabel: row.languageConfig.label,
    compileOutput: row.compileOutput,
    createdAt: row.createdAt,
    judgedAt: row.judgedAt,
    samples: await sampleCases(row.problemVersionId),
    passedCases: row.passedCases,
    totalCases: row.totalCases,
    maxTimeMs: row.maxTimeMs,
    maxMemoryKb: row.maxMemoryKb,
    testResults: row.testResults,
    details: row.details,
    compareMode: row.problemVersion.compareMode,
    functionSignature: row.problemVersion.functionSignature,
    scoringMode: row.problemVersion.scoringMode,
    score: row.score,
    maxScore: row.maxScore,
    subtaskResults: row.subtaskResults,
    testMeta: row.problemVersion.testCases.map((t) => ({ index: t.index, points: t.points, subtask: t.subtaskIndex })),
  });
}

export async function getSubmissionView(id: string, viewer: Viewer): Promise<SubmissionStudentView | null> {
  const row = await db.submission.findUnique({ where: { id }, select: SUBMISSION_SELECT });
  if (!row || !canView(viewer, row.userId)) return null;
  return submissionViewOf(row);
}

/** Everything the full submission page shows: the student view plus the submitted source. */
export interface SubmissionDetail {
  view: SubmissionStudentView;
  /** Null once the source has been archived out of the database. */
  source: string | null;
  /** Catalog language id for the cheap highlighter ("cpp", "python", …). */
  editorLanguage: string;
  /** Indexes of the pinned version's sample tests (labels while judging). */
  sampleIndexes: number[];
  problem: { slug: string; title: string; displayCode: string };
  /** Shown to staff viewing someone else's submission; never to students. */
  owner: { firstName: string; lastName: string } | null;
  /**
   * The revision the submission was judged against (its pinned, frozen
   * version) and that revision's statement, rendered — an older submission
   * keeps showing the problem as judged after a later revision changes it.
   */
  pinned: { revision: number; statementHtml: string };
  /** The problem's live revision now (null when it has none). */
  liveRevision: number | null;
}

/**
 * The full submission page (/problems/[slug]/submissions/[id]). Owner or
 * ADMIN / SUPER_ADMIN only — anyone else gets null (a 404, so ids cannot be
 * probed). Students see only their own PRACTICE submissions here; contest
 * and assessment submissions have their own surfaces and rules. The slug
 * must match the submission's problem. Node and calibration details are
 * never part of this (students never see them).
 */
export async function getSubmissionDetail(id: string, slug: string, viewer: Viewer): Promise<SubmissionDetail | null> {
  const row = await db.submission.findUnique({
    where: { id },
    select: {
      ...SUBMISSION_SELECT,
      origin: true,
      problem: { select: { slug: true, displayCode: true, liveVersion: { select: { revision: true } } } },
      problemVersion: { select: { ...SUBMISSION_SELECT.problemVersion.select, title: true, revision: true, statementMd: true } },
      source: { select: { source: true, archivedAt: true } },
      user: { select: { firstName: true, lastName: true } },
    },
  });
  if (!row || !canView(viewer, row.userId) || row.problem.slug !== slug) return null;
  const own = row.userId === viewer.id;
  if (!isStaff(viewer.role) && row.origin !== "PRACTICE") return null;
  const view = await submissionViewOf(row);
  const source = row.source && !row.source.archivedAt ? row.source.source : null;
  return {
    view,
    source,
    editorLanguage: isLanguageKey(row.language) ? LANGUAGE_CATALOG[row.language].editorLanguage : "plaintext",
    sampleIndexes: row.problemVersion.testCases.filter((t) => t.isSample).map((t) => t.index),
    problem: { slug: row.problem.slug, title: row.problemVersion.title, displayCode: row.problem.displayCode },
    owner: own ? null : { firstName: row.user.firstName, lastName: row.user.lastName },
    pinned: { revision: row.problemVersion.revision, statementHtml: renderMarkdown(row.problemVersion.statementMd) },
    liveRevision: row.problem.liveVersion?.revision ?? null,
  };
}

export async function getRunView(id: string, viewer: Viewer): Promise<RunStudentView | null> {
  const row = await db.runRequest.findUnique({
    where: { id },
    select: {
      id: true,
      userId: true,
      problemVersionId: true,
      status: true,
      verdict: true,
      language: true,
      customInput: true,
      result: true,
      compileOutput: true,
      createdAt: true,
      judgedAt: true,
      expiresAt: true,
      languageConfig: { select: { label: true } },
      problemVersion: { select: { compareMode: true, functionSignature: true } },
    },
  });
  // Runs live for 24 hours; after that they are gone even before the purge.
  if (!row || !canView(viewer, row.userId) || row.expiresAt.getTime() < Date.now()) return null;
  return toStudentView({
    kind: "run",
    id: row.id,
    status: row.status,
    verdict: row.verdict,
    language: row.language,
    languageLabel: row.languageConfig.label,
    compileOutput: row.compileOutput,
    createdAt: row.createdAt,
    judgedAt: row.judgedAt,
    // A custom run has no sample tests to annotate.
    samples: row.customInput === null ? await sampleCases(row.problemVersionId) : [],
    customInput: row.customInput,
    result: row.result,
    compareMode: row.problemVersion.compareMode,
    functionSignature: row.problemVersion.functionSignature,
  });
}

export function getStudentView(kind: Exclude<JobKind, "validation">, id: string, viewer: Viewer): Promise<StudentView | null> {
  return kind === "submission" ? getSubmissionView(id, viewer) : getRunView(id, viewer);
}

export interface HistoryRow {
  id: string;
  display: VerdictDisplay;
  passed: number;
  total: number;
  languageLabel: string;
  maxTimeMs: number | null;
  maxMemoryKb: number | null;
  createdAt: Date;
  /** PER_TEST / SUBTASK points, when scored. */
  score: number | null;
  maxScore: number | null;
}

/** How many of the viewer's submissions the workspace's Submissions tab lists. */
export const HISTORY_LIMIT = 20;

/** The viewer's most recent PRACTICE submissions to one problem (newest first). */
export async function recentSubmissions(userId: string, problemId: string, take = HISTORY_LIMIT): Promise<HistoryRow[]> {
  const rows = await db.submission.findMany({
    where: { userId, problemId, origin: "PRACTICE" },
    orderBy: { createdAt: "desc" },
    take,
    select: {
      id: true,
      status: true,
      verdict: true,
      passedCases: true,
      totalCases: true,
      maxTimeMs: true,
      maxMemoryKb: true,
      score: true,
      maxScore: true,
      createdAt: true,
      languageConfig: { select: { label: true } },
    },
  });
  return rows.map((r) => ({
    id: r.id,
    display: displayFor(r.status, r.verdict),
    passed: r.passedCases,
    total: r.totalCases,
    languageLabel: r.languageConfig.label,
    maxTimeMs: r.maxTimeMs,
    maxMemoryKb: r.maxMemoryKb,
    createdAt: r.createdAt,
    score: r.score,
    maxScore: r.maxScore,
  }));
}
