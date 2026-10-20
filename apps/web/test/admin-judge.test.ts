import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The /admin/judge server actions with their collaborators stubbed: RBAC is
 * checked through the guards module, every mutation is audited, the rejudge
 * reset is complete and goes onto the REJUDGE lane. AdminScope: a rejudge and
 * a cap override reach only students inside the actor's scope.
 */

const h = vi.hoisted(() => {
  const actor = { id: "admin_1", role: "ADMIN" as string };
  const db = {
    judgeNode: { findUnique: vi.fn(), updateMany: vi.fn() },
    submission: { updateMany: vi.fn(), findUniqueOrThrow: vi.fn(), findFirst: vi.fn(), update: vi.fn() },
    submissionTestDetail: { deleteMany: vi.fn() },
    languageConfig: { findUnique: vi.fn(), updateMany: vi.fn() },
    user: { findFirst: vi.fn() },
    judgeQuotaOverride: { create: vi.fn() },
    adminScope: { findMany: vi.fn() },
    $queryRaw: vi.fn(),
    $transaction: vi.fn(),
  };
  return { actor, db, audit: vi.fn(), enqueueJudge: vi.fn(), requireActionRole: vi.fn(), requireSuperAdmin: vi.fn() };
});

vi.mock("@/lib/auth/guards", () => ({
  requireActionRole: h.requireActionRole,
  requireSuperAdmin: h.requireSuperAdmin,
}));
vi.mock("@/lib/db", () => ({ db: h.db }));
vi.mock("@/lib/audit", () => ({ audit: h.audit }));
vi.mock("@/lib/ip", () => ({ requestIpHash: async () => "iphash" }));
vi.mock("@/lib/judge/queue", () => ({ enqueueJudge: h.enqueueJudge }));
vi.mock("@/lib/judge/lanes", () => ({ allowUnhardenedNodes: () => false }));

const { ForbiddenError } = await import("@/lib/errors");
const actions = await import("@/server/actions/admin-judge");

const REASON = "Kernel update scheduled tonight";
const fresh = () => new Date();

beforeEach(() => {
  vi.clearAllMocks();
  h.actor.role = "ADMIN";
  h.requireActionRole.mockImplementation(async (...roles: string[]) => {
    if (!roles.includes(h.actor.role)) throw new ForbiddenError();
    return h.actor;
  });
  h.requireSuperAdmin.mockImplementation(async () => {
    if (h.actor.role !== "SUPER_ADMIN") throw new ForbiddenError();
    return h.actor;
  });
  h.db.$transaction.mockImplementation(async (fn: (tx: typeof h.db) => unknown) => fn(h.db));
  h.enqueueJudge.mockResolvedValue(true);
  // An ADMIN with a college-wide grant unless a test narrows it.
  h.db.adminScope.findMany.mockResolvedValue([{ departmentCode: null, batchYear: null }]);
});

function node(fields: Record<string, unknown> = {}) {
  return {
    id: "judge-01",
    hostname: "judge-01.rec.local",
    status: "ONLINE",
    selfCheckOk: true,
    hostHardened: true,
    lastHeartbeatAt: fresh(),
    consecutiveIe: 0,
    ...fields,
  };
}

describe("setJudgeNodeStatus", () => {
  it("is ADMIN / SUPER_ADMIN only, checked before anything is read", async () => {
    h.actor.role = "STUDENT";
    const result = await actions.setJudgeNodeStatus({ nodeId: "judge-01", action: "drain", reason: REASON });
    expect(result).toEqual({ ok: false, error: "You don't have permission to do that." });
    expect(h.requireActionRole).toHaveBeenCalledWith("ADMIN", "SUPER_ADMIN");
    expect(h.db.judgeNode.findUnique).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
  });

  it("requires a reason", async () => {
    const result = await actions.setJudgeNodeStatus({ nodeId: "judge-01", action: "drain", reason: "  ok " });
    expect(result.ok).toBe(false);
    expect(h.db.judgeNode.updateMany).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
  });

  it("drains an ONLINE node conditionally and audits it", async () => {
    h.db.judgeNode.findUnique.mockResolvedValue(node());
    h.db.judgeNode.updateMany.mockResolvedValue({ count: 1 });
    const result = await actions.setJudgeNodeStatus({ nodeId: "judge-01", action: "drain", reason: REASON });
    expect(result).toEqual({ ok: true, data: { status: "DRAINING" } });
    expect(h.db.judgeNode.updateMany).toHaveBeenCalledWith({
      where: { id: "judge-01", status: "ONLINE" },
      data: { status: "DRAINING" },
    });
    expect(h.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: "admin_1",
        action: "judge.node.drained",
        entityType: "JudgeNode",
        entityId: "judge-01",
        sensitivity: "SENSITIVE",
        ipHash: "iphash",
        metadata: expect.objectContaining({ from: "ONLINE", to: "DRAINING", reason: REASON }),
      }),
    );
  });

  it("quarantine is a SECURITY audit event", async () => {
    h.db.judgeNode.findUnique.mockResolvedValue(node({ status: "DRAINING" }));
    h.db.judgeNode.updateMany.mockResolvedValue({ count: 1 });
    const result = await actions.setJudgeNodeStatus({ nodeId: "judge-01", action: "quarantine", reason: REASON });
    expect(result).toEqual({ ok: true, data: { status: "QUARANTINED" } });
    expect(h.audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "judge.node.quarantined", sensitivity: "SECURITY" }),
    );
  });

  it("returning a quarantined node clears the IE counter and is a SECURITY event", async () => {
    h.db.judgeNode.findUnique.mockResolvedValue(node({ status: "QUARANTINED", consecutiveIe: 3 }));
    h.db.judgeNode.updateMany.mockResolvedValue({ count: 1 });
    const result = await actions.setJudgeNodeStatus({ nodeId: "judge-01", action: "online", reason: REASON });
    expect(result).toEqual({ ok: true, data: { status: "ONLINE" } });
    expect(h.db.judgeNode.updateMany).toHaveBeenCalledWith({
      where: { id: "judge-01", status: "QUARANTINED" },
      data: { status: "ONLINE", consecutiveIe: 0 },
    });
    expect(h.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "judge.node.returned",
        sensitivity: "SECURITY",
        metadata: expect.objectContaining({ consecutiveIeCleared: 3 }),
      }),
    );
  });

  it("an OFFLINE node is not returned by hand, and a failed self-check blocks a return", async () => {
    h.db.judgeNode.findUnique.mockResolvedValue(node({ status: "OFFLINE" }));
    const offline = await actions.setJudgeNodeStatus({ nodeId: "judge-01", action: "online", reason: REASON });
    expect(offline.ok).toBe(false);
    h.db.judgeNode.findUnique.mockResolvedValue(node({ status: "QUARANTINED", selfCheckOk: false }));
    const failed = await actions.setJudgeNodeStatus({ nodeId: "judge-01", action: "online", reason: REASON });
    expect(failed.ok || failed.error).toMatch(/self-check failed/);
    h.db.judgeNode.findUnique.mockResolvedValue(node({ status: "QUARANTINED", hostHardened: false }));
    const unhardened = await actions.setJudgeNodeStatus({ nodeId: "judge-01", action: "online", reason: REASON });
    expect(unhardened.ok || unhardened.error).toMatch(/hardening/);
    expect(h.db.judgeNode.updateMany).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
  });

  it("a lost race changes nothing and is not audited", async () => {
    h.db.judgeNode.findUnique.mockResolvedValue(node());
    h.db.judgeNode.updateMany.mockResolvedValue({ count: 0 });
    const result = await actions.setJudgeNodeStatus({ nodeId: "judge-01", action: "drain", reason: REASON });
    expect(result.ok || result.error).toMatch(/changed a moment ago/);
    expect(h.audit).not.toHaveBeenCalled();
  });

  it("an unknown node is reported", async () => {
    h.db.judgeNode.findUnique.mockResolvedValue(null);
    const result = await actions.setJudgeNodeStatus({ nodeId: "nope", action: "drain", reason: REASON });
    expect(result).toEqual({ ok: false, error: "That judge node was not found." });
  });
});

describe("rejudgeSubmission", () => {
  const previous = {
    id: "sub_1",
    userId: "stu_1",
    status: "INTERNAL_ERROR",
    verdict: "IE",
    score: null,
    lane: "PRACTICE",
    origin: "PRACTICE",
    attemptCount: 3,
    judgeNodeId: "judge-02",
  };

  beforeEach(() => {
    h.db.$queryRaw.mockResolvedValue([{ id: "sub_1" }]);
    h.db.submission.findFirst.mockResolvedValue(previous);
    h.db.submission.update.mockResolvedValue({});
    h.db.submission.updateMany.mockResolvedValue({ count: 1 });
    h.db.submissionTestDetail.deleteMany.mockResolvedValue({ count: 2 });
  });

  it("is ADMIN / SUPER_ADMIN only", async () => {
    h.actor.role = "TA_MENTOR";
    const result = await actions.rejudgeSubmission({ submissionId: "sub_1" });
    expect(result.ok).toBe(false);
    expect(h.db.$transaction).not.toHaveBeenCalled();
    expect(h.enqueueJudge).not.toHaveBeenCalled();
  });

  it("resets the row onto the REJUDGE lane, clears details, enqueues and audits the previous verdict", async () => {
    const result = await actions.rejudgeSubmission({ submissionId: "sub_1" });
    expect(result).toEqual({ ok: true, data: { id: "sub_1", dispatched: true } });

    // The reset itself is lib/judge/rejudge.ts (shared with the global rejudge).
    expect(h.db.submissionTestDetail.deleteMany).toHaveBeenCalledWith({ where: { submissionId: { in: ["sub_1"] } } });
    const update = h.db.submission.updateMany.mock.calls[0]![0] as { where: unknown; data: Record<string, unknown> };
    expect(update.where).toEqual({ id: { in: ["sub_1"] } });
    expect(update.data).toMatchObject({
      status: "QUEUED",
      judgeState: "PENDING",
      lane: "REJUDGE",
      verdict: null,
      score: null,
      maxScore: null,
      cpuMs: null,
      passedCases: 0,
      firstFailedIndex: null,
      compileOutput: null,
      claimedByNodeId: null,
      claimToken: null,
      leaseExpiresAt: null,
      attemptCount: 0,
      judgeNodeId: null,
      calibrationScore: null,
      startedAt: null,
      judgedAt: null,
    });
    expect(update.data.queuedAt).toBeInstanceOf(Date);

    expect(h.enqueueJudge).toHaveBeenCalledWith("submission", "sub_1", "REJUDGE");
    expect(h.db.submission.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({ id: "sub_1", judgeState: "PENDING" }),
      data: { judgeState: "DISPATCHED" },
    });
    expect(h.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: "admin_1",
        action: "judge.rejudge",
        entityType: "Submission",
        entityId: "sub_1",
        targetUserId: "stu_1",
        metadata: expect.objectContaining({ scope: "single", previousVerdict: "IE", previousStatus: "INTERNAL_ERROR" }),
      }),
    );
  });

  it("with Redis down the row stays QUEUED for the reconciler", async () => {
    h.enqueueJudge.mockResolvedValue(false);
    const result = await actions.rejudgeSubmission({ submissionId: "sub_1" });
    expect(result).toEqual({ ok: true, data: { id: "sub_1", dispatched: false } });
    expect(h.db.submission.updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: { judgeState: "DISPATCHED" } }),
    );
    expect(h.audit).toHaveBeenCalledTimes(1);
  });

  it("refuses missing and cancelled submissions without touching them", async () => {
    h.db.$queryRaw.mockResolvedValue([]);
    const missing = await actions.rejudgeSubmission({ submissionId: "sub_x" });
    expect(missing).toEqual({ ok: false, error: "That submission was not found." });
    h.db.$queryRaw.mockResolvedValue([{ id: "sub_1" }]);
    h.db.submission.findFirst.mockResolvedValue({ ...previous, status: "CANCELLED" });
    const cancelled = await actions.rejudgeSubmission({ submissionId: "sub_1" });
    expect(cancelled.ok).toBe(false);
    expect(h.db.submission.updateMany).not.toHaveBeenCalled();
    expect(h.enqueueJudge).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
  });

  it("an out-of-scope submission reads as not found (the lock query and the read are scoped)", async () => {
    h.db.adminScope.findMany.mockResolvedValue([{ departmentCode: "ECE", batchYear: null }]);
    // The database returns nothing because the scoped join excludes the row.
    h.db.$queryRaw.mockResolvedValue([]);
    const result = await actions.rejudgeSubmission({ submissionId: "sub_1" });
    expect(result).toEqual({ ok: false, error: "That submission was not found." });
    const [, ...values] = h.db.$queryRaw.mock.calls[0]! as [TemplateStringsArray, ...unknown[]];
    const scopeSql = values.find((v) => typeof v === "object" && v !== null && "sql" in v) as { sql: string; values: unknown[] };
    expect(scopeSql.sql).toContain(`"u"."departmentCode"`);
    expect(scopeSql.values).toContain("ECE");
    expect(h.db.submissionTestDetail.deleteMany).not.toHaveBeenCalled();

    // Even if the lock saw the row, the scoped read refuses it.
    h.db.$queryRaw.mockResolvedValue([{ id: "sub_1" }]);
    h.db.submission.findFirst.mockResolvedValue(null);
    const again = await actions.rejudgeSubmission({ submissionId: "sub_1" });
    expect(again).toEqual({ ok: false, error: "That submission was not found." });
    expect(h.db.submission.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: "sub_1",
          user: { AND: [{ role: "STUDENT" }, { OR: [{ departmentCode: "ECE" }] }, {}] },
        },
      }),
    );
    expect(h.db.submission.updateMany).not.toHaveBeenCalled();
    expect(h.enqueueJudge).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
  });
});

describe("setLanguageEnabled", () => {
  const config = {
    id: "lc_1",
    key: "py312",
    toolchainId: "cpython-3.12.6",
    label: "Python 3.12",
    enabled: true,
    isCurrent: true,
    retiredAt: null,
  };

  it("toggles conditionally and audits judge.language.enabled_changed", async () => {
    h.db.languageConfig.findUnique.mockResolvedValue(config);
    h.db.languageConfig.updateMany.mockResolvedValue({ count: 1 });
    const result = await actions.setLanguageEnabled({ languageConfigId: "lc_1", enabled: false, reason: REASON });
    expect(result).toEqual({ ok: true, data: { enabled: false } });
    expect(h.db.languageConfig.updateMany).toHaveBeenCalledWith({
      where: { id: "lc_1", enabled: true },
      data: { enabled: false },
    });
    expect(h.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "judge.language.enabled_changed",
        entityType: "LanguageConfig",
        entityId: "lc_1",
        metadata: expect.objectContaining({ key: "py312", from: true, to: false, reason: REASON }),
      }),
    );
  });

  it("refuses a no-op and a retired toolchain", async () => {
    h.db.languageConfig.findUnique.mockResolvedValue(config);
    const same = await actions.setLanguageEnabled({ languageConfigId: "lc_1", enabled: true, reason: REASON });
    expect(same.ok || same.error).toMatch(/already enabled/);
    h.db.languageConfig.findUnique.mockResolvedValue({ ...config, enabled: false, retiredAt: new Date() });
    const retired = await actions.setLanguageEnabled({ languageConfigId: "lc_1", enabled: true, reason: REASON });
    expect(retired.ok).toBe(false);
    expect(h.db.languageConfig.updateMany).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
  });
});

describe("grantJudgeQuotaOverride", () => {
  beforeEach(() => {
    h.db.user.findFirst.mockResolvedValue({ id: "stu_1", collegeId: "2116230701001" });
    h.db.judgeQuotaOverride.create.mockResolvedValue({ id: "qo_1" });
  });

  it("is SUPER_ADMIN only", async () => {
    h.actor.role = "ADMIN";
    const result = await actions.grantJudgeQuotaOverride({ collegeId: "2116230701001", reason: REASON });
    expect(result).toEqual({ ok: false, error: "You don't have permission to do that." });
    expect(h.db.judgeQuotaOverride.create).not.toHaveBeenCalled();
  });

  it("creates the override (empty fields keep the default), expiry read as IST, and audits it", async () => {
    h.actor.role = "SUPER_ADMIN";
    const result = await actions.grantJudgeQuotaOverride({
      collegeId: " 2116230701001 ",
      practicePerDay: "500",
      runsPerHour: "",
      cpuMinutesPerDay: 45,
      expiresAt: "2099-01-01T09:30",
      reason: REASON,
    });
    expect(result).toEqual({ ok: true, data: { id: "qo_1", collegeId: "2116230701001" } });
    // Scoped (a SUPER_ADMIN's scope is the whole college): student accounts only.
    expect(h.db.user.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { AND: [{ role: "STUDENT" }, {}, { collegeId: { equals: "2116230701001", mode: "insensitive" } }] },
      }),
    );
    expect(h.db.judgeQuotaOverride.create).toHaveBeenCalledWith({
      data: {
        userId: "stu_1",
        practicePerDay: 500,
        runsPerHour: null,
        cpuMinutesPerDay: 45,
        reason: REASON,
        grantedById: "admin_1",
        expiresAt: new Date("2099-01-01T04:00:00.000Z"),
      },
      select: { id: true },
    });
    expect(h.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "judge.quota.override",
        entityType: "JudgeQuotaOverride",
        entityId: "qo_1",
        targetUserId: "stu_1",
        metadata: expect.objectContaining({ practicePerDay: 500, runsPerHour: null, cpuMinutesPerDay: 45 }),
      }),
    );
  });

  it("validates caps, expiry and the roll number", async () => {
    h.actor.role = "SUPER_ADMIN";
    const zero = await actions.grantJudgeQuotaOverride({ collegeId: "X1", practicePerDay: "0", reason: REASON });
    expect(zero.ok || zero.error).toMatch(/at least 1/);
    const frac = await actions.grantJudgeQuotaOverride({ collegeId: "X1", runsPerHour: "2.5", reason: REASON });
    expect(frac.ok || frac.error).toMatch(/whole number/);
    const past = await actions.grantJudgeQuotaOverride({ collegeId: "X1", expiresAt: "2020-01-01T00:00", reason: REASON });
    expect(past.ok || past.error).toMatch(/future/);
    const bad = await actions.grantJudgeQuotaOverride({ collegeId: "X1", expiresAt: "tomorrow", reason: REASON });
    expect(bad.ok).toBe(false);
    h.db.user.findFirst.mockResolvedValue(null);
    const unknown = await actions.grantJudgeQuotaOverride({ collegeId: "X1", reason: REASON });
    expect(unknown.ok || unknown.error).toMatch(/No student has the roll number X1/);
    expect(h.db.judgeQuotaOverride.create).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
  });
});
