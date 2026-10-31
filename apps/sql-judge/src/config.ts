import { existsSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { SQL_QUEUE_NAME } from "@recx/shared";
import { hydrateFileBackedSecrets } from "@recx/shared/env-file";

/**
 * SQL judge environment (Phase 12k).
 *
 * This is the one judge process that MUST hold a database credential — its
 * sandbox is a database — so the rule it lives by is narrower than the
 * isolate worker's "no DATABASE key at all". It holds exactly two
 * connection strings, both to the sandbox cluster, and nothing else:
 *
 *   RECX_SQL_OWNER_URL     owns the per-submission schemas and runs the
 *                          author's setup script.
 *   RECX_SQL_STUDENT_URL   runs the student's statement. A SEPARATE
 *                          connection as a SEPARATE role, not `SET ROLE` on
 *                          the owner's: a single statement can call
 *                          `set_config('role', …)`, and a session whose
 *                          session_user is privileged has something to go
 *                          back to. This one has nothing to go back to.
 *
 * `test/config.test.ts` fails if a key matching the application's own
 * secrets (DATABASE_URL, AUTH_SECRET, IP_HASH_PEPPER, an S3 key) is ever
 * added, and `boot.ts` refuses to start if the sandbox cluster turns out to
 * hold application tables.
 */

const LOG_LEVELS = ["fatal", "error", "warn", "info", "debug", "trace", "silent"] as const;
const SQL_QUEUES = Object.values(SQL_QUEUE_NAME);

/** A postgres:// URL, with its password never logged. */
const postgresUrl = z
  .string()
  .min(1)
  .refine((raw) => /^postgres(ql)?:\/\//.test(raw), "must be a postgres:// URL");

export const sqlJudgeEnvShape = {
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(LOG_LEVELS).default("info"),
  /** Same grammar the app host accepts in x-recx-judge-node. */
  RECX_NODE_ID: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, "RECX_NODE_ID must be 1–64 of [A-Za-z0-9._-]."),
  RECX_NODE_TOKEN: z
    .string()
    .regex(/^[A-Za-z0-9._~+/=-]{16,512}$/, "RECX_NODE_TOKEN must be 16–512 URL-safe characters."),
  RECX_APP_URL: z.string().url().transform((u) => u.replace(/\/+$/, "")),
  REDIS_URL: z.string().min(1),
  RECX_SQL_OWNER_URL: postgresUrl,
  RECX_SQL_STUDENT_URL: postgresUrl,
  /** Concurrent jobs. One connection pair each, so this is also a connection budget. */
  RECX_SLOTS: z.coerce.number().int().min(1).max(32).default(2),
  RECX_QUEUES: z
    .string()
    .default("judge-sql-practice,judge-sql-run")
    .transform((raw) => [...new Set(raw.split(",").map((q) => q.trim()).filter(Boolean))])
    .pipe(
      z
        .array(
          z
            .string()
            .refine((q) => SQL_QUEUES.includes(q), { message: `Queues must be among: ${SQL_QUEUES.join(", ")}.` }),
        )
        .min(1, "RECX_QUEUES must name at least one queue."),
    ),
  /**
   * Development only: let a node whose cluster hardening check failed take
   * jobs anyway (a developer's local cluster is not hardened). Refused with
   * NODE_ENV=production, exactly as the isolate worker's equivalent is.
   */
  RECX_DEV_ALLOW_UNHARDENED_CLUSTER: z
    .enum(["", "0", "1"], { message: "RECX_DEV_ALLOW_UNHARDENED_CLUSTER must be 1 (or unset)." })
    .optional()
    .transform((v) => v === "1"),
};

export const sqlJudgeEnvSchema = z.object(sqlJudgeEnvShape).superRefine((env, ctx) => {
  if (env.RECX_SQL_OWNER_URL === env.RECX_SQL_STUDENT_URL) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["RECX_SQL_STUDENT_URL"],
      message:
        "RECX_SQL_STUDENT_URL must be a different role from the owner. One connection string for both means the student's statement runs as the schema's owner.",
    });
  }
  if (env.NODE_ENV === "production" && env.RECX_DEV_ALLOW_UNHARDENED_CLUSTER) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["RECX_DEV_ALLOW_UNHARDENED_CLUSTER"],
      message: "RECX_DEV_ALLOW_UNHARDENED_CLUSTER is a development switch and is refused with NODE_ENV=production.",
    });
  }
});

export type SqlJudgeConfig = z.infer<typeof sqlJudgeEnvSchema>;

export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

/**
 * Keys this process must never hold. Each is an application secret: a judge
 * host that had one would be a judge host that could read or write student
 * data, which is the thing SPEC's anti-requirements forbid outright.
 */
export const FORBIDDEN_ENV_KEYS = [
  "DATABASE_URL",
  "DATABASE_URL_DIRECT",
  "RECX_TEST_DATABASE_URL",
  "AUTH_SECRET",
  "IP_HASH_PEPPER",
  "AI_API_KEY",
  "EXPORT_SIGNING_KEY",
  "S3_SECRET_ACCESS_KEY",
  "STORAGE_MASTER_KEY",
] as const;

/** The application secrets present in `env`, if any. */
export function forbiddenKeysPresent(env: NodeJS.ProcessEnv): string[] {
  return FORBIDDEN_ENV_KEYS.filter((key) => (env[key] ?? "").trim() !== "");
}

/** Development convenience: apps/sql-judge/.env.local, never in production. */
export function loadDevEnvFile(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.NODE_ENV === "production") return null;
  const file = path.resolve(import.meta.dirname, "..", ".env.local");
  if (!existsSync(file)) return null;
  process.loadEnvFile(file);
  return file;
}

export function parseConfig(env: NodeJS.ProcessEnv): SqlJudgeConfig {
  const forbidden = forbiddenKeysPresent(env);
  if (forbidden.length > 0) {
    throw new ConfigError(
      `The SQL judge refuses to start with application credentials in its environment: ${forbidden.join(", ")}. ` +
        "This process holds the sandbox cluster's two roles and nothing else.",
    );
  }
  // RECX_NODE_TOKEN and both URLs arrive as *_FILE on a judge host.
  hydrateFileBackedSecrets(Object.keys(sqlJudgeEnvShape), env);
  const parsed = sqlJudgeEnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join(".") || "env"}: ${i.message}`).join("\n");
    throw new ConfigError(`Invalid SQL judge environment:\n${issues}`);
  }
  return parsed.data;
}
