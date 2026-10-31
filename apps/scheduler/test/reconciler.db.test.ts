import { createPrismaClient, type Db, type Prisma } from "@recx/db";
import { JUDGE_LANES, JUDGE_RETRY, LANE_PRIORITY, LIMITS, QUEUE_NAME } from "@recx/shared";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RETENTION_DELETE_BATCH, RETENTION_SETTING_KEY, SELF_CHECK_STALE_RESTRICTION } from "../src/classify";
import { withSingleConnection } from "../src/config";
import { BullJudgeQueues } from "../src/queues";
import { LOCK_NAMESPACE, RECONCILER_LOCK, runReconcilerTick } from "../src/reconciler";
import { FakeQueues } from "./support/fake-queues";

/**
 * The reconciler against a real Postgres (database recx_test, migrations
 * applied). Opt-in: RECX_DB_TESTS=1. Redis is replaced by FakeQueues so the
 * test never touches queues a local judge worker may be consuming; with
 * RECX_REDIS_TESTS=1 as well, one block also ticks against real BullMQ
 * queues under a throwaway key prefix.
 *
 * The tick acts on every row in the database, so assertions only look at
 * rows this file created (ids prefixed with a per-run tag), and cleanup
 * deletes only those. The one global row touched is PlatformSetting
 * `retention`: it is set aside before the tests and restored afterwards.
 */
const ENABLED = process.env.RECX_DB_TESTS === "1";
const REDIS_ENABLED = process.env.RECX_REDIS_TESTS === "1";
const TEST_URL = process.env.RECX_TEST_DATABASE_URL ?? "postgresql://recx:recx-dev-only@127.0.0.1:5433/recx_test";
const REDIS_URL = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const log = pino({ level: "silent" });

describe.skipIf(!ENABLED)("reconciler against recx_test", () => {
  const tag = `schedtest-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const id = (name: string) => `${tag}-${name}`;
  let db: Db;
  let savedRetention: { value: Prisma.JsonValue } | null = null;

  async function dbNow(): Promise<Date> {
    const rows = await db.$queryRaw<{ now: Date }[]>`SELECT (now() AT TIME ZONE 'UTC') AS now`;
    return rows[0]!.now;
  }
  const at = (base: Date, offsetMs: number) => new Date(base.getTime() + offsetMs);
  const judging = { status: "JUDGING", judgeState: "RUNNING", claimToken: "t".repeat(32) } as const;

  function submission(name: string, data: Partial<Prisma.SubmissionUncheckedCreateInput>) {
    return db.submission.create({
      data: {
        id: id(name),
        userId: id("user"),
        problemId: id("problem"),
        problemVersionId: id("pv"),
        languageConfigId: id("lang"),
        language: "cpp",
        sourceSha256: "0".repeat(64),
        sourceBytes: 1,
        ...data,
      },
    });
  }

  function run(name: string, data: Partial<Prisma.RunRequestUncheckedCreateInput>) {
    return db.runRequest.create({
      data: {
        id: id(name),
        userId: id("user"),
        problemVersionId: id("pv"),
        languageConfigId: id("lang"),
        language: "cpp",
        source: "int main() {}",
        expiresAt: new Date(Date.now() + 24 * 60 * MIN),
        ...data,
      },
    });
  }

  function validation(name: string, data: Partial<Prisma.ValidationRunUncheckedCreateInput>) {
    return db.validationRun.create({
      data: {
        id: id(name),
        problemVersionId: id("pv"),
        referenceSolutionId: id("ref"),
        language: "cpp",
        languageConfigId: id("lang"),
        ...data,
      },
    });
  }

  function node(
    name: string,
    status: "ONLINE" | "DRAINING" | "OFFLINE" | "QUARANTINED",
    lastHeartbeatAt: Date | null,
    extra: Partial<Prisma.JudgeNodeUncheckedCreateInput> = {},
  ) {
    return db.judgeNode.create({
      data: { id: id(name), hostname: "scheduler-test", tokenHash: "x", status, lastHeartbeatAt, ...extra },
    });
  }

  /** Test-detail rows for submission `owner`, created `ageMs` before the database clock. */
  async function details(owner: string, rows: Array<{ testIndex: number; ageMs: number }>) {
    const now = await dbNow();
    await db.submissionTestDetail.createMany({
      data: rows.map((r) => ({
        id: id(`${owner}-d${r.testIndex}`),
        submissionId: id(owner),
        testIndex: r.testIndex,
        stdout: "visible output",
        createdAt: at(now, -r.ageMs),
      })),
    });
  }

  async function setRetention(value: Prisma.InputJsonValue | null): Promise<void> {
    if (value === null) {
      await db.platformSetting.deleteMany({ where: { key: RETENTION_SETTING_KEY } });
      return;
    }
    await db.platformSetting.upsert({
      where: { key: RETENTION_SETTING_KEY },
      create: { key: RETENTION_SETTING_KEY, value },
      update: { value },
    });
  }

  const sub = (name: string) => db.submission.findUniqueOrThrow({ where: { id: id(name) } });
  const runRow = (name: string) => db.runRequest.findUnique({ where: { id: id(name) } });
  const vrun = (name: string) => db.validationRun.findUniqueOrThrow({ where: { id: id(name) } });
  const nodeRow = (name: string) => db.judgeNode.findUniqueOrThrow({ where: { id: id(name) } });
  const detailIndexes = async (owner: string) =>
    (await db.submissionTestDetail.findMany({ where: { submissionId: id(owner) }, orderBy: { testIndex: "asc" } })).map(
      (d) => d.testIndex,
    );
  const addsFor = (q: FakeQueues, name: string) => q.added.filter((a) => a.data.id === id(name));
  const eventsFor = (q: FakeQueues, name: string) => q.published.filter((p) => p.id === id(name)).map((p) => p.event);

  beforeAll(async () => {
    if (!new URL(TEST_URL).pathname.endsWith("_test")) {
      throw new Error(`Refusing to run the reconciler test against a non-test database: ${new URL(TEST_URL).pathname}`);
    }
    db = createPrismaClient({ url: withSingleConnection(TEST_URL) });
    // A legal hold left in recx_test would suspend the purges asserted below.
    savedRetention = await db.platformSetting.findUnique({ where: { key: RETENTION_SETTING_KEY }, select: { value: true } });
    await setRetention(null);

    await db.user.create({
      data: {
        id: id("user"),
        collegeId: tag,
        email: `${tag}@scheduler.test`,
        firstName: "Scheduler",
        lastName: "Test",
        handle: tag,
      },
    });
    await db.languageConfig.create({
      data: { id: id("lang"), key: "cpp", toolchainId: tag, version: "13.2.0", label: "C++17", runtime: {} },
    });
    await db.problem.create({
      data: { id: id("problem"), slug: tag, displayCode: tag, title: "Scheduler test", difficulty: "EASY" },
    });
    await db.problemVersion.create({
      data: {
        id: id("pv"),
        problemId: id("problem"),
        revision: 1,
        title: "Scheduler test",
        difficulty: "EASY",
        statementMd: "Scheduler test.",
        ioMode: "STDIN",
        timeLimitMs: 1000,
      },
    });
    // The version is a draft (frozenAt null), so a reference solution may be added.
    await db.referenceSolution.create({
      data: { id: id("ref"), problemVersionId: id("pv"), language: "cpp", source: "int main() {}", expectedVerdict: "AC" },
    });
  });

  afterAll(async () => {
    if (!db) return;
    // SubmissionTestDetail rows cascade with their submissions.
    await db.submission.deleteMany({ where: { userId: id("user") } });
    await db.runRequest.deleteMany({ where: { userId: id("user") } });
    await db.validationRun.deleteMany({ where: { problemVersionId: id("pv") } });
    await db.referenceSolution.deleteMany({ where: { id: id("ref") } });
    await db.judgeNode.deleteMany({ where: { id: { startsWith: tag } } });
    await db.problemVersion.deleteMany({ where: { id: id("pv") } });
    await db.problem.deleteMany({ where: { id: id("problem") } });
    await db.languageConfig.deleteMany({ where: { id: id("lang") } });
    await db.user.deleteMany({ where: { id: id("user") } });
    await setRetention(savedRetention ? (savedRetention.value as Prisma.InputJsonValue) : null);
    await db.$disconnect();
  });

  it("dispatches, reclaims, fails, sweeps nodes and purges runs in one tick", async () => {
    const now = await dbNow();
    const old = at(now, -MIN);

    await node("live", "ONLINE", now);
    await node("dead", "ONLINE", at(now, -MIN));
    await node("draining", "DRAINING", at(now, -MIN));
    await node("quarantined", "QUARANTINED", at(now, -60 * MIN));

    await submission("queued-old", { queuedAt: old });
    await submission("queued-young", { queuedAt: now });
    await submission("queued-completed", { queuedAt: old, lane: "CONTEST", judgeState: "DISPATCHED" });
    await submission("queued-waiting", { queuedAt: old, lane: "ASSESSMENT" });
    await submission("queued-exhausted", { queuedAt: old, attemptCount: JUDGE_RETRY.attempts });
    await submission("lease-requeue", { ...judging, leaseExpiresAt: at(now, -1000), attemptCount: 1, claimedByNodeId: id("live") });
    await submission("lease-exhausted", {
      ...judging,
      leaseExpiresAt: at(now, -1000),
      attemptCount: JUDGE_RETRY.attempts,
      claimedByNodeId: id("live"),
    });
    await submission("lease-live", { ...judging, leaseExpiresAt: at(now, MIN), attemptCount: 1, claimedByNodeId: id("live") });
    await submission("dead-node", { ...judging, leaseExpiresAt: at(now, MIN), attemptCount: 1, claimedByNodeId: id("dead") });

    await run("run-queued-old", { createdAt: old });
    await run("run-lease-requeue", { ...judging, leaseExpiresAt: at(now, -1000), attemptCount: 0 });
    await run("run-expired", { status: "DONE", judgeState: "DONE", expiresAt: at(now, -1000) });
    await run("run-fresh", { status: "DONE", judgeState: "DONE" });

    const q = new FakeQueues();
    q.setState("CONTEST", id("queued-completed"), "completed");
    q.setState("ASSESSMENT", id("queued-waiting"), "waiting");

    const report = await runReconcilerTick({ db, queues: q, log });
    expect(report.lock).toBe("acquired");
    expect(report.dryRun).toBe(false);

    // (c) node sweep
    expect((await nodeRow("live")).status).toBe("ONLINE");
    expect((await nodeRow("dead")).status).toBe("OFFLINE");
    expect((await nodeRow("draining")).status).toBe("OFFLINE");
    expect((await nodeRow("quarantined")).status).toBe("QUARANTINED");
    expect(report.nodesOffline).toBeGreaterThanOrEqual(2);
    expect(report.leasesExpiredByNodeSweep).toBeGreaterThanOrEqual(1);

    // (a) QUEUED rows
    expect((await sub("queued-old")).judgeState).toBe("DISPATCHED");
    expect(addsFor(q, "queued-old")).toEqual([{ lane: "PRACTICE", data: { kind: "submission", id: id("queued-old") } }]);

    expect((await sub("queued-young")).judgeState).toBe("PENDING");
    expect(addsFor(q, "queued-young")).toEqual([]);

    expect(q.removed).toContainEqual({ lane: "CONTEST", id: id("queued-completed") });
    expect(addsFor(q, "queued-completed")).toHaveLength(1);

    expect((await sub("queued-waiting")).judgeState).toBe("DISPATCHED");
    expect(addsFor(q, "queued-waiting")).toEqual([]);

    const exhaustedQueued = await sub("queued-exhausted");
    expect(exhaustedQueued).toMatchObject({ status: "INTERNAL_ERROR", judgeState: "FAILED", verdict: "IE" });
    expect(exhaustedQueued.judgedAt).not.toBeNull();
    expect(addsFor(q, "queued-exhausted")).toEqual([]);
    expect(eventsFor(q, "queued-exhausted")).toEqual([{ type: "final" }]);

    // (b) lapsed leases
    expect(await sub("lease-requeue")).toMatchObject({
      status: "QUEUED",
      judgeState: "DISPATCHED",
      claimToken: null,
      claimedByNodeId: null,
      leaseExpiresAt: null,
      attemptCount: 1,
    });
    expect(addsFor(q, "lease-requeue")).toHaveLength(1);
    expect(eventsFor(q, "lease-requeue")).toEqual([{ type: "state", state: "QUEUED" }]);

    expect(await sub("lease-exhausted")).toMatchObject({
      status: "INTERNAL_ERROR",
      judgeState: "FAILED",
      verdict: "IE",
      claimToken: null,
    });
    expect(addsFor(q, "lease-exhausted")).toEqual([]);
    expect(eventsFor(q, "lease-exhausted")).toEqual([{ type: "final" }]);

    expect(await sub("lease-live")).toMatchObject({ status: "JUDGING", judgeState: "RUNNING", claimToken: "t".repeat(32) });

    // The dead node's lease was expired by (c) and reclaimed by (b) in the same tick.
    expect(await sub("dead-node")).toMatchObject({ status: "QUEUED", judgeState: "DISPATCHED", claimToken: null });
    expect(addsFor(q, "dead-node")).toHaveLength(1);

    // Runs: RUN lane, kind "run".
    expect((await runRow("run-queued-old"))?.judgeState).toBe("DISPATCHED");
    expect(addsFor(q, "run-queued-old")).toEqual([{ lane: "RUN", data: { kind: "run", id: id("run-queued-old") } }]);
    expect(await runRow("run-lease-requeue")).toMatchObject({ status: "QUEUED", judgeState: "DISPATCHED", claimToken: null });
    expect(addsFor(q, "run-lease-requeue")).toEqual([{ lane: "RUN", data: { kind: "run", id: id("run-lease-requeue") } }]);

    // (d) TTL
    expect(await runRow("run-expired")).toBeNull();
    expect(await runRow("run-fresh")).not.toBeNull();
    expect(report.runsDeleted).toBeGreaterThanOrEqual(1);
    expect(report.retention.hold).toBe("none");

    // A second tick finds every job live and changes nothing.
    const again = await runReconcilerTick({ db, queues: q, log });
    expect(again.lock).toBe("acquired");
    for (const name of ["queued-old", "queued-completed", "lease-requeue", "dead-node", "run-queued-old"]) {
      expect(addsFor(q, name)).toHaveLength(1);
    }
    expect((await sub("queued-exhausted")).status).toBe("INTERNAL_ERROR");
  });

  it("reconciles validation runs exactly like submissions, on the REJUDGE lane", async () => {
    const now = await dbNow();
    const old = at(now, -MIN);

    await node("v-live", "ONLINE", now);
    await node("v-dead", "ONLINE", at(now, -MIN));

    await validation("v-queued-old", { createdAt: old });
    await validation("v-queued-young", { createdAt: now });
    await validation("v-queued-completed", { createdAt: old, judgeState: "DISPATCHED" });
    await validation("v-queued-exhausted", { createdAt: old, attemptCount: JUDGE_RETRY.attempts });
    await validation("v-lease-requeue", { ...judging, leaseExpiresAt: at(now, -1000), attemptCount: 1, claimedByNodeId: id("v-live") });
    await validation("v-lease-exhausted", {
      ...judging,
      leaseExpiresAt: at(now, -1000),
      attemptCount: JUDGE_RETRY.attempts,
      claimedByNodeId: id("v-live"),
    });
    await validation("v-lease-live", { ...judging, leaseExpiresAt: at(now, MIN), attemptCount: 1, claimedByNodeId: id("v-live") });
    await validation("v-dead-node", { ...judging, leaseExpiresAt: at(now, MIN), attemptCount: 2, claimedByNodeId: id("v-dead") });

    const q = new FakeQueues();
    q.setState("REJUDGE", id("v-queued-completed"), "completed");

    const report = await runReconcilerTick({ db, queues: q, log });
    expect(report.lock).toBe("acquired");

    // (a) QUEUED: kind "validation" on the REJUDGE queue.
    expect((await vrun("v-queued-old")).judgeState).toBe("DISPATCHED");
    expect(addsFor(q, "v-queued-old")).toEqual([{ lane: "REJUDGE", data: { kind: "validation", id: id("v-queued-old") } }]);

    expect((await vrun("v-queued-young")).judgeState).toBe("PENDING");
    expect(addsFor(q, "v-queued-young")).toEqual([]);

    expect(q.removed).toContainEqual({ lane: "REJUDGE", id: id("v-queued-completed") });
    expect(addsFor(q, "v-queued-completed")).toEqual([
      { lane: "REJUDGE", data: { kind: "validation", id: id("v-queued-completed") } },
    ]);

    // Attempts exhausted while QUEUED: INTERNAL_ERROR / FAILED / IE, outcome FAILED.
    const exhaustedQueued = await vrun("v-queued-exhausted");
    expect(exhaustedQueued).toMatchObject({
      status: "INTERNAL_ERROR",
      judgeState: "FAILED",
      verdict: "IE",
      outcome: "FAILED",
      claimToken: null,
      leaseExpiresAt: null,
    });
    expect(exhaustedQueued.judgedAt).not.toBeNull();
    expect(addsFor(q, "v-queued-exhausted")).toEqual([]);
    expect(q.published.filter((p) => p.id === id("v-queued-exhausted"))).toEqual([
      { kind: "validation", id: id("v-queued-exhausted"), event: { type: "final" } },
    ]);

    // (b) lapsed leases
    expect(await vrun("v-lease-requeue")).toMatchObject({
      status: "QUEUED",
      judgeState: "DISPATCHED",
      outcome: "PENDING",
      claimToken: null,
      claimedByNodeId: null,
      leaseExpiresAt: null,
      attemptCount: 1,
    });
    expect(addsFor(q, "v-lease-requeue")).toEqual([
      { lane: "REJUDGE", data: { kind: "validation", id: id("v-lease-requeue") } },
    ]);
    expect(q.published.filter((p) => p.id === id("v-lease-requeue"))).toEqual([
      { kind: "validation", id: id("v-lease-requeue"), event: { type: "state", state: "QUEUED" } },
    ]);

    const exhaustedLease = await vrun("v-lease-exhausted");
    expect(exhaustedLease).toMatchObject({
      status: "INTERNAL_ERROR",
      judgeState: "FAILED",
      verdict: "IE",
      outcome: "FAILED",
      claimToken: null,
    });
    expect(exhaustedLease.judgedAt).not.toBeNull();
    expect(addsFor(q, "v-lease-exhausted")).toEqual([]);
    expect(eventsFor(q, "v-lease-exhausted")).toEqual([{ type: "final" }]);

    expect(await vrun("v-lease-live")).toMatchObject({
      status: "JUDGING",
      judgeState: "RUNNING",
      outcome: "PENDING",
      claimToken: "t".repeat(32),
    });
    expect(addsFor(q, "v-lease-live")).toEqual([]);

    // (c) the node sweep expires a dead node's validation lease too; (b) reclaims it.
    expect((await nodeRow("v-dead")).status).toBe("OFFLINE");
    expect(await vrun("v-dead-node")).toMatchObject({
      status: "QUEUED",
      judgeState: "DISPATCHED",
      claimToken: null,
      claimedByNodeId: null,
      attemptCount: 2,
    });
    expect(addsFor(q, "v-dead-node")).toEqual([{ lane: "REJUDGE", data: { kind: "validation", id: id("v-dead-node") } }]);

    // Nothing of this kind ever lands on another lane.
    const ours = q.added.filter((a) => a.data.id.startsWith(`${tag}-v-`));
    expect(ours.every((a) => a.lane === "REJUDGE" && a.data.kind === "validation")).toBe(true);

    // A second tick finds every job live and changes nothing.
    await runReconcilerTick({ db, queues: q, log });
    for (const name of ["v-queued-old", "v-queued-completed", "v-lease-requeue", "v-dead-node"]) {
      expect(addsFor(q, name)).toHaveLength(1);
    }
    expect((await vrun("v-queued-exhausted")).outcome).toBe("FAILED");
  });

  it("re-enqueues submissions on their own lane's queue, every lane", async () => {
    const now = await dbNow();
    for (const lane of JUDGE_LANES) {
      await submission(`lane-queued-${lane}`, { queuedAt: at(now, -MIN), lane });
      await submission(`lane-lease-${lane}`, { ...judging, lane, leaseExpiresAt: at(now, -1000), attemptCount: 1 });
    }

    const q = new FakeQueues();
    await runReconcilerTick({ db, queues: q, log });

    for (const lane of JUDGE_LANES) {
      for (const name of [`lane-queued-${lane}`, `lane-lease-${lane}`]) {
        expect(addsFor(q, name)).toEqual([{ lane, data: { kind: "submission", id: id(name) } }]);
        expect((await sub(name)).judgeState).toBe("DISPATCHED");
      }
    }
  });

  it("withdraws sensitive lanes from an ONLINE node whose self-check went stale", async () => {
    const now = await dbNow();
    const stale = at(now, -(LIMITS.selfCheck.staleAfterMs + MIN));
    const fresh = at(now, -HOUR);
    const restrictions = ["calibration off the fleet median"];

    await node("lanes-stale", "ONLINE", now, { sensitiveLanesOk: true, lastSelfCheckAt: stale });
    await node("lanes-never", "ONLINE", now, { sensitiveLanesOk: true, lastSelfCheckAt: null });
    await node("lanes-fresh", "ONLINE", now, { sensitiveLanesOk: true, lastSelfCheckAt: fresh });
    await node("lanes-already", "ONLINE", now, { sensitiveLanesOk: false, lastSelfCheckAt: stale, laneRestrictions: restrictions });
    await node("lanes-draining", "DRAINING", now, { sensitiveLanesOk: true, lastSelfCheckAt: stale });
    await node("lanes-dead", "ONLINE", at(now, -MIN), { sensitiveLanesOk: true, lastSelfCheckAt: stale });

    const report = await runReconcilerTick({ db, queues: new FakeQueues(), log });
    expect(report.nodesLaneRestricted).toBeGreaterThanOrEqual(2);

    for (const name of ["lanes-stale", "lanes-never"]) {
      expect(await nodeRow(name)).toMatchObject({
        status: "ONLINE",
        sensitiveLanesOk: false,
        laneRestrictions: [SELF_CHECK_STALE_RESTRICTION],
      });
    }
    expect(await nodeRow("lanes-fresh")).toMatchObject({ status: "ONLINE", sensitiveLanesOk: true, laneRestrictions: [] });
    // Already withheld: the web app's own reason is left alone.
    expect(await nodeRow("lanes-already")).toMatchObject({ sensitiveLanesOk: false, laneRestrictions: restrictions });
    // Only ONLINE nodes; a node going OFFLINE now is recomputed at its next heartbeat.
    expect(await nodeRow("lanes-draining")).toMatchObject({ status: "DRAINING", sensitiveLanesOk: true });
    expect(await nodeRow("lanes-dead")).toMatchObject({ status: "OFFLINE", sensitiveLanesOk: true });

    // Idempotent: a second tick has nothing left to restrict among these.
    const again = await runReconcilerTick({ db, queues: new FakeQueues(), log });
    expect(again.lock).toBe("acquired");
    expect((await nodeRow("lanes-fresh")).sensitiveLanesOk).toBe(true);
  });

  it("purges SubmissionTestDetail older than 30 days and keeps the rest", async () => {
    const days = LIMITS.detail.retentionDays;
    await submission("details", { status: "DONE", judgeState: "DONE", verdict: "WA" });
    await details("details", [
      { testIndex: 0, ageMs: 31 * DAY },
      { testIndex: 1, ageMs: days * DAY + MIN },
      { testIndex: 2, ageMs: days * DAY - MIN },
      { testIndex: 3, ageMs: 0 },
    ]);

    const report = await runReconcilerTick({ db, queues: new FakeQueues(), log });
    expect(report.retention.hold).toBe("none");
    expect(report.retention.purged.SubmissionTestDetail).toBeGreaterThanOrEqual(2);
    expect(await detailIndexes("details")).toEqual([2, 3]);
    // The submission itself is untouched.
    expect((await sub("details")).verdict).toBe("WA");
  });

  it("purges at most one batch of 10,000 per table per tick", async () => {
    await submission("bulk", { status: "DONE", judgeState: "DONE", verdict: "AC" });
    const owner = id("bulk");
    // One more than a batch, all past the window.
    await db.$executeRaw`
      INSERT INTO "SubmissionTestDetail" (id, "submissionId", "testIndex", stdout, "createdAt")
      SELECT ${owner} || '-d' || g, ${owner}, g, 'x', (now() AT TIME ZONE 'UTC') - interval '40 days'
      FROM generate_series(0, ${RETENTION_DELETE_BATCH}::int) AS g`;

    const first = await runReconcilerTick({ db, queues: new FakeQueues(), log });
    expect(first.retention.purged.SubmissionTestDetail).toBe(RETENTION_DELETE_BATCH);
    expect(first.capped).toContain("retention:SubmissionTestDetail");
    expect(await db.submissionTestDetail.count({ where: { submissionId: owner } })).toBeGreaterThanOrEqual(1);

    const second = await runReconcilerTick({ db, queues: new FakeQueues(), log });
    expect(second.retention.purged.SubmissionTestDetail).toBeGreaterThanOrEqual(1);
    expect(await db.submissionTestDetail.count({ where: { submissionId: owner } })).toBe(0);
  });

  it("suspends every purge (and the run TTL) under a legal hold or a malformed retention setting", async () => {
    const now = await dbNow();
    await submission("hold-details", { status: "DONE", judgeState: "DONE", verdict: "AC" });
    await details("hold-details", [{ testIndex: 0, ageMs: 45 * DAY }]);
    await run("hold-expired", { status: "DONE", judgeState: "DONE", expiresAt: at(now, -1000) });
    await submission("hold-queued", { queuedAt: at(now, -MIN) });

    try {
      await setRetention({ legalHold: true, reason: "scheduler test" });
      const q = new FakeQueues();
      const held = await runReconcilerTick({ db, queues: q, log });
      expect(held.retention.hold).toBe("legal-hold");
      expect(held.runsDeleted).toBe(0);
      expect(held.retention.purged.SubmissionTestDetail).toBe(0);
      expect(await detailIndexes("hold-details")).toEqual([0]);
      expect(await runRow("hold-expired")).not.toBeNull();
      // A hold stops deletion only; judging carries on.
      expect(addsFor(q, "hold-queued")).toHaveLength(1);

      await setRetention({ legalHold: "yes" });
      const invalid = await runReconcilerTick({ db, queues: new FakeQueues(), log });
      expect(invalid.retention.hold).toBe("invalid-setting");
      expect(invalid.runsDeleted).toBe(0);
      expect(await detailIndexes("hold-details")).toEqual([0]);
      expect(await runRow("hold-expired")).not.toBeNull();

      await setRetention({ legalHold: false });
      const lifted = await runReconcilerTick({ db, queues: new FakeQueues(), log });
      expect(lifted.retention.hold).toBe("none");
      expect(await detailIndexes("hold-details")).toEqual([]);
      expect(await runRow("hold-expired")).toBeNull();
    } finally {
      await setRetention(null);
    }
  });

  it("skips the tick while another session holds the reconciler lock", async () => {
    const holder = createPrismaClient({ url: withSingleConnection(TEST_URL) });
    try {
      await holder.$executeRaw`SELECT pg_advisory_lock(${LOCK_NAMESPACE}::int, ${RECONCILER_LOCK}::int)`;
      const now = await dbNow();
      await submission("locked-out", { queuedAt: at(now, -MIN) });
      const q = new FakeQueues();
      const report = await runReconcilerTick({ db, queues: q, log });
      expect(report.lock).toBe("busy");
      expect(q.added).toEqual([]);
      expect((await sub("locked-out")).judgeState).toBe("PENDING");
    } finally {
      await holder.$queryRaw`SELECT pg_advisory_unlock(${LOCK_NAMESPACE}::int, ${RECONCILER_LOCK}::int)`;
      await holder.$disconnect();
    }
    // Released: the next tick acts again.
    const q = new FakeQueues();
    expect((await runReconcilerTick({ db, queues: q, log })).lock).toBe("acquired");
    expect(addsFor(q, "locked-out")).toHaveLength(1);
  });

  it("decides but writes nothing in a dry run", async () => {
    const now = await dbNow();
    await node("dry-dead", "ONLINE", at(now, -MIN));
    await node("dry-stale", "ONLINE", now, {
      sensitiveLanesOk: true,
      lastSelfCheckAt: at(now, -(LIMITS.selfCheck.staleAfterMs + MIN)),
    });
    await submission("dry-queued", { queuedAt: at(now, -MIN) });
    await submission("dry-lease", {
      status: "JUDGING",
      judgeState: "RUNNING",
      claimToken: "d".repeat(32),
      leaseExpiresAt: at(now, -1000),
      attemptCount: 1,
    });
    await validation("dry-validation", { createdAt: at(now, -MIN) });
    await validation("dry-validation-exhausted", { createdAt: at(now, -MIN), attemptCount: JUDGE_RETRY.attempts });
    await run("dry-expired", { status: "DONE", judgeState: "DONE", expiresAt: at(now, -1000) });
    await submission("dry-details", { status: "DONE", judgeState: "DONE", verdict: "AC" });
    await details("dry-details", [{ testIndex: 0, ageMs: 31 * DAY }]);

    const q = new FakeQueues();
    const report = await runReconcilerTick({ db, queues: q, log, dryRun: true });
    expect(report.dryRun).toBe(true);
    expect(report.nodesOffline).toBeGreaterThanOrEqual(1);
    expect(report.nodesLaneRestricted).toBeGreaterThanOrEqual(1);
    expect(report.markedDispatched).toBeGreaterThanOrEqual(2);
    expect(report.requeued).toBeGreaterThanOrEqual(1);
    expect(report.failed).toBeGreaterThanOrEqual(1);
    expect(report.runsDeleted).toBeGreaterThanOrEqual(1);
    expect(report.retention.purged.SubmissionTestDetail).toBeGreaterThanOrEqual(1);
    expect(report.jobs.added).toBeGreaterThanOrEqual(3);

    expect(q.added).toEqual([]);
    expect(q.removed).toEqual([]);
    expect(q.published).toEqual([]);
    expect((await nodeRow("dry-dead")).status).toBe("ONLINE");
    expect((await nodeRow("dry-stale")).sensitiveLanesOk).toBe(true);
    expect((await sub("dry-queued")).judgeState).toBe("PENDING");
    expect(await sub("dry-lease")).toMatchObject({ status: "JUDGING", claimToken: "d".repeat(32) });
    expect((await vrun("dry-validation")).judgeState).toBe("PENDING");
    expect(await vrun("dry-validation-exhausted")).toMatchObject({ status: "QUEUED", outcome: "PENDING", verdict: null });
    expect(await runRow("dry-expired")).not.toBeNull();
    expect(await detailIndexes("dry-details")).toEqual([0]);
  });

  it("defers enqueues while Redis is down and catches up once it is back", async () => {
    const now = await dbNow();
    await submission("redis-down", { queuedAt: at(now, -MIN) });
    await validation("redis-down-validation", { createdAt: at(now, -MIN) });

    const q = new FakeQueues();
    q.connected = false;
    const down = await runReconcilerTick({ db, queues: q, log });
    expect(down.jobs.deferred).toBeGreaterThanOrEqual(2);
    expect(addsFor(q, "redis-down")).toEqual([]);
    expect(addsFor(q, "redis-down-validation")).toEqual([]);
    // Postgres still says QUEUED, so nothing is lost.
    expect((await sub("redis-down")).status).toBe("QUEUED");
    expect((await vrun("redis-down-validation")).status).toBe("QUEUED");

    q.connected = true;
    await runReconcilerTick({ db, queues: q, log });
    expect(addsFor(q, "redis-down")).toHaveLength(1);
    expect(addsFor(q, "redis-down-validation")).toEqual([
      { lane: "REJUDGE", data: { kind: "validation", id: id("redis-down-validation") } },
    ]);
  });

  it("counts transport errors and retries them on the next tick", async () => {
    const now = await dbNow();
    await submission("flaky", { queuedAt: at(now, -MIN) });

    const q = new FakeQueues();
    // Fail every state read in this tick.
    q.failNext = Number.MAX_SAFE_INTEGER;
    const report = await runReconcilerTick({ db, queues: q, log });
    expect(report.jobs.errors).toBeGreaterThanOrEqual(1);
    expect(addsFor(q, "flaky")).toEqual([]);

    q.failNext = 0;
    await runReconcilerTick({ db, queues: q, log });
    expect(addsFor(q, "flaky")).toHaveLength(1);
  });

  describe.skipIf(!REDIS_ENABLED)("with real BullMQ queues (RECX_REDIS_TESTS=1)", () => {
    // Every key lives under a throwaway prefix, deleted afterwards.
    const prefix = `recx-sched-dbtest-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    let conn: Redis;
    let queues: BullJudgeQueues;

    beforeAll(async () => {
      // Same options as main.ts.
      conn = new Redis(REDIS_URL, { enableOfflineQueue: false, maxRetriesPerRequest: 1, commandTimeout: 5_000, lazyConnect: true });
      await conn.connect();
      queues = new BullJudgeQueues(conn, log, prefix);
    });

    afterAll(async () => {
      await queues?.close();
      if (!conn) return;
      let cursor = "0";
      do {
        const [next, keys] = await conn.scan(cursor, "MATCH", `${prefix}:*`, "COUNT", 500);
        if (keys.length > 0) await conn.del(...keys);
        cursor = next;
      } while (cursor !== "0");
      await conn.quit();
    });

    it("lands validation runs on judge-rejudge and submissions on their lane, with the shared job options", async () => {
      const now = await dbNow();
      await validation("bull-validation", { createdAt: at(now, -MIN) });
      await submission("bull-contest", { queuedAt: at(now, -MIN), lane: "CONTEST" });

      const report = await runReconcilerTick({ db, queues, log });
      expect(report.lock).toBe("acquired");
      expect(report.jobs.errors).toBe(0);

      const inspect = async (lane: "REJUDGE" | "CONTEST", jobId: string) => {
        const queue = new Queue(QUEUE_NAME[lane], { connection: conn, prefix });
        try {
          const job = await queue.getJob(jobId);
          return job ? { id: job.id, data: job.data, priority: job.opts.priority, attempts: job.opts.attempts } : null;
        } finally {
          await queue.close();
        }
      };

      expect(QUEUE_NAME.REJUDGE).toBe("judge-rejudge");
      expect(await inspect("REJUDGE", id("bull-validation"))).toEqual({
        id: id("bull-validation"),
        data: { kind: "validation", id: id("bull-validation") },
        priority: LANE_PRIORITY.REJUDGE,
        attempts: JUDGE_RETRY.attempts,
      });
      expect(await inspect("CONTEST", id("bull-contest"))).toEqual({
        id: id("bull-contest"),
        data: { kind: "submission", id: id("bull-contest") },
        priority: LANE_PRIORITY.CONTEST,
        attempts: JUDGE_RETRY.attempts,
      });
      expect(await queues.state("isolate", "REJUDGE", id("bull-validation"))).toBe("prioritized");
      expect((await vrun("bull-validation")).judgeState).toBe("DISPATCHED");

      // The next tick finds the live job and keeps it.
      const again = await runReconcilerTick({ db, queues, log });
      expect(again.jobs.errors).toBe(0);
      expect(await queues.state("isolate", "REJUDGE", id("bull-validation"))).toBe("prioritized");
    });
  });
});
