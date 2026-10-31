import { z } from "zod";
import type { Prisma } from "@recx/db";
import { formatCohort } from "@/lib/admin/cohort";

/**
 * Who an announcement is for: a batch, a department and/or a section. A
 * missing value means every value of that dimension; a section needs both a
 * batch and a department (the same rule as the database CHECK
 * Announcement_section_needs_cohort_check). The author's scope must cover the
 * audience (scopeCovers on audienceCohort).
 */

const emptyToNull = (v: unknown) => (v === "" || v === undefined ? null : v);

export const audienceSchema = z
  .object({
    batchYear: z.preprocess(emptyToNull, z.coerce.number().int().min(2000).max(2100).nullable()),
    departmentCode: z.preprocess(
      emptyToNull,
      z
        .string()
        .trim()
        .toUpperCase()
        .regex(/^[A-Z]{2,10}$/, "The department code must be 2–10 letters.")
        .nullable(),
    ),
    section: z.preprocess(
      emptyToNull,
      z
        .string()
        .trim()
        .toUpperCase()
        .regex(/^[A-Z0-9]{1,4}$/, "The section must be 1–4 letters or digits.")
        .nullable(),
    ),
  })
  .superRefine((a, ctx) => {
    if (a.section !== null && (a.batchYear === null || a.departmentCode === null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["section"],
        message: "Choose a batch and a department before a section.",
      });
    }
  });

export type Audience = z.output<typeof audienceSchema>;

/** The User filter of the audience (no role, no scope, no status: the caller adds those). */
export function audienceWhere(a: Audience): Prisma.UserWhereInput {
  const where: Prisma.UserWhereInput = {};
  if (a.batchYear !== null) where.batchYear = a.batchYear;
  if (a.departmentCode !== null) where.departmentCode = a.departmentCode;
  if (a.section !== null) where.section = a.section;
  return where;
}

/** The part scopeCovers() checks (scope has no section dimension). */
export function audienceCohort(a: Pick<Audience, "batchYear" | "departmentCode">): {
  batchYear: number | null;
  departmentCode: string | null;
} {
  return { batchYear: a.batchYear, departmentCode: a.departmentCode };
}

/** "Every student", "CSE · every batch", "CSE 2027 · A". */
export function describeAudience(a: Audience): string {
  if (a.batchYear === null && a.departmentCode === null) return "Every student in your scope";
  if (a.batchYear === null) return `${a.departmentCode} · every batch`;
  if (a.departmentCode === null) return `Batch ${a.batchYear} · every department`;
  if (a.section === null) return `${a.departmentCode} ${a.batchYear} · every section`;
  return formatCohort(a);
}
