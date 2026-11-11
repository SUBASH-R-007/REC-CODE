import type { Role } from "@recx/db";

/**
 * Shared setup of the admin stream's database tests (RECX_DB_TESTS=1, the
 * recx_test database): users with a role and a cohort, AdminScope grants,
 * and a teardown that deletes only the suite's own rows. Guarded tables
 * (AdminScope, Accommodation, Announcement) refuse DELETE by trigger, so the
 * teardown lifts exactly those row triggers inside ONE transaction and
 * re-enables them before it commits (docs: FOUNDATION-REPORT, Fix-up 2).
 * Never TRUNCATE.
 */

// The app's client (src/lib/db.ts); typed loosely so this file does not load it.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any;

export interface UserSpec {
  role?: Role;
  status?: "ACTIVE" | "SOFT_RESTRICTED" | "DISABLED" | "GRADUATED" | "ARCHIVED";
  batchYear?: number | null;
  departmentCode?: string | null;
  section?: string | null;
  lmsUserId?: string | null;
  lastActiveAt?: Date | null;
}

export interface TestUser {
  id: string;
  collegeId: string;
  email: string;
  role: Role;
  firstName: string;
  lastName: string;
  [key: string]: unknown;
}

/** Create users keyed by name; collegeId, email and handle derive from `tag` so runs never collide. */
export async function createUsers<K extends string>(db: Db, tag: string, specs: Record<K, UserSpec>): Promise<Record<K, TestUser>> {
  const out = {} as Record<K, TestUser>;
  for (const [key, spec] of Object.entries(specs) as [K, UserSpec][]) {
    const handle = `${tag}-${key}`.toLowerCase();
    const collegeId = `${tag}${key}`.replace(/[^A-Za-z0-9]/g, "").toUpperCase().slice(0, 32);
    out[key] = await db.user.create({
      data: {
        collegeId,
        email: `${handle}@example.test`,
        firstName: key,
        lastName: "Test",
        handle,
        role: spec.role ?? "STUDENT",
        status: spec.status ?? "ACTIVE",
        batchYear: spec.batchYear ?? null,
        departmentCode: spec.departmentCode ?? null,
        section: spec.section ?? null,
        lmsUserId: spec.lmsUserId ?? null,
        lastActiveAt: spec.lastActiveAt ?? null,
      },
    });
  }
  return out;
}

export async function grantScope(
  db: Db,
  adminId: string,
  grantedById: string,
  grant: { departmentCode: string | null; batchYear: number | null },
): Promise<string> {
  const row = await db.adminScope.create({
    data: { adminId, grantedById, departmentCode: grant.departmentCode, batchYear: grant.batchYear, reason: "test grant" },
    select: { id: true },
  });
  return row.id;
}

const DELETE_GUARDS = [
  ["AdminScope", "AdminScope_grant_immutable"],
  ["Accommodation", "Accommodation_granted_terms_immutable"],
  ["Announcement", "Announcement_published_immutable"],
] as const;

/**
 * Delete everything the suite created for these users (and announcements
 * they wrote, plus users created by an import, matched by `extraUserIds`),
 * then the users themselves.
 */
export async function cleanupAdminRows(db: Db, userIds: string[], extraUserIds: string[] = []): Promise<void> {
  const ids = [...new Set([...userIds, ...extraUserIds])];
  if (ids.length === 0) return;
  const raw = (sql: string, ...params: unknown[]) => db.$executeRawUnsafe(sql, ...params);
  await db.$transaction([
    ...DELETE_GUARDS.map(([table, trigger]) => raw(`ALTER TABLE "public"."${table}" DISABLE TRIGGER "${trigger}"`)),
    raw(
      `DELETE FROM "public"."Notification" WHERE "userId" = ANY($1::text[])
         OR "announcementId" IN (SELECT id FROM "public"."Announcement" WHERE "createdById" = ANY($1::text[]))`,
      ids,
    ),
    raw(`DELETE FROM "public"."Announcement" WHERE "createdById" = ANY($1::text[])`, ids),
    raw(`UPDATE "public"."Accommodation" SET "supersedesId" = NULL WHERE "userId" = ANY($1::text[])`, ids),
    raw(`DELETE FROM "public"."Accommodation" WHERE "userId" = ANY($1::text[])`, ids),
    raw(`DELETE FROM "public"."AdminScope" WHERE "adminId" = ANY($1::text[])`, ids),
    ...DELETE_GUARDS.map(([table, trigger]) => raw(`ALTER TABLE "public"."${table}" ENABLE TRIGGER "${trigger}"`)),
    raw(`DELETE FROM "public"."RosterImport" WHERE "createdById" = ANY($1::text[])`, ids),
    raw(`DELETE FROM "public"."Session" WHERE "userId" = ANY($1::text[])`, ids),
    raw(`DELETE FROM "public"."StudyPlanEnrollment" WHERE "userId" = ANY($1::text[])`, ids),
    raw(`DELETE FROM "public"."UserProblemStatus" WHERE "userId" = ANY($1::text[])`, ids),
    raw(`DELETE FROM "public"."ActivityDay" WHERE "userId" = ANY($1::text[])`, ids),
    raw(`DELETE FROM "public"."XpBucket" WHERE "userId" = ANY($1::text[])`, ids),
    raw(`DELETE FROM "public"."UserStats" WHERE "userId" = ANY($1::text[])`, ids),
    raw(`DELETE FROM "public"."JudgeQuotaOverride" WHERE "userId" = ANY($1::text[])`, ids),
    raw(`DELETE FROM "public"."User" WHERE "id" = ANY($1::text[])`, ids),
  ]);
}

/** Names of user triggers that are not plainly enabled (must be none after a teardown). */
export async function disabledTriggers(db: Db): Promise<string[]> {
  const rows: Array<{ tgname: string }> = await db.$queryRawUnsafe(
    `SELECT "tgname" FROM pg_trigger WHERE NOT "tgisinternal" AND "tgenabled" <> 'O' ORDER BY 1`,
  );
  return rows.map((r) => r.tgname);
}
