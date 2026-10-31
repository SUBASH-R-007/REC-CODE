/**
 * Synthetic judge capacity burst — a development harness, never a production
 * tool. It writes N Submission / RunRequest rows for the seeded students
 * against published problems (using each problem's real AC model solution,
 * so verdicts should be AC), with a configurable lane mix and arrival
 * profile, enqueues each through BullMQ exactly as the web app does
 * (judgeJobOptions, jobId = row id, then DISPATCHED), waits until every row
 * is judged, and reports per lane: queue wait p50/p95/max, service time,
 * end-to-end p95, verdicts, internal errors — and whether PRACTICE was ever
 * starved while a slot it may use sat idle.
 *
 *   cd apps/web
 *   npx tsx ../../scripts/load/burst.ts --dry-run
 *   npx tsx ../../scripts/load/burst.ts --count 200 --spread 60 --json burst.json --markdown
 *
 * Needs the web app (claim / result endpoints), at least one judge worker
 * and Redis running; ASSESSMENT and CONTEST rows are only claimable by a node
 * whose sensitive lanes are allowed (calibrated, self-checked, hardened —
 * docs/JUDGE.md). Reads DATABASE_URL / REDIS_URL from apps/web/.env.local
 * unless already set, and refuses anything but local targets (burst-plan.ts).
 * Per-user caps are bypassed by writing rows directly; the judged rows still
 * count toward the seeded students' daily usage. Every source carries the
 * marker "recx-burst:<run id>", and `--cleanup <run id>` deletes the run's
 * finished rows afterwards.
 *
 * Clocks: queue times are taken here; a submission's start is the claim
 * (Postgres now()), a run's start is when a worker fetched it from BullMQ
 * (worker clock ≈ the Redis host's). Both are corrected by the offsets
 * measured against Postgres and Redis at start-up, which the report prints.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { Queue } from "bullmq";
import type { Redis } from "ioredis";
import { createPrismaClient, type Db } from "../../packages/db/src/index";
import { LIMITS, QUEUE_NAME, judgeJobOptions, type JobKind, type JudgeJobData } from "../../packages/shared/src/index";
import {
  BURST_LANES,
  USAGE,
  UsageError,
  assertSafeTarget,
  burstMarker,
  fleetRunReserve,
  fmtMs,
  laneCounts,
  laneMarkdown,
  laneReports,
  laneTable,
  newRunId,
  parseBurstArgs,
  planBurst,
  practiceStarvation,
  webRequire,
  type BurstCandidate,
  type BurstFixtures,
  type BurstLane,
  type BurstOptions,
  type JobOutcome,
  type PlannedJob,
} from "./burst-plan";

const { Queue: BullQueue } = webRequire("bullmq") as typeof import("bullmq");
const { Redis: IORedis } = webRequire("ioredis") as typeof import("ioredis");

const WEB_ENV_FILE = fileURLToPath(new URL("../../apps/web/.env.local", import.meta.url));
const TERMINAL = ["DONE", "INTERNAL_ERROR", "CANCELLED"] as const;

function log(message: string) {
  console.log(`[burst] ${message}`);
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, ms)));

// ── Fixtures and fleet ──────────────────────────────────────────────────

async function loadFixtures(db: Db, languages: string[] | null): Promise<BurstFixtures> {
  const students = await db.user.findMany({
    where: { role: "STUDENT", status: "ACTIVE" },
    orderBy: { collegeId: "asc" },
    select: { id: true, collegeId: true },
  });
  const configs = await db.languageConfig.findMany({
    where: { enabled: true, isCurrent: true, ...(languages ? { key: { in: languages } } : {}) },
    select: { id: true, key: true },
  });
  const configByKey = new Map(configs.map((c) => [c.key, c.id]));
  if (languages) {
    const missing = languages.filter((l) => !configByKey.has(l));
    if (missing.length > 0) throw new UsageError(`no enabled, current LanguageConfig for: ${missing.join(", ")}`);
  }
  const problems = await db.problem.findMany({
    where: { status: "PUBLISHED", liveVersionId: { not: null } },
    orderBy: { slug: "asc" },
    select: {
      id: true,
      slug: true,
      liveVersion: {
        select: {
          id: true,
          referenceSolutions: {
            where: { expectedVerdict: "AC" },
            orderBy: { createdAt: "asc" },
            select: { language: true, source: true },
          },
        },
      },
    },
  });
  const versionIds = problems.flatMap((p) => (p.liveVersion ? [p.liveVersion.id] : []));
  const counts = await db.testCase.groupBy({
    by: ["problemVersionId", "isSample"],
    where: { problemVersionId: { in: versionIds } },
    _count: { _all: true },
  });
  const tally = (versionId: string, sample: boolean | null) =>
    counts
      .filter((c) => c.problemVersionId === versionId && (sample === null || c.isSample === sample))
      .reduce((sum, c) => sum + c._count._all, 0);

  const candidates: BurstCandidate[] = [];
  for (const p of problems) {
    const v = p.liveVersion;
    if (!v) continue;
    const seen = new Set<string>();
    for (const ref of v.referenceSolutions) {
      const configId = configByKey.get(ref.language);
      if (!configId || seen.has(ref.language)) continue; // first AC model solution per language
      seen.add(ref.language);
      candidates.push({
        problemId: p.id,
        slug: p.slug,
        versionId: v.id,
        language: ref.language,
        languageConfigId: configId,
        source: ref.source,
        totalCases: tally(v.id, null),
        sampleCount: tally(v.id, true),
      });
    }
  }
  return { students, candidates: candidates.filter((c) => c.totalCases > 0) };
}

interface Fleet {
  nodes: { id: string; slots: number; sensitiveLanesOk: boolean; languages: string[] }[];
  slots: number;
  runReserved: number;
}

async function loadFleet(db: Db, slotsOverride: number | null): Promise<Fleet> {
  const rows = await db.judgeNode.findMany({
    where: { status: "ONLINE" },
    orderBy: { id: "asc" },
    select: { id: true, slots: true, sensitiveLanesOk: true, languages: true },
  });
  const nodes = rows.map((n) => ({
    id: n.id,
    slots: n.slots,
    sensitiveLanesOk: n.sensitiveLanesOk,
    languages: Array.isArray(n.languages) ? n.languages.filter((l): l is string => typeof l === "string") : [],
  }));
  const slots = slotsOverride ?? nodes.reduce((sum, n) => sum + n.slots, 0);
  return { nodes, slots, runReserved: fleetRunReserve(slotsOverride === null ? nodes.map((n) => n.slots) : [slotsOverride]) };
}

// ── Clocks ──────────────────────────────────────────────────────────────

/** Remote clock − local clock (ms), from the lowest-latency of five samples. */
async function clockOffset(sample: () => Promise<number>): Promise<{ offsetMs: number; rttMs: number }> {
  let best = { offsetMs: 0, rttMs: Number.POSITIVE_INFINITY };
  for (let i = 0; i < 5; i++) {
    const t0 = Date.now();
    const remote = await sample();
    const t1 = Date.now();
    if (t1 - t0 < best.rttMs) best = { offsetMs: remote - (t0 + t1) / 2, rttMs: t1 - t0 };
  }
  return best;
}

// ── Running the burst ───────────────────────────────────────────────────

interface Inserted {
  job: PlannedJob;
  id: string;
  queuedAt: number;
  enqueued: boolean;
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

async function insertAndEnqueue(db: Db, queues: Map<BurstLane, Queue<JudgeJobData>>, job: PlannedJob): Promise<Inserted> {
  const queuedAt = new Date();
  const c = job.candidate;
  let id: string;
  if (job.kind === "submission") {
    const row = await db.submission.create({
      data: {
        userId: job.userId,
        problemId: c.problemId,
        problemVersionId: c.versionId,
        languageConfigId: c.languageConfigId,
        language: c.language,
        origin: job.origin ?? "PRACTICE",
        lane: job.lane,
        status: "QUEUED",
        judgeState: "PENDING",
        totalCases: c.totalCases,
        sourceSha256: sha256(job.source),
        sourceBytes: Buffer.byteLength(job.source, "utf8"),
        queuedAt,
        source: { create: { source: job.source } },
      },
      select: { id: true },
    });
    id = row.id;
  } else {
    const row = await db.runRequest.create({
      data: {
        userId: job.userId,
        problemVersionId: c.versionId,
        languageConfigId: c.languageConfigId,
        language: c.language,
        source: job.source,
        customInput: null,
        status: "QUEUED",
        judgeState: "PENDING",
        createdAt: queuedAt,
        expiresAt: new Date(queuedAt.getTime() + LIMITS.customRun.ttlHours * 3_600_000),
      },
      select: { id: true },
    });
    id = row.id;
  }

  // As the web app does: enqueue after commit, then DISPATCHED if still PENDING.
  // If Redis refuses, the row stays PENDING and the reconciler enqueues it.
  const kind: JobKind = job.kind;
  let enqueued = false;
  try {
    await queues.get(job.lane)!.add("judge", { kind, id }, judgeJobOptions(job.lane, id));
    enqueued = true;
  } catch (error) {
    log(`enqueue failed for ${kind} ${id} (the reconciler will pick it up): ${(error as Error).message}`);
  }
  if (enqueued) {
    const where = { id, judgeState: "PENDING" as const };
    const data = { judgeState: "DISPATCHED" as const };
    if (kind === "submission") await db.submission.updateMany({ where, data });
    else await db.runRequest.updateMany({ where, data });
  }
  return { job, id, queuedAt: queuedAt.getTime(), enqueued };
}

/** Fire each job at its arrival offset, at most `concurrency` writes in flight. */
async function runSchedule(
  db: Db,
  queues: Map<BurstLane, Queue<JudgeJobData>>,
  plan: readonly PlannedJob[],
  concurrency: number,
): Promise<Inserted[]> {
  const started = Date.now();
  const inserted: Inserted[] = [];
  const inFlight = new Set<Promise<void>>();
  let lastLog = started;
  for (const job of plan) {
    await sleep(started + job.offsetMs - Date.now());
    while (inFlight.size >= concurrency) await Promise.race(inFlight);
    const p: Promise<void> = insertAndEnqueue(db, queues, job)
      .then((row) => {
        inserted.push(row);
      })
      .finally(() => inFlight.delete(p));
    inFlight.add(p);
    if (Date.now() - lastLog >= 10_000) {
      lastLog = Date.now();
      log(`submitted ${inserted.length}/${plan.length}`);
    }
  }
  await Promise.all(inFlight);
  return inserted.sort((a, b) => a.job.seq - b.job.seq);
}

async function waitForCompletion(db: Db, rows: readonly Inserted[], options: BurstOptions): Promise<boolean> {
  const subIds = rows.filter((r) => r.job.kind === "submission").map((r) => r.id);
  const runIds = rows.filter((r) => r.job.kind === "run").map((r) => r.id);
  const deadline = Date.now() + options.timeoutMs;
  let lastLog = 0;
  for (;;) {
    const [subsDone, runsDone] = await Promise.all([
      subIds.length ? db.submission.count({ where: { id: { in: subIds }, status: { in: [...TERMINAL] } } }) : 0,
      runIds.length ? db.runRequest.count({ where: { id: { in: runIds }, status: { in: [...TERMINAL] } } }) : 0,
    ]);
    const done = subsDone + runsDone;
    if (done === rows.length) return true;
    if (Date.now() - lastLog >= 5_000) {
      lastLog = Date.now();
      log(`judged ${done}/${rows.length}`);
    }
    if (Date.now() >= deadline) {
      log(`timed out after ${Math.round(options.timeoutMs / 1000)} s with ${rows.length - done} job(s) unfinished`);
      return false;
    }
    await sleep(options.pollMs);
  }
}

async function collectOutcomes(
  db: Db,
  queues: Map<BurstLane, Queue<JudgeJobData>>,
  rows: readonly Inserted[],
  offsets: { dbMs: number; redisMs: number },
): Promise<JobOutcome[]> {
  const subIds = rows.filter((r) => r.job.kind === "submission").map((r) => r.id);
  const runIds = rows.filter((r) => r.job.kind === "run").map((r) => r.id);
  const subs = new Map(
    (
      await db.submission.findMany({
        where: { id: { in: subIds } },
        select: { id: true, startedAt: true, judgedAt: true, verdict: true, status: true },
      })
    ).map((s) => [s.id, s]),
  );
  const runs = new Map(
    (
      await db.runRequest.findMany({ where: { id: { in: runIds } }, select: { id: true, judgedAt: true, verdict: true, status: true } })
    ).map((r) => [r.id, r]),
  );
  const outcomes: JobOutcome[] = [];
  for (const row of rows) {
    if (row.job.kind === "submission") {
      const s = subs.get(row.id);
      outcomes.push({
        seq: row.job.seq,
        lane: row.job.lane,
        queuedAt: row.queuedAt,
        // The claim's Postgres now(), moved onto this clock.
        startedAt: s?.startedAt ? s.startedAt.getTime() - offsets.dbMs : null,
        judgedAt: s?.judgedAt ? s.judgedAt.getTime() : null,
        verdict: s?.verdict ?? null,
        status: s?.status ?? "MISSING",
      });
    } else {
      const r = runs.get(row.id);
      // RunRequest has no startedAt: use when a worker fetched the job (BullMQ processedOn).
      const job = await queues.get("RUN")!.getJob(row.id);
      outcomes.push({
        seq: row.job.seq,
        lane: row.job.lane,
        queuedAt: row.queuedAt,
        startedAt: job?.processedOn ? job.processedOn - offsets.redisMs : null,
        judgedAt: r?.judgedAt ? r.judgedAt.getTime() : null,
        verdict: r?.verdict ?? null,
        status: r?.status ?? "MISSING",
      });
    }
  }
  return outcomes;
}

// ── Cleanup ─────────────────────────────────────────────────────────────

async function cleanup(db: Db, runId: string) {
  const marker = burstMarker(runId);
  const sources = await db.submissionSource.findMany({
    where: { source: { contains: marker } },
    select: { submissionId: true, submission: { select: { status: true } } },
  });
  const finishedSubs = sources.filter((s) => (TERMINAL as readonly string[]).includes(s.submission.status));
  const runs = await db.runRequest.findMany({ where: { source: { contains: marker } }, select: { id: true, status: true } });
  const finishedRuns = runs.filter((r) => (TERMINAL as readonly string[]).includes(r.status));
  const subResult = await db.submission.deleteMany({ where: { id: { in: finishedSubs.map((s) => s.submissionId) } } });
  const runResult = await db.runRequest.deleteMany({ where: { id: { in: finishedRuns.map((r) => r.id) } } });
  log(`run ${runId}: deleted ${subResult.count} submission(s) and ${runResult.count} run(s)`);
  const pending = sources.length - finishedSubs.length + runs.length - finishedRuns.length;
  if (pending > 0) log(`${pending} row(s) of this run are not finished yet and were kept; run --cleanup again later`);
}

// ── Main ────────────────────────────────────────────────────────────────

function describePlan(plan: readonly PlannedJob[], fixtures: BurstFixtures, fleet: Fleet, options: BurstOptions, runId: string) {
  const counts = laneCounts(options.count, options.mix);
  log(`run id ${runId} (sources are marked "${burstMarker(runId)}")`);
  log(
    `${plan.length} jobs: ` +
      BURST_LANES.filter((l) => counts[l] > 0)
        .map((l) => `${l} ${counts[l]}`)
        .join(", ") +
      (options.arrival.kind === "instant" ? ", all at once" : `, spread uniformly over ${options.arrival.spreadMs / 1000} s`),
  );
  const languages = [...new Set(fixtures.candidates.map((c) => c.language))].sort();
  const problems = [...new Set(fixtures.candidates.map((c) => c.slug))].sort();
  log(`students ${fixtures.students.length}; problems ${problems.join(", ")}; languages ${languages.join(", ")}`);
  log(
    `fleet: ${fleet.nodes.length} ONLINE node(s), ${fleet.slots} slot(s) (RUN hard-reserves ${fleet.runReserved})` +
      (fleet.nodes.length ? `: ${fleet.nodes.map((n) => `${n.id}×${n.slots}${n.sensitiveLanesOk ? "" : " (no ASSESSMENT/CONTEST)"}`).join(", ")}` : ""),
  );
  if ((counts.ASSESSMENT > 0 || counts.CONTEST > 0) && !fleet.nodes.some((n) => n.sensitiveLanesOk)) {
    log("warning: no ONLINE node may serve ASSESSMENT/CONTEST right now — those jobs will wait until one can (or time out)");
  }
  const served = new Set(fleet.nodes.flatMap((n) => n.languages));
  const unserved = languages.filter((l) => fleet.nodes.length > 0 && !served.has(l));
  if (unserved.length) log(`warning: no ONLINE node reports these languages: ${unserved.join(", ")}`);
}

async function main() {
  const options = parseBurstArgs(process.argv.slice(2));
  if (options.help) {
    console.log(USAGE);
    return;
  }
  if (existsSync(WEB_ENV_FILE)) process.loadEnvFile(WEB_ENV_FILE); // existing variables win
  const target = assertSafeTarget(process.env);
  const db = createPrismaClient({ url: target.databaseUrl });
  let redis: Redis | null = null;
  const queues = new Map<BurstLane, Queue<JudgeJobData>>();
  try {
    if (options.cleanup) {
      await cleanup(db, options.cleanup);
      return;
    }
    const fixtures = await loadFixtures(db, options.languages);
    const runId = newRunId();
    const plan = planBurst(options, fixtures, runId);
    const fleet = await loadFleet(db, options.slots);
    describePlan(plan, fixtures, fleet, options, runId);

    if (options.dryRun) {
      log("dry run: nothing written, nothing enqueued. First rows of the plan:");
      for (const job of plan.slice(0, 12)) {
        log(
          `  #${String(job.seq).padStart(4)} +${fmtMs(job.offsetMs).padStart(8)}  ${job.lane.padEnd(10)} ${job.kind.padEnd(10)} ` +
            `${job.candidate.slug}/${job.candidate.language}  user ${job.userId}  ${Buffer.byteLength(job.source, "utf8")} B`,
        );
      }
      if (plan.length > 12) log(`  … ${plan.length - 12} more`);
      return;
    }
    if (fleet.slots === 0) throw new UsageError("no ONLINE judge node: start a worker first (or pass --slots for the analysis)");

    redis = new IORedis(target.redisUrl, { maxRetriesPerRequest: null });
    for (const lane of BURST_LANES) queues.set(lane, new BullQueue<JudgeJobData>(QUEUE_NAME[lane], { connection: redis }));

    const dbClock = await clockOffset(async () => {
      const rows = await db.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
      return rows[0]!.now.getTime();
    });
    const redisRef = redis;
    const redisClock = await clockOffset(async () => {
      const [sec, micro] = await redisRef.time();
      return Number(sec) * 1000 + Math.floor(Number(micro) / 1000);
    });
    log(`clock offsets: postgres ${Math.round(dbClock.offsetMs)} ms (rtt ${dbClock.rttMs} ms), redis ${Math.round(redisClock.offsetMs)} ms (rtt ${redisClock.rttMs} ms)`);
    if (Math.abs(dbClock.offsetMs) > 1_000 || Math.abs(redisClock.offsetMs) > 1_000) {
      log("warning: a clock is more than 1 s off; waits are corrected by the measured offsets");
    }

    const t0 = Date.now();
    const rows = await runSchedule(db, queues, plan, options.concurrency);
    log(`all ${rows.length} rows written in ${fmtMs(Date.now() - t0)} (${rows.filter((r) => !r.enqueued).length} left for the reconciler)`);
    const complete = await waitForCompletion(db, rows, options);
    const endAt = Date.now();
    const outcomes = await collectOutcomes(db, queues, rows, { dbMs: dbClock.offsetMs, redisMs: redisClock.offsetMs });

    const lanes = laneReports(outcomes);
    const starvation = practiceStarvation(outcomes, fleet, options.starvationThresholdMs, endAt);
    const finished = outcomes.filter((o) => o.judgedAt !== null);
    const firstQueued = Math.min(...outcomes.map((o) => o.queuedAt));
    const lastJudged = finished.length ? Math.max(...finished.map((o) => o.judgedAt!)) : endAt;
    const services = finished.flatMap((o) => (o.startedAt === null ? [] : [o.judgedAt! - o.startedAt]));
    const meanServiceMs = services.length ? services.reduce((s, v) => s + v, 0) / services.length : null;
    const makespanMs = lastJudged - firstQueued;

    console.log("");
    console.log(laneTable(lanes));
    console.log("");
    log(`makespan ${fmtMs(makespanMs)} for ${outcomes.length} jobs on ${fleet.slots} slot(s): ${((finished.length / Math.max(1, makespanMs)) * 60_000).toFixed(1)} jobs/min`);
    log(`mean slot time per job (claim -> result): ${fmtMs(meanServiceMs)}`);
    log(
      `PRACTICE starvation: ${starvation.starved ? "YES" : "no"} — longest PRACTICE wait while a usable slot was free ` +
        `${fmtMs(starvation.maxWaitWhileUsableSlotFreeMs)} (threshold ${fmtMs(starvation.thresholdMs)}; ` +
        `while any slot, incl. RUN's reservation, was free: ${fmtMs(starvation.maxWaitWhileAnySlotFreeMs)})`,
    );
    if (!complete) log("INCOMPLETE: some jobs never finished; their waits are missing from the table");
    if (options.markdown) {
      console.log("");
      console.log(laneMarkdown(lanes));
    }
    if (options.json) {
      const report = {
        runId,
        at: new Date(t0).toISOString(),
        options: { ...options, json: undefined },
        fleet,
        clocks: { postgresOffsetMs: dbClock.offsetMs, redisOffsetMs: redisClock.offsetMs },
        complete,
        makespanMs,
        meanServiceMs,
        lanes,
        starvation,
        jobs: outcomes,
      };
      await writeFile(options.json, JSON.stringify(report, null, 2));
      log(`report written to ${options.json}`);
    }
    log(`clean up afterwards with: npx tsx ../../scripts/load/burst.ts --cleanup ${runId}`);
    if (!complete || lanes.some((l) => l.internalErrors > 0)) process.exitCode = 1;
  } finally {
    await Promise.all([...queues.values()].map((q) => q.close().catch(() => undefined)));
    redis?.disconnect();
    await db.$disconnect();
  }
}

main().catch((error: unknown) => {
  if (error instanceof UsageError) {
    console.error(`[burst] ${error.message}`);
    process.exit(2);
  }
  console.error("[burst] failed:", error);
  process.exit(1);
});
