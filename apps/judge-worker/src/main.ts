import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Redis } from "ioredis";
import { LIMITS, type HeartbeatResponse, type JudgeNodeStatus, type LanguageKey } from "@recx/shared";
import { startMetricsServer, type MetricsServer } from "@recx/shared/metrics-server";
import { LaneAllocator } from "./allocator";
import { HttpJudgeApi } from "./api";
import { enforceBootChecks } from "./boot";
import { BlobCache } from "./cache";
import {
  ConfigError,
  cpuPinningMismatches,
  loadDevEnvFile,
  maintenanceBoxIds,
  parseConfig,
  type WorkerConfig,
} from "./config";
import { createDriver, type JudgeDriver } from "./drivers";
import { resolveExecutable } from "./drivers/isolate";
import { errorMessage } from "./errors";
import { checkHostHardening, hardeningIntake } from "./hardening";
import { HeartbeatLoop, emptyHealth, type NodeHealth } from "./heartbeat";
import { createLogger, type Logger } from "./logger";
import { METRICS_CONTENT_TYPE, renderMetrics } from "./metrics";
import type { ProcessorDeps } from "./processor";
import { RedisPublisher } from "./publisher";
import { runCalibration } from "./calibration";
import { IsolateSandbox } from "./sandbox/isolate";
import { runSelfCheck } from "./selfcheck/runner";
import { SlotPool } from "./slots";
import { measureStartupCredit } from "./startup-credit";
import { WORKER_VERSION } from "./version";

/**
 * Judge worker entry point. Boot order (docs/JUDGE.md "Host hardening"):
 *
 *   config → mock/production guards → host hardening → driver → self-check →
 *   calibration → startup credit → heartbeat loop → lane allocator
 *
 * The allocator starts only after an ONLINE heartbeat whose lanes are
 * non-empty, and only when the node is cleared for intake (host hardened — or
 * RECX_DEV_ALLOW_UNHARDENED_HOST on a dev box — and the self-check passing).
 * Self-check and calibration re-run every 6 h; if they still pass intake is
 * not interrupted, and if a re-run fails the node stops taking jobs and keeps
 * heartbeating its failures so the web quarantines it.
 */

const DRAIN_MS = 60_000;
/** isolate first_uid (infra/judge/install-isolate.sh). Box uid = FIRST_UID + box id. */
const FIRST_UID = 60000;

function loadConfigOrExit(): WorkerConfig {
  loadDevEnvFile();
  enforceBootChecks(process.env);
  try {
    return parseConfig(process.env);
  } catch (error) {
    process.stderr.write(`[judge-worker] ${error instanceof ConfigError ? error.message : errorMessage(error)}\n`);
    process.exit(1);
  }
}

/** A maintenance sandbox in the self-check box range (never collides with a job box). */
function createMaintenanceSandbox(config: WorkerConfig, metaDir: string, logger: Logger): IsolateSandbox {
  return new IsolateSandbox({
    isolateBin: resolveExecutable(config.RECX_ISOLATE_BIN),
    boxIds: maintenanceBoxIds(config.RECX_SELFCHECK_BOX_BASE),
    syntheticEtc: config.RECX_SYNTHETIC_ETC,
    metaDir,
    logger,
  });
}

async function main(): Promise<void> {
  const config = loadConfigOrExit();
  const logger = createLogger({ level: config.LOG_LEVEL, nodeId: config.RECX_NODE_ID });
  logger.info(
    { version: WORKER_VERSION, driver: config.RECX_DRIVER, slots: config.RECX_SLOTS, queues: config.RECX_QUEUES },
    "judge worker starting",
  );
  if (config.NODE_ENV === "production" && config.RECX_APP_URL.startsWith("http://")) {
    logger.warn("RECX_APP_URL is plain http in production: the node token crosses the network unencrypted");
  }

  // ── Host hardening (isolate driver only; a real judge host) ─────────────
  /**
   * The `/metrics` listener (Phase 10a), or null when RECX_METRICS_PORT is 0.
   *
   * Declared here, started last, so that a scrape never sees a half-booted
   * node: until the heartbeat loop runs there is nothing true to report, and
   * a listener answering during the self-check would publish zeros that read
   * as "this node judged nothing" - which is exactly what a broken node also
   * looks like.
   */
  let metricsServer: MetricsServer | null = null;

  const health: NodeHealth = emptyHealth();
  const isReal = config.RECX_DRIVER === "isolate";
  let intakeAllowed = true;
  if (isReal) {
    const report = await checkHostHardening();
    health.hostHardening = { ok: report.ok, failures: report.failures.slice(0, 50) };
    const intake = hardeningIntake(report, {
      production: config.NODE_ENV === "production",
      devAllowUnhardened: config.RECX_DEV_ALLOW_UNHARDENED_HOST,
    });
    if (intake.allowed) {
      if (intake.warning) {
        const warning = intake.warning;
        logger.warn({ failures: report.failures.slice(0, 10) }, warning);
        setInterval(() => logger.warn(warning), 60 * 60 * 1000).unref();
      } else {
        logger.info("host hardening verified");
      }
    } else {
      intakeAllowed = false;
      logger.error({ failures: report.failures }, `host hardening check failed: ${intake.reason}`);
    }
  }

  let driver: JudgeDriver;
  try {
    driver = await createDriver(config, logger);
  } catch (error) {
    logger.fatal({ driver: config.RECX_DRIVER }, errorMessage(error));
    process.stderr.write(`[judge-worker] cannot start the ${config.RECX_DRIVER} driver: ${errorMessage(error)}\n`);
    process.exit(1);
  }
  const info = await driver.info();
  logger.info({ driver: info.driver, version: info.version, languages: info.languages }, "driver ready");

  // ── CPU pinning verification (isolate driver only) ──────────────────────
  if (isReal && config.RECX_SLOT_CPUS !== null) {
    try {
      const isolateConfig = await readFile("/usr/local/etc/isolate", "utf8");
      const mismatches = cpuPinningMismatches(config.RECX_BOX_BASE, config.RECX_SLOT_CPUS, isolateConfig);
      if (mismatches.length > 0) {
        logger.warn({ mismatches: mismatches.slice(0, 10) }, "RECX_SLOT_CPUS does not match the isolate per-box cpuset: slots are not actually pinned (timing noise on sensitive lanes)");
      } else {
        logger.info({ cpus: config.RECX_SLOT_CPUS }, "CPU pinning verified against the isolate config");
      }
    } catch (error) {
      logger.warn({ err: errorMessage(error) }, "could not read /usr/local/etc/isolate to verify CPU pinning");
    }
  }

  // ── Maintenance routines: self-check, calibration, startup credit ───────
  const abort = new AbortController();
  let maintenanceSandbox: IsolateSandbox | null = null;
  const maintenanceRunBoxId = maintenanceBoxIds(config.RECX_SELFCHECK_BOX_BASE).run;
  if (isReal && intakeAllowed) {
    const metaDir = await mkdtemp(path.join(os.tmpdir(), "recjudge-maint-"));
    maintenanceSandbox = createMaintenanceSandbox(config, metaDir, logger);
    await runMaintenance(maintenanceSandbox, maintenanceRunBoxId, info.languages, health, logger, abort.signal);
    if (health.selfCheck && !health.selfCheck.ok) intakeAllowed = false;
  }

  const cache = new BlobCache({ dir: config.RECX_CACHE_DIR, maxBytes: config.RECX_CACHE_MAX_BYTES, logger });
  await cache.init();
  logger.info({ dir: config.RECX_CACHE_DIR, blobs: cache.count, bytes: cache.sizeBytes }, "blob cache ready");

  const api = new HttpJudgeApi({ appUrl: config.RECX_APP_URL, nodeId: config.RECX_NODE_ID, token: config.RECX_NODE_TOKEN });
  const slots = new SlotPool(config.RECX_SLOTS);

  const queueRedis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
  const publishRedis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: 1, enableOfflineQueue: false });
  queueRedis.on("error", (err) => logger.warn({ err: err.message }, "redis (queues) error"));
  publishRedis.on("error", (err) => logger.debug({ err: err.message }, "redis (progress) error"));

  const deps: ProcessorDeps = {
    api,
    driver,
    cache,
    publisher: new RedisPublisher(publishRedis, logger),
    slots,
    logger,
    nodeId: config.RECX_NODE_ID,
    signal: abort.signal,
    // Stored with every result so a timing dispute is auditable.
    calibrationScore: () => health.calibrationScore,
  };

  let shuttingDown = false;
  const allocator = new LaneAllocator({
    deps,
    connection: queueRedis,
    slots,
    queues: config.RECX_QUEUES,
    logger,
    onProtocolMismatch: (error) => void shutdown(error.message, 1),
  });

  // Status + lanes drive the allocator. Intake requires: cleared for intake,
  // the web says ONLINE, and the web granted at least one lane.
  const applyHeartbeat = (status: JudgeNodeStatus, lanes: HeartbeatResponse["lanes"]) => {
    if (shuttingDown) return;
    allocator.setAllowedLanes(lanes);
    const ready = intakeAllowed && status === "ONLINE" && lanes.length > 0;
    if (ready) allocator.resume();
    else allocator.pause();
  };

  const heartbeat = new HeartbeatLoop({
    api,
    info,
    slots,
    logger,
    health: () => health,
    onStatus: () => undefined,
    onResponse: (response) => applyHeartbeat(response.status, response.lanes),
    onFatal: (error) => void shutdown(error.message, 1),
  });

  // Re-run self-check + calibration every 6 h; intake is not interrupted while
  // they pass, and stops if a re-run's self-check fails.
  let maintenanceTimer: NodeJS.Timeout | null = null;
  if (isReal && maintenanceSandbox) {
    const sandbox = maintenanceSandbox;
    maintenanceTimer = setInterval(() => {
      void (async () => {
        if (shuttingDown) return;
        await runSelfCheckAndCalibration(sandbox, maintenanceRunBoxId, health, logger, abort.signal);
        if (health.selfCheck && !health.selfCheck.ok) {
          intakeAllowed = false;
          allocator.pause();
          logger.error("self-check re-run failed: intake stopped until the node is rebuilt");
        }
      })();
    }, LIMITS.selfCheck.intervalMs);
    maintenanceTimer.unref();
  }

  async function shutdown(reason: string, code: number): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ reason, busySlots: slots.busy }, "shutting down: draining running jobs");
    allocator.pause();
    const deadline = setTimeout(() => {
      logger.warn({ afterMs: DRAIN_MS }, "drain deadline reached: aborting running jobs (leases are released)");
      abort.abort();
    }, DRAIN_MS);
    await allocator.close();
    clearTimeout(deadline);
    if (maintenanceTimer) clearInterval(maintenanceTimer);
    heartbeat.stop();
    /**
     * After the drain, not before it: the drain is the window somebody is
     * most likely to be watching, and `close()` drops keep-alive sockets
     * rather than waiting on them, so leaving it up costs the shutdown
     * deadline nothing.
     */
    await metricsServer?.close();
    await Promise.allSettled([queueRedis.quit(), publishRedis.quit()]);
    logger.info("stopped");
    process.exit(code);
  }

  let signals = 0;
  const onSignal = (signal: NodeJS.Signals) => {
    signals++;
    if (signals > 1) {
      logger.warn({ signal }, "second signal: exiting immediately");
      process.exit(1);
    }
    void shutdown(signal, 0);
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);

  if (!intakeAllowed) {
    logger.error("node is NOT cleared for intake; it will heartbeat its health but take no jobs");
  }
  heartbeat.start();

  if (config.RECX_METRICS_PORT > 0) {
    metricsServer = await startMetricsServer({
      port: config.RECX_METRICS_PORT,
      render: renderMetrics,
      contentType: METRICS_CONTENT_TYPE,
      onError: (error) => logger.warn({ err: error }, "metrics listener error"),
    });
    logger.info({ port: metricsServer?.port }, "serving /metrics on 127.0.0.1");
  }
}

/** Boot-time maintenance: self-check, calibration, startup credit, in order. */
async function runMaintenance(
  sandbox: IsolateSandbox,
  runBoxId: number,
  languages: readonly LanguageKey[],
  health: NodeHealth,
  logger: Logger,
  signal: AbortSignal,
): Promise<void> {
  await runSelfCheckAndCalibration(sandbox, runBoxId, health, logger, signal);
  const startupMs = await measureStartupCredit({ sandbox, languages, logger, signal });
  health.startupMs = startupMs;
}

async function runSelfCheckAndCalibration(
  sandbox: IsolateSandbox,
  runBoxId: number,
  health: NodeHealth,
  logger: Logger,
  signal: AbortSignal,
): Promise<void> {
  const selfCheck = await runSelfCheck({
    sandbox,
    runBoxId,
    firstUid: FIRST_UID,
    logger,
    signal,
  });
  health.selfCheck = { ok: selfCheck.ok, at: selfCheck.at, failures: selfCheck.failures.slice(0, 50) };
  const calibration = await runCalibration({ sandbox, logger, signal });
  health.calibrationScore = calibration.score;
  health.calibratedAt = calibration.at;
}

main().catch((error: unknown) => {
  process.stderr.write(`[judge-worker] FATAL: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exit(1);
});
