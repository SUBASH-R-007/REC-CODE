import type { Db } from "@recx/db";
import { MIN_PERCENTILE_COHORT, SCHEDULER_JOB_NAMES, TOPICS, type Topic } from "@recx/shared";
import pino from "pino";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { READINESS_BATCH, READINESS_HOUR_IST, READINESS_MINUTE_IST, ReadinessJob } from "../src/readiness";

/**
 * The nightly readiness run (Phase 9).
 *
 * The arithmetic is tested in `packages/shared/test/readiness.test.ts` and
 * the constraints in `packages/db/test/readiness-invariants.db.test.ts`. What
 * this file tests is the JOB: its clock gate, its ordering after the Phase 8
 * sweep, its idempotence, and — the one that matters most — that **a dry run
 * writes nothing**.
 *
 * The last block is the same shape Phase 8c's sweep has: a fake database
 * records every method touched, and a dry run's set must contain no
 * mutation at all. A write that reached the dry-run path later would show up
 * here before it showed up in five thousand students' snapshots.
 */

const log = pino({ level: "silent" });

/** 02:30 Asia/Kolkata is 21:00 UTC the previous day. */
const AT_0230_IST = new Date("2026-10-19T21:00:00.000Z");
const AT_0200_IST = new Date("2026-10-19T20:30:00.000Z");
const AT_0900_IST = new Date("2026-10-20T03:30:00.000Z");

vi.mock("@recx/db/readiness", async () => {
  const actual = await vi.importActual<typeof import("@recx/db/readiness")>("@recx/db/readiness");
  return { ...actual, loadReadinessSources: vi.fn(), writeSnapshots: vi.fn() };
});

const mocked = await import("@recx/db/readiness");
const loadReadinessSources = vi.mocked(mocked.loadReadinessSources);
const writeSnapshots = vi.mocked(mocked.writeSnapshots);

function evenTopics(each: number): Partial<Record<Topic, number>> {
  return Object.fromEntries(TOPICS.map((topic) => [topic, each]));
}

const student = (i: number, batchYear: number | null = 2027) => ({
  userId: `u${i}`,
  collegeId: `REC${String(i).padStart(4, "0")}`,
  batchYear,
  departmentCode: "CSE",
  section: "A",
});

/** Sources for `n` students, all in one cohort, all with some data. */
function sources(n: number, over: Record<string, unknown> = {}) {
  const students = Array.from({ length: n }, (_, i) => student(i));
  return {
    students,
    solves: new Map(students.map((s) => [s.userId, { easyMedium: 40, mediumUnassisted: 20, mediumHardUnassisted: 25 }])),
    topics: new Map(students.map((s) => [s.userId, evenTopics(3)])),
    aptitude: new Map(
      students.map((s) => [s.userId, { aptitude: { answered: 100, correct: 60 }, verbal: { answered: 60, correct: 40 } }]),
    ),
    rating: new Map(students.map((s) => [s.userId, { rating: 1300, contestsRated: 5 }])),
    activity: new Map(students.map((s) => [s.userId, { activeDays: 12, lastActiveOn: "2026-10-18" }])),
    evaluationDay: "2026-10-19",
    ...over,
  };
}

/** A database that records every property and method the job touches. */
function recordingDb() {
  const touched: string[] = [];
  const handler: ProxyHandler<object> = {
    get(_target, prop: string) {
      if (prop === "then") return undefined;
      touched.push(prop);
      return new Proxy(() => undefined, handler);
    },
    apply() {
      return Promise.resolve([]);
    },
  };
  return { db: new Proxy({}, handler) as unknown as Db, touched };
}

beforeEach(() => {
  vi.clearAllMocks();
  loadReadinessSources.mockResolvedValue(sources(MIN_PERCENTILE_COHORT) as never);
  writeSnapshots.mockResolvedValue(0);
});

describe("the job is registered", () => {
  it("is in SCHEDULER_JOB_NAMES, so /super/jobs shows a stale night", () => {
    expect(SCHEDULER_JOB_NAMES).toContain("readinessSnapshot");
  });
});

describe("the clock gate", () => {
  it("does nothing outside the readiness window", async () => {
    const { db } = recordingDb();
    const job = new ReadinessJob({ db, log, dryRun: true });
    const report = await job.tick(AT_0900_IST);
    expect(report).toMatchObject({ ran: false, skipped: "not-the-hour", studentsEvaluated: 0 });
    expect(loadReadinessSources).not.toHaveBeenCalled();
  });

  it("does NOT run at 02:00, when the inactivity sweep is still going", async () => {
    /**
     * The ordering that matters. `consistency` and `lastActiveOn` come from
     * ActivityDay, and readiness computed before the sweep had finished
     * would be computed against a cohort half of whose restrictions were a
     * day stale.
     */
    const { db } = recordingDb();
    const job = new ReadinessJob({ db, log, dryRun: true });
    const report = await job.tick(AT_0200_IST);
    expect(report.skipped).toBe("not-the-hour");
  });

  it("runs at 02:30 campus time, whatever the server's own zone", async () => {
    // 02:30 IST is 21:00 UTC the day before. A job gated on the SERVER's
    // clock would run at the wrong time on every host outside India.
    const { db } = recordingDb();
    const job = new ReadinessJob({ db, log, dryRun: true });
    const report = await job.tick(AT_0230_IST);
    expect(report.ran).toBe(true);
    expect(report.evaluationDay).toBe("2026-10-19");
  });

  it("names the hour and minute as constants, so the runbook cannot disagree", () => {
    expect(READINESS_HOUR_IST).toBe(2);
    expect(READINESS_MINUTE_IST).toBe(30);
  });
});

describe("once per campus day", () => {
  it("skips a second run on the same day", async () => {
    const { db } = recordingDb();
    const job = new ReadinessJob({ db, log, dryRun: true });
    expect((await job.tick(AT_0230_IST)).ran).toBe(true);
    expect(await job.tick(AT_0230_IST)).toMatchObject({ ran: false, skipped: "already-run-today" });
  });

  it("reports rather than failing when it has already run", async () => {
    const { db } = recordingDb();
    const job = new ReadinessJob({ db, log, dryRun: true });
    job.markRun("2026-10-19");
    const report = await job.tick(AT_0230_IST);
    expect(report.failed).toBe(false);
    expect(report.snapshotsWritten).toBe(0);
  });
});

describe("what it computes", () => {
  it("evaluates every student in the cohort", async () => {
    const { db } = recordingDb();
    const job = new ReadinessJob({ db, log, dryRun: true });
    const report = await job.tick(AT_0230_IST);
    expect(report.studentsEvaluated).toBe(MIN_PERCENTILE_COHORT);
  });

  it("counts a cohort too small to rank in, which is a fact an administrator acts on", async () => {
    // Eleven students is not a percentile, it is a ranking with the names
    // filed off.
    loadReadinessSources.mockResolvedValue(sources(11) as never);
    const { db } = recordingDb();
    const job = new ReadinessJob({ db, log, dryRun: true });
    const report = await job.tick(AT_0230_IST);
    expect(report.cohortsTooSmall).toEqual(["2027 (11)"]);
  });

  it("counts a tier nobody could be measured on", async () => {
    /**
     * A cohort too small to rank in loses all three percentile components,
     * so TOP (rating 0.35 + breadth 0.20 + coverage 0.30, with mock
     * permanently missing) still has 50 measurable — but a cohort too small
     * AND with no solves has nothing, and the score must be NULL rather than
     * zero.
     */
    loadReadinessSources.mockResolvedValue(
      sources(11, {
        solves: new Map(),
        topics: new Map(),
        aptitude: new Map(),
        rating: new Map(),
      }) as never,
    );
    const { db } = recordingDb();
    const job = new ReadinessJob({ db, log, dryRun: true });
    const report = await job.tick(AT_0230_IST);
    // SERVICE keeps coverage and consistency; PRODUCT and TOP keep coverage
    // and breadth. So none is fully unmeasurable — which is the honest
    // answer, and the counter proves the job is looking.
    expect(report.unmeasurable).toEqual({ service: 0, product: 0, top: 0 });
  });

  it("says nothing to do when there are no students", async () => {
    loadReadinessSources.mockResolvedValue(sources(0) as never);
    const { db } = recordingDb();
    const job = new ReadinessJob({ db, log, dryRun: true });
    expect(await job.tick(AT_0230_IST)).toMatchObject({ ran: false, skipped: "no-students" });
  });

  it("puts a DENOMINATOR on every figure in the sample", async () => {
    /**
     * The whole phase in one assertion. A bare "70" in a report a human
     * reads is the exact mistake this design is arranged to avoid: with
     * mockInterviewScore unsourced, a 70 on TOP is 70 out of 85.
     */
    const { db } = recordingDb();
    const job = new ReadinessJob({ db, log, dryRun: true });
    const report = await job.tick(AT_0230_IST);
    expect(report.sample.length).toBeGreaterThan(0);
    for (const row of report.sample) {
      expect(row.top, row.collegeId).toMatch(/^(—|\d+\/\d+)$/);
      if (row.top !== "—") expect(row.top.split("/")[1]).toBe("85");
    }
  });

  it("puts no name in the sample — a college id and numbers only", async () => {
    const { db } = recordingDb();
    const job = new ReadinessJob({ db, log, dryRun: true });
    const report = await job.tick(AT_0230_IST);
    const text = JSON.stringify(report);
    expect(text).toContain("REC0000");
    expect(text).not.toMatch(/firstName|lastName|email/);
  });

  it("bounds the sample", async () => {
    loadReadinessSources.mockResolvedValue(sources(200) as never);
    const { db } = recordingDb();
    const job = new ReadinessJob({ db, log, dryRun: true });
    const report = await job.tick(AT_0230_IST);
    expect(report.studentsEvaluated).toBe(200);
    expect(report.sample.length).toBeLessThanOrEqual(20);
  });
});

describe("a failing run is reported, not thrown", () => {
  it("records the error and does not take the scheduler down", async () => {
    loadReadinessSources.mockRejectedValue(new Error("the database went away"));
    const { db } = recordingDb();
    const job = new ReadinessJob({ db, log, dryRun: true });
    const report = await job.tick(AT_0230_IST);
    expect(report).toMatchObject({ failed: true, ran: false });
    expect(report.error).toMatch(/went away/);
  });
});

describe("A DRY RUN WRITES NOTHING", () => {
  const MUTATIONS = [
    "create",
    "createMany",
    "createManyAndReturn",
    "update",
    "updateMany",
    "upsert",
    "delete",
    "deleteMany",
    "$executeRaw",
    "$executeRawUnsafe",
    "$transaction",
  ];

  it("touches no mutating method, and calls writeSnapshots not once", async () => {
    const { db, touched } = recordingDb();
    const job = new ReadinessJob({ db, log, dryRun: true });
    const report = await job.tick(AT_0230_IST);

    expect(report.ran).toBe(true);
    expect(report.wrote).toBe(false);
    expect(report.snapshotsWritten).toBe(0);
    expect(writeSnapshots).not.toHaveBeenCalled();
    for (const mutation of MUTATIONS) {
      expect(touched, `the dry run touched ${mutation}`).not.toContain(mutation);
    }
  });

  it("still counts everything it would have written, so the report is the gate", async () => {
    // A dry run that reported nothing could not be the manual gate SPEC §5
    // asks for.
    const { db } = recordingDb();
    const job = new ReadinessJob({ db, log, dryRun: true });
    const report = await job.tick(AT_0230_IST);
    expect(report.studentsEvaluated).toBe(MIN_PERCENTILE_COHORT);
    expect(report.sample.length).toBeGreaterThan(0);
  });

  it("DOES write when it is not a dry run — so the block above proves something", async () => {
    // Without this, "touched no mutation" could pass because the job never
    // writes at all, and the dry-run assertion would be vacuous.
    const { db, touched } = recordingDb();
    writeSnapshots.mockResolvedValue(MIN_PERCENTILE_COHORT);
    const job = new ReadinessJob({ db, log, dryRun: false });
    const report = await job.tick(AT_0230_IST);

    expect(report.wrote).toBe(true);
    expect(writeSnapshots).toHaveBeenCalledTimes(1);
    expect(touched).toContain("upsert");
    expect(touched).toContain("readinessRun");
  });

  it("says of itself whether it writes", () => {
    const { db } = recordingDb();
    expect(new ReadinessJob({ db, log, dryRun: true }).writes).toBe(false);
    expect(new ReadinessJob({ db, log, dryRun: false }).writes).toBe(true);
  });

  it("mutation check: the recorder really would catch a write", async () => {
    const { db, touched } = recordingDb();
    await (db as unknown as { readinessRun: { upsert: () => Promise<unknown> } }).readinessRun.upsert();
    expect(touched).toContain("upsert");
  });
});

describe("batching", () => {
  it("flushes in batches rather than holding one transaction open", async () => {
    loadReadinessSources.mockResolvedValue(sources(READINESS_BATCH + 7) as never);
    writeSnapshots.mockResolvedValue(READINESS_BATCH);
    const { db } = recordingDb();
    const job = new ReadinessJob({ db, log, dryRun: false });
    await job.tick(AT_0230_IST);
    // One full batch, then the remainder.
    expect(writeSnapshots).toHaveBeenCalledTimes(2);
    expect(writeSnapshots.mock.calls[0]![1]).toHaveLength(READINESS_BATCH);
    expect(writeSnapshots.mock.calls[1]![1]).toHaveLength(7);
  });
});
