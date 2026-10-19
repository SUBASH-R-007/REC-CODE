import type { Db } from "@recx/db";
import { DEFAULT_INACTIVITY_POLICY, SCHEDULER_JOB_NAMES, SWEEP_HOLDBACKS } from "@recx/shared";
import pino from "pino";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  INACTIVITY_SWEEP_BATCH,
  INACTIVITY_SWEEP_MAX_BATCHES,
  InactivitySweepJob,
  SWEEP_HOUR_IST,
} from "../src/inactivity-sweep";

/**
 * The inactivity sweep (Phase 8c) — the DRY RUN.
 *
 * The counting and the planning are tested in
 * `packages/shared/test/inactivity.test.ts`, and the constraints in
 * `packages/db/test/restriction-invariants.db.test.ts`. What this file tests
 * is the JOB: its hour gate, its idempotence, its batching, and — the one
 * that matters most in this slice — that it WRITES NOTHING.
 *
 * SPEC §5 asks for the dry run to ship first, and the last describe block is
 * what makes that a property rather than an intention: the fake database
 * records every method touched, and the test asserts the set contains no
 * mutation at all. A write added here later would reach every student in the
 * college before anybody noticed.
 */

const log = pino({ level: "silent" });

/** 02:00 Asia/Kolkata is 20:30 UTC the previous day. */
const AT_0200_IST = new Date("2026-10-19T20:30:00.000Z");
const AT_0900_IST = new Date("2026-10-20T03:30:00.000Z");

const policy = (over = {}) => ({ version: 7, ...DEFAULT_INACTIVITY_POLICY, ...over });

vi.mock("@recx/db/inactivity", async () => {
  const actual = await vi.importActual<typeof import("@recx/db/inactivity")>("@recx/db/inactivity");
  return {
    ...actual,
    sweepCandidates: vi.fn(),
    loadSweepContext: vi.fn(),
  };
});

const mocked = await import("@recx/db/inactivity");
const sweepCandidates = vi.mocked(mocked.sweepCandidates);
const loadSweepContext = vi.mocked(mocked.loadSweepContext);

const candidate = (over: Record<string, unknown> = {}) => ({
  userId: "u1",
  collegeId: "REC001",
  name: "A Student",
  status: "ACTIVE" as const,
  batchYear: 2027,
  departmentCode: "CSE",
  lastActiveAt: new Date("2026-10-05T04:00:00.000Z"),
  stage: "NONE" as const,
  stageEnteredAt: null,
  graceEndsAt: null,
  notifiedAt: null,
  selfClearedCount: 0,
  selfClearedTermKey: null,
  hasOpenAttempt: false,
  hasPendingAppeal: false,
  hasAssessmentWithin72h: false,
  ...over,
});

/** A calendar covering the window as regular working days. */
function fullCalendar(fromDay: string, toDay: string) {
  const map = new Map<string, { date: string; kind: "REGULAR"; isWorkingDay: boolean }>();
  const start = Date.parse(`${fromDay}T00:00:00Z`);
  const end = Date.parse(`${toDay}T00:00:00Z`);
  for (let t = start; t <= end; t += 86_400_000) {
    const date = new Date(t).toISOString().slice(0, 10);
    map.set(date, { date, kind: "REGULAR", isWorkingDay: true });
  }
  return map;
}

const context = (over: Record<string, unknown> = {}) => ({
  policies: [policy()],
  cal: fullCalendar("2026-08-20", "2026-10-19"),
  leaves: new Map(),
  activity: new Map(),
  evaluationDay: "2026-10-19",
  windowStartDay: "2026-08-20",
  now: AT_0200_IST,
  ...over,
});

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
  sweepCandidates.mockResolvedValue([]);
  loadSweepContext.mockResolvedValue(context() as never);
});

describe("the job is registered", () => {
  it("is in SCHEDULER_JOB_NAMES, so /super/jobs shows it and a stale tick is visible", () => {
    expect(SCHEDULER_JOB_NAMES).toContain("inactivitySweep");
  });
});

describe("the hour gate", () => {
  it("does nothing outside 02:00 campus time", async () => {
    const { db } = recordingDb();
    const job = new InactivitySweepJob({ db, log, dryRun: true });
    const report = await job.tick(AT_0900_IST);
    expect(report).toMatchObject({ ran: false, skipped: "not-the-hour", considered: 0 });
    expect(sweepCandidates).not.toHaveBeenCalled();
  });

  it("runs at 02:00 campus time, whatever the server's own zone", async () => {
    // 02:00 IST is 20:30 UTC the day before. A job gated on the SERVER's
    // hour would run at the wrong time on every host outside India.
    const { db } = recordingDb();
    const job = new InactivitySweepJob({ db, log, dryRun: true });
    sweepCandidates.mockResolvedValueOnce([candidate()] as never);
    const report = await job.tick(AT_0200_IST);
    expect(report.ran).toBe(true);
    expect(report.evaluationDay).toBe("2026-10-19");
  });

  it("names the hour as a constant so the runbook and the job cannot disagree", () => {
    expect(SWEEP_HOUR_IST).toBe(2);
  });
});

describe("once per campus day", () => {
  it("skips a second run on the same evaluation day", async () => {
    const { db } = recordingDb();
    const job = new InactivitySweepJob({ db, log, dryRun: true });
    sweepCandidates.mockResolvedValue([candidate()] as never);

    const first = await job.tick(AT_0200_IST);
    expect(first.ran).toBe(true);
    const second = await job.tick(AT_0200_IST);
    expect(second).toMatchObject({ ran: false, skipped: "already-run-today" });
  });

  it("reports zero transitions rather than failing the tick", async () => {
    const { db } = recordingDb();
    const job = new InactivitySweepJob({ db, log, dryRun: true });
    job.markRun("2026-10-19");
    const report = await job.tick(AT_0200_IST);
    expect(report.failed).toBe(false);
    expect(report.wouldEscalate).toBe(0);
  });

  it("runs again on the next campus day", async () => {
    const { db } = recordingDb();
    const job = new InactivitySweepJob({ db, log, dryRun: true });
    sweepCandidates.mockResolvedValue([candidate()] as never);
    await job.tick(AT_0200_IST);

    const nextDay = new Date("2026-10-20T20:30:00.000Z");
    loadSweepContext.mockResolvedValue(context({ evaluationDay: "2026-10-20", now: nextDay }) as never);
    const report = await job.tick(nextDay);
    expect(report).toMatchObject({ ran: true, evaluationDay: "2026-10-20" });
  });
});

describe("no active policy", () => {
  it("does nothing and says so — it does not invent a default", async () => {
    // A college that has configured no policy has chosen for this engine to
    // do nothing. Inventing a default would mean restricting students under
    // rules nobody chose.
    const { db } = recordingDb();
    const job = new InactivitySweepJob({ db, log, dryRun: true });
    sweepCandidates.mockResolvedValue([candidate()] as never);
    loadSweepContext.mockResolvedValue(context({ policies: [] }) as never);

    const report = await job.tick(AT_0200_IST);
    expect(report).toMatchObject({ ran: false, skipped: "no-active-policy", failed: false });
  });
});

describe("what it would do", () => {
  it("counts an escalation it would make", async () => {
    const { db } = recordingDb();
    const job = new InactivitySweepJob({ db, log, dryRun: true });
    sweepCandidates.mockResolvedValue([candidate()] as never);

    const report = await job.tick(AT_0200_IST);
    expect(report.considered).toBe(1);
    expect(report.wouldEscalate).toBe(1);
    expect(report.sample[0]).toMatchObject({ collegeId: "REC001", kind: "escalate", toStage: "NUDGED" });
  });

  it("counts a clear for a student who is active again", async () => {
    const { db } = recordingDb();
    const job = new InactivitySweepJob({ db, log, dryRun: true });
    sweepCandidates.mockResolvedValue([
      candidate({ stage: "SOFT_RESTRICTED", lastActiveAt: new Date("2026-10-19T04:00:00.000Z") }),
    ] as never);

    const report = await job.tick(AT_0200_IST);
    expect(report.wouldClear).toBe(1);
    expect(report.wouldEscalate).toBe(0);
  });

  it.each(SWEEP_HOLDBACKS.filter((h) => h !== "no-policy" && h !== "calendar-incomplete"))(
    "holds a student back for %s and says which",
    async (holdback) => {
      const flags: Record<string, Record<string, boolean>> = {
        "open-attempt": { hasOpenAttempt: true },
        "pending-appeal": { hasPendingAppeal: true },
        "assessment-within-72h": { hasAssessmentWithin72h: true },
      };
      const { db } = recordingDb();
      const job = new InactivitySweepJob({ db, log, dryRun: true });
      sweepCandidates.mockResolvedValue([candidate(flags[holdback])] as never);

      const report = await job.tick(AT_0200_IST);
      expect(report.held).toBe(1);
      expect(report.wouldEscalate).toBe(0);
      expect(report.heldBy[holdback]).toBe(1);
    },
  );

  it("holds EVERYBODY back while the calendar is incomplete, and raises a review", async () => {
    // Every unentered day counts, which is the harshest possible reading —
    // so nothing escalates on it and a human is asked to finish the term.
    const { db } = recordingDb();
    const job = new InactivitySweepJob({ db, log, dryRun: true });
    sweepCandidates.mockResolvedValue([candidate()] as never);
    loadSweepContext.mockResolvedValue(context({ cal: new Map() }) as never);

    const report = await job.tick(AT_0200_IST);
    expect(report.calendarIncomplete).toBe(true);
    expect(report.heldBy["calendar-incomplete"]).toBe(1);
    expect(report.wouldEscalate).toBe(0);
    expect(report.adminReview).toBe(1);
  });

  it("raises a review for a student the policy would disable but may not", async () => {
    const { db } = recordingDb();
    const job = new InactivitySweepJob({ db, log, dryRun: true });
    sweepCandidates.mockResolvedValue([
      candidate({ stage: "SOFT_RESTRICTED", lastActiveAt: new Date("2026-08-25T04:00:00.000Z") }),
    ] as never);

    const report = await job.tick(AT_0200_IST);
    expect(report.adminReview).toBe(1);
    expect(report.wouldEscalate).toBe(0);
    expect(report.sample[0]?.kind).toBe("hold");
  });

  it("keeps the sample to the rows that would MOVE, and bounds it", async () => {
    // A page of "nothing changed" tells a human nothing, and an unbounded
    // sample in a status row is a status row nobody can read.
    const { db } = recordingDb();
    const job = new InactivitySweepJob({ db, log, dryRun: true });
    const many = Array.from({ length: 40 }, (_, i) =>
      candidate({ userId: `u${i}`, collegeId: `REC${i}` }),
    );
    sweepCandidates.mockResolvedValue(many as never);

    const report = await job.tick(AT_0200_IST);
    expect(report.considered).toBe(40);
    expect(report.wouldEscalate).toBe(40);
    expect(report.sample.length).toBeLessThanOrEqual(25);
    for (const row of report.sample) expect(row.kind).not.toBe("hold");
  });

  it("puts no name or address in the sample — a college id and counts only", async () => {
    const { db } = recordingDb();
    const job = new InactivitySweepJob({ db, log, dryRun: true });
    sweepCandidates.mockResolvedValue([candidate({ name: "Priya Sundaram" })] as never);

    const report = await job.tick(AT_0200_IST);
    const text = JSON.stringify(report);
    expect(text).not.toContain("Priya");
    expect(text).toContain("REC001");
  });
});

describe("batching", () => {
  it("pages by user id until a short batch comes back", async () => {
    const { db } = recordingDb();
    const job = new InactivitySweepJob({ db, log, dryRun: true });
    const full = Array.from({ length: INACTIVITY_SWEEP_BATCH }, (_, i) =>
      candidate({ userId: `a${String(i).padStart(4, "0")}`, collegeId: `REC${i}` }),
    );
    sweepCandidates.mockResolvedValueOnce(full as never).mockResolvedValueOnce([candidate({ userId: "zz" })] as never);

    const report = await job.tick(AT_0200_IST);
    expect(report.considered).toBe(INACTIVITY_SWEEP_BATCH + 1);
    expect(sweepCandidates).toHaveBeenCalledTimes(2);
    expect(sweepCandidates.mock.calls[1]?.[1]).toMatchObject({ afterUserId: `a${String(INACTIVITY_SWEEP_BATCH - 1).padStart(4, "0")}` });
  });

  it("stops at its batch ceiling rather than running for ever", async () => {
    const { db } = recordingDb();
    const job = new InactivitySweepJob({ db, log, dryRun: true });
    const full = Array.from({ length: INACTIVITY_SWEEP_BATCH }, (_, i) =>
      candidate({ userId: `a${String(i).padStart(4, "0")}` }),
    );
    sweepCandidates.mockResolvedValue(full as never);

    const report = await job.tick(AT_0200_IST);
    expect(report.considered).toBe(INACTIVITY_SWEEP_BATCH * INACTIVITY_SWEEP_MAX_BATCHES);
    expect(report.failed).toBe(false);
  });
});

describe("a failing tick is reported, not thrown", () => {
  it("records the error and does not take the scheduler down", async () => {
    const { db } = recordingDb();
    const job = new InactivitySweepJob({ db, log, dryRun: true });
    sweepCandidates.mockRejectedValue(new Error("the database went away"));

    const report = await job.tick(AT_0200_IST);
    expect(report).toMatchObject({ failed: true, ran: false });
    expect(report.error).toMatch(/went away/);
  });
});

describe("A DRY RUN WRITES NOTHING", () => {
  /**
   * What makes "dry run shipped first" a property of the code rather than an
   * intention. The fake database records every property the job touches; a
   * mutation that reached the dry-run path later would show up here before it
   * showed up in somebody's account.
   *
   * Slice 8c shipped this job writing nothing at all, with its own gate.
   * Slice 8d added the writes, so the contract is now narrower and sharper:
   * `--dry-run` reports and writes nothing, and the live path is tested
   * against a real database in `packages/db/test/inactivity-apply.db.test.ts`.
   */
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

  it("touches no mutating method on any model", async () => {
    const { db, touched } = recordingDb();
    const job = new InactivitySweepJob({ db, log, dryRun: true });
    sweepCandidates.mockResolvedValue([
      candidate(),
      candidate({ userId: "u2", stage: "SOFT_RESTRICTED", lastActiveAt: new Date("2026-08-25T04:00:00.000Z") }),
      candidate({ userId: "u3", stage: "WARNED", lastActiveAt: new Date("2026-10-19T04:00:00.000Z") }),
    ] as never);

    await job.tick(AT_0200_IST);
    // One of each kind went through the planner: escalate, hold-with-review
    // and clear. If a write were going to leak, it would be on one of these.
    for (const mutation of MUTATIONS) {
      expect(touched, `the sweep touched ${mutation}`).not.toContain(mutation);
    }
  });

  it("says of itself whether it writes", () => {
    const { db } = recordingDb();
    expect(new InactivitySweepJob({ db, log, dryRun: true }).writes).toBe(false);
    expect(new InactivitySweepJob({ db, log, dryRun: false }).writes).toBe(true);
  });

  it("still COUNTS everything it would do, so the report is worth reading", async () => {
    // A dry run that reported nothing would be a dry run nobody could use as
    // the manual gate the spec asks for.
    const { db } = recordingDb();
    const job = new InactivitySweepJob({ db, log, dryRun: true });
    sweepCandidates.mockResolvedValue([
      candidate(),
      candidate({ userId: "u2", stage: "WARNED", lastActiveAt: new Date("2026-10-19T04:00:00.000Z") }),
    ] as never);

    const report = await job.tick(AT_0200_IST);
    expect(report).toMatchObject({ considered: 2, wouldEscalate: 1, wouldClear: 1 });
    // And nothing was actually done.
    expect(report).toMatchObject({ escalated: 0, cleared: 0 });
  });

  it("reaches the write path when it is NOT a dry run — so the block above proves something", async () => {
    // Without this, "touched no mutation" could pass because the job never
    // tries to write at all, and the dry-run assertion would be vacuous.
    const { db, touched } = recordingDb();
    const job = new InactivitySweepJob({ db, log, dryRun: false });
    sweepCandidates.mockResolvedValue([candidate()] as never);
    await job.tick(AT_0200_IST);
    expect(touched).toContain("$transaction");
  });

  it("mutation check: the recorder really would catch a write", async () => {
    // Without this the block above could pass because the recorder is blind.
    const { db, touched } = recordingDb();
    await (db as unknown as { user: { update: () => Promise<unknown> } }).user.update();
    expect(touched).toContain("update");
  });
});
