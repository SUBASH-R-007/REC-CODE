import "server-only";
import { z } from "zod";
import { Prisma, type Db, type DbTx } from "@recx/db";
import { isoWeekKey, monthKey, rosterRowSchema, type RosterRow } from "@recx/shared";
import { ACTIVE_STUDENT_STATUSES, scopedStudentSql, scopedStudentWhere, type StudentScope } from "@/lib/auth/scope-where";
import { ConflictError } from "@/lib/errors";
import { cohortText, sameCohort } from "@/lib/admin/cohort";
import type { ValidatedRosterLine } from "@/lib/admin/roster-csv";
import { proposeHandle, handleBase, type ExistingUser, type RosterPlan } from "@/lib/admin/roster-plan";

/**
 * The database side of a roster import: loading the accounts a file's rows
 * match, and applying a confirmed plan inside the commit transaction.
 *
 * Two queries here are deliberately not scoped (exact-count exemptions in
 * tests/repo/admin-scope.test.ts): the key lookup, which must see accounts
 * outside the importer's scope to detect conflicts (it selects keys and
 * cohort only, and an out-of-scope match becomes OUTSIDE_SCOPE with no
 * detail), and the handle lookup for new accounts (handles are global).
 * user.createManyAndReturn is the LMS roster copy; planRosterImport() has
 * already checked the target cohort with scopeCovers().
 */

const storedLineSchema = z.union([
  z.object({ line: z.number().int().positive(), row: rosterRowSchema, error: z.null() }),
  z.object({
    line: z.number().int().positive(),
    row: z.null(),
    error: z.object({ reason: z.enum(["MISSING_LMS_ID", "INVALID_ROW"]), message: z.string().max(500) }),
  }),
]);

/** RosterImport.rows back into validated lines (null if the JSON is not what the preview stored). */
export function parseStoredLines(json: unknown): ValidatedRosterLine[] | null {
  const parsed = z.array(storedLineSchema).safeParse(json);
  return parsed.success ? (parsed.data as ValidatedRosterLine[]) : null;
}

const unique = <T>(values: T[]) => [...new Set(values)];

/**
 * Every account sharing an LMS id, roll number or email with a row, plus —
 * for the in-scope students among them — the profile fields an update compares.
 */
export async function loadRosterMatches(
  client: Db | DbTx,
  scope: StudentScope,
  rows: readonly RosterRow[],
): Promise<ExistingUser[]> {
  if (rows.length === 0) return [];
  const lms = unique(rows.map((r) => r.lmsUserId));
  const collegeIds = unique(rows.map((r) => r.collegeId));
  const emails = unique(rows.map((r) => r.email.toLowerCase()));
  // Unscoped on purpose (fence exemption): conflicts with accounts outside
  // the scope must be detected. Keys and cohort only — never names.
  const keyed = await client.user.findMany({
    where: {
      OR: [
        { lmsUserId: { in: lms } },
        { collegeId: { in: collegeIds, mode: "insensitive" } },
        { email: { in: emails, mode: "insensitive" } },
      ],
    },
    select: {
      id: true,
      role: true,
      status: true,
      lmsUserId: true,
      collegeId: true,
      email: true,
      batchYear: true,
      departmentCode: true,
    },
  });
  if (keyed.length === 0) return [];
  const details = await client.user.findMany({
    where: scopedStudentWhere(scope, { id: { in: keyed.map((u) => u.id) } }),
    select: { id: true, firstName: true, lastName: true, section: true },
  });
  const byId = new Map(details.map((d) => [d.id, { firstName: d.firstName, lastName: d.lastName, section: d.section }]));
  return keyed.map((u) => {
    const detail = byId.get(u.id);
    return detail ? { ...u, detail } : { ...u };
  });
}

export interface RosterResult {
  line: number;
  outcome: "CREATE" | "UPDATE" | "UNCHANGED" | "SKIPPED" | "REJECTED";
  userId?: string;
  changedFields?: string[];
  linked?: boolean;
  reason?: string;
}

export interface CohortMove {
  userId: string;
  from: string;
  to: string;
}

const CREATE_CHUNK = 1000;
const HANDLE_CHUNK = 200;

async function takenHandles(tx: DbTx, bases: readonly string[]): Promise<Set<string>> {
  const taken = new Set<string>();
  for (let i = 0; i < bases.length; i += HANDLE_CHUNK) {
    const chunk = bases.slice(i, i + HANDLE_CHUNK);
    // Unscoped on purpose (fence exemption): handles are unique across every account.
    const rows = await tx.user.findMany({
      where: { OR: chunk.map((b) => ({ handle: { startsWith: b, mode: "insensitive" as const } })) },
      select: { handle: true },
    });
    for (const r of rows) taken.add(r.handle.toLowerCase());
  }
  return taken;
}

/**
 * Apply a plan inside the commit transaction. Creates copy the LMS identity
 * (role STUDENT, status ACTIVE, no password: such an account cannot sign in
 * until LMS sign-in ships). Updates are conditional on every changed field
 * still holding the value the plan saw (and, for a link, no LMS id yet), the
 * account still current and still in scope; anything else aborts the whole
 * commit. Activity (sign-in, submissions) never conflicts. Role, status and password
 * are never written. The open-period XpBucket rows of moved students get
 * their new cohort, so this week's and month's boards follow the move.
 */
export interface ApplyRosterOptions {
  /**
   * Argon2id hash of the initial password the admin chose for the accounts
   * this import CREATES, or null to create them without one (they then use
   * the one-time link on the sign-in page). Never a plaintext password: the
   * caller hashes it once for the whole batch rather than per row, because a
   * five-hundred-row import would otherwise spend minutes in Argon2id.
   */
  initialPasswordHash?: string | null;
}

export async function applyRosterPlan(
  tx: DbTx,
  plan: RosterPlan,
  scope: StudentScope,
  now: Date,
  options: ApplyRosterOptions = {},
): Promise<{ results: RosterResult[]; moves: CohortMove[] }> {
  const results: RosterResult[] = [];
  const moves: CohortMove[] = [];

  // Creates.
  const creates = plan.lines.flatMap((l) => (l.outcome.kind === "CREATE" ? [{ line: l.line, row: l.outcome.row }] : []));
  if (creates.length > 0) {
    const taken = await takenHandles(tx, unique(creates.map((c) => handleBase(c.row.firstName, c.row.lastName))));
    const data = creates.map(({ row }) => {
      const handle = proposeHandle(row.firstName, row.lastName, taken);
      taken.add(handle);
      return {
        lmsUserId: row.lmsUserId,
        collegeId: row.collegeId,
        email: row.email,
        firstName: row.firstName,
        lastName: row.lastName,
        handle,
        role: "STUDENT" as const,
        status: "ACTIVE" as const,
        // An account created with no password is not locked out: the sign-in
        // page's "never set one?" link mints a one-time link to choose one.
        // With an initial password it must be replaced at first sign-in, and
        // the CHECK on User refuses the flag without a hash.
        passwordHash: options.initialPasswordHash ?? null,
        mustChangePassword: options.initialPasswordHash != null,
        batchYear: row.batchYear,
        departmentCode: row.departmentCode,
        section: row.section,
      };
    });
    const created = new Map<string, string>();
    for (let i = 0; i < data.length; i += CREATE_CHUNK) {
      const rows = await tx.user.createManyAndReturn({
        data: data.slice(i, i + CREATE_CHUNK),
        select: { id: true, collegeId: true },
      });
      for (const r of rows) created.set(r.collegeId, r.id);
    }
    for (const c of creates) results.push({ line: c.line, outcome: "CREATE", userId: created.get(c.row.collegeId) });
  }

  // Updates and links.
  const current = [...ACTIVE_STUDENT_STATUSES];
  for (const l of plan.lines) {
    const o = l.outcome;
    if (o.kind !== "UPDATE") continue;
    const data: Prisma.UserUpdateManyMutationInput = {};
    for (const c of o.changes) {
      if (c.field === "batchYear") data.batchYear = c.to as number | null;
      else if (c.field === "section") data.section = c.to as string | null;
      else data[c.field] = c.to as string;
    }
    if (o.link) data.lmsUserId = o.row.lmsUserId;
    const unchangedSincePlan: Prisma.UserWhereInput = Object.fromEntries(o.changes.map((c) => [c.field, c.from]));
    if (o.link) unchangedSincePlan.lmsUserId = null;
    const moved = await tx.user.updateMany({
      where: scopedStudentWhere(scope, { id: o.userId, status: { in: current }, ...unchangedSincePlan }),
      data,
    });
    if (moved.count !== 1) {
      throw new ConflictError("A student changed while the import was being applied. Nothing was imported — review the new preview.");
    }
    const before = Object.fromEntries(o.changes.map((c) => [c.field, c.from])) as Record<string, unknown>;
    const cohortChanged = o.changes.some((c) => c.field === "batchYear" || c.field === "departmentCode" || c.field === "section");
    if (cohortChanged) {
      const after = { batchYear: o.row.batchYear, departmentCode: o.row.departmentCode, section: o.row.section };
      const from = {
        batchYear: "batchYear" in before ? (before.batchYear as number | null) : o.row.batchYear,
        departmentCode: "departmentCode" in before ? (before.departmentCode as string | null) : o.row.departmentCode,
        section: "section" in before ? (before.section as string | null) : o.row.section,
      };
      if (!sameCohort(from, after)) moves.push({ userId: o.userId, from: cohortText(from), to: cohortText(after) });
    }
    results.push({
      line: l.line,
      outcome: "UPDATE",
      userId: o.userId,
      changedFields: o.changes.map((c) => c.field),
      linked: o.link,
    });
  }

  // Open-period leaderboard buckets follow the move (closed periods keep history).
  if (moves.length > 0) {
    const ids = moves.map((m) => m.userId);
    await tx.$executeRaw`
      UPDATE "XpBucket" b
      SET "batchYear" = u."batchYear", "departmentCode" = u."departmentCode", "section" = u."section"
      FROM "User" u
      WHERE u.id = b."userId"
        AND u.id = ANY(${ids}::text[])
        AND ${scopedStudentSql(scope, "u")}
        AND ((b.period = 'ALL_TIME' AND b."periodKey" = 'all')
          OR (b.period = 'MONTH' AND b."periodKey" = ${monthKey(now)})
          OR (b.period = 'WEEK' AND b."periodKey" = ${isoWeekKey(now)}))`;
  }

  for (const l of plan.lines) {
    const o = l.outcome;
    if (o.kind === "UNCHANGED") results.push({ line: l.line, outcome: "UNCHANGED", userId: o.userId });
    else if (o.kind === "SKIPPED") results.push({ line: l.line, outcome: "SKIPPED", userId: o.userId, reason: o.reason });
    else if (o.kind === "REJECTED") results.push({ line: l.line, outcome: "REJECTED", reason: o.reason });
  }
  results.sort((a, b) => a.line - b.line);
  return { results, moves };
}
