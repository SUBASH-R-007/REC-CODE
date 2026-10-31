import { describe, expect, it } from "vitest";
import { ForbiddenError } from "@/lib/errors";
import {
  buildStudentScope,
  describeScope,
  isEmptyScope,
  scopeCovers,
  scopedStudentSql,
  scopedStudentWhere,
  staffOnlyWhere,
} from "@/lib/auth/scope-where";

/**
 * AdminScope, the pure half (lib/auth/scope-where.ts): how a scope is built
 * from an actor's grants, and the Prisma / SQL filters every admin student
 * query is shaped with. Fail closed: no grants = no students.
 */

const admin = { id: "adm", role: "ADMIN" as const };
const superAdmin = { id: "sup", role: "SUPER_ADMIN" as const };

describe("buildStudentScope", () => {
  it("SUPER_ADMIN is never scoped", () => {
    const scope = buildStudentScope(superAdmin, [{ departmentCode: "CSE", batchYear: 2027 }]);
    expect(scope.kind).toBe("ALL");
    expect(scope.actorId).toBe("sup");
  });

  it("an ADMIN gets its grants, de-duplicated and sorted", () => {
    const scope = buildStudentScope(admin, [
      { departmentCode: "ECE", batchYear: 2027 },
      { departmentCode: "CSE", batchYear: null },
      { departmentCode: "ECE", batchYear: 2027 },
    ]);
    expect(scope).toMatchObject({
      kind: "GRANTS",
      grants: [
        { departmentCode: "CSE", batchYear: null },
        { departmentCode: "ECE", batchYear: 2027 },
      ],
    });
  });

  it("a grant with both dimensions null is the whole college", () => {
    expect(buildStudentScope(admin, [{ departmentCode: "CSE", batchYear: null }, { departmentCode: null, batchYear: null }]).kind).toBe(
      "ALL",
    );
  });

  it("an ADMIN with no grant sees nothing (fail closed)", () => {
    const scope = buildStudentScope(admin, []);
    expect(scope).toMatchObject({ kind: "GRANTS", grants: [] });
    expect(isEmptyScope(scope)).toBe(true);
  });

  it("any other role is refused", () => {
    for (const role of ["STUDENT", "TA_MENTOR", "PLACEMENT_OFFICER"] as const) {
      expect(() => buildStudentScope({ id: "x", role }, [])).toThrow(ForbiddenError);
    }
  });

  it("treats a blank department as no department", () => {
    expect(buildStudentScope(admin, [{ departmentCode: "  ", batchYear: 2026 }])).toMatchObject({
      kind: "GRANTS",
      grants: [{ departmentCode: null, batchYear: 2026 }],
    });
  });
});

describe("scopedStudentWhere", () => {
  it("ALL still requires role STUDENT and ANDs the extra filter", () => {
    expect(scopedStudentWhere(buildStudentScope(superAdmin, []), { batchYear: 2027 })).toEqual({
      AND: [{ role: "STUDENT" }, {}, { batchYear: 2027 }],
    });
  });

  it("an empty scope matches nothing", () => {
    expect(scopedStudentWhere(buildStudentScope(admin, []))).toEqual({
      AND: [{ role: "STUDENT" }, { id: { in: [] } }, {}],
    });
  });

  it("department-only, batch-only and both", () => {
    const scope = buildStudentScope(admin, [
      { departmentCode: "CSE", batchYear: null },
      { departmentCode: null, batchYear: 2026 },
      { departmentCode: "ECE", batchYear: 2027 },
    ]);
    expect(scopedStudentWhere(scope, { status: "ACTIVE" })).toEqual({
      AND: [
        { role: "STUDENT" },
        { OR: [{ batchYear: 2026 }, { departmentCode: "CSE" }, { departmentCode: "ECE", batchYear: 2027 }] },
        { status: "ACTIVE" },
      ],
    });
  });

  it("puts the extra filter in its own AND branch, so it cannot widen the scope", () => {
    const scope = buildStudentScope(admin, [{ departmentCode: "CSE", batchYear: null }]);
    const where = scopedStudentWhere(scope, { OR: [{ departmentCode: "ECE" }], role: "ADMIN" });
    expect(where.AND).toHaveLength(3);
    expect((where.AND as unknown[])[0]).toEqual({ role: "STUDENT" });
    expect((where.AND as unknown[])[1]).toEqual({ OR: [{ departmentCode: "CSE" }] });
  });
});

describe("scopedStudentSql", () => {
  it("binds grant values as parameters", () => {
    const sql = scopedStudentSql(buildStudentScope(admin, [{ departmentCode: "CSE", batchYear: 2027 }]), "u");
    expect(sql.sql).toBe(`("u"."role" = 'STUDENT'::"Role" AND (("u"."departmentCode" = ? AND "u"."batchYear" = ?::int)))`);
    expect(sql.values).toEqual(["CSE", 2027]);
  });

  it("ORs several grants", () => {
    const sql = scopedStudentSql(
      buildStudentScope(admin, [
        { departmentCode: "CSE", batchYear: null },
        { departmentCode: null, batchYear: 2026 },
      ]),
      "x",
    );
    expect(sql.sql).toBe(`("x"."role" = 'STUDENT'::"Role" AND (("x"."batchYear" = ?::int) OR ("x"."departmentCode" = ?)))`);
    expect(sql.values).toEqual([2026, "CSE"]);
  });

  it("ALL is TRUE and an empty scope is FALSE", () => {
    expect(scopedStudentSql(buildStudentScope(superAdmin, [])).sql).toBe(`("u"."role" = 'STUDENT'::"Role" AND (TRUE))`);
    expect(scopedStudentSql(buildStudentScope(admin, [])).sql).toBe(`("u"."role" = 'STUDENT'::"Role" AND (FALSE))`);
  });

  it("refuses an alias that is not a plain identifier", () => {
    const scope = buildStudentScope(superAdmin, []);
    for (const alias of ['u"; DROP TABLE x; --', "U", "1u", "u.v", ""]) {
      expect(() => scopedStudentSql(scope, alias)).toThrow(/invalid table alias/);
    }
  });
});

describe("staffOnlyWhere", () => {
  it("can never match a student", () => {
    expect(staffOnlyWhere({ id: { in: ["a"] } })).toEqual({ AND: [{ role: { not: "STUDENT" } }, { id: { in: ["a"] } }] });
  });
});

describe("scopeCovers", () => {
  const scope = buildStudentScope(admin, [
    { departmentCode: "CSE", batchYear: null },
    { departmentCode: "ECE", batchYear: 2027 },
  ]);

  it.each([
    [{ departmentCode: "CSE", batchYear: 2027 }, true],
    [{ departmentCode: "CSE", batchYear: null }, true],
    [{ departmentCode: "ECE", batchYear: 2027 }, true],
    [{ departmentCode: "ECE", batchYear: 2026 }, false],
    [{ departmentCode: "ECE", batchYear: null }, false],
    [{ departmentCode: null, batchYear: 2027 }, false],
    [{ departmentCode: null, batchYear: null }, false],
    [{ departmentCode: "MECH", batchYear: 2027 }, false],
  ])("%o → %s", (cohort, covered) => {
    expect(scopeCovers(scope, cohort)).toBe(covered);
  });

  it("the whole college covers everything; no grants cover nothing", () => {
    expect(scopeCovers(buildStudentScope(superAdmin, []), { departmentCode: null, batchYear: null })).toBe(true);
    expect(scopeCovers(buildStudentScope(admin, []), { departmentCode: "CSE", batchYear: 2027 })).toBe(false);
  });

  it("a batch-only grant covers every department of that batch", () => {
    const batch = buildStudentScope(admin, [{ departmentCode: null, batchYear: 2026 }]);
    expect(scopeCovers(batch, { departmentCode: null, batchYear: 2026 })).toBe(true);
    expect(scopeCovers(batch, { departmentCode: "CSE", batchYear: 2026 })).toBe(true);
    expect(scopeCovers(batch, { departmentCode: "CSE", batchYear: null })).toBe(false);
  });
});

describe("describeScope", () => {
  it("names the scope in words", () => {
    expect(describeScope(buildStudentScope(superAdmin, []))).toBe("Whole college");
    expect(describeScope(buildStudentScope(admin, []))).toBe("No student access");
    expect(
      describeScope(
        buildStudentScope(admin, [
          { departmentCode: "ECE", batchYear: 2027 },
          { departmentCode: "CSE", batchYear: null },
          { departmentCode: null, batchYear: 2026 },
        ]),
      ),
    ).toBe("Batch 2026 · all departments; CSE · all batches; ECE 2027");
  });
});
