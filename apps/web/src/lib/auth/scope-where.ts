import { Prisma, type Role } from "@recx/db";
import { ForbiddenError } from "@/lib/errors";

/**
 * AdminScope, the pure half (no I/O; unit-tested in test/admin-scope.test.ts).
 *
 * An ADMIN sees students by department and/or batch, through AdminScope rows
 * (a null dimension = every value; both null = the whole college). An ADMIN
 * with no active row sees NO students: the scope fails closed. SUPER_ADMIN is
 * never scoped. Every helper also requires role = STUDENT, so staff accounts
 * never appear in an admin's student queries.
 *
 * The loaders and guards live in lib/auth/scope.ts (server-only). Only these
 * two files may build a scope or mint a ScopedStudentId;
 * tests/repo/admin-scope.test.ts is the fence that keeps every admin student
 * query shaped through them.
 */

export interface ScopeGrant {
  readonly departmentCode: string | null;
  readonly batchYear: number | null;
}

declare const SCOPE: unique symbol;

/** A resolved scope. Branded: only buildStudentScope() produces one. */
export type StudentScope = { readonly [SCOPE]: true; readonly actorId: string } & (
  | { readonly kind: "ALL" }
  | { readonly kind: "GRANTS"; readonly grants: readonly ScopeGrant[] }
);

declare const SCOPED_ID: unique symbol;

/** A student id that was checked against a scope (lib/auth/scope.ts mints it). */
export type ScopedStudentId = string & { readonly [SCOPED_ID]: true };

/** The statuses that count as a current student (reports, announcements). */
export const ACTIVE_STUDENT_STATUSES = ["ACTIVE", "SOFT_RESTRICTED"] as const;

function normaliseGrant(g: ScopeGrant): ScopeGrant {
  const dept = typeof g.departmentCode === "string" ? g.departmentCode.trim() : null;
  return {
    departmentCode: dept ? dept : null,
    batchYear: typeof g.batchYear === "number" && Number.isInteger(g.batchYear) ? g.batchYear : null,
  };
}

/**
 * SUPER_ADMIN → the whole college. ADMIN → its grants (a grant with both
 * dimensions null collapses to the whole college; duplicates are dropped; no
 * grants = no students). Any other role → ForbiddenError.
 */
export function buildStudentScope(actor: { id: string; role: Role }, grants: readonly ScopeGrant[]): StudentScope {
  if (actor.role === "SUPER_ADMIN") return { kind: "ALL", actorId: actor.id } as StudentScope;
  if (actor.role !== "ADMIN") throw new ForbiddenError();
  const seen = new Set<string>();
  const unique: ScopeGrant[] = [];
  for (const raw of grants) {
    const g = normaliseGrant(raw);
    if (g.departmentCode === null && g.batchYear === null) return { kind: "ALL", actorId: actor.id } as StudentScope;
    const key = `${g.departmentCode ?? "*"}|${g.batchYear ?? "*"}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(Object.freeze(g));
  }
  unique.sort(
    (a, b) => (a.departmentCode ?? "").localeCompare(b.departmentCode ?? "") || (a.batchYear ?? 0) - (b.batchYear ?? 0),
  );
  return { kind: "GRANTS", actorId: actor.id, grants: Object.freeze(unique) } as StudentScope;
}

function grantClause(g: ScopeGrant): Prisma.UserWhereInput {
  const clause: Prisma.UserWhereInput = {};
  if (g.departmentCode !== null) clause.departmentCode = g.departmentCode;
  if (g.batchYear !== null) clause.batchYear = g.batchYear;
  return clause;
}

/**
 * The User filter of every admin student query:
 *   { AND: [{ role: "STUDENT" }, <scope>, extra ?? {}] }
 * where <scope> is {} for ALL, an OR of the grants, or { id: { in: [] } }
 * (matches nothing) for an empty scope. Pass it whole — `where:
 * scopedStudentWhere(scope, {...})` or `user: scopedStudentWhere(scope)` —
 * never spread it, so no later key can override the scope.
 */
export function scopedStudentWhere(scope: StudentScope, extra?: Prisma.UserWhereInput): Prisma.UserWhereInput {
  let clause: Prisma.UserWhereInput;
  if (scope.kind === "ALL") clause = {};
  else if (scope.grants.length === 0) clause = { id: { in: [] } };
  else clause = { OR: scope.grants.map(grantClause) };
  return { AND: [{ role: "STUDENT" }, clause, extra ?? {}] };
}

const ALIAS = /^[a-z_][a-z0-9_]*$/;

/**
 * The same filter for raw SQL against a joined `"User" <alias>`:
 *   ("u"."role" = 'STUDENT'::"Role" AND (<grants>))
 * Grant values are bound parameters; an empty scope is FALSE. Interpolate it
 * whole: ${scopedStudentSql(scope, "u")}.
 */
export function scopedStudentSql(scope: StudentScope, alias = "u"): Prisma.Sql {
  if (!ALIAS.test(alias)) throw new Error(`scopedStudentSql: invalid table alias ${JSON.stringify(alias)}`);
  const col = (name: string) => Prisma.raw(`"${alias}"."${name}"`);
  let grants: Prisma.Sql;
  if (scope.kind === "ALL") {
    grants = Prisma.sql`TRUE`;
  } else if (scope.grants.length === 0) {
    grants = Prisma.sql`FALSE`;
  } else {
    grants = Prisma.join(
      scope.grants.map((g) => {
        const parts: Prisma.Sql[] = [];
        if (g.departmentCode !== null) parts.push(Prisma.sql`${col("departmentCode")} = ${g.departmentCode}`);
        if (g.batchYear !== null) parts.push(Prisma.sql`${col("batchYear")} = ${g.batchYear}::int`);
        return Prisma.sql`(${Prisma.join(parts, " AND ")})`;
      }),
      " OR ",
    );
  }
  return Prisma.sql`(${col("role")} = 'STUDENT'::"Role" AND (${grants}))`;
}

/**
 * Staff-only User filter, for names of grantors, authors and deciders:
 *   { AND: [{ role: { not: "STUDENT" } }, extra] }
 * It can never return a student, so it needs no scope.
 */
export function staffOnlyWhere(extra: Prisma.UserWhereInput): Prisma.UserWhereInput {
  return { AND: [{ role: { not: "STUDENT" } }, extra] };
}

/**
 * Does the scope cover a cohort? A grant covers it when each of its non-null
 * dimensions equals the cohort's; a null in the COHORT means "every value"
 * (e.g. an announcement to every batch), which only a grant that is null in
 * that dimension covers.
 */
export function scopeCovers(
  scope: StudentScope,
  cohort: { departmentCode: string | null; batchYear: number | null },
): boolean {
  if (scope.kind === "ALL") return true;
  return scope.grants.some(
    (g) =>
      (g.departmentCode === null || (cohort.departmentCode !== null && g.departmentCode === cohort.departmentCode)) &&
      (g.batchYear === null || (cohort.batchYear !== null && g.batchYear === cohort.batchYear)),
  );
}

export function isEmptyScope(scope: StudentScope): boolean {
  return scope.kind === "GRANTS" && scope.grants.length === 0;
}

function describeGrant(g: ScopeGrant): string {
  if (g.departmentCode !== null && g.batchYear !== null) return `${g.departmentCode} ${g.batchYear}`;
  if (g.departmentCode !== null) return `${g.departmentCode} · all batches`;
  return `Batch ${g.batchYear} · all departments`;
}

/** "Whole college", "CSE · all batches; ECE 2027", "No student access". */
export function describeScope(scope: StudentScope): string {
  if (scope.kind === "ALL") return "Whole college";
  if (scope.grants.length === 0) return "No student access";
  return scope.grants.map(describeGrant).join("; ");
}
