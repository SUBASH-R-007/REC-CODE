import "server-only";
import { z } from "zod";
import type { RosterImportStatus, User } from "@recx/db";
import { db } from "@/lib/db";
import type { StudentScope } from "@/lib/auth/scope";
import { loadRosterMatches, parseStoredLines, type RosterResult } from "@/lib/admin/roster";
import { planRosterImport, rosterPlanSha256, type RosterCounts, type RosterPlan } from "@/lib/admin/roster-plan";

/**
 * Read side of /admin/students/import. A preview is re-planned from the
 * stored rows at every render, against the accounts as they are NOW; the
 * commit compares the hash of what was shown with a fresh plan.
 */

export interface RosterImportSummary {
  id: string;
  status: RosterImportStatus;
  fileName: string;
  rowCount: number;
  counts: RosterCounts | null;
  createdAt: Date;
  expiresAt: Date;
  committedAt: Date | null;
  createdById: string;
}

const countsSchema = z.object({
  create: z.number(),
  update: z.number(),
  link: z.number(),
  unchanged: z.number(),
  skipped: z.number(),
  rejected: z.number(),
});

const summarySelect = {
  id: true,
  status: true,
  fileName: true,
  rowCount: true,
  counts: true,
  createdAt: true,
  expiresAt: true,
  committedAt: true,
  createdById: true,
} as const;

type SummaryRecord = Omit<RosterImportSummary, "counts"> & { counts: unknown };

function summary(r: SummaryRecord): RosterImportSummary {
  const counts = countsSchema.safeParse(r.counts);
  return { ...r, counts: counts.success ? counts.data : null };
}

/** The viewer's recent imports (a SUPER_ADMIN sees everyone's). Never the rows. */
export async function listRecentImports(viewer: Pick<User, "id" | "role">): Promise<RosterImportSummary[]> {
  const rows = await db.rosterImport.findMany({
    where: viewer.role === "SUPER_ADMIN" ? {} : { createdById: viewer.id },
    orderBy: { createdAt: "desc" },
    take: 10,
    select: summarySelect,
  });
  return rows.map(summary);
}

const resultSchema = z.object({
  line: z.number(),
  outcome: z.enum(["CREATE", "UPDATE", "UNCHANGED", "SKIPPED", "REJECTED"]),
  userId: z.string().optional(),
  changedFields: z.array(z.string()).optional(),
  linked: z.boolean().optional(),
  reason: z.string().optional(),
});

export type ImportView =
  | { kind: "preview"; summary: RosterImportSummary; plan: RosterPlan; diffSha256: string }
  | { kind: "committed"; summary: RosterImportSummary; results: RosterResult[] }
  | { kind: "closed"; summary: RosterImportSummary };

/**
 * The import page's data, or null when the import does not exist or is
 * someone else's (a SUPER_ADMIN may open any). An expired preview is closed.
 */
export async function getImportPreview(
  viewer: Pick<User, "id" | "role">,
  scope: StudentScope,
  importId: string,
  now = new Date(),
): Promise<ImportView | null> {
  const row = await db.rosterImport.findUnique({
    where: { id: importId },
    select: { ...summarySelect, rows: true, results: true },
  });
  if (!row) return null;
  if (row.createdById !== viewer.id && viewer.role !== "SUPER_ADMIN") return null;
  const base = summary(row);
  if (row.status === "COMMITTED") {
    const results = z.array(resultSchema).safeParse(row.results);
    return { kind: "committed", summary: base, results: results.success ? results.data : [] };
  }
  if (row.status !== "PREVIEWED" || row.expiresAt <= now) return { kind: "closed", summary: base };
  const lines = parseStoredLines(row.rows);
  if (!lines) return { kind: "closed", summary: base };
  const matches = await loadRosterMatches(
    db,
    scope,
    lines.flatMap((l) => (l.row ? [l.row] : [])),
  );
  const plan = planRosterImport(lines, matches, scope);
  return { kind: "preview", summary: base, plan, diffSha256: rosterPlanSha256(plan) };
}
