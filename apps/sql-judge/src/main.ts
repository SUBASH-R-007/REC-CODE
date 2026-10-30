import os from "node:os";
import { Worker, type Job } from "bullmq";
import IORedis from "ioredis";
import {
  JUDGE_HEARTBEAT_MS,
  JUDGE_PROTOCOL_VERSION,
  LIMITS,
  SQL_LANGUAGE_KEY,
  type JudgeJobData,
  type JudgeNodeStatus,
} from "@recx/shared";
import { HttpSqlJudgeApi, isRefusal, type SqlJudgeApi } from "./api";
import { ConfigError, loadDevEnvFile, parseConfig, type SqlJudgeConfig } from "./config";
import { InfraError, ProtocolMismatchError, errorMessage } from "./errors";
import { checkCluster } from "./hardening";
import { judgeSqlJob } from "./judge";
import { createLogger, type Logger } from "./logger";
import { SqlSandbox } from "./sandbox";
import { runSelfCheck, type SelfCheckResult } from "./selfcheck";
import { SQL_JUDGE_VERSION } from "./version";

/**
 * The SQL judge process (Phase 12k).
 *
 * It consumes only the SQL queues, claims each job, runs its cases in the
 * sandbox and posts the result — the same lease, the same attempt cap and
 * the same release-on-infrastructure-failure rules as the isolate worker,
 * because they are the pipeline's rules rather than that worker's.
 *
 * At boot it checks the cluster (`hardening.ts`) and runs the adversarial
 * self-check (`selfcheck.ts`). A cluster that fails the first is refused
 * outright: a sandbox that is actually the application's database is not
 * something to carry on with. A failed self-check is reported in every
 * heartbeat, which is what the fleet uses to withhold the sensitive lanes.
 */

async function main(): Promise<void> {
  const envFile = loadDevEnvFile();
  let config: SqlJudgeConfig;
  try {
    config = parseConfig(process.env);
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message);
      process.exit(78); // EX_CONFIG
    }
    throw error;
  }

  const logger = createLogger({ level: config.LOG_LEVEL, nodeId: config.RECX_NODE_ID });
  if (envFile) logger.info({ envFile }, "loaded development environment file");

  const sandbox = new SqlSandbox({
    ownerUrl: config.RECX_SQL_OWNER_URL,
    studentUrl: config.RECX_SQL_STUDENT_URL,
  });

  // ── Boot checks ───────────────────────────────────────────────────────
  const cluster = await checkCluster({
    ownerUrl: config.RECX_SQL_OWNER_URL,
    studentUrl: config.RECX_SQL_STUDENT_URL,
  }).catch((error: unknown) => {
    logger.fatal({ err: error }, "the sandbox cluster could not be checked");
    process.exit(75); // EX_TEMPFAIL
  });

  for (const check of cluster.checks) {
    logger[check.ok ? "info" : "error"]({ check: check.name }, check.detail);
  }
  const sandboxOnly = cluster.checks.find((c) => c.name === "sandbox-only database");
  if (sandboxOnly && !sandboxOnly.ok) {
    // Never, whatever the override says: this is the one check whose
    // failure means student data is in reach.
    logger.fatal("refusing to start: the configured sandbox is the application's database");
    process.exit(78);
  }
  if (!cluster.ok && !config.RECX_DEV_ALLOW_UNHARDENED_CLUSTER) {
    logger.fatal("refusing to start: the sandbox cluster failed its hardening checks");
    process.exit(78);
  }

  // A schema left behind means a judge died mid-case, and the student role
  // was granted SELECT on it. Sweep before taking any work.
  const stale = await sandbox.dropStaleSchemas().catch((error: unknown) => {
    logger.error({ err: errorMessage(error) }, "could not sweep stale schemas");
    return [] as string[];
  });
  if (stale.length > 0) logger.warn({ dropped: stale.length }, "dropped schemas left behind by an earlier process");

  let selfCheck: SelfCheckResult = await runSelfCheck(sandbox);
  for (const failure of selfCheck.failures) logger.error({ selfCheck: true }, failure);
  logger.info({ ok: selfCheck.ok, cases: selfCheck.failures.length }, "self-check complete");

  const api: SqlJudgeApi = new HttpSqlJudgeApi({
    appUrl: config.RECX_APP_URL,
    nodeId: config.RECX_NODE_ID,
    token: config.RECX_NODE_TOKEN,
  });

  // ── Heartbeat ─────────────────────────────────────────────────────────
  let status: JudgeNodeStatus = "OFFLINE";
  let busy = 0;
  const beat = async () => {
    try {
      const response = await api.heartbeat({
        protocolVersion: JUDGE_PROTOCOL_VERSION,
        hostname: os.hostname(),
        workerVersion: SQL_JUDGE_VERSION,
        isolateVersion: "",
        driver: "postgres",
        engineVersion: cluster.engineVersion,
        /**
         * The one language this node judges. `sql17` is not a toolchain —
         * there is no argv and no /opt/toolchains directory behind it —
         * but it IS the language a submission carries, and the fleet page
         * reads this list to say what a node can do. Reporting nothing
         * made a working node look like a node with nothing to offer.
         */
        languages: [SQL_LANGUAGE_KEY],
        slots: config.RECX_SLOTS,
        busySlots: busy,
        calibrationScore: null,
        calibratedAt: null,
        selfCheck: {
          ok: selfCheck.ok,
          at: selfCheck.ranAt.toISOString(),
          failures: selfCheck.failures.slice(0, 50),
        },
        hostHardening: { ok: cluster.ok, failures: cluster.checks.filter((c) => !c.ok).map((c) => c.detail) },
        startupMs: {},
      });
      if (response.status !== status) logger.info({ from: status, to: response.status }, "node status changed");
      status = response.status;
    } catch (error) {
      if (error instanceof ProtocolMismatchError) throw error;
      logger.warn({ err: errorMessage(error) }, "heartbeat failed");
    }
  };
  await beat();
  const heartbeat = setInterval(() => void beat(), JUDGE_HEARTBEAT_MS);

  // The self-check is re-run on the same cadence the isolate worker uses,
  // so a cluster somebody loosened by hand stops serving sensitive lanes.
  const selfCheckTimer = setInterval(
    () =>
      void runSelfCheck(sandbox)
        .then((result) => {
          selfCheck = result;
          for (const failure of result.failures) logger.error({ selfCheck: true }, failure);
        })
        .catch((error: unknown) => logger.warn({ err: errorMessage(error) }, "self-check could not run")),
    LIMITS.selfCheck.intervalMs,
  );

  // ── The job loop ──────────────────────────────────────────────────────
  const connection = new IORedis(config.REDIS_URL, { maxRetriesPerRequest: null });
  const workers = config.RECX_QUEUES.map(
    (queue) =>
      new Worker<JudgeJobData>(
        queue,
        async (job: Job<JudgeJobData>) => {
          busy += 1;
          try {
            await runOne(job.data, { api, sandbox, nodeId: config.RECX_NODE_ID, logger });
          } finally {
            busy -= 1;
          }
        },
        { connection, concurrency: config.RECX_SLOTS },
      ),
  );

  const stop = async () => {
    clearInterval(heartbeat);
    clearInterval(selfCheckTimer);
    await Promise.all(workers.map((w) => w.close()));
    await connection.quit().catch(() => undefined);
    logger.info("stopped");
  };
  process.on("SIGINT", () => void stop().then(() => process.exit(0)));
  process.on("SIGTERM", () => void stop().then(() => process.exit(0)));

  logger.info(
    { queues: config.RECX_QUEUES, slots: config.RECX_SLOTS, engine: cluster.engineVersion },
    "sql judge ready",
  );
}

/** One job: claim, judge, post. Releases the lease on an infrastructure failure. */
export async function runOne(
  data: JudgeJobData,
  deps: { api: SqlJudgeApi; sandbox: SqlSandbox; nodeId: string; logger: Logger },
): Promise<void> {
  const log = deps.logger.child({ kind: data.kind, id: data.id });
  const claim = await deps.api.claim(data);
  if (isRefusal(claim)) {
    log.info({ reason: claim.reason }, "claim refused; the job is done");
    return;
  }
  const spec = claim;

  let outcome;
  try {
    outcome = await judgeSqlJob(spec, {
      sandbox: deps.sandbox,
      readBlob: (ref) => deps.api.fetchBlob(ref, { kind: spec.kind, id: spec.id, claimToken: spec.claimToken }),
      logger: log,
    });
  } catch (error) {
    if (error instanceof ProtocolMismatchError) throw error;
    const infra = error instanceof InfraError ? error : new InfraError(errorMessage(error), { cause: error });
    await deps.api
      .release({
        protocolVersion: JUDGE_PROTOCOL_VERSION,
        kind: spec.kind,
        id: spec.id,
        claimToken: spec.claimToken,
        reason: infra.message.slice(0, 500),
        permanent: infra.permanent,
      })
      .catch((releaseError: unknown) => log.error({ err: errorMessage(releaseError) }, "release failed"));
    if (infra.permanent) {
      log.error({ err: infra.message }, "this job can never be judged as specified; released permanently");
      return;
    }
    log.error({ err: infra.message }, "infrastructure failure; lease released for a retry");
    throw infra;
  }

  const posted = await deps.api.postResult({
    protocolVersion: JUDGE_PROTOCOL_VERSION,
    kind: spec.kind,
    id: spec.id,
    claimToken: spec.claimToken,
    ...outcome,
    subtasks: [],
    judgeNodeId: deps.nodeId,
    calibrationScore: null,
  });
  log[posted.stale ? "warn" : "info"](
    { verdict: outcome.verdict, passed: outcome.passedCases, total: outcome.totalCases, stale: posted.stale },
    posted.stale ? "result was stale; discarded by the server" : "judged",
  );
}

// `node dist/main.js` only; importing this module in a test runs nothing.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop() ?? "")) {
  main().catch((error: unknown) => {
    console.error(errorMessage(error));
    process.exit(1);
  });
}
