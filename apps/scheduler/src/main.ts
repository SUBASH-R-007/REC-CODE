import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";
import { createPrismaClient } from "@recx/db";
import { RECONCILER_INTERVAL_MS, type SchedulerJobName } from "@recx/shared";
import { Redis } from "ioredis";
import pino from "pino";
import { describeDatabaseUrl, loadConfig, loadDevEnvFile, withSingleConnection } from "./config";
import { DailyChallengeJob } from "./daily-challenge";
import { AttemptSweepJob } from "./attempt-sweep";
import { ContestRankJob } from "./contest-rank";
import { GovernanceSweepJob } from "./governance";
import { recordJobStatus } from "./job-status";
import { LeaderboardFreezeJob } from "./leaderboard-freeze";
import { createMailTransport } from "./mail";
import { OutboxDrainJob } from "./outbox";
import { BullJudgeQueues } from "./queues";
import { runReconcilerTick, tickDidWork } from "./reconciler";

/**
 * REC Code scheduler. Every RECONCILER_INTERVAL_MS one tick runs the judge
 * reconciler (submissions, runs and validation runs; node sweep and lane
 * hygiene), the RunRequest TTL and the retention purge — the last two
 * suspended while PlatformSetting `retention` holds `{ legalHold: true }`.
 * The same tick then runs the progress jobs — the daily challenge (a row for
 * each campus day) and the leaderboard freeze (snapshots of closed WEEK /
 * MONTH periods) — which cost nothing until there is work, and are each
 * isolated so one failing never stops the others. Later phases add the
 * dormancy sweep and the remaining retention purges (SubmissionSource
 * archival, proctoring evidence) to this same loop.
 *
 *   node dist/main.js            run until SIGTERM / SIGINT
 *   node dist/main.js --once     one tick, then exit (exit code 1 if it failed)
 *   node dist/main.js --dry-run  read and decide, write nothing to Postgres or Redis
 */

/** Hard stop if a graceful shutdown hangs (a wedged tick or connection). */
const SHUTDOWN_DEADLINE_MS = 30_000;
/** How long startup waits for Redis before ticking anyway (Postgres work does not need it). */
const REDIS_STARTUP_WAIT_MS = 5_000;
/** Redis reconnect errors repeat every second or two during an outage; log one per window. */
const REDIS_ERROR_LOG_WINDOW_MS = 60_000;

function parseFlags(): { once: boolean; dryRun: boolean } {
  try {
    const { values } = parseArgs({
      options: {
        once: { type: "boolean", default: false },
        "dry-run": { type: "boolean", default: false },
      },
      strict: true,
    });
    return { once: values.once === true, dryRun: values["dry-run"] === true };
  } catch (err) {
    console.error(`${(err as Error).message}\nUsage: node dist/main.js [--once] [--dry-run]`);
    process.exit(2);
  }
}
const { once, dryRun } = parseFlags();

const envFile = loadDevEnvFile();
const config = loadConfig();
const log = pino({ name: "recx-scheduler", level: config.logLevel });

if (envFile) log.info({ envFile }, "loaded development environment file");
if (config.databaseUrlSource === "DATABASE_URL") {
  log.warn("DATABASE_URL_DIRECT is not set; using DATABASE_URL (accepted in development only)");
}
if (dryRun) log.info("dry run: decisions are logged, nothing is written to Postgres or Redis");

const db = createPrismaClient({ url: withSingleConnection(config.databaseUrl) });
const redis = new Redis(config.redisUrl, {
  // Fail fast while disconnected so a Redis outage never stalls a tick; the
  // rows stay QUEUED in Postgres and the next tick retries.
  enableOfflineQueue: false,
  maxRetriesPerRequest: 1,
  commandTimeout: 5_000,
});
let lastRedisErrorAt = 0;
redis.on("error", (err: Error) => {
  const now = Date.now();
  if (now - lastRedisErrorAt < REDIS_ERROR_LOG_WINDOW_MS) return;
  lastRedisErrorAt = now;
  log.warn({ err: err.message }, "redis connection error (enqueues are deferred until it recovers)");
});
redis.on("ready", () => {
  lastRedisErrorAt = 0;
  log.info("redis connected");
});
const queues = new BullJudgeQueues(redis, log);
const dailyChallenge = new DailyChallengeJob({ db, log, dryRun });
const leaderboardFreeze = new LeaderboardFreezeJob({ db, log, dryRun });
// Governance (Phase 4): the security-email outbox drain and the sweep that
// expires privileged requests and closes lapsed impersonations.
const mailTransport = createMailTransport(config.mail, log);
const outbox = new OutboxDrainJob({ db, log, dryRun, transport: mailTransport });
const governance = new GovernanceSweepJob({ db, log, dryRun });
// Contests (Phase 5): the only writer of ContestStanding.rank.
const contestRank = new ContestRankJob({ db, log, dryRun });
const attemptSweep = new AttemptSweepJob({ db, log, dryRun });
log.info({ mailTransport: mailTransport.name }, "mail transport");

// ── Lifecycle ───────────────────────────────────────────────────────────

let stopping = false;
const wake = new AbortController();

function requestStop(signal: NodeJS.Signals): void {
  if (stopping) {
    log.warn({ signal }, "second signal; exiting immediately");
    process.exit(1);
  }
  stopping = true;
  log.info({ signal }, "shutting down after the current tick");
  wake.abort();
  setTimeout(() => {
    log.error("graceful shutdown timed out; exiting");
    process.exit(1);
  }, SHUTDOWN_DEADLINE_MS).unref();
}
process.on("SIGTERM", requestStop);
process.on("SIGINT", requestStop);

async function waitForRedis(timeoutMs: number): Promise<void> {
  if (queues.ready()) return;
  const done = new AbortController();
  const finish = () => done.abort();
  redis.once("ready", finish);
  wake.signal.addEventListener("abort", finish, { once: true });
  await sleep(timeoutMs, undefined, { signal: done.signal }).catch(() => undefined);
  redis.off("ready", finish);
  wake.signal.removeEventListener("abort", finish);
  if (!queues.ready()) log.warn("redis not ready yet; ticking anyway (enqueues are deferred)");
}

/**
 * Run one job, isolated: a throw is logged and marks the tick failed, and
 * the job's status row (SchedulerJobStatus, read by /super/jobs) is
 * recorded either way, except in a dry run, which writes nothing.
 */
async function runJob(
  job: SchedulerJobName,
  fn: () => Promise<{ ok: boolean; report: unknown }>,
): Promise<boolean> {
  const startedAt = new Date();
  let ok = false;
  let report: unknown;
  let error: string | null = null;
  try {
    ({ ok, report } = await fn());
    if (!ok) error = "the job reported a failure (see the scheduler log)";
  } catch (err) {
    log.error({ err, job }, "scheduler job failed");
    error = err instanceof Error ? err.message : String(err);
  }
  try {
    await recordJobStatus(db, job, { startedAt, finishedAt: new Date(), ok, error, report }, dryRun);
  } catch (err) {
    log.warn({ err, job }, "could not record the job status");
  }
  return ok;
}

/** One tick, never throwing: a failed tick is logged and the next one retries. */
async function tick(): Promise<boolean> {
  const results: boolean[] = [];
  results.push(
    await runJob("reconciler", async () => {
      const report = await runReconcilerTick({ db, queues, log, dryRun });
      if (report.lock === "busy") log.debug("another scheduler instance holds the reconciler lock; skipped");
      else if (tickDidWork(report) || once) log.info({ report }, "reconciler tick");
      else log.debug({ report }, "reconciler tick");
      return { ok: true, report };
    }),
  );
  // Progress jobs: idempotent inserts keyed by date / period, so they need no
  // instance lock; each logs its own work and backs off after a failure.
  const now = new Date();
  results.push(
    await runJob("dailyChallenge", async () => {
      const report = await dailyChallenge.tick(now);
      return { ok: !report.failed, report };
    }),
  );
  results.push(
    await runJob("leaderboardFreeze", async () => {
      const report = await leaderboardFreeze.tick(now);
      return { ok: !report.failed, report };
    }),
  );
  // Governance: SKIP LOCKED claims and conditional updates, safe with two instances.
  results.push(await runJob("outbox", async () => ({ ok: true, report: await outbox.tick() })));
  results.push(await runJob("governance", async () => ({ ok: true, report: await governance.tick() })));
  // Contests: idempotent "set rank to this value" writes, so it is safe
  // with two instances; the job itself holds the 15-second cadence.
  results.push(
    await runJob("contestRank", async () => {
      const report = await contestRank.tick(now);
      if (report.reranked > 0) log.info({ report }, "contest rank tick");
      return { ok: !report.failed, report };
    }),
  );
  // Assessments: auto-submit at the deadline and the 45-second presence
  // sweep. SKIP LOCKED claims and status-conditional writes, so it is safe
  // with two instances; the job itself holds the 15-second cadence.
  results.push(
    await runJob("attemptSweep", async () => {
      const report = await attemptSweep.tick(now);
      if (report.autoSubmitted > 0 || report.disconnected > 0) log.info({ report }, "attempt sweep tick");
      return { ok: !report.failed, report };
    }),
  );
  return results.every(Boolean);
}

async function close(): Promise<void> {
  await queues.close();
  await redis.quit().catch(() => redis.disconnect());
  await db.$disconnect();
}

async function main(): Promise<void> {
  log.info(
    {
      intervalMs: RECONCILER_INTERVAL_MS,
      once,
      dryRun,
      database: describeDatabaseUrl(config.databaseUrl),
      databaseUrlFrom: config.databaseUrlSource,
    },
    "scheduler starting",
  );
  await waitForRedis(REDIS_STARTUP_WAIT_MS);

  let ok = true;
  // The next tick starts only after the previous one has finished, so ticks
  // never overlap however long one takes.
  while (!stopping) {
    const startedAt = Date.now();
    ok = await tick();
    if (once) break;
    const remaining = RECONCILER_INTERVAL_MS - (Date.now() - startedAt);
    if (remaining > 0) await sleep(remaining, undefined, { signal: wake.signal }).catch(() => undefined);
  }

  await close();
  log.info("scheduler stopped");
  if (once && !ok) process.exitCode = 1;
}

main().catch(async (err: unknown) => {
  log.fatal({ err }, "scheduler crashed");
  await close().catch(() => undefined);
  process.exit(1);
});
