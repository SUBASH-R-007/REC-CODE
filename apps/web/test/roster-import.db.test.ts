import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * The roster import against a real Postgres (recx_test): the preview is a
 * true dry run (no User row is created or touched); a student changed
 * between preview and commit makes the commit refuse; the commit applies
 * exactly the plan — new accounts are role STUDENT, status ACTIVE, with the
 * LMS id and NO password; a student matched by roll number gets the LMS id
 * linked; out-of-scope and id-less rows change nothing; the stored rows are
 * dropped; only open-period XpBucket rows follow a cohort move; an expired
 * or discarded preview cannot be committed.
 *
 * Opt-in: RECX_DB_TESTS=1 (RECX_TEST_DATABASE_URL overrides the URL).
 */
const ENABLED = process.env.RECX_DB_TESTS === "1";

const state = vi.hoisted(() => {
  if (process.env.RECX_DB_TESTS === "1") {
    process.env.DATABASE_URL =
      process.env.RECX_TEST_DATABASE_URL ?? "postgresql://recx:recx-dev-only@127.0.0.1:5433/recx_test";
  }
  return { user: null as unknown, redirect: "" as string, audits: [] as Array<Record<string, unknown>> };
});

vi.mock("@/lib/auth/session", () => ({ getCurrentUser: async () => state.user, destroyAllSessions: async () => undefined }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined, revalidateTag: () => undefined }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    state.redirect = url;
    throw new Error("NEXT_REDIRECT");
  },
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));
vi.mock("@/lib/rate-limit", () => ({ hitRateLimit: async () => ({ allowed: true, remaining: 9, retryAfterMs: 0 }) }));
vi.mock("@/lib/ip", () => ({ requestIpHash: async () => null }));
vi.mock("@/lib/audit", () => ({
  audit: async (entry: Record<string, unknown>) => {
    state.audits.push(entry);
  },
}));

type M = {
  db: (typeof import("@/lib/db"))["db"];
  actions: typeof import("@/server/actions/admin-roster");
  queries: typeof import("@/server/queries/admin-roster");
  scope: typeof import("@/lib/auth/scope");
  shared: typeof import("@recx/shared");
  support: typeof import("./support/admin-db");
};

const letters = (n: number) => Array.from(randomBytes(n), (b) => String.fromCharCode(65 + (b % 26))).join("");

describe.skipIf(!ENABLED)("roster import against recx_test", () => {
  const tag = `ri${Date.now().toString(36)}${randomBytes(2).toString("hex")}`;
  const deptA = `R${letters(5)}`;
  const deptB = `S${letters(5)}`;
  const newCollegeId = `${tag}N1`.toUpperCase();
  let m: M;
  let u: Record<"sup" | "admin" | "s1" | "s2" | "s3", import("./support/admin-db").TestUser>;
  const created: string[] = [];

  async function preview(rows: Record<string, string>[]): Promise<string> {
    const header = m.shared.ROSTER_COLUMNS.join(",");
    const text = [header, ...rows.map((r) => m.shared.ROSTER_COLUMNS.map((c) => r[c] ?? "").join(","))].join("\n");
    const form = new FormData();
    form.set("file", new File([text], `${tag}.csv`, { type: "text/csv" }));
    state.redirect = "";
    await expect(m.actions.previewRosterImport(null, form)).rejects.toThrow("NEXT_REDIRECT");
    const id = state.redirect.split("/").pop()!;
    expect(id).toMatch(/^c[a-z0-9]+$/);
    return id;
  }

  const csvRows = () => [
    // New identity in scope.
    { lmsUserId: `${tag}-n1`, collegeId: newCollegeId, email: `${tag}-n1@example.test`, firstName: "Nila", lastName: "Varma", batchYear: "2027", departmentCode: deptA, section: "A" },
    // s1: matched by roll number, no LMS id yet → link; last name and section change.
    { lmsUserId: `${tag}-s1`, collegeId: u.s1.collegeId, email: u.s1.email, firstName: "s1", lastName: "Renamed", batchYear: "2027", departmentCode: deptA, section: "B" },
    // s2: identical → unchanged.
    { lmsUserId: `${tag}-s2`, collegeId: u.s2.collegeId, email: u.s2.email, firstName: "s2", lastName: "Test", batchYear: "2027", departmentCode: deptA, section: "A" },
    // s3: another department → outside the scope.
    { lmsUserId: `${tag}-s3`, collegeId: u.s3.collegeId, email: u.s3.email, firstName: "s3", lastName: "Moved", batchYear: "2027", departmentCode: deptB, section: "A" },
    // No LMS id → refused.
    { lmsUserId: "", collegeId: `${tag}N2`.toUpperCase(), email: `${tag}-n2@example.test`, firstName: "No", lastName: "Id", batchYear: "2027", departmentCode: deptA, section: "A" },
  ];

  beforeAll(async () => {
    m = {
      db: (await import("@/lib/db")).db,
      actions: await import("@/server/actions/admin-roster"),
      queries: await import("@/server/queries/admin-roster"),
      scope: await import("@/lib/auth/scope"),
      shared: await import("@recx/shared"),
      support: await import("./support/admin-db"),
    };
    u = await m.support.createUsers(m.db, tag, {
      sup: { role: "SUPER_ADMIN" },
      admin: { role: "ADMIN" },
      s1: { batchYear: 2027, departmentCode: deptA, section: "A" },
      s2: { batchYear: 2027, departmentCode: deptA, section: "A" },
      s3: { batchYear: 2027, departmentCode: deptB, section: "A" },
    });
    await m.db.user.update({ where: { id: u.s2.id }, data: { lmsUserId: `${tag}-s2` } });
    await m.db.user.update({ where: { id: u.s3.id }, data: { lmsUserId: `${tag}-s3` } });
    await m.support.grantScope(m.db, u.admin.id, u.sup.id, { departmentCode: deptA, batchYear: null });
    const now = new Date();
    const bucket = (period: "ALL_TIME" | "MONTH" | "WEEK", periodKey: string) => ({
      userId: u.s1.id,
      period,
      periodKey,
      xp: 10,
      batchYear: 2027,
      departmentCode: deptA,
      section: "A",
      lastXpAt: now,
    });
    await m.db.xpBucket.createMany({
      data: [
        bucket("ALL_TIME", "all"),
        bucket("MONTH", m.shared.monthKey(now)),
        bucket("WEEK", m.shared.isoWeekKey(now)),
        bucket("WEEK", "2020-W01"),
      ],
    });
    state.user = await m.db.user.findUniqueOrThrow({ where: { id: u.admin.id } });
  }, 60_000);

  afterAll(async () => {
    if (!m) return;
    try {
      const imported = await m.db.user.findMany({ where: { collegeId: { startsWith: tag.toUpperCase() } }, select: { id: true } });
      created.push(...imported.map((x) => x.id));
      await m.support.cleanupAdminRows(m.db, Object.values(u ?? {}).map((x) => x.id), created);
      expect(await m.support.disabledTriggers(m.db)).toEqual([]);
    } finally {
      await m.db.$disconnect();
    }
  }, 60_000);

  const usersInDept = () => m.db.user.count({ where: { departmentCode: deptA } });

  let importId = "";

  it("the preview is a dry run: no User row is created or touched", async () => {
    const before = await usersInDept();
    const s1Before = await m.db.user.findUniqueOrThrow({ where: { id: u.s1.id } });
    importId = await preview(csvRows());
    expect(await usersInDept()).toBe(before);
    expect(await m.db.user.findUniqueOrThrow({ where: { id: u.s1.id } })).toEqual(s1Before);
    expect(await m.db.user.count({ where: { collegeId: newCollegeId } })).toBe(0);

    const row = await m.db.rosterImport.findUniqueOrThrow({ where: { id: importId } });
    expect(row.status).toBe("PREVIEWED");
    expect(row.rows).not.toBeNull();
    expect(row.counts).toEqual({ create: 1, update: 1, link: 1, unchanged: 1, skipped: 0, rejected: 2 });
    expect(state.audits.at(-1)).toMatchObject({ action: "roster.import.previewed", sensitivity: "NORMAL" });
  });

  it("a student changed after the preview makes the commit refuse, and nothing is written", async () => {
    const shown = await m.queries.getImportPreview(state.user as never, await m.scope.loadStudentScope(u.admin), importId);
    expect(shown?.kind).toBe("preview");
    const staleHash = shown!.kind === "preview" ? shown!.diffSha256 : "";
    await m.db.user.update({ where: { id: u.s1.id }, data: { firstName: "s1" } }); // same value, new updatedAt
    const result = await m.actions.commitRosterImport({ importId, diffSha256: staleHash });
    expect(result.ok || result.error).toMatch(/changed since your preview/);
    expect(await m.db.user.count({ where: { collegeId: newCollegeId } })).toBe(0);
    expect((await m.db.rosterImport.findUniqueOrThrow({ where: { id: importId } })).status).toBe("PREVIEWED");
  });

  it("the commit applies exactly the plan", async () => {
    const shown = await m.queries.getImportPreview(state.user as never, await m.scope.loadStudentScope(u.admin), importId);
    const hash = shown!.kind === "preview" ? shown!.diffSha256 : "";
    const result = await m.actions.commitRosterImport({ importId, diffSha256: hash });
    expect(result).toEqual({ ok: true, data: { importId } });

    const fresh = await m.db.user.findUniqueOrThrow({ where: { collegeId: newCollegeId } });
    created.push(fresh.id);
    expect(fresh).toMatchObject({
      role: "STUDENT",
      status: "ACTIVE",
      passwordHash: null,
      lmsUserId: `${tag}-n1`,
      email: `${tag}-n1@example.test`,
      departmentCode: deptA,
      batchYear: 2027,
      section: "A",
    });
    expect(fresh.handle).toMatch(/^nila-v(-\d+)?$/);

    const s1 = await m.db.user.findUniqueOrThrow({ where: { id: u.s1.id } });
    expect(s1).toMatchObject({ lmsUserId: `${tag}-s1`, lastName: "Renamed", section: "B", role: "STUDENT", status: "ACTIVE" });
    const s3 = await m.db.user.findUniqueOrThrow({ where: { id: u.s3.id } });
    expect(s3).toMatchObject({ lastName: "Test", departmentCode: deptB });
    expect(await m.db.user.count({ where: { collegeId: `${tag}N2`.toUpperCase() } })).toBe(0);

    const row = await m.db.rosterImport.findUniqueOrThrow({ where: { id: importId } });
    expect(row.status).toBe("COMMITTED");
    expect(row.rows).toBeNull();
    expect(row.resultsSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(row.results)).not.toContain("@example.test");

    const committed = state.audits.find((a) => a.action === "roster.import.committed");
    expect(committed).toMatchObject({ sensitivity: "SENSITIVE" });
    expect(state.audits.filter((a) => a.action === "student.cohort.changed")).toEqual([
      expect.objectContaining({ targetUserId: u.s1.id, metadata: expect.objectContaining({ from: `2027.${deptA}.A`, to: `2027.${deptA}.B` }) }),
    ]);
  });

  it("only open-period XpBucket rows follow the move", async () => {
    const buckets = await m.db.xpBucket.findMany({ where: { userId: u.s1.id }, select: { periodKey: true, section: true } });
    const byKey = Object.fromEntries(buckets.map((b) => [b.periodKey, b.section]));
    expect(byKey["2020-W01"]).toBe("A");
    expect(byKey.all).toBe("B");
    expect(byKey[m.shared.isoWeekKey(new Date())]).toBe("B");
    expect(byKey[m.shared.monthKey(new Date())]).toBe("B");
  });

  it("a committed import cannot be committed again", async () => {
    const result = await m.actions.commitRosterImport({ importId, diffSha256: "a".repeat(64) });
    expect(result.ok || result.error).toMatch(/already committed or discarded/);
  });

  it("an expired or discarded preview is refused", async () => {
    const expired = await preview([csvRows()[2]!]);
    await m.db.rosterImport.update({ where: { id: expired }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const late = await m.actions.commitRosterImport({ importId: expired, diffSha256: "b".repeat(64) });
    expect(late.ok || late.error).toMatch(/expired/);

    const discarded = await preview([csvRows()[2]!]);
    expect(await m.actions.discardRosterImport({ importId: discarded })).toEqual({ ok: true, data: { importId: discarded } });
    const row = await m.db.rosterImport.findUniqueOrThrow({ where: { id: discarded } });
    expect(row).toMatchObject({ status: "EXPIRED", rows: null });
    const again = await m.actions.commitRosterImport({ importId: discarded, diffSha256: "c".repeat(64) });
    expect(again.ok || again.error).toMatch(/already committed or discarded/);
  });

  it("another admin's import is not found", async () => {
    const other = await m.db.rosterImport.create({
      data: {
        createdById: u.sup.id,
        fileName: "x.csv",
        fileSha256: "0".repeat(64),
        rowCount: 0,
        rows: [],
        counts: {},
        diffSha256: "0".repeat(64),
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    const result = await m.actions.discardRosterImport({ importId: other.id });
    expect(result).toEqual({ ok: false, error: "That import was not found." });
  });
});
