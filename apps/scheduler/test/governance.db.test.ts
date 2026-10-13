import { randomBytes } from "node:crypto";
import { createPrismaClient, type Db } from "@recx/db";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withSingleConnection } from "../src/config";
import { GovernanceSweepJob } from "../src/governance";
import { recordJobStatus } from "../src/job-status";

/**
 * The governance sweep against a real Postgres (recx_test): an expired
 * PENDING request becomes EXPIRED (audited, requester notified); an
 * operation stuck EXECUTING for over 15 minutes becomes FAILED; a lapsed
 * impersonation is ended EXPIRED with its session pointer cleared; two
 * sweeps racing write exactly one end audit; a dry run writes nothing; the
 * job status row is upserted. Fixtures go through the allowed paths only
 * (PENDING inserts within the 5-minute window, then UPDATEs). Opt-in:
 * RECX_DB_TESTS=1.
 */
const ENABLED = process.env.RECX_DB_TESTS === "1";
const TEST_URL = process.env.RECX_TEST_DATABASE_URL ?? "postgresql://recx:recx-dev-only@localhost:5433/recx_test";
const log = pino({ level: "silent" });

const DELETE_GUARDS = [
  ["PrivilegedOperation", "PrivilegedOperation_request_immutable"],
  ["ImpersonationSession", "ImpersonationSession_immutable"],
] as const;

describe.skipIf(!ENABLED)("governance sweep against recx_test", () => {
  const tag = `gov-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
  let db: Db;
  let db2: Db;
  const ids: string[] = [];
  let requester = "";
  let approver = "";
  let student = "";

  const mkUser = async (key: string, role: "SUPER_ADMIN" | "STUDENT") => {
    const handle = `${tag}-${key}`;
    const user = await db.user.create({
      data: { collegeId: handle.toUpperCase(), email: `${handle}@example.test`, handle, firstName: key, lastName: "Gov", role },
    });
    ids.push(user.id);
    return user.id;
  };

  const pending = (fields: { requestedAt: Date; expiresAt: Date }) =>
    db.privilegedOperation.create({
      data: {
        kind: "PROBLEM_DELETE",
        payload: { problemId: `${tag}-p` },
        payloadSha256: "f".repeat(64),
        summary: `Governance ${tag}`,
        affectedCount: 1,
        reason: "fixture",
        requestedById: requester,
        ...fields,
      },
    });

  beforeAll(async () => {
    if (!new URL(TEST_URL).pathname.endsWith("_test")) throw new Error("Refusing to run against a non-test database");
    db = createPrismaClient({ url: withSingleConnection(TEST_URL), log: [] });
    db2 = createPrismaClient({ url: withSingleConnection(TEST_URL), log: [] });
    requester = await mkUser("req", "SUPER_ADMIN");
    approver = await mkUser("app", "SUPER_ADMIN");
    student = await mkUser("stu", "STUDENT");
  });

  afterAll(async () => {
    try {
      if (db && ids.length > 0) {
        const ops = await db.privilegedOperation.findMany({ where: { requestedById: { in: ids } }, select: { id: true } });
        const imps = await db.impersonationSession.findMany({ where: { impersonatorId: { in: ids } }, select: { id: true } });
        const entityIds = [...ops.map((o) => o.id), ...imps.map((i) => i.id)];
        const raw = (sql: string, ...params: unknown[]) => db.$executeRawUnsafe(sql, ...params);
        await db.$transaction([
          ...DELETE_GUARDS.map(([t, g]) => raw(`ALTER TABLE "public"."${t}" DISABLE TRIGGER "${g}"`)),
          raw(`UPDATE "public"."Session" SET "impersonationId" = NULL WHERE "userId" = ANY($1::text[])`, ids),
          raw(`DELETE FROM "public"."PrivilegedOperation" WHERE "requestedById" = ANY($1::text[])`, ids),
          raw(`DELETE FROM "public"."ImpersonationSession" WHERE "impersonatorId" = ANY($1::text[])`, ids),
          ...DELETE_GUARDS.map(([t, g]) => raw(`ALTER TABLE "public"."${t}" ENABLE TRIGGER "${g}"`)),
          raw(`DELETE FROM "public"."AuditLog" WHERE "entityId" = ANY($1::text[])`, entityIds),
          raw(`DELETE FROM "public"."Notification" WHERE "userId" = ANY($1::text[])`, ids),
          raw(`DELETE FROM "public"."Session" WHERE "userId" = ANY($1::text[])`, ids),
          raw(`DELETE FROM "public"."User" WHERE "id" = ANY($1::text[])`, ids),
        ]);
        await db.schedulerJobStatus.deleteMany({ where: { instance: tag } });
        const stuck = await db.$queryRawUnsafe<Array<{ tgname: string }>>(
          `SELECT "tgname" FROM pg_trigger WHERE NOT "tgisinternal" AND "tgenabled" <> 'O'`,
        );
        expect(stuck).toEqual([]);
      }
    } finally {
      await db?.$disconnect();
      await db2?.$disconnect();
    }
  });

  it("a dry run decides but writes nothing", async () => {
    const now = Date.now();
    const op = await pending({ requestedAt: new Date(now - 4 * 60_000), expiresAt: new Date(now - 3 * 60_000) });
    const report = await new GovernanceSweepJob({ db, log, dryRun: true }).tick();
    expect(report.dryRun).toBe(true);
    expect(report.expired).toBeGreaterThanOrEqual(1);
    expect((await db.privilegedOperation.findUniqueOrThrow({ where: { id: op.id } })).status).toBe("PENDING");
  });

  it("expires PENDING requests past expiresAt, audits and notifies the requester", async () => {
    const now = Date.now();
    const fresh = await pending({ requestedAt: new Date(now), expiresAt: new Date(now + 3_600_000) });
    await new GovernanceSweepJob({ db, log, dryRun: false }).tick();
    const expired = await db.privilegedOperation.findMany({ where: { requestedById: requester, status: "EXPIRED" } });
    expect(expired.length).toBeGreaterThanOrEqual(1);
    expect(expired.every((o) => o.decidedById === null && !o.breakGlass)).toBe(true);
    expect((await db.privilegedOperation.findUniqueOrThrow({ where: { id: fresh.id } })).status).toBe("PENDING");
    const audits = await db.auditLog.findMany({ where: { action: "privileged.expired", entityId: { in: expired.map((o) => o.id) } } });
    expect(audits).toHaveLength(expired.length);
    expect(audits.every((a) => a.actorId === null && a.sensitivity === "NORMAL")).toBe(true);
    expect(await db.notification.count({ where: { userId: requester, kind: "privileged.expired" } })).toBe(expired.length);
  });

  it("fails an operation stuck EXECUTING for more than 15 minutes", async () => {
    const now = Date.now();
    const op = await pending({ requestedAt: new Date(now - 60_000), expiresAt: new Date(now + 3_600_000) });
    await db.$executeRaw`UPDATE "PrivilegedOperation" SET status = 'APPROVED', "decidedById" = ${approver},
      "decidedAt" = (now() AT TIME ZONE 'UTC') WHERE id = ${op.id}`;
    await db.$executeRaw`UPDATE "PrivilegedOperation" SET status = 'EXECUTING',
      "executionStartedAt" = (now() AT TIME ZONE 'UTC') - interval '16 minutes' WHERE id = ${op.id}`;
    const report = await new GovernanceSweepJob({ db, log, dryRun: false }).tick();
    expect(report.failedStale).toBeGreaterThanOrEqual(1);
    const row = await db.privilegedOperation.findUniqueOrThrow({ where: { id: op.id } });
    expect(row.status).toBe("FAILED");
    expect(row.executedAt).not.toBeNull();
    expect(row.error).toMatch(/15 minutes/);
    expect(await db.auditLog.count({ where: { action: "privileged.failed", entityId: op.id } })).toBe(1);
  });

  it("ends lapsed impersonations once, even with two sweeps racing", async () => {
    const now = Date.now();
    const imp = await db.impersonationSession.create({
      data: {
        impersonatorId: requester,
        targetUserId: student,
        reason: `lapsed ${tag}`,
        startedAt: new Date(now - 4 * 60_000),
        expiresAt: new Date(now - 60_000),
      },
    });
    const session = await db.session.create({
      data: { tokenHash: `${tag}-${randomBytes(8).toString("hex")}`, userId: requester, expiresAt: new Date(now + 86_400_000), impersonationId: imp.id },
    });
    await Promise.all([
      new GovernanceSweepJob({ db, log, dryRun: false }).tick(),
      new GovernanceSweepJob({ db: db2, log, dryRun: false }).tick(),
    ]);
    const row = await db.impersonationSession.findUniqueOrThrow({ where: { id: imp.id } });
    expect(row.endReason).toBe("EXPIRED");
    expect(row.endedAt).not.toBeNull();
    expect((await db.session.findUniqueOrThrow({ where: { id: session.id } })).impersonationId).toBeNull();
    const audits = await db.auditLog.findMany({ where: { action: "impersonation.ended", entityId: imp.id } });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ sensitivity: "SECURITY", actorId: null, targetUserId: student });
    expect(audits[0]!.metadata).toMatchObject({ endReason: "EXPIRED", impersonatorId: requester });
  });

  it("records the job status (never in a dry run)", async () => {
    const started = new Date();
    await recordJobStatus(db, "governance", { startedAt: started, finishedAt: new Date(), ok: true, report: { n: 1n } }, true, tag);
    const before = await db.schedulerJobStatus.findUnique({ where: { job: "governance" } });
    expect(before?.instance === tag).toBe(false);
    // The real "governance" row belongs to whatever scheduler ran last; write under it and restore.
    const saved = before;
    await recordJobStatus(db, "governance", { startedAt: started, finishedAt: new Date(), ok: false, error: "boom" }, false, tag);
    const failed = await db.schedulerJobStatus.findUniqueOrThrow({ where: { job: "governance" } });
    expect(failed).toMatchObject({ instance: tag, lastOk: false, lastError: "boom" });
    expect(failed.consecutiveFailures).toBe((saved?.consecutiveFailures ?? 0) + 1);
    await recordJobStatus(db, "governance", { startedAt: started, finishedAt: new Date(), ok: true, report: { n: 2n } }, false, tag);
    const ok = await db.schedulerJobStatus.findUniqueOrThrow({ where: { job: "governance" } });
    expect(ok).toMatchObject({ lastOk: true, consecutiveFailures: 0, lastReport: { n: "2" } });
    if (saved) {
      await db.schedulerJobStatus.update({
        where: { job: "governance" },
        data: {
          instance: saved.instance,
          lastStartedAt: saved.lastStartedAt,
          lastFinishedAt: saved.lastFinishedAt,
          lastOk: saved.lastOk,
          lastError: saved.lastError,
          lastReport: saved.lastReport ?? {},
          consecutiveFailures: saved.consecutiveFailures,
        },
      });
    }
  });
});
