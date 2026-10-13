import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Impersonation rows against a real Postgres (recx_test): the session
 * pointer, one live impersonation per session, the database's 15-minute box
 * and not-self CHECKs, no DELETE, and two concurrent closes writing exactly
 * one end audit (the conditional UPDATE on endedAt IS NULL). The scheduler
 * side of the race is apps/scheduler/test/governance.db.test.ts.
 * Opt-in: RECX_DB_TESTS=1.
 */
const ENABLED = process.env.RECX_DB_TESTS === "1";

const state = vi.hoisted(() => {
  if (process.env.RECX_DB_TESTS === "1") {
    process.env.DATABASE_URL =
      process.env.RECX_TEST_DATABASE_URL ?? "postgresql://recx:recx-dev-only@localhost:5433/recx_test";
  }
  return { audits: [] as Array<Record<string, unknown>> };
});

vi.mock("@/lib/audit", () => ({
  audit: async (entry: Record<string, unknown>) => {
    state.audits.push(entry);
  },
}));

describe.skipIf(!ENABLED)("impersonation against recx_test", () => {
  const tag = `imp-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
  let db: (typeof import("@/lib/db"))["db"];
  let support: typeof import("./support/governance-db");
  let lib: typeof import("@/lib/auth/impersonation");
  let users: Awaited<ReturnType<typeof support.createUsers>>;
  let sessionId = "";

  beforeAll(async () => {
    support = await import("./support/governance-db");
    support.assertTestDatabase();
    db = (await import("@/lib/db")).db;
    lib = await import("@/lib/auth/impersonation");
    users = await support.createUsers(db, tag, { admin: { role: "SUPER_ADMIN" }, student: { role: "STUDENT" } });
    const session = await db.session.create({
      data: { tokenHash: `${tag}-${randomBytes(16).toString("hex")}`, userId: users.admin!.id, expiresAt: new Date(Date.now() + 86_400_000) },
    });
    sessionId = session.id;
  });

  beforeEach(() => {
    state.audits.length = 0;
  });

  afterAll(async () => {
    if (!db) return;
    try {
      await support.cleanupGovernance(db, Object.values(users ?? {}).map((u) => u.id), tag);
      expect(await support.disabledTriggers(db)).toEqual([]);
    } finally {
      await db.$disconnect();
    }
  });

  it("points the session at a 15-minute impersonation, one at a time", async () => {
    const now = new Date();
    const started = await lib.beginImpersonation({
      sessionId,
      impersonatorId: users.admin!.id,
      targetUserId: users.student!.id,
      reason: `Checking the dashboard ${tag}`,
      now,
    });
    expect(started.expiresAt.getTime() - now.getTime()).toBe(15 * 60_000);
    const session = await db.session.findUniqueOrThrow({ where: { id: sessionId } });
    expect(session.impersonationId).toBe(started.id);
    await expect(
      lib.beginImpersonation({ sessionId, impersonatorId: users.admin!.id, targetUserId: users.student!.id, reason: `Again ${tag}`, now: new Date() }),
    ).rejects.toThrow(/already viewing/);
  });

  it("the database refuses a longer box, self-impersonation and a delete", async () => {
    const now = new Date();
    await expect(
      db.impersonationSession.create({
        data: {
          impersonatorId: users.admin!.id,
          targetUserId: users.student!.id,
          reason: `too long ${tag}`,
          startedAt: now,
          expiresAt: new Date(now.getTime() + 16 * 60_000),
        },
      }),
    ).rejects.toThrow();
    await expect(
      db.impersonationSession.create({
        data: {
          impersonatorId: users.admin!.id,
          targetUserId: users.admin!.id,
          reason: `self ${tag}`,
          startedAt: now,
          expiresAt: new Date(now.getTime() + 60_000),
        },
      }),
    ).rejects.toThrow();
    const live = await db.impersonationSession.findFirstOrThrow({ where: { impersonatorId: users.admin!.id, endedAt: null } });
    await expect(db.$executeRaw`DELETE FROM "ImpersonationSession" WHERE id = ${live.id}`).rejects.toThrow();
  });

  it("two concurrent closes: exactly one wins and audits; the pointer is cleared", async () => {
    const live = await db.impersonationSession.findFirstOrThrow({ where: { impersonatorId: users.admin!.id, endedAt: null } });
    const results = await Promise.all([
      lib.closeImpersonation({ impersonationId: live.id, reason: "ENDED", actorId: users.admin!.id }),
      lib.closeImpersonation({ impersonationId: live.id, reason: "EXPIRED", actorId: null }),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(state.audits.filter((a) => a.action === "impersonation.ended")).toHaveLength(1);
    const row = await db.impersonationSession.findUniqueOrThrow({ where: { id: live.id } });
    expect(row.endedAt).not.toBeNull();
    expect(row.endedAt!.getTime()).toBeGreaterThanOrEqual(row.startedAt.getTime());
    expect((await db.session.findUniqueOrThrow({ where: { id: sessionId } })).impersonationId).toBeNull();
    // An ended impersonation is never reopened.
    await expect(db.$executeRaw`UPDATE "ImpersonationSession" SET "endedAt" = NULL, "endReason" = NULL WHERE id = ${live.id}`).rejects.toThrow();
  });

  it("closeImpersonationsOf revokes by impersonator or target", async () => {
    const started = await lib.beginImpersonation({
      sessionId,
      impersonatorId: users.admin!.id,
      targetUserId: users.student!.id,
      reason: `Second look ${tag}`,
      now: new Date(),
    });
    expect(await lib.closeImpersonationsOf(users.student!.id, "REVOKED", users.admin!.id)).toBe(1);
    expect((await db.impersonationSession.findUniqueOrThrow({ where: { id: started.id } })).endReason).toBe("REVOKED");
  });
});
