import type { Db, Role } from "@recx/db";

/**
 * Fixtures and teardown for the governance database tests (RECX_DB_TESTS=1,
 * recx_test only). Every row is tagged or owned by the suite's own users,
 * and teardown follows the foundation's rule: in ONE transaction, disable
 * each delete guard of the tables being cleaned, delete only this suite's
 * rows, re-enable, then assert no trigger is left disabled. Never TRUNCATE.
 */

export const TEST_URL = process.env.RECX_TEST_DATABASE_URL ?? "postgresql://recx:recx-dev-only@localhost:5433/recx_test";

export function assertTestDatabase(): void {
  if (!new URL(TEST_URL).pathname.endsWith("_test")) {
    throw new Error(`Refusing to run against a non-test database: ${new URL(TEST_URL).pathname}`);
  }
}

export async function createUsers(
  db: Db,
  tag: string,
  specs: Record<string, { role: Role; status?: "ACTIVE" | "SOFT_RESTRICTED" | "DISABLED" }>,
): Promise<Record<string, { id: string; collegeId: string; role: Role; firstName: string; lastName: string }>> {
  const out: Record<string, { id: string; collegeId: string; role: Role; firstName: string; lastName: string }> = {};
  for (const [key, spec] of Object.entries(specs)) {
    const handle = `${tag}-${key}`.toLowerCase();
    out[key] = await db.user.create({
      data: {
        collegeId: handle.toUpperCase(),
        email: `${handle}@example.test`,
        handle,
        firstName: key,
        lastName: "Gov",
        role: spec.role,
        status: spec.status ?? "ACTIVE",
      },
      select: { id: true, collegeId: true, role: true, firstName: true, lastName: true },
    });
  }
  return out;
}

const DELETE_GUARDS = [
  ["PrivilegedOperation", "PrivilegedOperation_request_immutable"],
  ["AdminScope", "AdminScope_grant_immutable"],
  ["ImpersonationSession", "ImpersonationSession_immutable"],
  ["XpEvent", "XpEvent_append_only"],
] as const;

/** Names of user triggers that are not plainly enabled ('O'). */
export async function disabledTriggers(db: Db): Promise<string[]> {
  const rows = await db.$queryRawUnsafe<Array<{ tgname: string }>>(
    `SELECT "tgname" FROM pg_trigger WHERE NOT "tgisinternal" AND "tgenabled" <> 'O' ORDER BY 1`,
  );
  return rows.map((r) => r.tgname);
}

/**
 * Delete everything the suite's users own across the governance tables,
 * then the users. `tag` also removes notifications and outbox rows sent to
 * OTHER super-admins about this suite's operations (their text carries it).
 */
export async function cleanupGovernance(db: Db, userIds: readonly string[], tag: string): Promise<void> {
  if (userIds.length === 0) return;
  const ids = [...userIds];
  const raw = (sql: string, ...params: unknown[]) => db.$executeRawUnsafe(sql, ...params);
  const like = `%${tag}%`;
  // Lift only the guards of tables that hold this suite's rows: ALTER TABLE
  // takes a table lock, and fewer of them means less contention with suites
  // running in parallel.
  const counts = await db.$queryRawUnsafe<Array<{ t: string; n: number }>>(
    `SELECT 'PrivilegedOperation' AS t, count(*)::int AS n FROM "public"."PrivilegedOperation" WHERE "requestedById" = ANY($1::text[])
     UNION ALL SELECT 'AdminScope', count(*)::int FROM "public"."AdminScope" WHERE "adminId" = ANY($1::text[])
     UNION ALL SELECT 'ImpersonationSession', count(*)::int FROM "public"."ImpersonationSession" WHERE "impersonatorId" = ANY($1::text[]) OR "targetUserId" = ANY($1::text[])
     UNION ALL SELECT 'XpEvent', count(*)::int FROM "public"."XpEvent" WHERE "userId" = ANY($1::text[])`,
    ids,
  );
  const present = new Set(counts.filter((c) => c.n > 0).map((c) => c.t));
  const guards = DELETE_GUARDS.filter(([table]) => present.has(table));
  await db.$transaction([
    ...guards.map(([table, trigger]) => raw(`ALTER TABLE "public"."${table}" DISABLE TRIGGER "${trigger}"`)),
    raw(
      `DELETE FROM "public"."EmailOutbox" WHERE "toUserId" = ANY($1::text[]) OR "entityId" IN (SELECT id FROM "public"."PrivilegedOperation" WHERE "requestedById" = ANY($1::text[])) OR "subject" LIKE $2 OR "bodyText" LIKE $2`,
      ids,
      like,
    ),
    raw(`DELETE FROM "public"."Notification" WHERE "userId" = ANY($1::text[]) OR "body" LIKE $2 OR "title" LIKE $2`, ids, like),
    raw(`DELETE FROM "public"."PrivilegedOperation" WHERE "requestedById" = ANY($1::text[])`, ids),
    raw(`DELETE FROM "public"."AdminScope" WHERE "adminId" = ANY($1::text[])`, ids),
    raw(`UPDATE "public"."Session" SET "impersonationId" = NULL WHERE "userId" = ANY($1::text[])`, ids),
    raw(`DELETE FROM "public"."ImpersonationSession" WHERE "impersonatorId" = ANY($1::text[]) OR "targetUserId" = ANY($1::text[])`, ids),
    raw(`DELETE FROM "public"."XpEvent" WHERE "userId" = ANY($1::text[])`, ids),
    ...guards.map(([table, trigger]) => raw(`ALTER TABLE "public"."${table}" ENABLE TRIGGER "${trigger}"`)),
    raw(`DELETE FROM "public"."XpBucket" WHERE "userId" = ANY($1::text[])`, ids),
    raw(`DELETE FROM "public"."UserStats" WHERE "userId" = ANY($1::text[])`, ids),
    raw(`DELETE FROM "public"."Session" WHERE "userId" = ANY($1::text[])`, ids),
    raw(`DELETE FROM "public"."User" WHERE "id" = ANY($1::text[])`, ids),
  ]);
}
