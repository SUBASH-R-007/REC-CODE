import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Two-person approval against a real Postgres (recx_test): request →
 * second super-admin approves → the executor runs; self-approval without
 * break-glass is refused; the database CHECK and trigger refuse a forged
 * self-decision, a payload change and a delete; an expired request cannot
 * be approved; two concurrent approvals produce one execution; break-glass
 * writes a SECURITY audit, one outbox email and one notification per ACTIVE
 * super-admin. Opt-in: RECX_DB_TESTS=1. Session, audit, rate limit and
 * flags are in-memory fakes; everything else is real.
 */
const ENABLED = process.env.RECX_DB_TESTS === "1";

const state = vi.hoisted(() => {
  if (process.env.RECX_DB_TESTS === "1") {
    process.env.DATABASE_URL =
      process.env.RECX_TEST_DATABASE_URL ?? "postgresql://recx:recx-dev-only@127.0.0.1:5433/recx_test";
  }
  return { user: null as unknown, audits: [] as Array<Record<string, unknown>> };
});

vi.mock("@/lib/auth/session", () => ({ getCurrentUser: async () => state.user, destroyAllSessions: async () => undefined }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined, revalidateTag: () => undefined }));
vi.mock("@/lib/rate-limit", () => ({
  hitRateLimit: async () => ({ allowed: true, remaining: 1, retryAfterMs: 0, key: "k", member: "m", failedOpen: true }),
}));
vi.mock("@/lib/flags", () => ({ isFeatureEnabled: async () => true, getFeatureFlags: async () => ({ impersonation: true, breakGlassSelfApproval: true }) }));
vi.mock("@/lib/ip", () => ({ requestIpHash: async () => null }));
vi.mock("@/lib/env", () => ({ env: () => ({ APP_URL: "http://localhost:3000" }), isProduction: () => false }));
vi.mock("@/lib/audit", () => ({
  audit: async (entry: Record<string, unknown>) => {
    state.audits.push(entry);
  },
  auditMany: async (entries: Array<Record<string, unknown>>) => {
    state.audits.push(...entries);
  },
}));

type M = {
  db: (typeof import("@/lib/db"))["db"];
  problems: typeof import("@/server/actions/super-problems");
  privileged: typeof import("@/server/actions/privileged");
  support: typeof import("./support/governance-db");
};

describe.skipIf(!ENABLED)("privileged operations against recx_test", () => {
  const tag = `priv-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
  let m: M;
  let users: Awaited<ReturnType<M["support"]["createUsers"]>>;
  const as = (key: string) => {
    state.user = { ...users[key]!, status: "ACTIVE" };
  };

  /** A never-published problem with one DRAFT revision. */
  async function draftProblem(suffix: string) {
    const problem = await m.db.problem.create({
      data: { slug: `${tag}-${suffix}`, displayCode: `${tag}-${suffix}`.toUpperCase(), title: `Draft ${tag}`, difficulty: "EASY" },
    });
    await m.db.problemVersion.create({
      data: {
        problemId: problem.id,
        revision: 1,
        title: `Draft ${tag}`,
        difficulty: "EASY",
        statementMd: "Draft statement",
        ioMode: "STDIN",
        timeLimitMs: 1000,
      },
    });
    return problem;
  }

  async function request(suffix: string) {
    const problem = await draftProblem(suffix);
    as("a");
    const result = await m.problems.requestProblemDeletion({ problemId: problem.id, reason: `Test deletion ${tag}` });
    if (!result.ok) throw new Error(result.error);
    const op = await m.db.privilegedOperation.findUniqueOrThrow({ where: { id: result.data.id } });
    return { problem, op };
  }

  beforeAll(async () => {
    const support = await import("./support/governance-db");
    support.assertTestDatabase();
    const [dbModule, problems, privileged] = await Promise.all([
      import("@/lib/db"),
      import("@/server/actions/super-problems"),
      import("@/server/actions/privileged"),
    ]);
    m = { db: dbModule.db, problems, privileged, support };
    users = await support.createUsers(m.db, tag, {
      a: { role: "SUPER_ADMIN" },
      b: { role: "SUPER_ADMIN" },
      c: { role: "SUPER_ADMIN" },
    });
  });

  beforeEach(() => {
    state.audits.length = 0;
  });

  afterAll(async () => {
    if (!m) return;
    try {
      const ids = Object.values(users ?? {}).map((u) => u.id);
      const problems = await m.db.problem.findMany({ where: { slug: { startsWith: tag } }, select: { id: true } });
      for (const p of problems) {
        await m.db.problem.update({ where: { id: p.id }, data: { liveVersionId: null } });
        await m.db.problemReview.deleteMany({ where: { problemVersion: { problemId: p.id } } });
        await m.db.problemVersion.deleteMany({ where: { problemId: p.id } });
        await m.db.problem.delete({ where: { id: p.id } });
      }
      await m.support.cleanupGovernance(m.db, ids, tag);
      expect(await m.support.disabledTriggers(m.db)).toEqual([]);
    } finally {
      await m.db.$disconnect();
    }
  });

  it("request → a second super-admin approves → the executor deletes the draft problem", async () => {
    const { problem, op } = await request("p1");
    expect(op.status).toBe("PENDING");
    expect(op.payloadSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(op.expiresAt.getTime() - op.requestedAt.getTime()).toBe(24 * 3_600_000);
    expect(state.audits.map((a) => a.action)).toContain("privileged.requested");
    const pending = await m.db.notification.count({ where: { kind: "privileged.pending", userId: { in: [users.b!.id, users.c!.id] }, body: { contains: tag } } });
    expect(pending).toBe(2);

    as("b");
    const result = await m.privileged.approvePrivilegedOperation({ id: op.id, payloadSha256: op.payloadSha256 });
    expect(result).toEqual({ ok: true, data: { status: "EXECUTED", error: null } });
    const after = await m.db.privilegedOperation.findUniqueOrThrow({ where: { id: op.id } });
    expect(after).toMatchObject({ status: "EXECUTED", decidedById: users.b!.id, breakGlass: false });
    expect(after.executionStartedAt).not.toBeNull();
    expect(after.executedAt).not.toBeNull();
    expect(await m.db.problem.findUnique({ where: { id: problem.id } })).toBeNull();
    expect(state.audits.map((a) => a.action)).toEqual(
      expect.arrayContaining(["privileged.approved", "problem.deleted", "privileged.executed"]),
    );
  });

  it("refuses self-approval without break-glass, and a wrong digest", async () => {
    const { op } = await request("p2");
    as("a");
    const self = await m.privileged.approvePrivilegedOperation({ id: op.id, payloadSha256: op.payloadSha256 });
    expect(self.ok).toBe(false);
    as("b");
    const wrong = await m.privileged.approvePrivilegedOperation({ id: op.id, payloadSha256: "0".repeat(64) });
    expect(wrong.ok).toBe(false);
    expect((await m.db.privilegedOperation.findUniqueOrThrow({ where: { id: op.id } })).status).toBe("PENDING");
  });

  it("the database refuses a forged self-decision, a payload change and a delete", async () => {
    const { op } = await request("p3");
    await expect(
      m.db.$executeRaw`UPDATE "PrivilegedOperation" SET status = 'APPROVED', "decidedById" = "requestedById",
        "decidedAt" = (now() AT TIME ZONE 'UTC'), "breakGlass" = false WHERE id = ${op.id}`,
    ).rejects.toThrow();
    await expect(
      m.db.$executeRaw`UPDATE "PrivilegedOperation" SET payload = '{"problemId":"other"}'::jsonb WHERE id = ${op.id}`,
    ).rejects.toThrow();
    await expect(m.db.$executeRaw`DELETE FROM "PrivilegedOperation" WHERE id = ${op.id}`).rejects.toThrow();
    expect((await m.db.privilegedOperation.findUniqueOrThrow({ where: { id: op.id } })).status).toBe("PENDING");
  });

  it("an expired request cannot be approved", async () => {
    const problem = await draftProblem("p4");
    const now = Date.now();
    const op = await m.db.privilegedOperation.create({
      data: {
        kind: "PROBLEM_DELETE",
        payload: { problemId: problem.id },
        payloadSha256: "e".repeat(64),
        summary: `Expired ${tag}`,
        affectedCount: 1,
        reason: "expired fixture",
        requestedById: users.a!.id,
        requestedAt: new Date(now - 4 * 60_000),
        expiresAt: new Date(now - 3 * 60_000),
      },
    });
    as("b");
    const result = await m.privileged.approvePrivilegedOperation({ id: op.id, payloadSha256: op.payloadSha256 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/expired/);
    expect(await m.db.problem.findUnique({ where: { id: problem.id } })).not.toBeNull();
  });

  it("two concurrent approvals: one executes, the other is refused", async () => {
    const { op } = await request("p5");
    as("b");
    const first = m.privileged.approvePrivilegedOperation({ id: op.id, payloadSha256: op.payloadSha256 });
    as("c");
    const second = m.privileged.approvePrivilegedOperation({ id: op.id, payloadSha256: op.payloadSha256 });
    const results = await Promise.all([first, second]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toHaveLength(1);
    expect(state.audits.filter((a) => a.action === "privileged.executed")).toHaveLength(1);
    expect((await m.db.privilegedOperation.findUniqueOrThrow({ where: { id: op.id } })).status).toBe("EXECUTED");
  });

  it("break-glass: SECURITY audit, one email and one notification per ACTIVE super-admin", async () => {
    const { problem, op } = await request("p6");
    as("a");
    const result = await m.privileged.selfApprovePrivilegedOperation({
      id: op.id,
      payloadSha256: op.payloadSha256,
      justification: `Emergency clean-up during the exam window ${tag}`,
    });
    expect(result.ok).toBe(true);
    const row = await m.db.privilegedOperation.findUniqueOrThrow({ where: { id: op.id } });
    expect(row).toMatchObject({ breakGlass: true, decidedById: users.a!.id, status: "EXECUTED" });
    const outbox = await m.db.emailOutbox.findMany({ where: { entityId: op.id } });
    // Other suites may create super-admins concurrently, so compare with what the action saw:
    // one email per recipient, every recipient a super-admin, this suite's three included.
    if (result.ok) expect(result.data).toMatchObject({ status: "EXECUTED", emailed: outbox.length });
    const recipients = outbox.map((r) => r.toUserId);
    expect(new Set(recipients).size).toBe(recipients.length);
    expect(recipients).toEqual(expect.arrayContaining([users.a!.id, users.b!.id, users.c!.id]));
    const roles = await m.db.user.findMany({ where: { id: { in: recipients } }, select: { role: true } });
    expect(roles.every((u) => u.role === "SUPER_ADMIN")).toBe(true);
    expect(outbox.every((r) => r.kind === "security.break_glass" && r.status === "PENDING")).toBe(true);
    // Never an address in the queued row.
    expect(JSON.stringify(outbox)).not.toMatch(/@example\.test/);
    const notices = await m.db.notification.count({ where: { kind: "privileged.break_glass", body: { contains: tag } } });
    expect(notices).toBe(outbox.length);
    const breakGlass = state.audits.find((a) => a.action === "privileged.break_glass");
    expect(breakGlass).toMatchObject({ sensitivity: "SECURITY", entityId: op.id });
    expect(await m.db.problem.findUnique({ where: { id: problem.id } })).toBeNull();
  });

  it("refuses to delete a published problem: retire instead", async () => {
    const problem = await draftProblem("p7");
    // A live problem (liveVersionId set) is never deletable.
    const version = await m.db.problemVersion.findFirstOrThrow({ where: { problemId: problem.id } });
    await m.db.problem.update({ where: { id: problem.id }, data: { liveVersionId: version.id, status: "PUBLISHED" } });
    as("a");
    const result = await m.problems.requestProblemDeletion({ problemId: problem.id, reason: `Test deletion ${tag}` });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/Retire it instead/);
  });
});
