import { randomInt } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * The audit chain after the jsonb round-trip, against a real Postgres
 * (recx_test): rows appended through @recx/db/audit (what audit() and
 * auditMany() call), concurrently and with awkward metadata, verify intact
 * with the paged verifier /super/audit uses; an edited row is found.
 * The suite writes to its own far-future chain day, so no other test's
 * chain is touched, and deletes that day afterwards (AuditLog row DELETE is
 * allowed: it is the retention purge's path). Opt-in: RECX_DB_TESTS=1.
 */
const ENABLED = process.env.RECX_DB_TESTS === "1";
if (ENABLED) {
  process.env.DATABASE_URL = process.env.RECX_TEST_DATABASE_URL ?? "postgresql://recx:recx-dev-only@localhost:5433/recx_test";
}

describe.skipIf(!ENABLED)("audit chain verification against recx_test", () => {
  // A unique far-future UTC day per run (2090-01-01 + up to ~27 years).
  const dayDate = new Date(Date.UTC(2090, 0, 1) + randomInt(0, 10_000) * 86_400_000);
  const day = dayDate.toISOString().slice(0, 10);
  let db: import("@recx/db").Db;
  let support: typeof import("./support/governance-db");
  let append: typeof import("@recx/db/audit").appendAuditEntriesInTx;
  let verify: typeof import("@/server/queries/super-audit").verifyAuditDay;

  const at = (ms: number) => new Date(dayDate.getTime() + 3_600_000 + ms);

  beforeAll(async () => {
    support = await import("./support/governance-db");
    support.assertTestDatabase();
    const { createPrismaClient } = await import("@recx/db");
    db = createPrismaClient({ url: support.TEST_URL, log: [] });
    append = (await import("@recx/db/audit")).appendAuditEntriesInTx;
    verify = (await import("@/server/queries/super-audit")).verifyAuditDay;
    const existing = await db.auditLog.count({ where: { chainDay: day } });
    if (existing > 0) throw new Error(`chain day ${day} is not empty; rerun`);
  });

  afterAll(async () => {
    if (!db) return;
    try {
      await db.auditLog.deleteMany({ where: { chainDay: day } });
      expect(await support.disabledTriggers(db)).toEqual([]);
    } finally {
      await db.$disconnect();
    }
  });

  it("rows appended singly, in batches and concurrently verify after the jsonb round-trip", async () => {
    await db.$transaction((tx) =>
      append(
        tx,
        [
          {
            actorId: null,
            action: "test.audit.single",
            entityType: "Test",
            sensitivity: "SECURITY",
            metadata: { nested: { z: 1, a: [1, 2.5, "x"] }, unicode: "தமிழ் — ✓", empty: {}, nil: null, flag: false },
          },
        ],
        at(0),
      ),
    );
    await db.$transaction((tx) =>
      append(
        tx,
        Array.from({ length: 5 }, (_, i) => ({
          actorId: `actor-${i}`,
          action: "test.audit.batch",
          entityType: "Test",
          entityId: `e${i}`,
          sensitivity: "SENSITIVE" as const,
          metadata: { i, at: at(i).toISOString() },
        })),
        at(1),
      ),
    );
    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        db.$transaction((tx) => append(tx, [{ actorId: null, action: "test.audit.concurrent", entityType: "Test", metadata: { i } }], at(2 + i))),
      ),
    );
    const verdict = await verify(db, day);
    expect(verdict).toMatchObject({ day, rows: 14, intact: true, firstBadId: null });
    const last = await db.auditLog.findFirstOrThrow({ where: { chainDay: day }, orderBy: { id: "desc" } });
    expect(verdict.terminalHash).toBe(last.hash);
  });

  it("an edited row breaks the chain at that row", async () => {
    const rows = await db.auditLog.findMany({ where: { chainDay: day }, orderBy: { id: "asc" }, select: { id: true } });
    const victim = rows[3]!.id;
    // AuditLog is append-only; lift the guard for one statement, in one transaction, then restore it.
    await db.$transaction([
      db.$executeRawUnsafe(`ALTER TABLE "public"."AuditLog" DISABLE TRIGGER "AuditLog_append_only"`),
      db.$executeRawUnsafe(`UPDATE "public"."AuditLog" SET "metadata" = '{"i":999}'::jsonb WHERE "id" = $1`, victim),
      db.$executeRawUnsafe(`ALTER TABLE "public"."AuditLog" ENABLE TRIGGER "AuditLog_append_only"`),
    ]);
    expect(await support.disabledTriggers(db)).toEqual([]);
    const verdict = await verify(db, day);
    expect(verdict.intact).toBe(false);
    expect(verdict.firstBadId).toBe(victim.toString());
  });
});
