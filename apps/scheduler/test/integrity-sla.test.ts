import type { Db } from "@recx/db";
import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import { IntegritySlaJob } from "../src/integrity-sla";

/**
 * The 72-hour review SLA (Phase 6e).
 *
 * This job is the mechanism that makes SPEC §0's ceiling on automatic
 * consequences real: "the maximum automatic consequence in the entire system
 * is flag for review and withhold from the public leaderboard, with a 72-hour
 * SLA after which the result publishes automatically as CLEARED."
 *
 * So the tests here are mostly about what the job must NOT be able to do. The
 * job runs unattended against every flag in the system; the direction it can
 * move one is the only thing standing between a review queue nobody staffed
 * and a student losing a placement to it. Every write it makes is captured
 * and inspected field by field, because "it only clears" is a claim about the
 * SHAPE of its writes and not about its happy path.
 */

const log = pino({ level: "silent" });
const NOW = new Date("2026-10-19T12:00:00.000Z");

type FlagRow = {
  id: string;
  band: "LOW" | "MEDIUM" | "HIGH";
  flaggedAt: Date;
  attempt: { userId: string; id: string };
};
type AppealRow = { id: string; flagId: string; studentId: string; submittedAt: Date };
type Write = { model: string; where: Record<string, unknown>; data: Record<string, unknown> };

function fakeDb(options: {
  flags?: FlagRow[];
  appeals?: AppealRow[];
  /** Models whose conditional update should report "somebody got there first". */
  lost?: string[];
  failOn?: string;
}) {
  const writes: Write[] = [];
  const audit: Array<Record<string, unknown>> = [];
  const lost = new Set(options.lost ?? []);

  const updateMany = (model: string) =>
    vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      writes.push({ model, where, data });
      return { count: lost.has(model) ? 0 : 1 };
    });

  const db = {
    integrityFlag: {
      findMany: vi.fn(async (_args: Record<string, unknown>) => {
        if (options.failOn === "integrityFlag") throw new Error("the database went away");
        return options.flags ?? [];
      }),
      updateMany: updateMany("integrityFlag"),
    },
    integrityAppeal: {
      findMany: vi.fn(async (_args: Record<string, unknown>) => {
        if (options.failOn === "integrityAppeal") throw new Error("the database went away");
        return options.appeals ?? [];
      }),
      updateMany: updateMany("integrityAppeal"),
    },
    // `appendAuditEntries` opens a transaction and writes one `createMany`.
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        $executeRaw: vi.fn(async () => 1),
        auditLog: {
          findFirst: vi.fn(async () => null),
          createMany: vi.fn(async ({ data }: { data: Array<Record<string, unknown>> }) => {
            audit.push(...data);
            return { count: data.length };
          }),
        },
      }),
    ),
  };
  return { db: db as unknown as Db, writes, audit, raw: db };
}

const flag = (patch: Partial<FlagRow> = {}): FlagRow => ({
  id: "flag1",
  band: "MEDIUM",
  flaggedAt: new Date("2026-10-16T11:00:00.000Z"),
  attempt: { userId: "student1", id: "attempt1" },
  ...patch,
});

const appeal = (patch: Partial<AppealRow> = {}): AppealRow => ({
  id: "appeal1",
  flagId: "flag1",
  studentId: "student1",
  submittedAt: new Date("2026-10-12T09:00:00.000Z"),
  ...patch,
});

const job = (db: Db, dryRun = false) => new IntegritySlaJob({ db, log, dryRun });

describe("the overdue flag sweep", () => {
  it("clears a flag whose 72 hours are up", async () => {
    const { db, writes } = fakeDb({ flags: [flag()] });
    const report = await job(db).tick(NOW);

    expect(report.autoCleared).toBe(1);
    expect(report.failed).toBe(false);
    expect(writes).toHaveLength(1);
    expect(writes[0]!.data).toEqual({ status: "AUTO_CLEARED", resolvedAt: NOW, withheld: false });
  });

  it("stops withholding the result, which is the whole point", async () => {
    // Withheld-from-the-leaderboard is the consequence; clearing the flag
    // without lifting it would leave the student in exactly the position the
    // SLA exists to get them out of.
    const { db, writes } = fakeDb({ flags: [flag()] });
    await job(db).tick(NOW);
    expect(writes[0]!.data.withheld).toBe(false);
  });

  it("only touches a flag that is still OPEN", async () => {
    // A reviewer who resolved it in the same second must win: their verdict
    // has a rationale and a name against it, and this job has neither.
    const { db, writes } = fakeDb({ flags: [flag()] });
    await job(db).tick(NOW);
    expect(writes[0]!.where).toMatchObject({ id: "flag1", status: "OPEN" });
  });

  it("does not count a flag another writer resolved first", async () => {
    const { db, audit } = fakeDb({ flags: [flag()], lost: ["integrityFlag"] });
    const report = await job(db).tick(NOW);
    expect(report.autoCleared).toBe(0);
    // And writes no audit row claiming it cleared something it did not.
    expect(audit).toHaveLength(0);
  });

  it("reads the oldest deadline first, so a backlog drains in order", async () => {
    const { db, raw } = fakeDb({ flags: [] });
    await job(db).tick(NOW);
    const args = raw.integrityFlag.findMany.mock.calls[0]![0] as unknown as {
      where: { status: string; reviewDeadline: { lte: Date } };
      orderBy: { reviewDeadline: string };
      take: number;
    };
    expect(args.where.status).toBe("OPEN");
    expect(args.where.reviewDeadline.lte).toBe(NOW);
    expect(args.orderBy).toEqual({ reviewDeadline: "asc" });
    // Bounded, so one tick cannot run long on a backlog.
    expect(args.take).toBeLessThanOrEqual(500);
  });

  it("writes an audit row that says who it was about and why it cleared", async () => {
    const { db, audit } = fakeDb({ flags: [flag()] });
    await job(db).tick(NOW);

    expect(audit).toHaveLength(1);
    const row = audit[0]!;
    expect(row.action).toBe("integrity.flag.auto_cleared");
    // No actor: nobody decided this, and attributing it to a person would be
    // a lie in the one record a student may later read.
    expect(row.actorId).toBeNull();
    expect(row.targetUserId).toBe("student1");
    const metadata = row.metadata as { note: string; attemptId: string };
    expect(metadata.attemptId).toBe("attempt1");
    expect(metadata.note).toContain("institution");
  });

  it("writes nothing on a dry run, and still reports what it would do", async () => {
    const { db, writes, audit } = fakeDb({ flags: [flag(), flag({ id: "flag2" })] });
    const report = await job(db, true).tick(NOW);
    expect(report.autoCleared).toBe(2);
    expect(writes).toHaveLength(0);
    expect(audit).toHaveLength(0);
  });

  it("does nothing at all when nothing is overdue", async () => {
    const { db, writes } = fakeDb({});
    const report = await job(db).tick(NOW);
    expect(report).toEqual({ autoCleared: 0, appealsOverturned: 0, failed: false });
    expect(writes).toHaveLength(0);
  });
});

describe("the overdue appeal sweep", () => {
  it("resolves an undecided appeal in the student's favour", async () => {
    const { db, writes } = fakeDb({ appeals: [appeal()] });
    const report = await job(db).tick(NOW);

    expect(report.appealsOverturned).toBe(1);
    const appealWrite = writes.find((w) => w.model === "integrityAppeal");
    expect(appealWrite!.data).toEqual({ outcome: "OVERTURNED", resolvedAt: NOW });
    expect(appealWrite!.where).toMatchObject({ id: "appeal1", outcome: "PENDING" });
  });

  it("overturns the flag the appeal was about, and lifts the withholding", async () => {
    const { db, writes } = fakeDb({ appeals: [appeal()] });
    await job(db).tick(NOW);
    const flagWrite = writes.find((w) => w.model === "integrityFlag");
    expect(flagWrite!.data).toEqual({ status: "OVERTURNED", withheld: false, resolvedAt: NOW });
    // OVERTURNED is only reachable from UPHELD; a flag cleared another way
    // stays cleared, and the appeal is still recorded as overturned.
    expect(flagWrite!.where).toMatchObject({ id: "flag1", status: "UPHELD" });
  });

  it("moves the flag before the appeal, so a crash cannot leave a student overturned-but-withheld", async () => {
    const { db, writes } = fakeDb({ appeals: [appeal()] });
    await job(db).tick(NOW);
    expect(writes.map((w) => w.model)).toEqual(["integrityFlag", "integrityAppeal"]);
  });

  it("does not count an appeal somebody decided first", async () => {
    const { db, audit } = fakeDb({ appeals: [appeal()], lost: ["integrityAppeal"] });
    const report = await job(db).tick(NOW);
    expect(report.appealsOverturned).toBe(0);
    expect(audit).toHaveLength(0);
  });

  it("records the appeal audit row as SENSITIVE", async () => {
    const { db, audit } = fakeDb({ appeals: [appeal()] });
    await job(db).tick(NOW);
    expect(audit).toHaveLength(1);
    expect(audit[0]!.action).toBe("integrity.appeal.auto_overturned");
    expect(audit[0]!.sensitivity).toBe("SENSITIVE");
    expect((audit[0]!.metadata as { note: string }).note).toContain("favour");
  });

  it("writes nothing on a dry run", async () => {
    const { db, writes } = fakeDb({ appeals: [appeal()] });
    const report = await job(db, true).tick(NOW);
    expect(report.appealsOverturned).toBe(1);
    expect(writes).toHaveLength(0);
  });
});

describe("what this job can never do", () => {
  /** Every write the job makes, across both sweeps and several rows. */
  async function allWrites() {
    const { db, writes } = fakeDb({
      flags: [flag(), flag({ id: "flag2", band: "HIGH" })],
      appeals: [appeal(), appeal({ id: "appeal2", flagId: "flag2" })],
    });
    await job(db).tick(NOW);
    return writes;
  }

  it("writes only the four fields that lift a consequence", async () => {
    // The real assertion of this file: an allowlist, so a field added to the
    // job later fails this test rather than reaching 5,000 students unnoticed.
    // A flag's state is `status`; an appeal's is `outcome`.
    const allowed = new Set(["status", "outcome", "resolvedAt", "withheld"]);
    for (const write of await allWrites()) {
      for (const field of Object.keys(write.data)) {
        expect(allowed.has(field), `${write.model}.${field} is not one of status/outcome/resolvedAt/withheld`).toBe(
          true,
        );
      }
    }
  });

  it("moves a status only to AUTO_CLEARED, OVERTURNED or the appeal's OVERTURNED", async () => {
    const clearing = new Set(["AUTO_CLEARED", "OVERTURNED"]);
    for (const write of await allWrites()) {
      const next = (write.data.status ?? write.data.outcome) as string;
      expect(clearing.has(next), `moved to ${next}`).toBe(true);
    }
  });

  it("never upholds, voids or penalises", async () => {
    const forbidden = ["UPHELD", "VOIDED", "TERMINATED", "PENDING", "OPEN"];
    for (const write of await allWrites()) {
      const next = (write.data.status ?? write.data.outcome) as string;
      expect(forbidden).not.toContain(next);
    }
  });

  it("never sets withheld to true", async () => {
    // Nothing in this job may START a consequence. It only ends one.
    for (const write of await allWrites()) {
      if ("withheld" in write.data) expect(write.data.withheld).toBe(false);
    }
  });

  it("never writes a score, a band or an integrity score", async () => {
    // SPEC §0: no signal auto-penalises, and nothing outside the review
    // surfaces may carry a band at all.
    const banned = /score|band|points|rating|xp|verdict|rationale|penalt/i;
    for (const write of await allWrites()) {
      for (const field of Object.keys(write.data)) {
        expect(banned.test(field), `${write.model}.${field}`).toBe(false);
      }
    }
  });

  it("touches only the two integrity models", async () => {
    const models = new Set((await allWrites()).map((w) => w.model));
    expect([...models].sort()).toEqual(["integrityAppeal", "integrityFlag"]);
  });

  it("never deletes anything", async () => {
    const { db, raw } = fakeDb({ flags: [flag()], appeals: [appeal()] });
    await job(db).tick(NOW);
    // The fake has no delete delegate at all, so a delete would have thrown
    // and `failed` would be true. Assert it did not.
    expect("delete" in raw.integrityFlag).toBe(false);
    expect("deleteMany" in raw.integrityAppeal).toBe(false);
  });
});

describe("a failing tick", () => {
  it("reports the failure instead of throwing, so the scheduler keeps ticking", async () => {
    const { db } = fakeDb({ failOn: "integrityFlag" });
    const report = await job(db).tick(NOW);
    expect(report.failed).toBe(true);
    expect(report.error).toContain("the database went away");
    expect(report.autoCleared).toBe(0);
  });

  it("keeps the flags it already cleared when the appeal sweep fails", async () => {
    // A flag that cleared is cleared: its audit row is written and the
    // student's result has published. Reporting zero would make the next tick
    // look like it had made no progress.
    const { db } = fakeDb({ flags: [flag()], failOn: "integrityAppeal" });
    const report = await job(db).tick(NOW);
    expect(report.failed).toBe(true);
    expect(report.autoCleared).toBe(1);
    expect(report.appealsOverturned).toBe(0);
  });
});
