import { createHash, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { parseArgs } from "node:util";
import { createPrismaClient } from "../../packages/db/src/index";
import {
  ALERTS,
  LANE_PRIORITY,
  QUEUE_NAME,
  buildMetrics,
  parseSamples,
  type AlertReading,
  type AlertSpec,
} from "../../packages/shared/src/index";
import { observeJudgeMetrics } from "../../apps/scheduler/src/observe";
import { BullJudgeQueues } from "../../apps/scheduler/src/queues";
import { renderMetrics as renderSchedulerMetrics } from "../../apps/scheduler/src/metrics";

/**
 * scripts/ops is not a workspace package (no dependencies of its own), so
 * third-party packages are loaded through apps/scheduler's dependency tree
 * — the same tree the scheduler modules above already resolve from, which
 * is what makes reusing its observer in-process possible at all. The types
 * come from tsconfig "paths" (scripts/ops/tsconfig.json). scripts/load does
 * the same through apps/web.
 */
const schedulerRequire = createRequire(new URL("../../apps/scheduler/package.json", import.meta.url));
const { Queue } = schedulerRequire("bullmq") as typeof import("bullmq");
const { Redis } = schedulerRequire("ioredis") as typeof import("ioredis");
const { Counter, Gauge, Histogram, Registry } = schedulerRequire("@prometheus-io/client") as typeof import("@prometheus-io/client");

type Counter<T extends string> = import("@prometheus-io/client").Counter<T>;
type Gauge<T extends string> = import("@prometheus-io/client").Gauge<T>;
type Histogram<T extends string> = import("@prometheus-io/client").Histogram<T>;
type Redis = import("ioredis").Redis;

/**
 * Fire every alert rule (Phase 10b).
 *
 * SPEC §10's gate item is not the rule file, it is this: each of the eight
 * rules driven against a condition this repository can produce, with the
 * number it computes read back and compared with the rule's own threshold.
 * An alert rule that has never been fired is a comment.
 *
 * What it does for each rule:
 *
 *   1. reads the metric BEFORE producing anything (the baseline),
 *   2. produces the condition,
 *   3. reads the metric again and runs the rule's own `reduce` over both
 *      scrapes,
 *   4. compares with the rule's `threshold`.
 *
 * Four rules are produced for real, against the live Redis, Postgres and web
 * app. Four cannot be, and the table says so rather than quietly passing:
 * two read exporters that need root to install on a development machine, one
 * needs a problem whose checker exits 3 run through the whole pipeline, and
 * one needs the judge to be slow on purpose. Those four are asserted against
 * samples — for our own metrics, built from the contract's real definitions
 * through `buildMetrics`, so a bucket ladder or a label set changed in
 * `packages/shared/src/metrics.ts` changes what this asserts.
 *
 * And the honest limit, stated here because it would otherwise be implied
 * away: this proves the CONDITION is producible and the NUMBER crosses.
 * `reduce` mirrors each PromQL expression; it does not evaluate it. Nothing
 * on this machine can — `promtool check rules` in CI is what checks the
 * expressions themselves.
 *
 * Usage (Postgres and Redis up; the scheduler and the worker stopped):
 *
 *   pnpm --filter @recx/scheduler exec tsx ../../scripts/ops/fire-alerts.ts
 *   pnpm --filter @recx/scheduler exec tsx ../../scripts/ops/fire-alerts.ts --only JudgeQueueBacklog
 *   pnpm --filter @recx/scheduler exec tsx ../../scripts/ops/fire-alerts.ts --list
 */

const { values } = parseArgs({
  options: {
    only: { type: "string" },
    list: { type: "boolean", default: false },
    "web-url": { type: "string", default: process.env.RECX_APP_URL ?? "http://localhost:3000" },
  },
});

const WEB_URL = (values["web-url"] as string).replace(/\/+$/, "");
const METRICS_TOKEN = process.env.METRICS_TOKEN ?? "";
const REDIS_URL = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";

/** Everything this script creates carries this prefix, and is removed. */
const TAG = "fire-alerts";
const BACKLOG_JOBS = 250;
const LOGIN_ATTEMPTS = 120;
/** The oldest-job rule needs 60 s of real waiting; allow 80. */
const AGE_WAIT_MS = 80_000;

/**
 * The logger the scheduler's observer expects. Not pino: a stub, whose
 * `warn` goes to the console on purpose. `observeJudgeMetrics` swallows
 * every failure by design — a metrics problem must never fail a tick — so
 * in a harness whose whole job is to watch those metrics move, the swallowed
 * warning is the most useful line on the screen.
 */
const noop = () => {};
const log = {
  warn: (...args: unknown[]) => console.error("    [observer]", ...args),
  info: noop,
  debug: noop,
  error: (...args: unknown[]) => console.error("    [observer]", ...args),
  fatal: noop,
  trace: noop,
  silent: noop,
  level: "warn",
} as unknown as import("pino").Logger;

type Status = "PASS" | "FAIL" | "SKIP";

interface Outcome {
  readonly alert: AlertSpec;
  readonly status: Status;
  /** The number before the condition was produced, if it could be read. */
  readonly baseline: number | null;
  readonly measured: number | null;
  readonly note: string;
}

/** A producer returns the two scrapes the rule's `reduce` needs. */
type Producer = () => Promise<{ reading: AlertReading; note: string }>;

// ── Reading the registries ──────────────────────────────────────────────

/**
 * The scheduler's gauges, published by the scheduler's own observer.
 *
 * In-process rather than by scraping a running scheduler, and that is a
 * deliberate trade: the real process publishes once a RECONCILER_INTERVAL_MS
 * tick, so scraping one would mean waiting up to a minute per rule and
 * racing its reconciler, which removes queue jobs whose submissions it
 * cannot find. This calls the same `observeJudgeMetrics` the tick calls,
 * against the same Redis and the same table, and renders the same registry.
 */
async function schedulerScrape(db: ReturnType<typeof createPrismaClient>, queues: BullJudgeQueues): Promise<string> {
  await observeJudgeMetrics({ db, queues, log });
  return renderSchedulerMetrics();
}

/** The web app's `/metrics`, through the bearer token it is guarded by. */
async function webScrape(): Promise<string> {
  const url = `${WEB_URL}/api/metrics`;
  const response = await fetch(url, { headers: { authorization: `Bearer ${METRICS_TOKEN}` } }).catch(
    (error: unknown) => {
      // `fetch failed` on its own is the least useful line this harness could
      // print: the whole question is which address it could not reach.
      throw new Error(`cannot reach ${url} (is the web app running?): ${error instanceof Error ? error.message : String(error)}`);
    },
  );
  if (response.status === 404) {
    // The route answers 404 rather than 401 for a wrong or unset token, so
    // that a scan cannot tell the endpoint exists. Here it means the token.
    throw new Error(`${url} answered 404: METRICS_TOKEN does not match the web app's`);
  }
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  return response.text();
}

/**
 * A registry holding the contract's own metrics, for the rules whose
 * condition cannot be produced here.
 *
 * Built through `buildMetrics`, so these are the real definitions — the same
 * names, labels, help text and bucket ladders the web process publishes. An
 * assertion against a histogram invented in this file would prove nothing
 * about the rule; an assertion against this one fails if the ladder in
 * `packages/shared/src/metrics.ts` moves under it.
 */
function contractRegistry(owner: "web" | "scheduler" | "judge-worker") {
  const registry = new Registry();
  const metrics = buildMetrics<Counter<string>, Gauge<string>, Histogram<string>>(owner, {
    counter: (options) => new Counter({ ...options, registers: [registry] }),
    gauge: (options) => new Gauge({ ...options, registers: [registry] }),
    histogram: (options) => new Histogram({ ...options, registers: [registry] }),
  });
  return { registry, metrics };
}

function reading(before: string, after: string, elapsedSeconds: number): AlertReading {
  return { before: parseSamples(before), after: parseSamples(after), elapsedSeconds };
}

// ── The producers ───────────────────────────────────────────────────────

function buildProducers(db: ReturnType<typeof createPrismaClient>, redis: Redis, queues: BullJudgeQueues): Record<string, Producer> {
  const practice = () => new Queue(QUEUE_NAME.PRACTICE, { connection: redis });

  return {
    /**
     * 250 jobs into the PRACTICE lane. PRACTICE on purpose: it is the lowest
     * priority, so if a worker is running after all it takes the contest and
     * assessment lanes first, and the only thing this can delay is itself.
     */
    JudgeQueueBacklog: async () => {
      const queue = practice();
      const ids = Array.from({ length: BACKLOG_JOBS }, (_, i) => `${TAG}-backlog-${i}`);
      try {
        const before = await schedulerScrape(db, queues);
        await queue.addBulk(
          ids.map((id) => ({
            name: "judge",
            data: { kind: "submission" as const, id },
            opts: { jobId: id, priority: LANE_PRIORITY.PRACTICE, removeOnComplete: true, removeOnFail: true },
          })),
        );
        const after = await schedulerScrape(db, queues);
        return { reading: reading(before, after, 1), note: `${BACKLOG_JOBS} jobs enqueued on ${QUEUE_NAME.PRACTICE}` };
      } finally {
        // Always: 250 orphan jobs left in a dev Redis are 250 jobs a worker
        // started later would try to judge.
        await Promise.allSettled(ids.map((id) => queue.remove(id)));
        await queue.close();
      }
    },

    /**
     * One job, and then the only honest way to produce a 60-second wait:
     * waiting. Backdating the job's arrival time would test the clock
     * arithmetic and nothing else.
     */
    JudgeOldestJobStale: async () => {
      const queue = practice();
      const id = `${TAG}-age`;
      try {
        const before = await schedulerScrape(db, queues);
        await queue.add(
          "judge",
          { kind: "submission" as const, id },
          { jobId: id, priority: LANE_PRIORITY.PRACTICE, removeOnComplete: true, removeOnFail: true },
        );
        const alert = ALERTS.find((a) => a.name === "JudgeOldestJobStale")!;
        const deadline = Date.now() + AGE_WAIT_MS;
        let after = await schedulerScrape(db, queues);
        process.stdout.write(`    waiting for the job to age past ${alert.threshold}s `);
        while (Date.now() < deadline) {
          const value = alert.reduce(reading(before, after, 1));
          if (value !== null && value > alert.threshold) break;
          await new Promise((resolve) => setTimeout(resolve, 5_000));
          process.stdout.write(".");
          after = await schedulerScrape(db, queues);
        }
        process.stdout.write("\n");
        return { reading: reading(before, after, 1), note: "one job left to wait, no worker consuming the lane" };
      } finally {
        await queue.remove(id).catch(() => undefined);
        await queue.close();
      }
    },

    /**
     * A real JudgeNode row whose last heartbeat is two minutes old. Real
     * because the gauge is DERIVED from this table rather than
     * self-reported, so the row is the condition: there is nothing else to
     * fake.
     */
    JudgeWorkerHeartbeatStale: async () => {
      const id = `${TAG}-probe`;
      try {
        const before = await schedulerScrape(db, queues);
        await db.judgeNode.upsert({
          where: { id },
          update: { lastHeartbeatAt: new Date(Date.now() - 120_000) },
          create: {
            id,
            hostname: `${TAG}-probe`,
            // Never a real token, and never one that could be used: a random
            // 32 bytes hashed, which no token hashes to.
            tokenHash: createHash("sha256").update(randomBytes(32)).digest("hex"),
            status: "OFFLINE",
            lastHeartbeatAt: new Date(Date.now() - 120_000),
          },
        });
        const after = await schedulerScrape(db, queues);
        /**
         * The rule computes `max by (worker)`, and on a development stack
         * the max is usually some other node that stopped checking in an
         * hour ago — so the max alone would say nothing about what this
         * harness produced. The probe's OWN series goes in the note, which
         * is the number that proves the row reached the gauge.
         */
        const probe = parseSamples(after).find(
          (sample) => sample.name === "judge_worker_heartbeat_age_seconds" && sample.labels.worker === `${TAG}-probe`,
        );
        const own = probe ? `${probe.value.toFixed(0)}s` : "ABSENT";
        return {
          reading: reading(before, after, 1),
          note: `a JudgeNode row whose last heartbeat is 120s old; its own series reads ${own}`,
        };
      } finally {
        await db.judgeNode.delete({ where: { id } }).catch(() => undefined);
      }
    },

    /**
     * 120 real sign-in attempts against the running web app, with a
     * password that is wrong because the account does not exist.
     *
     * An identifier that does not exist on purpose: a real student's account
     * would collect five audit rows and sit rate-limited for fifteen
     * minutes, and the counter does not care which it was. What this does
     * leave behind is this machine's hashed address in the IP bucket for the
     * window — which is the limiter working, and is why the runbook says to
     * expect it.
     */
    FailedLoginBurst: async () => {
      if (!METRICS_TOKEN) throw new Error("METRICS_TOKEN is not set, so /api/metrics cannot be read");
      const before = await webScrape();
      const startedAt = Date.now();
      const identifier = `${TAG}-no-such-account@rajalakshmi.edu.in`;
      let posted = 0;
      // Eight at a time: enough to outrun the Argon2id verification the
      // first few attempts pay for, without making this a load test.
      for (let batch = 0; batch < LOGIN_ATTEMPTS; batch += 8) {
        await Promise.all(
          Array.from({ length: Math.min(8, LOGIN_ATTEMPTS - batch) }, async () => {
            const body = new URLSearchParams({ identifier, password: "not-the-password" });
            const response = await fetch(`${WEB_URL}/api/auth/login`, {
              method: "POST",
              headers: { "content-type": "application/x-www-form-urlencoded", origin: WEB_URL },
              body,
              redirect: "manual",
            });
            if (response.status === 303) posted++;
          }),
        );
      }
      const elapsedSeconds = (Date.now() - startedAt) / 1000;
      const after = await webScrape();
      return {
        reading: reading(before, after, elapsedSeconds),
        note: `${posted} refusals in ${elapsedSeconds.toFixed(1)}s against an identifier that does not exist`,
      };
    },

    /**
     * 100 verdicts, three of them IE, through the contract's own counter.
     *
     * Not produced for real: a genuine INTERNAL_ERROR needs a problem whose
     * checker exits 3 and a submission run through the whole pipeline. That
     * is the mid-contest judge drill in 10f — a thing to do to a judge host,
     * not a row for a script to write into a database.
     */
    JudgeInternalErrorRate: async () => {
      const { registry, metrics } = contractRegistry("web");
      const verdicts = metrics.judge_verdict_total as Counter<string>;
      const before = await registry.metrics();
      for (let i = 0; i < 97; i++) verdicts.inc({ verdict: "AC", language: "cpp" });
      for (let i = 0; i < 3; i++) verdicts.inc({ verdict: "IE", language: "cpp" });
      return {
        reading: reading(before, await registry.metrics(), 300),
        note: "3 IE in 100 verdicts, on the contract's own counter",
      };
    },

    /**
     * 20 verdicts, two of them over 30 seconds, through the contract's own
     * histogram — buckets included, which is the part that matters: the p95
     * of a histogram is a function of its bucket ladder, and this assertion
     * fails if the ladder in `metrics.ts` moves.
     */
    SubmissionLatencyP95High: async () => {
      const { registry, metrics } = contractRegistry("web");
      const latency = metrics.submission_e2e_latency_seconds as Histogram<string>;
      const before = await registry.metrics();
      for (let i = 0; i < 18; i++) latency.observe(2);
      latency.observe(40);
      latency.observe(50);
      return {
        reading: reading(before, await registry.metrics(), 300),
        note: "2 of 20 verdicts over 30s, on the contract's own histogram",
      };
    },

    /**
     * node_exporter's filesystem gauges, in its own shape.
     *
     * Filling a disk to 80% on a development laptop is not a test, it is an
     * outage — and the exporter is not installable here without root, so
     * there would be nothing to read even if it were filled.
     */
    HostDiskNearlyFull: async () => ({
      reading: reading(
        "",
        [
          'node_filesystem_size_bytes{instance="db.recx.internal:9100",mountpoint="/",fstype="ext4"} 500107862016',
          'node_filesystem_avail_bytes{instance="db.recx.internal:9100",mountpoint="/",fstype="ext4"} 90019415162',
        ].join("\n"),
        60,
      ),
      note: "node_exporter samples: 410 GB used of 500 GB (82%)",
    }),

    /**
     * postgres_exporter's connection gauges, in its own shape. The
     * condition itself is producible here — opening 80 connections is a
     * loop — but nothing would export it.
     */
    PostgresConnectionsHigh: async () => ({
      reading: reading(
        "",
        [
          "pg_settings_max_connections 100",
          'pg_stat_database_numbackends{datname="recx"} 78',
          'pg_stat_database_numbackends{datname="postgres"} 4',
        ].join("\n"),
        60,
      ),
      note: "postgres_exporter samples: 82 backends of 100",
    }),
  };
}

// ── Running them ────────────────────────────────────────────────────────

async function run(): Promise<number> {
  if (values.list) {
    for (const alert of ALERTS) {
      console.log(`${alert.produced === "live" ? "live     " : "synthetic"}  ${alert.name.padEnd(26)} ${alert.spec}`);
      console.log(`           ${alert.how}`);
    }
    return 0;
  }

  const selected = values.only ? ALERTS.filter((a) => a.name === values.only) : ALERTS;
  if (selected.length === 0) {
    console.error(`No rule named ${values.only}. --list shows them.`);
    return 2;
  }

  const db = createPrismaClient();
  const redis = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
  const queues = new BullJudgeQueues(redis, log);
  const producers = buildProducers(db, redis, queues);
  const outcomes: Outcome[] = [];

  try {
    for (const alert of selected) {
      console.log(`\n${alert.name} — ${alert.spec}`);
      const producer = producers[alert.name];
      if (!producer) {
        outcomes.push({ alert, status: "SKIP", baseline: null, measured: null, note: "no producer in this harness" });
        continue;
      }
      /**
       * The baseline is reported, not asserted. On a development stack the
       * dev judge node has usually not checked in for an hour, so
       * JudgeWorkerHeartbeatStale is already over its threshold before
       * anything is produced — which is the rule working, not a failure of
       * the harness. The two-sided proof (quiet below the threshold, firing
       * above it) is in packages/shared/test/alerts.test.ts, where the
       * readings can be controlled.
       */
      let baseline: number | null = null;
      try {
        const { reading: produced, note } = await producer();
        baseline = alert.reduce({ before: produced.before, after: produced.before, elapsedSeconds: produced.elapsedSeconds });
        const measured = alert.reduce(produced);
        const fired = measured !== null && measured > alert.threshold;
        outcomes.push({
          alert,
          status: fired ? "PASS" : "FAIL",
          baseline,
          measured,
          note: measured === null ? `${note} — the metric was not published at all` : note,
        });
        console.log(`    ${fired ? "FIRES" : "DID NOT FIRE"}: ${format(measured)} vs ${alert.threshold} (${note})`);
      } catch (error) {
        const why = error instanceof Error ? error.message : String(error);
        outcomes.push({ alert, status: "SKIP", baseline, measured: null, note: why });
        console.log(`    SKIPPED: ${why}`);
      }
    }
  } finally {
    await queues.close().catch(() => undefined);
    await redis.quit().catch(() => redis.disconnect());
    await db.$disconnect().catch(() => undefined);
  }

  report(outcomes);
  return outcomes.some((o) => o.status === "FAIL") ? 1 : 0;
}

function format(value: number | null): string {
  if (value === null) return "absent";
  return Number.isInteger(value) ? String(value) : value.toFixed(4);
}

function report(outcomes: readonly Outcome[]): void {
  console.log("\n  rule                        produced   baseline    measured   threshold  result");
  console.log("  " + "-".repeat(84));
  for (const o of outcomes) {
    console.log(
      `  ${o.alert.name.padEnd(27)} ${o.alert.produced.padEnd(10)} ${format(o.baseline).padStart(9)} ${format(o.measured).padStart(11)} ${String(o.alert.threshold).padStart(10)}  ${o.status}`,
    );
  }
  const passed = outcomes.filter((o) => o.status === "PASS").length;
  const failed = outcomes.filter((o) => o.status === "FAIL");
  const skipped = outcomes.filter((o) => o.status === "SKIP");
  console.log(`\n  ${passed}/${outcomes.length} rules fired.`);
  for (const o of failed) console.log(`  FAIL  ${o.alert.name}: ${o.note}`);
  for (const o of skipped) console.log(`  SKIP  ${o.alert.name}: ${o.note}`);
  const synthetic = outcomes.filter((o) => o.status === "PASS" && o.alert.produced === "synthetic");
  if (synthetic.length > 0) {
    console.log(
      `\n  ${synthetic.length} of those were asserted against samples rather than a produced condition:`,
    );
    for (const o of synthetic) console.log(`        ${o.alert.name}: ${o.alert.how}`);
  }
  console.log(
    "\n  This asserts that each condition is producible and that the number crosses.\n" +
      "  Whether the PromQL computes that number is checked by promtool in CI.",
  );
}

run().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error);
    process.exit(2);
  },
);
