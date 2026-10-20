import "server-only";
import { isActiveDevice, type AttestationKind } from "@recx/shared";
import { scopedStudentWhere, type StudentScope } from "@/lib/auth/scope";
import { db } from "@/lib/db";

/**
 * Exam devices, for the supervisor's enrolment screen (Phase 6d).
 *
 * A query module rather than reads in the page, because
 * `tests/repo/admin-scope.test.ts` R9 forbids an `/admin` page from importing
 * `@/lib/db` at all — "read through a server/queries module or write through
 * a server action". It caught the first draft of `/admin/devices` doing it,
 * and the rule is a good one: it means every staff-facing read of a student's
 * data goes through a function that takes a `StudentScope` and cannot forget
 * to apply it.
 */

export interface AdminDeviceRow {
  readonly id: string;
  readonly label: string;
  readonly isLoaner: boolean;
  readonly loanConsumedAt: Date | null;
  readonly revokedAt: Date | null;
  readonly enrolledAt: Date;
  readonly attestationKind: AttestationKind;
  /** Active = not withdrawn, and not a spent loaner. */
  readonly active: boolean;
}

/**
 * One student's devices, scoped through the device's owner so an
 * administrator sees only their own students'.
 */
export async function listStudentDevices(scope: StudentScope, userId: string): Promise<AdminDeviceRow[]> {
  const rows = await db.deviceRegistration.findMany({
    where: { userId, user: scopedStudentWhere(scope) },
    // Active first, then newest: a supervisor looking at this screen wants
    // the device the student is about to sit on, not the history.
    orderBy: [{ revokedAt: "asc" }, { enrolledAt: "desc" }],
    select: {
      id: true,
      label: true,
      isLoaner: true,
      loanConsumedAt: true,
      revokedAt: true,
      enrolledAt: true,
      attestationKind: true,
    },
  });
  return rows.map((row) => ({
    ...row,
    attestationKind: row.attestationKind as AttestationKind,
    active: isActiveDevice({ id: row.id, label: row.label, revokedAt: row.revokedAt, isLoaner: row.isLoaner, loanConsumedAt: row.loanConsumedAt }),
  }));
}
