import "server-only";
import { z } from "zod";
import {
  PROBLEM_REPORT_DUPLICATE,
  PROBLEM_REPORT_LIMITS,
  PROBLEM_REPORT_REASONS,
  problemReportDecisionProblem,
  PROBLEM_REPORT_DECISION_MESSAGE,
  type ProblemReportReason,
} from "@recx/shared";
import { db } from "@/lib/db";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";

/**
 * Defect reports on a published revision (Phase 16a).
 *
 * The reasoning for the shape is in `packages/shared/src/problem-report.ts`.
 * This module is the three database operations it implies, and the one
 * decision that only makes sense next to a database:
 *
 * **A report is about a revision a student could actually have read.** Not
 * any revision: the LIVE one of a PUBLISHED problem. A draft is nobody's to
 * complain about, and an old revision is answered by the one that replaced
 * it — a student looking at a stale page who reports the revision they were
 * served would otherwise open a queue item about bytes that are no longer
 * served to anybody.
 */

const id = z.string().min(1).max(64);

export const reportProblemSchema = z
  .object({
    problemId: id,
    reason: z.enum(PROBLEM_REPORT_REASONS as unknown as [ProblemReportReason, ...ProblemReportReason[]]),
    detail: z
      .string()
      .trim()
      .min(1, "Say what looks wrong — one sentence is enough.")
      .max(PROBLEM_REPORT_LIMITS.detail, `Keep it under ${PROBLEM_REPORT_LIMITS.detail} characters.`),
  })
  .strict();
export type ReportProblemInput = z.input<typeof reportProblemSchema>;

export const decideProblemReportSchema = z
  .object({
    reportId: id,
    status: z.enum(["UPHELD", "DISMISSED"]),
    resolution: z.string().trim().max(PROBLEM_REPORT_LIMITS.resolution),
    hold: z.boolean().default(false),
    holdReason: z.string().trim().max(PROBLEM_REPORT_LIMITS.holdReason).nullable().default(null),
  })
  .strict();
export type DecideProblemReportInput = z.input<typeof decideProblemReportSchema>;

export const clearQualityHoldSchema = z.object({ problemId: id, reason: z.string().trim().max(300) }).strict();
export type ClearQualityHoldInput = z.input<typeof clearQualityHoldSchema>;

export interface ReportedProblem {
  reportId: string;
  problemId: string;
  problemVersionId: string;
  reason: ProblemReportReason;
}

/** Postgres raises 23505 on the partial unique index; that is the duplicate, not a bug. */
function isUniqueViolation(error: unknown): boolean {
  const code = (error as { code?: unknown })?.code;
  return code === "P2002" || code === "23505";
}

export async function reportProblemFor(userId: string, input: unknown): Promise<ReportedProblem> {
  const { problemId, reason, detail } = reportProblemSchema.parse(input);

  const problem = await db.problem.findUnique({
    where: { id: problemId },
    select: { id: true, status: true, liveVersionId: true },
  });
  if (!problem || problem.status !== "PUBLISHED" || !problem.liveVersionId) {
    // Same sentence for "no such problem" and "not published": a student
    // who can see neither should learn nothing from the difference.
    throw new NotFoundError("That problem was not found.");
  }

  try {
    const row = await db.problemReport.create({
      data: { problemVersionId: problem.liveVersionId, reporterId: userId, reason, detail },
      select: { id: true },
    });
    return { reportId: row.id, problemId: problem.id, problemVersionId: problem.liveVersionId, reason };
  } catch (error) {
    if (isUniqueViolation(error)) throw new ConflictError(PROBLEM_REPORT_DUPLICATE);
    throw error;
  }
}

export interface DecidedReport {
  reportId: string;
  problemId: string;
  reporterId: string;
  status: "UPHELD" | "DISMISSED";
  /** Whether this decision left the problem withheld from new papers. */
  held: boolean;
}

export async function decideProblemReportAs(actorId: string, input: unknown): Promise<DecidedReport> {
  const parsed = decideProblemReportSchema.parse(input);
  const problem = problemReportDecisionProblem({
    status: parsed.status,
    resolution: parsed.resolution,
    hold: parsed.hold,
    holdReason: parsed.holdReason,
  });
  if (problem) throw new ValidationError(PROBLEM_REPORT_DECISION_MESSAGE[problem]);

  const report = await db.problemReport.findUnique({
    where: { id: parsed.reportId },
    select: {
      id: true,
      status: true,
      reporterId: true,
      problemVersion: { select: { problemId: true } },
    },
  });
  if (!report) throw new NotFoundError("That report was not found.");
  if (report.status !== "OPEN") throw new ValidationError("That report has already been decided.");

  const now = new Date();
  const problemId = report.problemVersion.problemId;

  await db.$transaction(async (tx) => {
    await tx.problemReport.update({
      where: { id: report.id },
      data: {
        status: parsed.status,
        resolution: parsed.resolution,
        resolvedById: actorId,
        resolvedAt: now,
      },
    });
    if (parsed.hold) {
      await tx.problem.update({
        where: { id: problemId },
        data: {
          qualityHold: true,
          qualityHoldReason: parsed.holdReason,
          qualityHeldById: actorId,
          qualityHeldAt: now,
        },
      });
    }
  });

  return { reportId: report.id, problemId, reporterId: report.reporterId, status: parsed.status, held: parsed.hold };
}

/**
 * Clear a hold. Deliberately NOT part of deciding a report: the fix lands in
 * a new revision, which is a different day's work by possibly a different
 * person, and a hold that lifted itself when the report was closed would be
 * a hold that never held anything.
 */
export async function clearQualityHoldAs(
  actorId: string,
  input: unknown,
): Promise<{ problemId: string; previousReason: string }> {
  const { problemId } = clearQualityHoldSchema.parse(input);
  const problem = await db.problem.findUnique({
    where: { id: problemId },
    select: { id: true, qualityHold: true, qualityHoldReason: true },
  });
  if (!problem) throw new NotFoundError("That problem was not found.");
  if (!problem.qualityHold) throw new ValidationError("That problem is not withheld.");

  await db.problem.update({
    where: { id: problem.id },
    data: { qualityHold: false, qualityHoldReason: null, qualityHeldById: null, qualityHeldAt: null },
  });
  void actorId;
  return { problemId: problem.id, previousReason: problem.qualityHoldReason ?? "" };
}

export interface StaffReportRow {
  id: string;
  reason: ProblemReportReason;
  detail: string;
  status: "OPEN" | "UPHELD" | "DISMISSED";
  createdAt: Date;
  revision: number;
  resolution: string | null;
  resolvedAt: Date | null;
}

/** Every report on any revision of one problem, newest first. Staff only. */
export async function reportsForProblem(problemId: string, take = 50): Promise<StaffReportRow[]> {
  const rows = await db.problemReport.findMany({
    where: { problemVersion: { problemId } },
    orderBy: [{ status: "asc" }, { createdAt: "desc" }],
    take,
    select: {
      id: true,
      reason: true,
      detail: true,
      status: true,
      createdAt: true,
      resolution: true,
      resolvedAt: true,
      problemVersion: { select: { revision: true } },
    },
  });
  return rows.map((row) => ({
    id: row.id,
    reason: row.reason,
    detail: row.detail,
    status: row.status,
    createdAt: row.createdAt,
    revision: row.problemVersion.revision,
    resolution: row.resolution,
    resolvedAt: row.resolvedAt,
  }));
}

export interface MyReport {
  id: string;
  reason: ProblemReportReason;
  status: "OPEN" | "UPHELD" | "DISMISSED";
  resolution: string | null;
}

/**
 * What the student who reported sees on the problem page: their own rows on
 * the LIVE revision only. Somebody else's report is not their business, and
 * a report on a superseded revision is answered by the revision that
 * replaced it.
 */
export async function myReportsFor(userId: string, problemId: string): Promise<MyReport[]> {
  const problem = await db.problem.findUnique({ where: { id: problemId }, select: { liveVersionId: true } });
  if (!problem?.liveVersionId) return [];
  const rows = await db.problemReport.findMany({
    where: { reporterId: userId, problemVersionId: problem.liveVersionId },
    orderBy: { createdAt: "desc" },
    take: 5,
    select: { id: true, reason: true, status: true, resolution: true },
  });
  return rows;
}

/** Open report counts for the admin problem list, by problem id. */
export async function openReportCounts(problemIds: readonly string[]): Promise<Map<string, number>> {
  if (problemIds.length === 0) return new Map();
  const rows = await db.problemReport.findMany({
    where: { status: "OPEN", problemVersion: { problemId: { in: [...problemIds] } } },
    select: { problemVersion: { select: { problemId: true } } },
  });
  const counts = new Map<string, number>();
  for (const row of rows) {
    const key = row.problemVersion.problemId;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}
