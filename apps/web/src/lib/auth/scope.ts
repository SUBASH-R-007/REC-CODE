import "server-only";
import { cache } from "react";
import { notFound } from "next/navigation";
import type { AccountStatus, Db, DbTx, Prisma, Role, User } from "@recx/db";
import { requireActionRole, requirePageRole } from "@/lib/auth/guards";
import { db } from "@/lib/db";
import { NotFoundError } from "@/lib/errors";
import {
  buildStudentScope,
  scopedStudentWhere,
  type ScopedStudentId,
  type StudentScope,
} from "@/lib/auth/scope-where";

export {
  ACTIVE_STUDENT_STATUSES,
  describeScope,
  isEmptyScope,
  scopeCovers,
  scopedStudentSql,
  scopedStudentWhere,
  staffOnlyWhere,
  type ScopeGrant,
  type ScopedStudentId,
  type StudentScope,
} from "@/lib/auth/scope-where";

/**
 * AdminScope, the server half: loading an admin's active grants and the guards
 * every /admin page and action starts with. Reads AdminScope only; the rows
 * are written by the governance actions (grant / revoke, SUPER_ADMIN).
 *
 *   Pages:   const { user, scope } = await requireAdminScopePage();
 *   Actions: const { user, scope } = await requireAdminScopeAction();
 *   One student: requireScopedStudent(scope, id) / requireScopedStudentPage(scope, id)
 *
 * Fail closed: an ADMIN without an active grant gets an empty scope, which
 * matches no student.
 */

const loadScopeFor = cache(async (id: string, role: Role): Promise<StudentScope> => {
  if (role !== "ADMIN") return buildStudentScope({ id, role }, []);
  const grants = await db.adminScope.findMany({
    where: { adminId: id, revokedAt: null },
    select: { departmentCode: true, batchYear: true },
  });
  return buildStudentScope({ id, role }, grants);
});

/** The viewer's scope (cached per request). Throws ForbiddenError for a non-admin role. */
export function loadStudentScope(user: Pick<User, "id" | "role">): Promise<StudentScope> {
  return loadScopeFor(user.id, user.role);
}

/** Page guard for /admin: ADMIN or SUPER_ADMIN (else redirect), plus the scope. */
export async function requireAdminScopePage(): Promise<{ user: User; scope: StudentScope }> {
  const user = await requirePageRole("ADMIN", "SUPER_ADMIN");
  return { user, scope: await loadStudentScope(user) };
}

/** Action guard for /admin: ADMIN or SUPER_ADMIN (else ForbiddenError), plus the scope. */
export async function requireAdminScopeAction(): Promise<{ user: User; scope: StudentScope }> {
  const user = await requireActionRole("ADMIN", "SUPER_ADMIN");
  return { user, scope: await loadStudentScope(user) };
}

/** A student the viewer's scope covers. Per-student admin queries take this, never a raw id. */
export interface ScopedStudent {
  scopedId: ScopedStudentId;
  collegeId: string;
  lmsUserId: string | null;
  firstName: string;
  lastName: string;
  email: string;
  handle: string;
  status: AccountStatus;
  batchYear: number | null;
  departmentCode: string | null;
  section: string | null;
  lastActiveAt: Date | null;
  lastLoginAt: Date | null;
  createdAt: Date;
}

const studentSelect = {
  id: true,
  collegeId: true,
  lmsUserId: true,
  firstName: true,
  lastName: true,
  email: true,
  handle: true,
  status: true,
  batchYear: true,
  departmentCode: true,
  section: true,
  lastActiveAt: true,
  lastLoginAt: true,
  createdAt: true,
} as const;

type StudentRow = { id: string } & Omit<ScopedStudent, "scopedId">;

function toScoped({ id, ...rest }: StudentRow): ScopedStudent {
  return { scopedId: id as ScopedStudentId, ...rest };
}

/** The first student matching `where` inside the scope, or null. */
export async function findScopedStudent(
  scope: StudentScope,
  where: Prisma.UserWhereInput,
  client: Db | DbTx = db,
): Promise<ScopedStudent | null> {
  const row = await client.user.findFirst({ where: scopedStudentWhere(scope, where), select: studentSelect });
  return row ? toScoped(row) : null;
}

/**
 * The student with this id, if the scope covers them. A missing id and an
 * out-of-scope id give the same NotFoundError, so ids cannot be probed.
 */
export async function requireScopedStudent(
  scope: StudentScope,
  userId: string,
  client: Db | DbTx = db,
): Promise<ScopedStudent> {
  const student = await findScopedStudent(scope, { id: userId }, client);
  if (!student) throw new NotFoundError("That student was not found.");
  return student;
}

/** Page form of requireScopedStudent: the route's 404 instead of an error. */
export async function requireScopedStudentPage(scope: StudentScope, userId: string): Promise<ScopedStudent> {
  const student = await findScopedStudent(scope, { id: userId });
  if (!student) notFound();
  return student;
}

/** Ids of every in-scope student matching `where` (e.g. an announcement's audience). */
export async function listScopedStudentIds(
  client: Db | DbTx,
  scope: StudentScope,
  where?: Prisma.UserWhereInput,
): Promise<ScopedStudentId[]> {
  const rows = await client.user.findMany({
    where: scopedStudentWhere(scope, where),
    select: { id: true },
    orderBy: { id: "asc" },
  });
  return rows.map((r) => r.id as ScopedStudentId);
}
