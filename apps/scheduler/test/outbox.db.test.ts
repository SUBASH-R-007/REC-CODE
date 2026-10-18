import { randomBytes } from "node:crypto";
import { createPrismaClient, type Db } from "@recx/db";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withSingleConnection } from "../src/config";
import type { MailMessage, MailTransport } from "../src/mail";
import { OUTBOX_MAX_ATTEMPTS, OutboxDrainJob } from "../src/outbox";

/**
 * The EmailOutbox drain against a real Postgres (recx_test): due rows and
 * rows whose lease ran out are claimed, sent and marked SENT; future and
 * freshly leased rows wait; a failure backs off; the last failed attempt
 * of security mail is FAILED and SECURITY-audited; two concurrent drains
 * (SKIP LOCKED) never send a row twice. Only this suite's rows are
 * asserted on and deleted. Opt-in: RECX_DB_TESTS=1.
 */
const ENABLED = process.env.RECX_DB_TESTS === "1";
const TEST_URL = process.env.RECX_TEST_DATABASE_URL ?? "postgresql://recx:recx-dev-only@localhost:5433/recx_test";
const log = pino({ level: "silent" });

class FakeTransport implements MailTransport {
  readonly name = "smtp" as const;
  readonly sent: MailMessage[] = [];
  failFor = new Set<string>();
  async send(message: MailMessage): Promise<void> {
    if (this.failFor.has(message.subject)) throw new Error(`550 mailbox <${message.to}> unavailable`);
    this.sent.push(message);
  }
}

describe.skipIf(!ENABLED)("outbox drain against recx_test", () => {
  const tag = `obx-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
  let db: Db;
  let db2: Db;
  let userId = "";
  const subject = (s: string) => `${tag} ${s}`;

  beforeAll(async () => {
    if (!new URL(TEST_URL).pathname.endsWith("_test")) throw new Error("Refusing to run against a non-test database");
    db = createPrismaClient({ url: withSingleConnection(TEST_URL), log: [] });
    db2 = createPrismaClient({ url: withSingleConnection(TEST_URL), log: [] });
    const user = await db.user.create({
      data: { collegeId: tag.toUpperCase(), email: `${tag}@example.test`, handle: tag, firstName: "Out", lastName: "Box", role: "SUPER_ADMIN" },
    });
    userId = user.id;
  });

  afterAll(async () => {
    try {
      if (db && userId) {
        const rows = await db.emailOutbox.findMany({ where: { toUserId: userId }, select: { id: true } });
        await db.auditLog.deleteMany({ where: { action: "email.delivery_failed", entityId: { in: rows.map((r) => r.id) } } });
        await db.emailOutbox.deleteMany({ where: { toUserId: userId } });
        await db.user.delete({ where: { id: userId } });
      }
    } finally {
      await db?.$disconnect();
      await db2?.$disconnect();
    }
  });

  const enqueue = (s: string, fields: Record<string, unknown> = {}) =>
    db.emailOutbox.create({
      data: { kind: "security.test", toUserId: userId, subject: subject(s), bodyText: `body ${tag}`, ...fields },
    });

  it("sends due and lease-expired rows; future and leased rows wait", async () => {
    const now = Date.now();
    const due = await enqueue("due");
    const stale = await enqueue("stale", { status: "SENDING", attempts: 1, lockedUntil: new Date(now - 60_000) });
    const future = await enqueue("future", { nextAttemptAt: new Date(now + 3_600_000) });
    const leased = await enqueue("leased", { status: "SENDING", attempts: 1, lockedUntil: new Date(now + 60_000) });
    const transport = new FakeTransport();
    await new OutboxDrainJob({ db, log, dryRun: false, transport, batch: 50 }).tick();

    const mine = new Map((await db.emailOutbox.findMany({ where: { toUserId: userId } })).map((r) => [r.id, r]));
    expect(mine.get(due.id)).toMatchObject({ status: "SENT", attempts: 1, lockedUntil: null, transport: "smtp" });
    expect(mine.get(stale.id)).toMatchObject({ status: "SENT", attempts: 2 });
    expect(mine.get(future.id)).toMatchObject({ status: "PENDING", attempts: 0 });
    expect(mine.get(leased.id)).toMatchObject({ status: "SENDING", attempts: 1 });
    const mySends = transport.sent.filter((m) => m.subject.startsWith(tag));
    expect(mySends.map((m) => m.subject).sort()).toEqual([subject("due"), subject("stale")].sort());
    expect(mySends.every((m) => m.to === `${tag}@example.test`)).toBe(true);
  });

  it("backs off after a failure, and gives up (FAILED + SECURITY audit) after the last attempt", async () => {
    const retry = await enqueue("retry");
    const last = await enqueue("last", { attempts: OUTBOX_MAX_ATTEMPTS - 1 });
    const transport = new FakeTransport();
    transport.failFor = new Set([subject("retry"), subject("last")]);
    await new OutboxDrainJob({ db, log, dryRun: false, transport, batch: 50 }).tick();

    const r = await db.emailOutbox.findUniqueOrThrow({ where: { id: retry.id } });
    expect(r).toMatchObject({ status: "PENDING", attempts: 1, lockedUntil: null });
    expect(r.nextAttemptAt.getTime()).toBeGreaterThan(Date.now() + 20_000);
    expect(r.lastError).toContain("<address>");
    expect(r.lastError).not.toContain("@example.test");

    const l = await db.emailOutbox.findUniqueOrThrow({ where: { id: last.id } });
    expect(l).toMatchObject({ status: "FAILED", attempts: OUTBOX_MAX_ATTEMPTS });
    const audit = await db.auditLog.findMany({ where: { action: "email.delivery_failed", entityId: last.id } });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ sensitivity: "SECURITY", actorId: null, targetUserId: userId });
    expect(JSON.stringify(audit[0]!.metadata)).not.toContain("@example.test");
  });

  it("two concurrent drains never send a row twice", async () => {
    const rows = await Promise.all(Array.from({ length: 12 }, (_, i) => enqueue(`race-${i}`)));
    const t1 = new FakeTransport();
    const t2 = new FakeTransport();
    await Promise.all([
      new OutboxDrainJob({ db, log, dryRun: false, transport: t1, batch: 7 }).tick(),
      new OutboxDrainJob({ db: db2, log, dryRun: false, transport: t2, batch: 7 }).tick(),
    ]);
    // A third pass picks up anything neither batch reached.
    await new OutboxDrainJob({ db, log, dryRun: false, transport: t1, batch: 50 }).tick();
    const raceSubjects = new Set(rows.map((r) => r.subject));
    const sent = [...t1.sent, ...t2.sent].map((m) => m.subject).filter((s) => raceSubjects.has(s));
    expect(sent.sort()).toEqual([...raceSubjects].sort());
    const states = await db.emailOutbox.findMany({ where: { id: { in: rows.map((r) => r.id) } }, select: { status: true, attempts: true } });
    expect(states.every((s) => s.status === "SENT" && s.attempts === 1)).toBe(true);
  });

  it("stops sending when the tick's budget runs out; untried rows go back to PENDING with their attempt refunded", async () => {
    const rows = [await enqueue("budget-1"), await enqueue("budget-2"), await enqueue("budget-3")];
    const transport = new FakeTransport();
    // A fake clock: every reading moves 100 ms on; the budget allows one send.
    let t = 0;
    const now = () => (t += 100);
    const report = await new OutboxDrainJob({ db, log, dryRun: false, transport, batch: 50, sendBudgetMs: 150, now }).tick();
    expect(report.deferred).toBeGreaterThanOrEqual(2);
    const states = await db.emailOutbox.findMany({ where: { id: { in: rows.map((r) => r.id) } }, orderBy: { createdAt: "asc" } });
    expect(states.filter((r) => r.status === "SENT")).toHaveLength(1);
    const back = states.filter((r) => r.status === "PENDING");
    expect(back).toHaveLength(2);
    expect(back.every((r) => r.attempts === 0 && r.lockedUntil === null)).toBe(true);
    // The next tick (no budget pressure) sends them.
    await new OutboxDrainJob({ db, log, dryRun: false, transport, batch: 50 }).tick();
    const after = await db.emailOutbox.findMany({ where: { id: { in: rows.map((r) => r.id) } } });
    expect(after.every((r) => r.status === "SENT" && r.attempts === 1)).toBe(true);
  });

  it("a row reclaimed by another instance mid-send is not finished by the first claimer", async () => {
    const row = await enqueue("reclaimed");
    const transport = new FakeTransport();
    const slowSend = transport.send.bind(transport);
    transport.send = async (message) => {
      if (message.subject === subject("reclaimed")) {
        // Our lease ran out during a slow send and another instance claimed the row.
        await db2.$executeRaw`UPDATE "EmailOutbox" SET attempts = attempts + 1,
          "lockedUntil" = (now() AT TIME ZONE 'UTC') + interval '2 minutes' WHERE id = ${row.id}`;
      }
      await slowSend(message);
    };
    await new OutboxDrainJob({ db, log, dryRun: false, transport, batch: 50 }).tick();
    // Still the other instance's: SENDING under its claim (attempts 2), not SENT by us.
    expect(await db.emailOutbox.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({ status: "SENDING", attempts: 2 });
  });

  it("a dry run claims and writes nothing", async () => {
    const row = await enqueue("dry");
    await new OutboxDrainJob({ db, log, dryRun: true, transport: new FakeTransport() }).tick();
    expect(await db.emailOutbox.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({ status: "PENDING", attempts: 0 });
  });
});
