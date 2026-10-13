import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Voiding XP against a real Postgres (recx_test): a REVERSAL row pointing at
 * the original (reversesEventId, key "void:{id}"), all three period buckets
 * and UserStats.xpTotal lowered, a second void refused, the original row
 * unchanged (the ledger is append-only). Opt-in: RECX_DB_TESTS=1.
 */
const ENABLED = process.env.RECX_DB_TESTS === "1";

const state = vi.hoisted(() => {
  if (process.env.RECX_DB_TESTS === "1") {
    process.env.DATABASE_URL =
      process.env.RECX_TEST_DATABASE_URL ?? "postgresql://recx:recx-dev-only@localhost:5433/recx_test";
  }
  return { user: null as unknown, audits: [] as Array<Record<string, unknown>> };
});

vi.mock("@/lib/auth/session", () => ({ getCurrentUser: async () => state.user }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/lib/ip", () => ({ requestIpHash: async () => null }));
vi.mock("@/lib/audit", () => ({
  audit: async (entry: Record<string, unknown>) => {
    state.audits.push(entry);
  },
}));

describe.skipIf(!ENABLED)("voidXpEvent against recx_test", () => {
  const tag = `xpv-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
  let db: (typeof import("@/lib/db"))["db"];
  let support: typeof import("./support/governance-db");
  let voidXpEvent: (typeof import("@/server/actions/super-xp"))["voidXpEvent"];
  let users: Awaited<ReturnType<typeof support.createUsers>>;
  let eventId: bigint;
  const occurredAt = new Date();

  beforeAll(async () => {
    support = await import("./support/governance-db");
    support.assertTestDatabase();
    db = (await import("@/lib/db")).db;
    voidXpEvent = (await import("@/server/actions/super-xp")).voidXpEvent;
    const { bucketKeys } = await import("@/lib/progress/rules");
    users = await support.createUsers(db, tag, { admin: { role: "SUPER_ADMIN" }, student: { role: "STUDENT" } });
    const student = users.student!.id;
    const event = await db.xpEvent.create({
      data: {
        userId: student,
        kind: "SOLVE",
        amount: 120,
        idempotencyKey: `solve:${student}:${tag}`,
        rulesVersion: 1,
        occurredAt,
      },
    });
    eventId = event.id;
    for (const { period, periodKey } of bucketKeys(occurredAt)) {
      await db.xpBucket.create({ data: { userId: student, period, periodKey, xp: 200, lastXpAt: occurredAt } });
    }
    await db.userStats.create({ data: { userId: student, xpTotal: 200 } });
    state.user = { ...users.admin!, status: "ACTIVE" };
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

  it("writes a REVERSAL, lowers the three buckets and xpTotal, and leaves the original row alone", async () => {
    const before = await db.xpEvent.findUniqueOrThrow({ where: { id: eventId } });
    const result = await voidXpEvent({ eventId: eventId.toString(), reason: `Copied solution ${tag}` });
    expect(result).toEqual({ ok: true, data: { reversalOf: eventId.toString(), amount: 120 } });

    const reversal = await db.xpEvent.findUniqueOrThrow({ where: { idempotencyKey: `void:${eventId}` } });
    expect(reversal).toMatchObject({
      kind: "REVERSAL",
      amount: -120,
      reversesEventId: eventId,
      grantedById: users.admin!.id,
      userId: users.student!.id,
    });
    const buckets = await db.xpBucket.findMany({ where: { userId: users.student!.id } });
    expect(buckets).toHaveLength(3);
    expect(buckets.every((b) => b.xp === 80)).toBe(true);
    expect((await db.userStats.findUniqueOrThrow({ where: { userId: users.student!.id } })).xpTotal).toBe(80);
    expect(await db.xpEvent.findUniqueOrThrow({ where: { id: eventId } })).toEqual(before);
    expect(state.audits).toEqual([
      expect.objectContaining({ action: "xp.voided", sensitivity: "SENSITIVE", targetUserId: users.student!.id }),
    ]);
  });

  it("refuses a second void and a void of the reversal itself", async () => {
    const again = await voidXpEvent({ eventId: eventId.toString(), reason: `Copied solution ${tag}` });
    expect(again).toEqual({ ok: false, error: "This XP event has already been voided." });
    const reversal = await db.xpEvent.findUniqueOrThrow({ where: { idempotencyKey: `void:${eventId}` } });
    const nested = await voidXpEvent({ eventId: reversal.id.toString(), reason: `Copied solution ${tag}` });
    expect(nested.ok).toBe(false);
    expect((await db.userStats.findUniqueOrThrow({ where: { userId: users.student!.id } })).xpTotal).toBe(80);
  });
});
