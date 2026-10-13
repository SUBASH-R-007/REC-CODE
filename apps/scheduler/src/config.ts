import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MAIL_TRANSPORTS, type MailTransportName } from "@recx/shared";
import { z } from "zod";

/**
 * Scheduler environment.
 *
 * The scheduler is the one process that must use the DIRECT (non-pooled)
 * Postgres URL: the reconciler holds a session-level advisory lock across a
 * tick and leases rows with SELECT … FOR UPDATE SKIP LOCKED, and neither
 * survives PgBouncer transaction pooling (the next statement may run on a
 * different server connection).
 */

/** apps/scheduler — one level above both src/config.ts and dist/main.js. */
const PACKAGE_DIR = fileURLToPath(new URL("..", import.meta.url));

/**
 * Development only. The FIRST of these files that exists is loaded with
 * process.loadEnvFile, which never overrides a variable already set in the
 * real environment:
 *
 *   1. apps/scheduler/.env.local — scheduler-specific overrides, if you need any;
 *   2. apps/web/.env.local       — the web app's local config. It already holds
 *                                  DATABASE_URL (direct in development: there is
 *                                  no PgBouncer locally) and REDIS_URL, so a
 *                                  fresh checkout needs no second copy.
 *
 * Note that Prisma Client, when imported, also loads packages/db/.env (the
 * file next to schema.prisma) without overriding anything already set. In a
 * dev checkout that file usually defines DATABASE_URL_DIRECT, so it is what
 * the scheduler connects with; the DATABASE_URL fallback covers checkouts
 * without it. main.ts logs which variable won and the target host/database.
 *
 * Production never reads a file: the service manager supplies the environment.
 */
export const DEV_ENV_FILES: readonly string[] = [
  path.join(PACKAGE_DIR, ".env.local"),
  path.join(PACKAGE_DIR, "..", "web", ".env.local"),
];

/** Load the development env file, if any. Returns the path loaded, or null. */
export function loadDevEnvFile(): string | null {
  if (process.env.NODE_ENV === "production") return null;
  for (const file of DEV_ENV_FILES) {
    if (existsSync(file)) {
      process.loadEnvFile(file);
      return file;
    }
  }
  return null;
}

const postgresUrl = z
  .string()
  .regex(/^postgres(ql)?:\/\//, "must be a postgres:// or postgresql:// URL")
  .refine((url) => !/[?&]pgbouncer=true(&|$)/.test(url), {
    message: "must be the direct, non-pooled URL (advisory locks and SKIP LOCKED leases do not survive PgBouncer)",
  });

const schema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    DATABASE_URL_DIRECT: postgresUrl.optional(),
    DATABASE_URL: z.string().optional(),
    REDIS_URL: z.string().regex(/^rediss?:\/\//, "must be a redis:// or rediss:// URL").optional(),
    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
    // Security email (EmailOutbox drain). Default: log in development, disabled elsewhere.
    MAIL_TRANSPORT: z.enum(MAIL_TRANSPORTS).optional(),
    SMTP_URL: z.string().regex(/^smtps?:\/\//, "must be an smtp:// or smtps:// URL").optional(),
    MAIL_FROM: z.string().min(3).max(200).optional(),
  })
  .superRefine((env, ctx) => {
    if (!env.DATABASE_URL_DIRECT) {
      if (env.NODE_ENV !== "development") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["DATABASE_URL_DIRECT"],
          message: "is required outside development (the scheduler needs the direct, non-pooled URL)",
        });
      } else if (!env.DATABASE_URL) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["DATABASE_URL_DIRECT"],
          message: "is required (in development DATABASE_URL is accepted as a fallback, but neither is set)",
        });
      } else {
        const fallback = postgresUrl.safeParse(env.DATABASE_URL);
        if (!fallback.success) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["DATABASE_URL"],
            message: fallback.error.issues[0]?.message ?? "is not a usable direct URL",
          });
        }
      }
    }
    if (!env.REDIS_URL && env.NODE_ENV === "production") {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["REDIS_URL"], message: "is required in production" });
    }
    if (env.MAIL_TRANSPORT === "log" && env.NODE_ENV === "production") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["MAIL_TRANSPORT"],
        message: "log is refused in production (it writes mail bodies to the log); use smtp or disabled",
      });
    }
    if (env.MAIL_TRANSPORT === "smtp" && !env.SMTP_URL) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["SMTP_URL"], message: "is required when MAIL_TRANSPORT=smtp" });
    }
  });

export interface SchedulerConfig {
  nodeEnv: "development" | "test" | "production";
  databaseUrl: string;
  /** Which variable the URL came from — the fallback is logged as a warning. */
  databaseUrlSource: "DATABASE_URL_DIRECT" | "DATABASE_URL";
  redisUrl: string;
  logLevel: "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";
  mail: MailConfig;
}

export interface MailConfig {
  transport: MailTransportName;
  /** Only for smtp. Holds credentials: never logged. */
  smtpUrl: string | null;
  from: string;
}

export const DEFAULT_MAIL_FROM = "REC Code <no-reply@rec-code.invalid>";

/** Validate the environment. Throws one readable error listing every problem. */
export function loadConfig(source: NodeJS.ProcessEnv = process.env): SchedulerConfig {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid scheduler environment:\n${issues}`);
  }
  const env = parsed.data;
  const direct = env.DATABASE_URL_DIRECT;
  return {
    nodeEnv: env.NODE_ENV,
    // superRefine guarantees DATABASE_URL is set when DIRECT is absent.
    databaseUrl: direct ?? env.DATABASE_URL ?? "",
    databaseUrlSource: direct ? "DATABASE_URL_DIRECT" : "DATABASE_URL",
    redisUrl: env.REDIS_URL ?? "redis://127.0.0.1:6379",
    logLevel: env.LOG_LEVEL,
    mail: {
      transport: env.MAIL_TRANSPORT ?? (env.NODE_ENV === "development" ? "log" : "disabled"),
      smtpUrl: env.SMTP_URL ?? null,
      from: env.MAIL_FROM ?? DEFAULT_MAIL_FROM,
    },
  };
}

/**
 * The scheduler is strictly serial, so its Prisma pool is pinned to ONE
 * connection. That is what makes the session advisory lock meaningful: the
 * lock, every transaction in the tick and the unlock all run on the same
 * server session.
 */
export function withSingleConnection(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  url.searchParams.set("connection_limit", "1");
  return url.toString();
}

/** host:port/database for logs — never the credentials. */
export function describeDatabaseUrl(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  return `${url.host}${url.pathname}`;
}
