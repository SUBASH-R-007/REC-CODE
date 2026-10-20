import { describe, expect, it } from "vitest";
import type { RosterRow } from "@recx/shared";
import { buildStudentScope } from "@/lib/auth/scope-where";
import type { ValidatedRosterLine } from "@/lib/admin/roster-csv";
import {
  planRosterImport,
  proposeHandle,
  rosterPlanSha256,
  type ExistingUser,
  type RosterOutcome,
} from "@/lib/admin/roster-plan";

/** The roster dry run: every outcome, the scope rules, the hash and handle proposals. */

const cse = buildStudentScope({ id: "adm", role: "ADMIN" }, [{ departmentCode: "CSE", batchYear: null }]);
const all = buildStudentScope({ id: "sup", role: "SUPER_ADMIN" }, []);
const nothing = buildStudentScope({ id: "adm", role: "ADMIN" }, []);
const T0 = new Date("2026-10-01T10:00:00.000Z");

function r(fields: Partial<RosterRow> = {}): RosterRow {
  return {
    lmsUserId: "lms-1",
    collegeId: "2116231001001",
    email: "priya@example.edu",
    firstName: "Priya",
    lastName: "Sharma",
    batchYear: 2027,
    departmentCode: "CSE",
    section: "A",
    ...fields,
  };
}

function u(fields: Partial<ExistingUser> = {}, detail: ExistingUser["detail"] | null = { firstName: "Priya", lastName: "Sharma", section: "A" }): ExistingUser {
  const base: ExistingUser = {
    id: "u1",
    role: "STUDENT",
    status: "ACTIVE",
    lmsUserId: "lms-1",
    collegeId: "2116231001001",
    email: "priya@example.edu",
    batchYear: 2027,
    departmentCode: "CSE",
    updatedAt: T0,
    ...fields,
  };
  return detail ? { ...base, detail } : base;
}

const line = (n: number, row: RosterRow): ValidatedRosterLine => ({ line: n, row, error: null });
const outcome = (lines: ValidatedRosterLine[], matches: ExistingUser[], scope = cse): RosterOutcome[] =>
  planRosterImport(lines, matches, scope).lines.map((l) => l.outcome);

describe("planRosterImport", () => {
  it("CREATE a new LMS identity inside the scope", () => {
    expect(outcome([line(2, r())], [])).toEqual([{ kind: "CREATE", row: r() }]);
  });

  it("refuses a CREATE into a cohort outside the scope", () => {
    expect(outcome([line(2, r({ departmentCode: "ECE" }))], [])).toMatchObject([{ kind: "REJECTED", reason: "OUTSIDE_SCOPE" }]);
    expect(outcome([line(2, r())], [], nothing)).toMatchObject([{ kind: "REJECTED", reason: "OUTSIDE_SCOPE" }]);
  });

  it("UPDATE lists exactly the changed fields", () => {
    const [o] = outcome([line(2, r({ email: "PRIYA@example.edu", lastName: "S", section: "B" }))], [u()]);
    expect(o).toMatchObject({
      kind: "UPDATE",
      userId: "u1",
      link: false,
      changes: [
        { field: "lastName", from: "Sharma", to: "S" },
        { field: "section", from: "A", to: "B" },
      ],
    });
  });

  it("LINK: a student matched by roll number gets the LMS id", () => {
    const [o] = outcome([line(2, r())], [u({ lmsUserId: null })]);
    expect(o).toMatchObject({ kind: "UPDATE", link: true, changes: [] });
  });

  it("UNCHANGED when nothing differs", () => {
    expect(outcome([line(2, r())], [u()])).toEqual([{ kind: "UNCHANGED", userId: "u1", updatedAt: T0.toISOString() }]);
  });

  it("SKIPPED for an account that is not active, never reactivated", () => {
    for (const status of ["DISABLED", "GRADUATED", "ARCHIVED"] as const) {
      expect(outcome([line(2, r({ lastName: "New" }))], [u({ status })])).toMatchObject([
        { kind: "SKIPPED", reason: "ACCOUNT_NOT_ACTIVE" },
      ]);
    }
    expect(outcome([line(2, r({ lastName: "New" }))], [u({ status: "SOFT_RESTRICTED" })])).toMatchObject([{ kind: "UPDATE" }]);
  });

  it("REJECTED for invalid rows and missing LMS ids (carried from validation)", () => {
    const lines: ValidatedRosterLine[] = [
      { line: 2, row: null, error: { reason: "MISSING_LMS_ID", message: "The LMS user id is missing." } },
      { line: 3, row: null, error: { reason: "INVALID_ROW", message: "The email address is not valid." } },
    ];
    expect(outcome(lines, [])).toEqual([
      { kind: "REJECTED", reason: "MISSING_LMS_ID", message: "The LMS user id is missing." },
      { kind: "REJECTED", reason: "INVALID_ROW", message: "The email address is not valid." },
    ]);
  });

  it("REJECTED for every line sharing a key inside the file", () => {
    const lines = [
      line(2, r()),
      line(3, r({ lmsUserId: "lms-2", collegeId: "2116231001002", email: "PRIYA@example.edu" })),
      line(4, r({ lmsUserId: "lms-3", collegeId: "2116231001003", email: "c@example.edu" })),
    ];
    expect(outcome(lines, []).map((o) => (o.kind === "REJECTED" ? o.reason : o.kind))).toEqual([
      "DUPLICATE_IN_FILE",
      "DUPLICATE_IN_FILE",
      "CREATE",
    ]);
  });

  it("KEY_CONFLICT when the keys point at different accounts, or the LMS id differs", () => {
    const other = u({ id: "u2", lmsUserId: "lms-9", collegeId: "2116231001009", email: "x@example.edu" });
    expect(outcome([line(2, r({ email: "x@example.edu" }))], [u(), other])).toMatchObject([{ reason: "KEY_CONFLICT" }]);
    expect(outcome([line(2, r({ lmsUserId: "lms-7" }))], [u()])).toMatchObject([{ reason: "KEY_CONFLICT" }]);
    // Same email, different roll number, no LMS id on file.
    expect(outcome([line(2, r({ collegeId: "2116231001005" }))], [u({ lmsUserId: null })])).toMatchObject([
      { reason: "KEY_CONFLICT" },
    ]);
  });

  it("ROLL_NUMBER_CHANGED when the LMS id is known under another roll number", () => {
    expect(outcome([line(2, r({ collegeId: "2116231009999", email: "new@example.edu" }))], [u()])).toMatchObject([
      { reason: "ROLL_NUMBER_CHANGED" },
    ]);
  });

  it("STAFF_ACCOUNT is never touched", () => {
    expect(outcome([line(2, r())], [u({ role: "ADMIN" }, null)], all)).toMatchObject([{ reason: "STAFF_ACCOUNT" }]);
  });

  it("OUTSIDE_SCOPE when the student or their new cohort is outside the scope", () => {
    // The student is in ECE now (no detail: the scoped detail lookup did not return them).
    expect(outcome([line(2, r())], [u({ departmentCode: "ECE" }, null)])).toMatchObject([{ reason: "OUTSIDE_SCOPE" }]);
    // In scope now, but the row moves them to ECE.
    expect(outcome([line(2, r({ departmentCode: "ECE" }))], [u()])).toMatchObject([{ reason: "OUTSIDE_SCOPE" }]);
    // Out-of-scope disabled accounts do not reveal their status.
    expect(outcome([line(2, r())], [u({ departmentCode: "ECE", status: "DISABLED" }, null)])).toMatchObject([
      { reason: "OUTSIDE_SCOPE" },
    ]);
  });

  it("counts every outcome", () => {
    const plan = planRosterImport(
      [
        line(2, r({ lmsUserId: "n1", collegeId: "2116231001101", email: "n1@example.edu" })),
        line(3, r({ lastName: "Changed" })),
        line(4, r({ lmsUserId: "lms-4", collegeId: "2116231001004", email: "d@example.edu" })),
        { line: 5, row: null, error: { reason: "INVALID_ROW", message: "x" } },
      ],
      [u(), u({ id: "u4", lmsUserId: null, collegeId: "2116231001004", email: "d@example.edu" })],
      cse,
    );
    expect(plan.counts).toEqual({ create: 1, update: 1, link: 1, unchanged: 0, skipped: 0, rejected: 1 });
  });
});

describe("rosterPlanSha256", () => {
  const lines = [line(3, r({ lastName: "Changed" })), line(2, r({ lmsUserId: "n1", collegeId: "2116231001101", email: "n@example.edu" }))];

  it("is deterministic and independent of the input order", () => {
    const a = rosterPlanSha256(planRosterImport(lines, [u()], cse));
    const b = rosterPlanSha256(planRosterImport([...lines].reverse(), [u()], cse));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).toBe(b);
  });

  it("changes when a matched account changed since the preview (updatedAt)", () => {
    const before = rosterPlanSha256(planRosterImport(lines, [u()], cse));
    const after = rosterPlanSha256(planRosterImport(lines, [u({ updatedAt: new Date(T0.getTime() + 1) })], cse));
    expect(after).not.toBe(before);
  });

  it("changes when the outcome changes (e.g. the scope)", () => {
    expect(rosterPlanSha256(planRosterImport(lines, [u()], cse))).not.toBe(rosterPlanSha256(planRosterImport(lines, [u()], nothing)));
  });
});

describe("proposeHandle", () => {
  it("builds the handle from the name, never the roll number", () => {
    expect(proposeHandle("Priya", "Sharma", new Set())).toBe("priya-s");
    expect(proposeHandle("Priya", "Sharma", new Set(["priya-s"]))).toBe("priya-s-2");
    expect(proposeHandle("Priya", "Sharma", new Set(["PRIYA-S", "priya-s-2"]))).toBe("priya-s-3");
  });

  it("copes with accents, spaces, an empty last name and a name with no letters", () => {
    expect(proposeHandle("Élodie Anne", "Rāman", new Set())).toBe("elodie-anne-r");
    expect(proposeHandle("Arjun", "", new Set())).toBe("arjun");
    expect(proposeHandle("!!!", "", new Set())).toBe("student");
  });
});
