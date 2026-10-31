import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { QUEUE_NAME } from "@recx/shared";
import { hydrateFileBackedSecrets } from "@recx/shared/env-file";

/**
 * Judge worker environment. Deliberately credential-free: there is no
 * database URL, no auth secret, no storage key — and no key of any kind that
 * could turn networking on for a sandbox. The only secret is the node token,
 * which can do nothing but heartbeat / claim / fetch-blob / result / release
 * for this node. test/config.test.ts fails if a key matching /DATABASE|NET/i
 * is ever added.
 */

const GIB = 1024 * 1024 * 1024;
const QUEUE_NAMES = Object.values(QUEUE_NAME);
const LOG_LEVELS = ["fatal", "error", "warn", "info", "debug", "trace", "silent"] as const;

export function defaultCacheDir(platform: NodeJS.Platform = process.platform): string {
  return platform === "linux" ? "/var/cache/recjudge/blobs" : path.join(os.tmpdir(), "recjudge-blobs");
}

/** The raw key → validator map. Exported so tests can inspect the key set. */
export const workerEnvShape = {
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(LOG_LEVELS).default("info"),
  /**
   * Port for the `/metrics` listener, or 0 for none (Phase 10a).
   *
   * Zero by default, and deliberately so: the listener is a socket, and
   * neither the test suite nor a hand-run worker on a developer's box should
   * open one or fail because a port was taken. A judge host's systemd unit
   * sets it. The listener binds to 127.0.0.1 and this host has no public
   * interface at all (Phase 2), so the node exporter scrapes it over the
   * host's own loopback and nothing else can reach it.
   *
   * Not named RECX_PORT: this process serves nothing else, and a key that
   * read as "the worker's port" would invite somebody to put the judge API
   * behind it one day.
   */
  RECX_METRICS_PORT: z.coerce.number().int().min(0).max(65535).default(0),
  /** Same grammar the app host accepts in x-recx-judge-node. */
  RECX_NODE_ID: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, "RECX_NODE_ID must be 1–64 of [A-Za-z0-9._-]."),
  RECX_NODE_TOKEN: z
    .string()
    .regex(/^[A-Za-z0-9._~+/=-]{16,512}$/, "RECX_NODE_TOKEN must be 16–512 URL-safe characters."),
  RECX_APP_URL: z.string().url().transform((u) => u.replace(/\/+$/, "")),
  REDIS_URL: z.string().min(1),
  RECX_DRIVER: z.enum(["isolate", "docker", "mock"]).default("isolate"),
  RECX_SLOTS: z.coerce.number().int().min(1).max(100).default(1),
  /** Slot N uses box ids BASE+N (run), BASE+100+N (compile), BASE+200+N (checker). */
  RECX_BOX_BASE: z.coerce.number().int().min(0).max(99).default(0),
  RECX_CACHE_DIR: z.string().min(1).default(defaultCacheDir()),
  RECX_CACHE_MAX_BYTES: z.coerce.number().int().positive().default(40 * GIB),
  RECX_ISOLATE_BIN: z.string().min(1).default("isolate"),
  /** Bound read-only as the box's /etc: a 3-line passwd and nothing else. */
  RECX_SYNTHETIC_ETC: z.string().min(1).default("/var/lib/recjudge/etc"),
  RECX_QUEUES: z
    .string()
    .default("judge-practice,judge-run")
    .transform((raw) => [...new Set(raw.split(",").map((q) => q.trim()).filter(Boolean))])
    .pipe(
      z
        .array(z.string().refine((q) => QUEUE_NAMES.includes(q), { message: `Queues must be among: ${QUEUE_NAMES.join(", ")}.` }))
        .min(1, "RECX_QUEUES must name at least one queue."),
    ),
  /**
   * Optional CPU pinning: one core per slot, e.g. "2,3,4,5,6,7" pins slot N's
   * boxes to the N-th core. isolate reads the per-box cpuset from its own
   * config (box<id>.cpus, see isolateCpuConfigLines); the worker only verifies
   * at boot that it matches. Left unset on WSL2 development boxes.
   */
  RECX_SLOT_CPUS: z
    .string()
    .optional()
    .transform((raw, ctx) => {
      if (raw === undefined || raw.trim() === "") return null;
      const parts = raw.split(",").map((p) => p.trim());
      const cpus: number[] = [];
      for (const part of parts) {
        if (!/^\d{1,4}$/.test(part)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: `RECX_SLOT_CPUS: "${part}" is not a CPU number.` });
          return z.NEVER;
        }
        cpus.push(Number(part));
      }
      if (new Set(cpus).size !== cpus.length) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "RECX_SLOT_CPUS must not pin two slots to one core." });
        return z.NEVER;
      }
      return cpus;
    }),
  /**
   * Development only: let a node whose kernel hardening check failed take
   * jobs anyway (a WSL2 box cannot be hardened). Rejected in production.
   */
  RECX_DEV_ALLOW_UNHARDENED_HOST: z
    .enum(["", "0", "1"], { message: "RECX_DEV_ALLOW_UNHARDENED_HOST must be 1 (or unset)." })
    .optional()
    .transform((v) => v === "1"),
  /** Boxes BASE..BASE+9 are the node's maintenance range (calibration, startup credit, self-check). */
  RECX_SELFCHECK_BOX_BASE: z.coerce.number().int().min(300).max(990).default(900),
};

export const workerEnvSchema = z.object(workerEnvShape).superRefine((env, ctx) => {
  if (env.RECX_BOX_BASE + env.RECX_SLOTS > 100) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["RECX_BOX_BASE"],
      message: "RECX_BOX_BASE + RECX_SLOTS must be ≤ 100 so run, compile and checker box ids never overlap.",
    });
  }
  if (env.RECX_SLOT_CPUS !== null && env.RECX_SLOT_CPUS.length !== env.RECX_SLOTS) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["RECX_SLOT_CPUS"],
      message: `RECX_SLOT_CPUS lists ${env.RECX_SLOT_CPUS.length} cores for ${env.RECX_SLOTS} slots; give exactly one core per slot.`,
    });
  }
  if (env.NODE_ENV === "production" && env.RECX_DEV_ALLOW_UNHARDENED_HOST) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["RECX_DEV_ALLOW_UNHARDENED_HOST"],
      message: "RECX_DEV_ALLOW_UNHARDENED_HOST is a development switch and is refused with NODE_ENV=production.",
    });
  }
});

export type WorkerConfig = z.infer<typeof workerEnvSchema>;

export type BoxRole = "run" | "compile" | "checker";

/** isolate box ids for one slot (docs/OPEN-QUESTIONS.md, item 5). */
export function boxIdsForSlot(base: number, slot: number): Record<BoxRole, number> {
  return { run: base + slot, compile: base + 100 + slot, checker: base + 200 + slot };
}

/**
 * The maintenance boxes (calibration, startup credit, self-check): a range of
 * ten ids at RECX_SELFCHECK_BOX_BASE (≥ 300), so they can never collide with
 * a job box (every job box id is < 300).
 */
export function maintenanceBoxIds(selfCheckBase: number): Record<BoxRole, number> {
  return { run: selfCheckBase, compile: selfCheckBase + 1, checker: selfCheckBase + 2 };
}

/**
 * The /usr/local/etc/isolate lines that pin slot N's three boxes to
 * cpus[N]. isolate applies box<id>.cpus as the box cgroup's cpuset.cpus.
 * infra/judge/install-isolate.sh appends exactly these lines.
 */
export function isolateCpuConfigLines(boxBase: number, cpus: readonly number[]): string[] {
  return cpus.flatMap((cpu, slot) => {
    const ids = boxIdsForSlot(boxBase, slot);
    return [ids.run, ids.compile, ids.checker].map((id) => `box${id}.cpus = ${cpu}`);
  });
}

/** box id → cpus value from an isolate config file (comments and other keys ignored). */
export function parseIsolateCpuConfig(text: string): Map<number, string> {
  const result = new Map<number, string>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*box(\d+)\.cpus\s*=\s*(\S+)\s*$/.exec(line);
    if (match?.[1] !== undefined && match[2] !== undefined) result.set(Number(match[1]), match[2]);
  }
  return result;
}

/** Mismatches between the configured pinning and the isolate config; empty when they agree. */
export function cpuPinningMismatches(boxBase: number, cpus: readonly number[], isolateConfig: string): string[] {
  const configured = parseIsolateCpuConfig(isolateConfig);
  const problems: string[] = [];
  cpus.forEach((cpu, slot) => {
    const ids = boxIdsForSlot(boxBase, slot);
    for (const [role, id] of Object.entries(ids)) {
      const actual = configured.get(id);
      if (actual !== String(cpu)) {
        problems.push(`slot ${slot} ${role} box ${id}: expected box${id}.cpus = ${cpu}, found ${actual ?? "nothing"}`);
      }
    }
  });
  return problems;
}

/**
 * Development convenience: load apps/judge-worker/.env.local when it exists.
 * Never in production (a production node gets its environment from systemd).
 * Variables already set in the environment win over the file.
 */
export function loadDevEnvFile(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.NODE_ENV === "production") return null;
  const file = path.resolve(import.meta.dirname, "..", ".env.local");
  if (!existsSync(file)) return null;
  process.loadEnvFile(file);
  return file;
}

export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

export function parseConfig(env: NodeJS.ProcessEnv): WorkerConfig {
  // RECX_NODE_TOKEN arrives as RECX_NODE_TOKEN_FILE on a judge host
  // (deploy/compose.judge.yml), which is the only secret this process has.
  // The whole shape is eligible so that nothing has to remember to add the
  // next one.
  hydrateFileBackedSecrets(Object.keys(workerEnvShape), env);
  const parsed = workerEnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join(".") || "env"}: ${i.message}`).join("\n");
    throw new ConfigError(`Invalid judge worker environment:\n${issues}`);
  }
  return parsed.data;
}
