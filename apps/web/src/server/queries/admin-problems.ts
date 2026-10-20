import "server-only";
import type { Prisma, ProblemImportRowStatus, Role } from "@recx/db";
import { isVerdict, type Verdict } from "@recx/shared";
import {
  REVIEW_STAGES,
  reviewStageOf,
  versionContentIssues,
  type ContentIssue,
  type ReviewStage,
} from "@recx/shared/authoring";
import { loadVersionContentInput } from "@/lib/authoring/content-input";
import { getPublishReadiness, type PublishReadiness } from "@/lib/authoring/readiness";
import { IMPORT_STALE_AFTER_MS } from "@/lib/authoring/import/run";
import { isStaff } from "@/lib/auth/guards";
import { staffOnlyWhere } from "@/lib/auth/scope-where";
import { db } from "@/lib/db";
import { ForbiddenError, NotFoundError } from "@/lib/errors";
import { readBlobBytes } from "@/lib/testdata/blobs";
import { referenceRunnability } from "@/lib/judge/validation";
import { getTestDataStore } from "@/lib/testdata/store";

/**
 * Read side of /admin/problems. Staff only: every function starts with
 * assertStaffViewer(), on top of the page guards. These queries read hidden
 * tests, reference sources and checkers, so this module lives under the
 * sensitive path prefix (server/queries/admin-) and nothing student-facing
 * may import it.
 */

export interface StaffViewer {
  id: string;
  role: Role;
}

export function assertStaffViewer(viewer: StaffViewer): void {
  if (!isStaff(viewer.role)) throw new ForbiddenError();
}

const PAGE_SIZE = 50;

/** Names of staff actors (authors, editors, reviewers, uploaders); never a student. */
async function userNames(ids: ReadonlyArray<string | null | undefined>): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter((id): id is string => typeof id === "string"))];
  if (wanted.length === 0) return new Map();
  const users = await db.user.findMany({
    where: staffOnlyWhere({ id: { in: wanted } }),
    select: { id: true, firstName: true, lastName: true },
  });
  return new Map(users.map((u) => [u.id, `${u.firstName} ${u.lastName}`.trim()]));
}

// ── List and review queue ──────────────────────────────────────────────

export interface AdminProblemRow {
  id: string;
  slug: string;
  displayCode: string;
  title: string;
  difficulty: "EASY" | "MEDIUM" | "HARD";
  status: "DRAFT" | "IN_REVIEW" | "PUBLISHED" | "RETIRED";
  liveRevision: number | null;
  /** The open draft (unfrozen revision), if any, with its review stage. */
  open: { revision: number; stage: ReviewStage } | null;
  updatedAt: Date;
}

export interface AdminProblemList {
  rows: AdminProblemRow[];
  total: number;
  page: number;
  pageCount: number;
  /** Review-queue counts over every problem. */
  queue: { draft: number; inReview: number; approved: number; published: number; retired: number };
}

function stageWhere(stage: ReviewStage | null): Prisma.ProblemWhereInput {
  switch (stage) {
    case "DRAFT":
      return { versions: { some: { frozenAt: null, status: "DRAFT" } } };
    case "IN_REVIEW":
      return { versions: { some: { frozenAt: null, status: "IN_REVIEW", approvedAt: null } } };
    case "APPROVED":
      return { versions: { some: { frozenAt: null, status: "IN_REVIEW", approvedAt: { not: null } } } };
    case "PUBLISHED":
      return { status: "PUBLISHED" };
    case "RETIRED":
      return { status: "RETIRED" };
    default:
      return {};
  }
}

export function parseStage(value: unknown): ReviewStage | null {
  return typeof value === "string" && (REVIEW_STAGES as readonly string[]).includes(value) ? (value as ReviewStage) : null;
}

export async function listAdminProblems(
  viewer: StaffViewer,
  filters: { stage: ReviewStage | null; q: string; difficulty: "EASY" | "MEDIUM" | "HARD" | null; page: number },
): Promise<AdminProblemList> {
  assertStaffViewer(viewer);
  const q = filters.q.trim().slice(0, 100);
  const where: Prisma.ProblemWhereInput = {
    AND: [
      stageWhere(filters.stage),
      filters.difficulty ? { difficulty: filters.difficulty } : {},
      q
        ? {
            OR: [
              // Served by the pg_trgm GIN index on Problem.title.
              { title: { contains: q, mode: "insensitive" } },
              { slug: { startsWith: q.toLowerCase() } },
              { displayCode: { startsWith: q.toUpperCase() } },
            ],
          }
        : {},
    ],
  };
  const page = Math.max(1, Math.floor(filters.page) || 1);
  const [total, problems, draft, inReview, approved, published, retired] = await Promise.all([
    db.problem.count({ where }),
    db.problem.findMany({
      where,
      orderBy: [{ updatedAt: "desc" }, { displayCode: "asc" }],
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      select: {
        id: true,
        slug: true,
        displayCode: true,
        title: true,
        difficulty: true,
        status: true,
        liveVersionId: true,
        updatedAt: true,
        liveVersion: { select: { revision: true } },
        versions: {
          where: { frozenAt: null },
          orderBy: { revision: "desc" },
          take: 1,
          select: { id: true, revision: true, status: true, approvedAt: true, frozenAt: true },
        },
      },
    }),
    db.problem.count({ where: stageWhere("DRAFT") }),
    db.problem.count({ where: stageWhere("IN_REVIEW") }),
    db.problem.count({ where: stageWhere("APPROVED") }),
    db.problem.count({ where: stageWhere("PUBLISHED") }),
    db.problem.count({ where: stageWhere("RETIRED") }),
  ]);
  return {
    rows: problems.map((p) => {
      const open = p.versions[0] ?? null;
      return {
        id: p.id,
        slug: p.slug,
        displayCode: p.displayCode,
        title: p.title,
        difficulty: p.difficulty,
        status: p.status,
        liveRevision: p.liveVersion?.revision ?? null,
        open: open ? { revision: open.revision, stage: reviewStageOf(open, p) } : null,
        updatedAt: p.updatedAt,
      };
    }),
    total,
    page,
    pageCount: Math.max(1, Math.ceil(total / PAGE_SIZE)),
    queue: { draft, inReview, approved, published, retired },
  };
}

/** The next free REC-NNNN display code (a suggestion; the create action re-checks). */
export async function suggestDisplayCode(viewer: StaffViewer): Promise<string> {
  assertStaffViewer(viewer);
  const rows = await db.problem.findMany({
    where: { displayCode: { startsWith: "REC-" } },
    select: { displayCode: true },
  });
  let max = 0;
  for (const r of rows) {
    const m = /^REC-(\d{4})$/.exec(r.displayCode);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `REC-${String(Math.min(max + 1, 9999)).padStart(4, "0")}`;
}

// ── One problem ────────────────────────────────────────────────────────

export interface RevisionSummary {
  id: string;
  revision: number;
  stage: ReviewStage;
  createdAt: Date;
  publishedAt: Date | null;
  approvedAt: Date | null;
  approvedBy: string | null;
}

export interface AdminProblemDetail {
  problem: {
    id: string;
    slug: string;
    displayCode: string;
    title: string;
    status: "DRAFT" | "IN_REVIEW" | "PUBLISHED" | "RETIRED";
    version: number;
    liveVersionId: string | null;
    topics: string[];
  };
  revisions: RevisionSummary[];
  /** The revision shown: ?rev=N, else the open draft, else the live one. */
  selected: {
    id: string;
    revision: number;
    stage: ReviewStage;
    editable: boolean;
    /** The viewer created, last edited or submitted this revision (so may not approve it). */
    viewerIsAuthor: boolean;
    editSeq: number;
    judgeSeq: number;
    title: string;
    difficulty: "EASY" | "MEDIUM" | "HARD";
    statementMd: string;
    constraints: string[];
    origin: "FACULTY" | "SENIOR_STUDENT" | "AI_ASSISTED";
    ioMode: "STDIN" | "FUNCTION";
    functionSignatureJson: string;
    compareMode: "EXACT" | "TOKEN" | "FLOAT" | "CHECKER" | "INTERACTIVE";
    floatEpsilon: number | null;
    scoringMode: "ICPC" | "SUBTASK" | "PER_TEST";
    stopOnFirstFailure: boolean;
    timeLimitMs: number;
    memoryLimitKb: number;
    checkerSource: string | null;
    tests: { total: number; samples: number };
    references: { id: string; language: string; label: string | null; expectedVerdict: Verdict; source: string; measuredMs: number | null }[];
    starters: { language: string; code: string }[];
    hints: string[];
    editorialMd: string | null;
    contentIssues: ContentIssue[];
    people: { createdBy: string | null; lastEditedBy: string | null; submittedBy: string | null; approvedBy: string | null };
    submittedForReviewAt: Date | null;
    reviews: { action: string; actor: string | null; comment: string | null; attestedOriginal: boolean; createdAt: Date }[];
  } | null;
  openDraft: { id: string; revision: number } | null;
}

function stringConstraints(value: Prisma.JsonValue): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

export async function getAdminProblem(viewer: StaffViewer, problemId: string, rev: number | null): Promise<AdminProblemDetail | null> {
  assertStaffViewer(viewer);
  const problem = await db.problem.findUnique({
    where: { id: problemId },
    select: {
      id: true,
      slug: true,
      displayCode: true,
      title: true,
      status: true,
      version: true,
      liveVersionId: true,
      tags: { select: { topic: true } },
      versions: {
        orderBy: { revision: "desc" },
        select: { id: true, revision: true, status: true, approvedAt: true, approvedById: true, frozenAt: true, createdAt: true, publishedAt: true },
      },
    },
  });
  if (!problem) return null;
  const openDraft = problem.versions.find((v) => v.frozenAt === null) ?? null;
  const target =
    (rev !== null ? problem.versions.find((v) => v.revision === rev) : undefined) ??
    (rev === null ? (openDraft ?? problem.versions.find((v) => v.id === problem.liveVersionId) ?? problem.versions[0]) : undefined) ??
    null;

  const names = await userNames(problem.versions.map((v) => v.approvedById));
  const revisions: RevisionSummary[] = problem.versions.map((v) => ({
    id: v.id,
    revision: v.revision,
    stage: reviewStageOf(v, problem),
    createdAt: v.createdAt,
    publishedAt: v.publishedAt,
    approvedAt: v.approvedAt,
    approvedBy: v.approvedById ? (names.get(v.approvedById) ?? "unknown") : v.approvedAt ? "operator (CLI)" : null,
  }));

  let selected: AdminProblemDetail["selected"] = null;
  if (target) {
    const v = await db.problemVersion.findUniqueOrThrow({
      where: { id: target.id },
      select: {
        id: true,
        revision: true,
        status: true,
        approvedAt: true,
        approvedById: true,
        frozenAt: true,
        editSeq: true,
        judgeSeq: true,
        title: true,
        difficulty: true,
        statementMd: true,
        constraints: true,
        origin: true,
        ioMode: true,
        functionSignature: true,
        compareMode: true,
        floatEpsilon: true,
        scoringMode: true,
        stopOnFirstFailure: true,
        timeLimitMs: true,
        memoryLimitKb: true,
        checkerSha256: true,
        createdById: true,
        lastEditedById: true,
        submittedById: true,
        submittedForReviewAt: true,
        referenceSolutions: {
          orderBy: { createdAt: "asc" },
          select: { id: true, language: true, label: true, expectedVerdict: true, source: true, measuredMs: true },
        },
        starterCodes: { orderBy: { language: "asc" }, select: { language: true, code: true } },
        hints: { orderBy: { tier: "asc" }, select: { contentMd: true } },
        editorial: { select: { contentMd: true } },
        reviews: { orderBy: { createdAt: "asc" }, select: { action: true, actorId: true, comment: true, attestedOriginal: true, createdAt: true } },
        _count: { select: { testCases: true } },
      },
    });
    const samples = await db.testCase.count({ where: { problemVersionId: v.id, isSample: true } });
    let checkerSource: string | null = null;
    if (v.checkerSha256) {
      const blob = await db.testBlob.findUnique({ where: { sha256: v.checkerSha256 } });
      if (blob) checkerSource = (await readBlobBytes(getTestDataStore(), blob)).toString("utf8");
    }
    const people = await userNames([v.createdById, v.lastEditedById, v.submittedById, v.approvedById, ...v.reviews.map((r) => r.actorId)]);
    const name = (id: string | null) => (id ? (people.get(id) ?? "unknown") : null);
    const content = await loadVersionContentInput(db, v.id);
    const stage = reviewStageOf(v, problem);
    selected = {
      id: v.id,
      revision: v.revision,
      stage,
      editable: stage === "DRAFT",
      viewerIsAuthor: [v.createdById, v.lastEditedById, v.submittedById].includes(viewer.id),
      editSeq: v.editSeq,
      judgeSeq: v.judgeSeq,
      title: v.title,
      difficulty: v.difficulty,
      statementMd: v.statementMd,
      constraints: stringConstraints(v.constraints),
      origin: v.origin,
      ioMode: v.ioMode,
      functionSignatureJson: v.functionSignature === null ? "" : JSON.stringify(v.functionSignature, null, 2),
      compareMode: v.compareMode,
      floatEpsilon: v.floatEpsilon,
      scoringMode: v.scoringMode,
      stopOnFirstFailure: v.stopOnFirstFailure,
      timeLimitMs: v.timeLimitMs,
      memoryLimitKb: v.memoryLimitKb,
      checkerSource,
      tests: { total: v._count.testCases, samples },
      references: v.referenceSolutions,
      starters: v.starterCodes,
      hints: v.hints.map((h) => h.contentMd),
      editorialMd: v.editorial?.contentMd ?? null,
      contentIssues: content ? versionContentIssues(content) : [],
      people: {
        createdBy: name(v.createdById),
        lastEditedBy: name(v.lastEditedById),
        submittedBy: name(v.submittedById),
        approvedBy: v.approvedById ? name(v.approvedById) : v.approvedAt ? "operator (CLI)" : null,
      },
      submittedForReviewAt: v.submittedForReviewAt,
      reviews: v.reviews.map((r) => ({
        action: r.action,
        actor: name(r.actorId) ?? (r.actorId === null ? "operator (CLI)" : null),
        comment: r.comment,
        attestedOriginal: r.attestedOriginal,
        createdAt: r.createdAt,
      })),
    };
  }
  return {
    problem: {
      id: problem.id,
      slug: problem.slug,
      displayCode: problem.displayCode,
      title: problem.title,
      status: problem.status,
      version: problem.version,
      liveVersionId: problem.liveVersionId,
      topics: problem.tags.map((t) => t.topic),
    },
    revisions,
    selected,
    openDraft: openDraft ? { id: openDraft.id, revision: openDraft.revision } : null,
  };
}

// ── Tests of a revision ────────────────────────────────────────────────

const PREVIEW_BYTES = 1024;

async function preview(blob: { inline: string | null; storageKey: string | null; sizeBytes: number }): Promise<string> {
  if (blob.inline !== null) return blob.inline.slice(0, PREVIEW_BYTES);
  if (!blob.storageKey) return "";
  try {
    const stream = await getTestDataStore().stream(blob.storageKey);
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (size < PREVIEW_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.byteLength;
    }
    await reader.cancel().catch(() => undefined);
    return Buffer.concat(chunks).subarray(0, PREVIEW_BYTES).toString("utf8");
  } catch {
    return "(preview unavailable)";
  }
}

export interface DraftTestRow {
  index: number;
  isSample: boolean;
  subtaskIndex: number | null;
  points: number | null;
  inputBytes: number;
  outputBytes: number;
  inputSha: string;
  outputSha: string;
  inputPreview: string;
  outputPreview: string;
}

export interface DraftTests {
  problem: { id: string; slug: string; displayCode: string; title: string };
  version: { id: string; revision: number; stage: ReviewStage; editable: boolean; editSeq: number; scoringMode: string };
  tests: DraftTestRow[];
  subtasks: { index: number; points: number; aggregation: "MIN" | "SUM_FRACTION"; dependsOn: number[] }[];
}

export async function getDraftTests(viewer: StaffViewer, problemId: string, rev: number | null): Promise<DraftTests | null> {
  assertStaffViewer(viewer);
  const problem = await db.problem.findUnique({
    where: { id: problemId },
    select: {
      id: true,
      slug: true,
      displayCode: true,
      title: true,
      status: true,
      liveVersionId: true,
      versions: { orderBy: { revision: "desc" }, select: { id: true, revision: true, frozenAt: true } },
    },
  });
  if (!problem) return null;
  const target =
    (rev !== null
      ? problem.versions.find((v) => v.revision === rev)
      : (problem.versions.find((v) => v.frozenAt === null) ?? problem.versions.find((v) => v.id === problem.liveVersionId))) ?? null;
  if (!target) return null;
  const v = await db.problemVersion.findUniqueOrThrow({
    where: { id: target.id },
    select: {
      id: true,
      revision: true,
      status: true,
      approvedAt: true,
      frozenAt: true,
      editSeq: true,
      scoringMode: true,
      subtasks: { orderBy: { index: "asc" }, select: { index: true, points: true, aggregation: true, dependsOn: true } },
      testCases: {
        orderBy: { index: "asc" },
        select: {
          index: true,
          isSample: true,
          subtaskIndex: true,
          points: true,
          input: { select: { sha256: true, sizeBytes: true, inline: true, storageKey: true } },
          output: { select: { sha256: true, sizeBytes: true, inline: true, storageKey: true } },
        },
      },
    },
  });
  const stage = reviewStageOf(v, problem);
  const tests: DraftTestRow[] = [];
  for (const t of v.testCases) {
    tests.push({
      index: t.index,
      isSample: t.isSample,
      subtaskIndex: t.subtaskIndex,
      points: t.points,
      inputBytes: t.input.sizeBytes,
      outputBytes: t.output.sizeBytes,
      inputSha: t.input.sha256.slice(0, 12),
      outputSha: t.output.sha256.slice(0, 12),
      inputPreview: await preview(t.input),
      outputPreview: await preview(t.output),
    });
  }
  return {
    problem: { id: problem.id, slug: problem.slug, displayCode: problem.displayCode, title: problem.title },
    version: { id: v.id, revision: v.revision, stage, editable: stage === "DRAFT", editSeq: v.editSeq, scoringMode: v.scoringMode },
    tests,
    subtasks: v.subtasks,
  };
}

// ── Validation report ──────────────────────────────────────────────────

export interface ReferenceRunRow {
  referenceId: string;
  label: string | null;
  language: string;
  expected: Verdict;
  runnable: boolean;
  /** Why it cannot run: its language is disabled, or (FUNCTION) has no harness. */
  unrunnable: "disabled" | "no-harness" | null;
  run: {
    status: string;
    verdict: Verdict | null;
    outcome: string;
    measuredMs: number | null;
    firstFailingIndex: number | null;
    strip: { i: number; v: Verdict }[];
    compileOutput: string | null;
    judgedAt: Date | null;
  } | null;
}

export interface ValidationReport {
  problem: { id: string; slug: string; displayCode: string; title: string };
  readiness: PublishReadiness;
  references: ReferenceRunRow[];
  limits: { language: string; timeLimitMs: number; memoryLimitKb: number; measuredModelMs: number | null; measuredOnGeneration: string | null }[];
}

function verdictStrip(value: Prisma.JsonValue | null): { i: number; v: Verdict }[] {
  if (!Array.isArray(value)) return [];
  const out: { i: number; v: Verdict }[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const i = (item as Record<string, unknown>).i;
    const v = (item as Record<string, unknown>).v;
    if (typeof i === "number" && isVerdict(v)) out.push({ i, v });
  }
  return out.sort((a, b) => a.i - b.i);
}

export async function getValidationReport(viewer: StaffViewer, problemId: string, rev: number | null): Promise<ValidationReport | null> {
  assertStaffViewer(viewer);
  const problem = await db.problem.findUnique({
    where: { id: problemId },
    select: {
      id: true,
      slug: true,
      displayCode: true,
      title: true,
      liveVersionId: true,
      versions: { orderBy: { revision: "desc" }, select: { id: true, revision: true, frozenAt: true } },
    },
  });
  if (!problem) return null;
  const target =
    (rev !== null
      ? problem.versions.find((v) => v.revision === rev)
      : (problem.versions.find((v) => v.frozenAt === null) ?? problem.versions.find((v) => v.id === problem.liveVersionId))) ?? null;
  if (!target) return null;
  const readiness = await getPublishReadiness(target.id);
  const refs = await db.referenceSolution.findMany({
    where: { problemVersionId: target.id },
    orderBy: { createdAt: "asc" },
    select: { id: true, label: true, language: true, expectedVerdict: true },
  });
  const runs = await db.validationRun.findMany({
    where: { problemVersionId: target.id, judgeSeq: readiness.validation.judgeSeq },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: {
      referenceSolutionId: true,
      status: true,
      verdict: true,
      outcome: true,
      measuredMs: true,
      testResults: true,
      compileOutput: true,
      judgedAt: true,
    },
  });
  const latest = new Map<string, (typeof runs)[number]>();
  for (const r of runs) if (!latest.has(r.referenceSolutionId)) latest.set(r.referenceSolutionId, r);
  const [version, configs] = await Promise.all([
    db.problemVersion.findUniqueOrThrow({ where: { id: target.id }, select: { ioMode: true } }),
    db.languageConfig.findMany({ where: { enabled: true, isCurrent: true }, select: { key: true } }),
  ]);
  const enabled = new Set(configs.map((c) => c.key));
  const limits = await db.problemLanguageLimit.findMany({
    where: { problemVersionId: target.id },
    orderBy: { language: "asc" },
    select: { language: true, timeLimitMs: true, memoryLimitKb: true, measuredModelMs: true, measuredOnGeneration: true },
  });
  return {
    problem: { id: problem.id, slug: problem.slug, displayCode: problem.displayCode, title: problem.title },
    readiness,
    references: refs.map((ref) => {
      const run = latest.get(ref.id) ?? null;
      const strip = run ? verdictStrip(run.testResults) : [];
      const can = referenceRunnability(ref.language, version.ioMode, enabled);
      return {
        referenceId: ref.id,
        label: ref.label,
        language: ref.language,
        expected: ref.expectedVerdict,
        runnable: can.runnable,
        unrunnable: can.unrunnable ?? null,
        run: run
          ? {
              status: run.status,
              verdict: run.verdict,
              outcome: run.outcome,
              measuredMs: run.measuredMs,
              firstFailingIndex: strip.find((t) => t.v !== "AC" && t.v !== "SKIPPED")?.i ?? null,
              strip,
              compileOutput: run.compileOutput ? run.compileOutput.slice(0, 8 * 1024) : null,
              judgedAt: run.judgedAt,
            }
          : null,
      };
    }),
    limits,
  };
}

// ── Imports ────────────────────────────────────────────────────────────

export interface ImportSummary {
  id: string;
  fileName: string;
  sizeBytes: number;
  status: "PROCESSING" | "DONE" | "FAILED";
  total: number;
  created: number;
  revised: number;
  unchanged: number;
  failed: number;
  error: string | null;
  startedAt: Date;
  finishedAt: Date | null;
  uploadedBy: string | null;
}

export interface ImportRowView {
  entry: string;
  slug: string | null;
  status: ProblemImportRowStatus;
  problemId: string | null;
  revision: number | null;
  errors: { path: string; message: string }[];
  warnings: { path: string; message: string }[];
}

function issues(value: Prisma.JsonValue): { path: string; message: string }[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const { path, message } = item as Record<string, unknown>;
    return typeof message === "string" ? [{ path: typeof path === "string" ? path : "", message }] : [];
  });
}

function summary(row: {
  id: string;
  fileName: string;
  sizeBytes: bigint;
  status: "PROCESSING" | "DONE" | "FAILED";
  total: number;
  created: number;
  revised: number;
  unchanged: number;
  failed: number;
  error: string | null;
  startedAt: Date;
  finishedAt: Date | null;
}, uploadedBy: string | null): ImportSummary {
  // Read-only view of an import the process lost (a restart): shown as
  // interrupted here; the next upload marks it FAILED for good (sweepStaleImports).
  const stale = row.status === "PROCESSING" && Date.now() - row.startedAt.getTime() > IMPORT_STALE_AFTER_MS;
  return {
    ...row,
    ...(stale ? { status: "FAILED" as const, error: "Interrupted before it finished. Upload the archive again: entries already imported come back UNCHANGED." } : {}),
    sizeBytes: Number(row.sizeBytes),
    uploadedBy,
  };
}

const importSelect = {
  id: true,
  fileName: true,
  sizeBytes: true,
  status: true,
  total: true,
  created: true,
  revised: true,
  unchanged: true,
  failed: true,
  error: true,
  startedAt: true,
  finishedAt: true,
  uploadedById: true,
} as const satisfies Prisma.ProblemImportSelect;

export async function getImport(viewer: StaffViewer, importId: string): Promise<{ summary: ImportSummary; rows: ImportRowView[] } | null> {
  assertStaffViewer(viewer);
  const row = await db.problemImport.findUnique({ where: { id: importId }, select: importSelect });
  if (!row) return null;
  const rows = await db.problemImportRow.findMany({
    where: { importId },
    orderBy: { entry: "asc" },
    select: { entry: true, slug: true, status: true, problemId: true, revision: true, errors: true, warnings: true },
  });
  const names = await userNames([row.uploadedById]);
  const { uploadedById, ...rest } = row;
  const views = rows.map((r) => ({ ...r, errors: issues(r.errors), warnings: issues(r.warnings) }));
  // Failed rows first, then the rest in entry order.
  views.sort((a, b) => Number(b.status === "FAILED") - Number(a.status === "FAILED") || a.entry.localeCompare(b.entry));
  return { summary: summary(rest, names.get(uploadedById) ?? null), rows: views };
}

export async function listMyImports(viewer: StaffViewer, take = 20): Promise<ImportSummary[]> {
  assertStaffViewer(viewer);
  const rows = await db.problemImport.findMany({
    where: { uploadedById: viewer.id },
    orderBy: { startedAt: "desc" },
    take,
    select: importSelect,
  });
  return rows.map(({ uploadedById: _u, ...rest }) => summary(rest, null));
}

/** Throws NotFoundError when the problem does not exist (for actions that need the row). */
export async function requireProblem(viewer: StaffViewer, problemId: string): Promise<{ id: string; slug: string }> {
  assertStaffViewer(viewer);
  const p = await db.problem.findUnique({ where: { id: problemId }, select: { id: true, slug: true } });
  if (!p) throw new NotFoundError("That problem was not found.");
  return p;
}
