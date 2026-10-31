import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { XP_KEYS, XP_RULES_VERSION } from "@recx/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Structural decision 4: XP is an append-only ledger. The database refuses
 * every UPDATE and DELETE on "XpEvent" (trigger XpEvent_append_only, migration
 * 20261010001004) — through Prisma and through raw SQL alike — and the unique
 * idempotencyKey makes a retried award a no-op (ON CONFLICT DO NOTHING), which
 * is what the progress engine relies on to award a solve exactly once.
 * Voiding XP is a compensating REVERSAL row, never an edit.
 *
 * DB-backed: runs only with RECX_DB_TESTS=1, against recx_test (never recx).
 * Migrations are applied first with `prisma migrate deploy`
 * (RECX_DB_TESTS_MIGRATE=0 skips that step). The progress engine's own
 * end-to-end test is apps/web/test/progress-apply.db.test.ts.
 */

const RUN = process.env.RECX_DB_TESTS === "1";
const TEST_URL = process.env.RECX_TEST_DATABASE_URL ?? "postgresql://recx:recx-dev-only@127.0.0.1:5433/recx_test";
const DB_PACKAGE_DIR = fileURLToPath(new URL("..", import.meta.url));

const TITLE = RUN
  ? "append-only XP ledger (recx_test)"
  : "append-only XP ledger [skipped: set RECX_DB_TESTS=1 to run against recx_test on localhost:5433]";

if (!RUN) {
  console.info(
    "xp-ledger.db.test.ts skipped: set RECX_DB_TESTS=1 (PostgreSQL recx_test on localhost:5433, or RECX_TEST_DATABASE_URL) to run.",
  );
}

type DbModule = typeof import("../src/index");
type Db = ReturnType<DbModule["createPrismaClient"]>;

function applyMigrations() {
  const require = createRequire(import.meta.url);
  const pkgJson = require.resolve("prisma/package.json");
  const cli = path.join(path.dirname(pkgJson), "build", "index.js");
  execFileSync(process.execPath, [cli, "migrate", "deploy"], {
    cwd: DB_PACKAGE_DIR,
    env: { ...process.env, DATABASE_URL: TEST_URL, DATABASE_URL_DIRECT: TEST_URL },
    stdio: "pipe",
    timeout: 150_000,
  });
}

/** The trigger's refusal, whichever layer surfaces it. */
const REFUSED = /append-only ledger/;

describe.skipIf(!RUN)(TITLE, () => {
  let db: Db;
  const tag = `xl-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
  let userId = "";
  let eventId = 0n;
  const key = () => XP_KEYS.solve(userId, `${tag}-problem`);

  beforeAll(async () => {
    const dbName = new URL(TEST_URL).pathname.replace(/^\//, "");
    if (!dbName.endsWith("_test")) {
      throw new Error(`Refusing to run destructive tests against "${dbName}": the database name must end in _test.`);
    }
    if (process.env.RECX_DB_TESTS_MIGRATE !== "0") applyMigrations();

    process.env.DATABASE_URL = TEST_URL;
    process.env.DATABASE_URL_DIRECT = TEST_URL;
    const mod = await import("../src/index");
    // No error logging: most writes below are expected to be refused.
    db = mod.createPrismaClient({ url: TEST_URL, log: [] });

    userId = (
      await db.user.create({
        data: {
          collegeId: tag,
          email: `${tag}@rec-code.example`,
          firstName: "Ledger",
          lastName: "Tester",
          handle: tag,
        },
        select: { id: true },
      })
    ).id;
    eventId = (
      await db.xpEvent.create({
        data: {
          userId,
          kind: "SOLVE",
          amount: 50,
          idempotencyKey: key(),
          rulesVersion: XP_RULES_VERSION,
          meta: { difficulty: "EASY", assisted: false, capped: false, dailyChallenge: false },
        },
        select: { id: true },
      })
    ).id;
  });

  afterAll(async () => {
    if (!db) return;
    try {
      if (userId) {
        // The trigger refuses every delete, by design. Teardown lifts it inside
        // one transaction (DDL is transactional; no other session sees it off).
        await db.$transaction([
          db.$executeRawUnsafe(`ALTER TABLE "XpEvent" DISABLE TRIGGER "XpEvent_append_only"`),
          db.$executeRawUnsafe(`DELETE FROM "XpEvent" WHERE "userId" = $1`, userId),
          db.$executeRawUnsafe(`ALTER TABLE "XpEvent" ENABLE TRIGGER "XpEvent_append_only"`),
          db.$executeRawUnsafe(`DELETE FROM "User" WHERE "id" = $1`, userId),
        ]);
      }
    } finally {
      await db.$disconnect();
    }
  });

  const amountOf = async () =>
    (await db.xpEvent.findUniqueOrThrow({ where: { id: eventId }, select: { amount: true } })).amount;

  it("the trigger is installed and enabled", async () => {
    const rows = await db.$queryRaw<Array<{ enabled: string }>>`
      SELECT t.tgenabled AS enabled FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      WHERE c.relname = 'XpEvent' AND t.tgname = 'XpEvent_append_only'`;
    expect(rows).toEqual([{ enabled: "O" }]);
  });

  it("refuses UPDATE through Prisma", async () => {
    await expect(db.xpEvent.update({ where: { id: eventId }, data: { amount: 5000 } })).rejects.toThrow(REFUSED);
    await expect(db.xpEvent.updateMany({ where: { userId }, data: { amount: 5000 } })).rejects.toThrow(REFUSED);
    expect(await amountOf()).toBe(50);
  });

  it("refuses UPDATE through raw SQL", async () => {
    await expect(db.$executeRaw`UPDATE "XpEvent" SET "amount" = 5000 WHERE "id" = ${eventId}`).rejects.toThrow(REFUSED);
    await expect(db.$executeRaw`UPDATE "XpEvent" SET "meta" = '{}'::jsonb WHERE "userId" = ${userId}`).rejects.toThrow(
      REFUSED,
    );
    expect(await amountOf()).toBe(50);
  });

  it("refuses DELETE through Prisma and raw SQL", async () => {
    await expect(db.xpEvent.delete({ where: { id: eventId } })).rejects.toThrow(REFUSED);
    await expect(db.xpEvent.deleteMany({ where: { userId } })).rejects.toThrow(REFUSED);
    await expect(db.$executeRaw`DELETE FROM "XpEvent" WHERE "id" = ${eventId}`).rejects.toThrow(REFUSED);
    expect(await db.xpEvent.count({ where: { userId } })).toBe(1);
  });

  it("refuses even a no-op UPDATE, with SQLSTATE check_violation (23514)", async () => {
    const error: unknown = await db.$executeRaw`UPDATE "XpEvent" SET "amount" = "amount" WHERE "id" = ${eventId}`.then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).not.toBeNull();
    const meta = (error as { meta?: Record<string, unknown> }).meta;
    expect(meta?.code).toBe("23514");
  });

  it("an idempotency key is spent once: a retried award inserts nothing", async () => {
    const retry = {
      userId,
      kind: "SOLVE" as const,
      amount: 50,
      idempotencyKey: key(),
      rulesVersion: XP_RULES_VERSION,
    };
    // The progress engine's insert: ON CONFLICT DO NOTHING, returning what was inserted.
    expect(await db.xpEvent.createManyAndReturn({ data: [retry], skipDuplicates: true })).toEqual([]);
    expect((await db.xpEvent.createMany({ data: [retry], skipDuplicates: true })).count).toBe(0);
    expect(
      await db.$executeRaw`
        INSERT INTO "XpEvent" ("userId", "kind", "amount", "idempotencyKey", "rulesVersion")
        VALUES (${userId}, 'SOLVE'::"XpEventKind", 50, ${key()}, ${XP_RULES_VERSION})
        ON CONFLICT ("idempotencyKey") DO NOTHING`,
    ).toBe(0);
    // A plain insert of a spent key is an error, not a second award.
    await expect(db.xpEvent.create({ data: retry })).rejects.toThrow(/Unique constraint/);
    expect(await db.xpEvent.count({ where: { idempotencyKey: key() } })).toBe(1);
  });

  it("voiding XP is a new REVERSAL row, which the trigger allows", async () => {
    const reversal = await db.xpEvent.createManyAndReturn({
      data: [
        {
          userId,
          kind: "REVERSAL",
          amount: -50,
          idempotencyKey: XP_KEYS.reversal(eventId),
          rulesVersion: XP_RULES_VERSION,
          reversesEventId: eventId,
        },
      ],
      skipDuplicates: true,
      select: { amount: true, reversesEventId: true },
    });
    expect(reversal).toEqual([{ amount: -50, reversesEventId: eventId }]);
    expect(await amountOf()).toBe(50);
  });
});
