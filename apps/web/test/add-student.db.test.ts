import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Adding one student by hand (`admin-roster#addStudent`, Phase 11a),
 * against the real tables.
 *
 * The thing worth testing is not that a row appears — it is that this
 * entry point cannot do anything the roster import would refuse. It shares
 * the import's schema, planner and apply step precisely so that the
 * answers to "is this roll number free", "is this cohort mine" and "what
 * does a created account look like" have exactly one implementation; these
 * tests are what says so.
 *
 * Opt-in: RECX_DB_TESTS=1.
 */
const ENABLED = process.env.RECX_DB_TESTS === "1";

vi.hoisted(() => {
  if (process.env.RECX_DB_TESTS === "1") {
    process.env.DATABASE_URL =
      process.env.RECX_TEST_DATABASE_URL ?? "postgresql://recx:recx-dev-only@127.0.0.1:5433/recx_test";
    process.env.IP_HASH_PEPPER ??= "add-student-test-pepper";
  }
});

vi.mock("next/headers", () => ({
  headers: async () => new Headers(),
  cookies: async () => ({ get: () => undefined, set: () => undefined, delete: () => undefined }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined, revalidateTag: () => undefined }));
/**
 * `next/navigation` is NOT mocked. The action ends in `redirect()`, which
 * throws the control-flow error `runAction` is careful to rethrow
 * (`isNextControlFlow`, lib/errors.ts) — and a stand-in that throws a plain
 * Error instead would be caught and masked as "something went wrong", which
 * is exactly what happened the first time this file was written. The real
 * thing carries the destination in its `digest`, so the test reads it from
 * there.
 */

const tag = `add-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
const DEPT = "CSE";
const BATCH = 2029;

/** The acting admin, whose scope the planner reads. */
let actorId = "";

vi.mock("@/lib/auth/scope", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/scope")>();
  return {
    ...actual,
    requireAdminScopeAction: async () => ({
      user: { id: actorId, role: "ADMIN" as const },
      scope: scopeFor(),
    }),
  };
});

/** Rebuilt per test so a case can narrow or widen what the admin covers. */
let scopeFor: () => unknown;

describe.skipIf(!ENABLED)("adding one student against recx_test", () => {
  let db: (typeof import("@/lib/db"))["db"];
  let addStudent: (typeof import("@/server/actions/admin-roster"))["addStudent"];
  let scopeWhere: typeof import("@/lib/auth/scope-where");
  const userIds: string[] = [];

  function form(fields: Record<string, string>): FormData {
    const data = new FormData();
    for (const [key, value] of Object.entries(fields)) data.set(key, value);
    return data;
  }

  const row = (suffix: string, extra: Record<string, string> = {}) => ({
    lmsUserId: `${tag}-${suffix}`,
    collegeId: `${tag.replace(/-/g, "")}${suffix}`.toUpperCase().slice(0, 32),
    email: `${tag}-${suffix}@rajalakshmi.edu.invalid`,
    firstName: "Added",
    lastName: suffix,
    batchYear: String(BATCH),
    departmentCode: DEPT,
    section: "A",
    ...extra,
  });

  /** The action's success path throws Next's redirect; unwrap it to the id it redirected to. */
  async function add(fields: Record<string, string>): Promise<{ ok: true; userId: string } | { ok: false; error: string }> {
    try {
      const result = await addStudent(null, form(fields));
      return result.ok ? { ok: true, userId: result.data.userId } : { ok: false, error: result.error };
    } catch (error) {
      // NEXT_REDIRECT;<kind>;<url>;<status>;
      const digest = typeof (error as { digest?: unknown }).digest === "string" ? (error as { digest: string }).digest : "";
      const match = /;\/admin\/students\/([^;]+);/.exec(digest);
      if (match) {
        userIds.push(match[1]!);
        return { ok: true, userId: match[1]! };
      }
      throw error;
    }
  }

  beforeAll(async () => {
    ({ db } = await import("@/lib/db"));
    scopeWhere = await import("@/lib/auth/scope-where");
    scopeFor = () =>
      scopeWhere.buildStudentScope({ id: actorId, role: "ADMIN" }, [{ departmentCode: DEPT, batchYear: BATCH }]);
    const actor = await db.user.create({
      data: {
        collegeId: `${tag}-ADMIN`.toUpperCase().slice(0, 32),
        email: `${tag}-admin@rajalakshmi.edu.invalid`,
        firstName: "Scope",
        lastName: "Admin",
        handle: `${tag}-admin`.slice(0, 30),
        role: "ADMIN",
        status: "ACTIVE",
      },
      select: { id: true },
    });
    actorId = actor.id;
    userIds.push(actor.id);
    ({ addStudent } = await import("@/server/actions/admin-roster"));
  }, 120_000);

  afterAll(async () => {
    if (!ENABLED || userIds.length === 0) return;
    await db.auditLog.deleteMany({ where: { targetUserId: { in: userIds } } });
    await db.auditLog.deleteMany({ where: { actorId: { in: userIds } } });
    await db.user.deleteMany({ where: { id: { in: userIds } } });
  }, 60_000);

  it("creates the student the roster import would have created: no password, STUDENT, ACTIVE, a handle", async () => {
    const fields = row("one");
    const result = await add(fields);
    expect(result.ok, "ok" in result && !result.ok ? result.error : "").toBe(true);

    const created = await db.user.findUniqueOrThrow({
      where: { collegeId: fields.collegeId },
      select: {
        role: true,
        status: true,
        passwordHash: true,
        handle: true,
        batchYear: true,
        departmentCode: true,
        section: true,
        lmsUserId: true,
        email: true,
      },
    });
    expect(created.role).toBe("STUDENT");
    expect(created.status).toBe("ACTIVE");
    // The whole reason the one-time link exists: nobody chooses a password
    // for somebody else, here or in an import.
    expect(created.passwordHash).toBeNull();
    expect(created.handle.length).toBeGreaterThan(0);
    expect(created.handle).not.toContain(fields.collegeId);
    expect(created.batchYear).toBe(BATCH);
    expect(created.departmentCode).toBe(DEPT);
    expect(created.section).toBe("A");
    expect(created.lmsUserId).toBe(fields.lmsUserId);
    expect(created.email).toBe(fields.email.toLowerCase());
  }, 60_000);

  it("records who added them, with the roll number and the scope", async () => {
    const fields = row("audited");
    expect((await add(fields)).ok).toBe(true);
    const student = await db.user.findUniqueOrThrow({ where: { collegeId: fields.collegeId }, select: { id: true } });
    const entry = await db.auditLog.findFirstOrThrow({
      where: { targetUserId: student.id, action: "student.added" },
      select: { actorId: true, sensitivity: true, metadata: true },
    });
    expect(entry.actorId).toBe(actorId);
    expect(entry.sensitivity).toBe("SENSITIVE");
    expect(JSON.stringify(entry.metadata)).toContain(fields.collegeId);
  }, 60_000);

  it("refuses a roll number, email or LMS id that already belongs to somebody", async () => {
    const first = row("dupe");
    expect((await add(first)).ok).toBe(true);

    for (const [field, value] of [
      ["collegeId", first.collegeId],
      ["email", first.email],
      ["lmsUserId", first.lmsUserId],
    ] as const) {
      const again = await add({ ...row(`dupe-${field}`.slice(0, 8)), [field]: value });
      expect(again.ok, `a second account was created for the same ${field}`).toBe(false);
      /**
       * The words differ by collision: all three keys pointing at one
       * account is an UPDATE this entry point refuses, while a mixture is
       * the planner's own "keys point at different accounts" rejection.
       * What matters to a student is the same either way — one person, one
       * account — so that is what is asserted.
       */
      if (!again.ok) expect(again.error.length).toBeGreaterThan(10);
      expect(await db.user.count({ where: { [field]: value } as never }), `${field} now names two accounts`).toBe(1);
    }
  }, 120_000);

  it("refuses a cohort outside the admin's scope, without saying anything about it", async () => {
    const outside = await add(row("outside", { departmentCode: "ECE" }));
    expect(outside.ok).toBe(false);
    if (!outside.ok) {
      // The planner's OUTSIDE_SCOPE message, which names no account and no cohort.
      expect(outside.error).not.toContain("ECE");
    }
    expect(await db.user.findUnique({ where: { lmsUserId: `${tag}-outside` } })).toBeNull();
  }, 60_000);

  it("refuses what the roster schema refuses, field by field", async () => {
    const cases: Array<[string, Record<string, string>]> = [
      ["a roll number with punctuation", { collegeId: "211-62310" }],
      ["an email that is not one", { email: "not-an-email" }],
      ["a batch year outside 2000–2100", { batchYear: "1899" }],
      ["a department code with digits", { departmentCode: "CS3" }],
      ["a section that is too long", { section: "TOOLONG" }],
      ["no first name", { firstName: "" }],
      ["no LMS user id", { lmsUserId: "" }],
    ];
    for (const [what, override] of cases) {
      const result = await add(row("bad", override));
      expect(result.ok, `accepted ${what}`).toBe(false);
    }
  }, 120_000);
});
