import "server-only";

import { countsAsActivitySchema, type InactivityPolicyShape } from "@recx/shared";
import { db } from "@/lib/db";

/**
 * Reading the inactivity policy versions, for `/super/settings/inactivity`
 * (Phase 8b).
 *
 * `super-`-prefixed for the same reason as the calendar reads: the prefix is
 * what keeps a staff-only read out of the student-exposure scan, by name
 * rather than by a listed exception.
 */

export const POLICY_PAGE_SIZE = 40;

type PolicyRow = InactivityPolicyShape & {
  readonly createdById: string;
  readonly createdAt: Date;
};

const SELECT = {
  version: true,
  isActive: true,
  batchYear: true,
  departmentCode: true,
  nudgeAfterDays: true,
  warnAfterDays: true,
  softRestrictAfterDays: true,
  disableAfterDays: true,
  autoDisableEnabled: true,
  graceDays: true,
  countsAsActivity: true,
  minActivityPerDay: true,
  excludeNonWorkingDays: true,
  excludeApprovedLeave: true,
  notifyMentor: true,
  notifyParentEmail: true,
  createdById: true,
  createdAt: true,
} as const;

function shape(row: {
  countsAsActivity: unknown;
  [key: string]: unknown;
}): PolicyRow {
  return {
    ...(row as unknown as Omit<PolicyRow, "countsAsActivity">),
    // Parsed rather than cast: the column is a CHECK'd jsonb, and a page that
    // trusted the cast would render `undefined` for a key the CHECK already
    // guarantees — hiding a schema drift rather than failing on it.
    countsAsActivity: countsAsActivitySchema.parse(row.countsAsActivity),
  };
}

/** Every version, newest first. The history IS the audit of the thresholds. */
export async function inactivityPolicyVersions(limit = POLICY_PAGE_SIZE): Promise<PolicyRow[]> {
  const rows = await db.inactivityPolicy.findMany({
    orderBy: { version: "desc" },
    take: limit,
    select: SELECT,
  });
  return rows.map(shape);
}

/** The live policies, one per scope. */
export async function activeInactivityPolicies(): Promise<PolicyRow[]> {
  const rows = await db.inactivityPolicy.findMany({
    where: { isActive: true },
    orderBy: [{ batchYear: "asc" }, { departmentCode: "asc" }],
    select: SELECT,
  });
  return rows.map(shape);
}
