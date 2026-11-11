import { z } from "zod";

/**
 * Cohorts are derived, not stored: a cohort is a (batchYear, departmentCode,
 * section) combination of User columns the LMS owns. There is no Cohort
 * model. In URLs a cohort is "2027.CSE.A", or "2027.CSE.-" without a section.
 */

export interface Cohort {
  batchYear: number;
  departmentCode: string;
  section: string | null;
}

/** A cohort as it appears on a user row, where any column may be missing. */
export interface PartialCohort {
  batchYear: number | null;
  departmentCode: string | null;
  section: string | null;
}

export const cohortKeySchema = z
  .string()
  .trim()
  .max(32)
  .regex(/^(\d{4})\.([A-Z]{2,10})\.([A-Z0-9]{1,4}|-)$/);

/** "2027.CSE.A" → the cohort; anything else → null (the filter is ignored). */
export function parseCohortParam(raw: string | string[] | undefined | null): Cohort | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  const parsed = cohortKeySchema.safeParse(value);
  if (!parsed.success) return null;
  const [year, dept, section] = parsed.data.split(".") as [string, string, string];
  const batchYear = Number(year);
  if (batchYear < 2000 || batchYear > 2100) return null;
  return { batchYear, departmentCode: dept, section: section === "-" ? null : section };
}

/** The URL key of a complete cohort, or null when the row lacks a batch or department. */
export function cohortKey(c: PartialCohort): string | null {
  if (c.batchYear === null || c.departmentCode === null) return null;
  return `${c.batchYear}.${c.departmentCode}.${c.section ?? "-"}`;
}

/** "CSE 2027 · A", "CSE 2027 · no section", "No cohort". */
export function formatCohort(c: PartialCohort): string {
  if (c.batchYear === null && c.departmentCode === null) return c.section ? `Section ${c.section}` : "No cohort";
  const base = [c.departmentCode ?? "No department", c.batchYear ?? "no batch"].join(" ");
  return `${base} · ${c.section ? c.section : "no section"}`;
}

/** Audit-friendly cohort text: "2027.CSE.A", with "?" for a missing part. */
export function cohortText(c: PartialCohort): string {
  return `${c.batchYear ?? "?"}.${c.departmentCode ?? "?"}.${c.section ?? "-"}`;
}

export function sameCohort(a: PartialCohort, b: PartialCohort): boolean {
  return a.batchYear === b.batchYear && a.departmentCode === b.departmentCode && a.section === b.section;
}
