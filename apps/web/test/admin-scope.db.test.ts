import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * AdminScope against a real Postgres (recx_test): an ADMIN granted one
 * department sees only that department's students in the student list, the
 * cohorts and the reports; another department's student is "not found"; an
 * ADMIN without a grant, or with a revoked one, sees nothing; a SUPER_ADMIN
 * sees every student and never a staff account; a duplicate active grant is
 * refused by the partial unique index. Department codes are unique to the
 * run, so other data in the database cannot leak into the assertions.
 *
 * Opt-in: RECX_DB_TESTS=1 (RECX_TEST_DATABASE_URL overrides the URL).
 */
const ENABLED = process.env.RECX_DB_TESTS === "1";

vi.hoisted(() => {
  if (process.env.RECX_DB_TESTS === "1") {
    process.env.DATABASE_URL =
      process.env.RECX_TEST_DATABASE_URL ?? "postgresql://recx:recx-dev-only@localhost:5433/recx_test";
  }
});

vi.mock("@/lib/auth/session", () => ({ getCurrentUser: async () => null, destroyAllSessions: async () => undefined }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined, revalidateTag: () => undefined }));

type M = {
  db: (typeof import("@/lib/db"))["db"];
  scope: typeof import("@/lib/auth/scope");
  students: typeof import("@/server/queries/admin-students");
  cohorts: typeof import("@/server/queries/admin-cohorts");
  reports: typeof import("@/server/queries/admin-reports");
  support: typeof import("./support/admin-db");
};

const letters = (n: number) =>
  Array.from(randomBytes(n), (b) => String.fromCharCode(65 + (b % 26))).join("");

describe.skipIf(!ENABLED)("AdminScope against recx_test", () => {
  const tag = `as${Date.now().toString(36)}${randomBytes(2).toString("hex")}`;
  const deptA = `Q${letters(5)}`;
  const deptB = `X${letters(5)}`;
  let m: M;
  let u: Record<"sup" | "adminA" | "adminNone" | "adminRevoked" | "ta" | "a27" | "a26" | "b27", import("./support/admin-db").TestUser>;

  beforeAll(async () => {
    m = {
      db: (await import("@/lib/db")).db,
      scope: await import("@/lib/auth/scope"),
      students: await import("@/server/queries/admin-students"),
      cohorts: await import("@/server/queries/admin-cohorts"),
      reports: await import("@/server/queries/admin-reports"),
      support: await import("./support/admin-db"),
    };
    u = await m.support.createUsers(m.db, tag, {
      sup: { role: "SUPER_ADMIN" },
      adminA: { role: "ADMIN" },
      adminNone: { role: "ADMIN" },
      adminRevoked: { role: "ADMIN" },
      ta: { role: "TA_MENTOR", batchYear: 2027, departmentCode: deptA, section: "A" },
      a27: { batchYear: 2027, departmentCode: deptA, section: "A", lastActiveAt: new Date() },
      a26: { batchYear: 2026, departmentCode: deptA, section: "B" },
      b27: { batchYear: 2027, departmentCode: deptB, section: "A" },
    });
    await m.support.grantScope(m.db, u.adminA.id, u.sup.id, { departmentCode: deptA, batchYear: null });
    const revoked = await m.support.grantScope(m.db, u.adminRevoked.id, u.sup.id, { departmentCode: deptA, batchYear: null });
    await m.db.adminScope.update({ where: { id: revoked }, data: { revokedAt: new Date(), revokedById: u.sup.id } });
  }, 60_000);

  afterAll(async () => {
    if (!m) return;
    try {
      await m.support.cleanupAdminRows(m.db, Object.values(u ?? {}).map((x) => x.id));
      expect(await m.support.disabledTriggers(m.db)).toEqual([]);
    } finally {
      await m.db.$disconnect();
    }
  }, 60_000);

  const scopeOf = (key: keyof typeof u) => m.scope.loadStudentScope(u[key]);

  it("an ADMIN granted one department lists only its students — never staff, never another department", async () => {
    const scope = await scopeOf("adminA");
    expect(scope).toMatchObject({ kind: "GRANTS", grants: [{ departmentCode: deptA, batchYear: null }] });
    const list = await m.students.listStudents(scope, {});
    expect(list.rows.map((r) => r.id).sort()).toEqual([u.a26.id, u.a27.id].sort());
    expect(list.total).toBe(2);
  });

  it("cohorts and reports stay inside the scope", async () => {
    const scope = await scopeOf("adminA");
    const cohorts = await m.cohorts.listCohorts(scope);
    expect(cohorts.map((c) => `${c.batchYear}.${c.departmentCode}.${c.section}:${c.total}`).sort()).toEqual(
      [`2026.${deptA}.B:1`, `2027.${deptA}.A:1`].sort(),
    );
    expect(cohorts.find((c) => c.batchYear === 2027)?.activeLast7Days).toBe(1);

    const report = await m.reports.getCohortReport(scope, { weeks: 8 });
    expect(report.summary.map((r) => r.departmentCode)).toEqual([deptA, deptA]);
    expect(report.summary.reduce((n, r) => n + r.students, 0)).toBe(2);
    expect(report.weeks).toHaveLength(8);

    // A cohort outside the scope is ignored, not shown.
    const outside = await m.reports.getCohortReport(scope, { cohort: { batchYear: 2027, departmentCode: deptB, section: "A" } });
    expect(outside.cohort).toBeNull();
    expect(outside.summary.every((r) => r.departmentCode === deptA)).toBe(true);
    const inside = await m.reports.getCohortReport(scope, { cohort: { batchYear: 2027, departmentCode: deptA, section: "A" } });
    expect(inside.summary).toHaveLength(1);
    expect(inside.summary[0]).toMatchObject({ students: 1, active7: 1, zeroSolve: 1 });
  });

  it("a student outside the scope is not found, exactly like a missing id", async () => {
    const scope = await scopeOf("adminA");
    await expect(m.scope.requireScopedStudent(scope, u.b27.id)).rejects.toThrow("That student was not found.");
    await expect(m.scope.requireScopedStudent(scope, "no-such-id")).rejects.toThrow("That student was not found.");
    await expect(m.scope.requireScopedStudent(scope, u.ta.id)).rejects.toThrow("That student was not found.");
    const found = await m.scope.requireScopedStudent(scope, u.a27.id);
    expect(found.scopedId).toBe(u.a27.id);
  });

  it("an ADMIN without a grant, or with only a revoked one, sees no student", async () => {
    for (const key of ["adminNone", "adminRevoked"] as const) {
      const scope = await scopeOf(key);
      expect(m.scope.isEmptyScope(scope)).toBe(true);
      expect((await m.students.listStudents(scope, {})).total).toBe(0);
      expect(await m.cohorts.listCohorts(scope)).toEqual([]);
      await expect(m.scope.requireScopedStudent(scope, u.a27.id)).rejects.toThrow("That student was not found.");
      expect(await m.scope.listScopedStudentIds(m.db, scope)).toEqual([]);
    }
  });

  it("a SUPER_ADMIN sees every student and never a staff account", async () => {
    const scope = await scopeOf("sup");
    expect(scope.kind).toBe("ALL");
    for (const key of ["a27", "a26", "b27"] as const) {
      expect((await m.scope.requireScopedStudent(scope, u[key].id)).scopedId).toBe(u[key].id);
    }
    await expect(m.scope.requireScopedStudent(scope, u.ta.id)).rejects.toThrow("That student was not found.");
    await expect(m.scope.requireScopedStudent(scope, u.adminA.id)).rejects.toThrow("That student was not found.");
    const b = await m.students.listStudents(scope, { dept: deptB });
    expect(b.rows.map((r) => r.id)).toEqual([u.b27.id]);
    const a = await m.scope.listScopedStudentIds(m.db, scope, { departmentCode: deptA });
    expect([...a].sort()).toEqual([u.a26.id, u.a27.id].sort());
  });

  it("the database refuses a second identical active grant", async () => {
    await expect(m.support.grantScope(m.db, u.adminA.id, u.sup.id, { departmentCode: deptA, batchYear: null })).rejects.toMatchObject({
      code: "P2002",
    });
  });
});
