import os from "node:os";
import {
  JUDGE_HEARTBEAT_MS,
  JUDGE_PROTOCOL_VERSION,
  type HeartbeatRequest,
  type HeartbeatResponse,
  type JudgeNodeStatus,
  type LanguageKey,
} from "@recx/shared";
import type { JudgeApi } from "./api";
import type { DriverInfo } from "./drivers/types";
import { ProtocolMismatchError, errorMessage } from "./errors";
import type { Logger } from "./logger";
import type { SlotPool } from "./slots";
import { WORKER_VERSION } from "./version";

/**
 * Heartbeat every JUDGE_HEARTBEAT_MS. The request carries the Phase 2 node
 * health (calibration, self-check, host hardening, per-language startup
 * credit); the response carries the node's status and the lanes it may serve
 * right now. Only ONLINE takes jobs; DRAINING, QUARANTINED and OFFLINE pause
 * intake. The lanes drive the allocator: ASSESSMENT and CONTEST vanish when
 * the web withholds them (uncalibrated / self-check stale / unhardened).
 */

/** Node health reported in every heartbeat. Refreshed in place by the boot routines. */
export interface NodeHealth {
  calibrationScore: number | null;
  calibratedAt: string | null;
  selfCheck: { ok: boolean; at: string; failures: string[] } | null;
  hostHardening: { ok: boolean; failures: string[] } | null;
  startupMs: Partial<Record<LanguageKey, number>>;
}

export function emptyHealth(): NodeHealth {
  return { calibrationScore: null, calibratedAt: null, selfCheck: null, hostHardening: null, startupMs: {} };
}

/**
 * Languages this node offers: installed toolchains, narrowed — once the boot
 * startup-credit measurement has run — to those whose hello-world actually
 * compiled and ran in the sandbox. A toolchain directory alone proves nothing.
 */
export function advertisedLanguages(
  installed: readonly LanguageKey[],
  startupMs: Partial<Record<LanguageKey, number>>,
): LanguageKey[] {
  const measured = Object.keys(startupMs);
  if (measured.length === 0) return [...installed];
  return installed.filter((key) => startupMs[key] !== undefined);
}

export function heartbeatBody(
  info: DriverInfo,
  slots: Pick<SlotPool, "size" | "busy">,
  health: NodeHealth,
): HeartbeatRequest {
  return {
    protocolVersion: JUDGE_PROTOCOL_VERSION,
    hostname: os.hostname().slice(0, 255),
    workerVersion: WORKER_VERSION,
    isolateVersion: info.version.slice(0, 64),
    // Protocol 4 (Phase 12k) carries the engine's own version for drivers
    // that are not isolate. This one's engine IS isolate, and its version
    // is the line above.
    engineVersion: "",
    driver: info.driver,
    languages: advertisedLanguages(info.languages, health.startupMs),
    slots: slots.size,
    calibrationScore: health.calibrationScore,
    calibratedAt: health.calibratedAt,
    selfCheck: health.selfCheck,
    hostHardening: health.hostHardening,
    startupMs: health.startupMs,
    busySlots: slots.busy,
  };
}

export interface HeartbeatLoopOptions {
  api: JudgeApi;
  info: DriverInfo;
  slots: Pick<SlotPool, "size" | "busy">;
  logger: Logger;
  /** Current node health (read fresh on every beat). */
  health?: () => NodeHealth;
  intervalMs?: number;
  onStatus(status: JudgeNodeStatus): void;
  /** The full response, for the lanes the allocator may serve. */
  onResponse?(response: HeartbeatResponse): void;
  onFatal(error: Error): void;
}

export class HeartbeatLoop {
  private timer: NodeJS.Timeout | null = null;
  private inFlight = false;
  private failures = 0;

  constructor(private readonly options: HeartbeatLoopOptions) {}

  start(): void {
    if (this.timer) return;
    void this.beat();
    this.timer = setInterval(() => void this.beat(), this.options.intervalMs ?? JUDGE_HEARTBEAT_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async beat(): Promise<HeartbeatResponse | null> {
    if (this.inFlight) return null;
    this.inFlight = true;
    try {
      const health = this.options.health?.() ?? emptyHealth();
      const response = await this.options.api.heartbeat(heartbeatBody(this.options.info, this.options.slots, health));
      if (this.failures > 0) this.options.logger.info({ after: this.failures }, "heartbeat recovered");
      this.failures = 0;
      this.options.onStatus(response.status);
      this.options.onResponse?.(response);
      return response;
    } catch (error) {
      if (error instanceof ProtocolMismatchError) {
        this.options.onFatal(error);
        return null;
      }
      // Log the first failure and then once a minute, not every 5 s.
      if (this.failures % 12 === 0) {
        this.options.logger.error({ err: errorMessage(error), failures: this.failures + 1 }, "heartbeat failed");
      }
      this.failures++;
      return null;
    } finally {
      this.inFlight = false;
    }
  }
}
