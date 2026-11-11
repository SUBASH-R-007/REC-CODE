import "server-only";
import type { AccommodationKind, AccommodationStatus, ProctorEventKind } from "@recx/db";
import { db } from "@/lib/db";
import { scopedStudentWhere, staffOnlyWhere, type ScopedStudent, type StudentScope } from "@/lib/auth/scope";

/**
 * Read side of /admin/accommodations. The list never carries `kinds` or
 * `reason` (a disability label and its justification): only status,
 * validity and the timing/display terms. Kinds, reason and the decision note
 * appear only on the detail page (getAccommodation).
 */

export interface AccommodationTermsView {
  exemptSignals: ProctorEventKind[];
  extraTimePercent: number;
  extraTimeMinutes: number;
  allowBreaks: boolean;
  breakMinutes: number;
  fontScalePercent: number;
  allowScribe: boolean;
  highContrast: boolean;
  validUntil: Date;
}

export interface AccommodationListRow extends AccommodationTermsView {
  id: string;
  status: AccommodationStatus;
  requestedAt: Date;
  supersedesId: string | null;
  student: {
    id: string;
    collegeId: string;
    firstName: string;
    lastName: string;
    batchYear: number | null;
    departmentCode: string | null;
    section: string | null;
  };
}

const termsSelect = {
  exemptSignals: true,
  extraTimePercent: true,
  extraTimeMinutes: true,
  allowBreaks: true,
  breakMinutes: true,
  fontScalePercent: true,
  allowScribe: true,
  highContrast: true,
  validUntil: true,
} as const;

const studentSelect = {
  id: true,
  collegeId: true,
  firstName: true,
  lastName: true,
  batchYear: true,
  departmentCode: true,
  section: true,
} as const;

export async function listAccommodations(
  scope: StudentScope,
  status: AccommodationStatus | null,
): Promise<AccommodationListRow[]> {
  const rows = await db.accommodation.findMany({
    where: { ...(status ? { status } : {}), user: scopedStudentWhere(scope) },
    orderBy: [{ requestedAt: "desc" }, { id: "asc" }],
    take: 200,
    select: {
      id: true,
      status: true,
      requestedAt: true,
      supersedesId: true,
      ...termsSelect,
      user: { select: studentSelect },
    },
  });
  return rows.map(({ user, ...r }) => ({ ...r, student: user }));
}

export interface AccommodationDetail extends AccommodationListRow {
  kinds: AccommodationKind[];
  reason: string;
  decisionNote: string | null;
  requestedByName: string;
  requestedById: string;
  decidedByName: string | null;
  decidedAt: Date | null;
  grantedAt: Date | null;
  approvedByName: string | null;
  revokedAt: Date | null;
  revokedByName: string | null;
  supersedes: { id: string; status: AccommodationStatus } | null;
  supersededBy: { id: string; status: AccommodationStatus } | null;
}

/** One accommodation of an in-scope student, with kinds and reason (detail page only), or null. */
export async function getAccommodation(scope: StudentScope, id: string): Promise<AccommodationDetail | null> {
  const a = await db.accommodation.findFirst({
    where: { id, user: scopedStudentWhere(scope) },
    select: {
      id: true,
      status: true,
      requestedAt: true,
      supersedesId: true,
      ...termsSelect,
      kinds: true,
      reason: true,
      decisionNote: true,
      requestedById: true,
      decidedById: true,
      decidedAt: true,
      grantedAt: true,
      approvedBySuperAdminId: true,
      revokedAt: true,
      revokedById: true,
      user: { select: studentSelect },
      supersedes: { select: { id: true, status: true } },
      supersededBy: { select: { id: true, status: true } },
    },
  });
  if (!a) return null;
  const staffIds = [a.requestedById, a.decidedById, a.approvedBySuperAdminId, a.revokedById].filter(
    (v): v is string => typeof v === "string",
  );
  const staff = await db.user.findMany({
    where: staffOnlyWhere({ id: { in: staffIds } }),
    select: { id: true, firstName: true, lastName: true },
  });
  const name = new Map(staff.map((s) => [s.id, `${s.firstName} ${s.lastName}`]));
  const nameOf = (id: string | null) => (id ? (name.get(id) ?? "Unknown account") : null);
  const { user, decidedById: _d, approvedBySuperAdminId, revokedById, ...rest } = a;
  return {
    ...rest,
    student: user,
    requestedByName: nameOf(a.requestedById) ?? "Unknown account",
    decidedByName: nameOf(a.decidedById),
    approvedByName: nameOf(approvedBySuperAdminId),
    revokedByName: nameOf(revokedById),
  };
}

export interface StudentAccommodationState {
  approved: (AccommodationTermsView & { id: string; kinds: AccommodationKind[] }) | null;
  openRequestId: string | null;
}

/** The student's current grant (to pre-fill a superseding request) and any open request. */
export async function studentAccommodationState(student: ScopedStudent): Promise<StudentAccommodationState> {
  const rows = await db.accommodation.findMany({
    where: { userId: student.scopedId, status: { in: ["APPROVED", "REQUESTED"] } },
    select: { id: true, status: true, kinds: true, ...termsSelect },
  });
  const approved = rows.find((r) => r.status === "APPROVED");
  const open = rows.find((r) => r.status === "REQUESTED");
  return {
    approved: approved ? { ...approved } : null,
    openRequestId: open?.id ?? null,
  };
}
