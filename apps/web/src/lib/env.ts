import "server-only";
import { z } from "zod";

/**
 * Validated server environment. Parsed lazily (first access) so `next build`
 * can run without a live database, and parsed once so every request sees the
 * same configuration.
 */
const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  APP_URL: z.string().url().default("http://localhost:3000"),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required."),
  REDIS_URL: z.string().min(1).default("redis://127.0.0.1:6379"),
  /** Pepper for ipHash = sha256(ip + pepper). Never store a raw IP. */
  IP_HASH_PEPPER: z.string().min(16, "IP_HASH_PEPPER must be at least 16 characters."),
  /** Test-data store driver: local filesystem (dev/CI) or S3/MinIO. */
  TESTDATA_DRIVER: z.enum(["local", "s3"]).default("local"),
  TESTDATA_DIR: z.string().default("./storage/testdata"),
  S3_ENDPOINT: z.string().optional(),
  S3_REGION: z.string().default("us-east-1"),
  S3_BUCKET: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  /** Private spool directory for problem-import uploads (default: <os tmpdir>/recx-imports). */
  IMPORT_SPOOL_DIR: z.string().optional(),
  /** Trust X-Forwarded-For from the reverse proxy (Caddy) only when set. */
  TRUST_PROXY: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  /**
   * Development only: let judge nodes whose kernel hardening check fails
   * (a WSL2 dev kernel) serve every lane. Refused outright in production.
   */
  JUDGE_ALLOW_UNHARDENED_NODES: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
}).superRefine((value, ctx) => {
  if (value.NODE_ENV === "production" && value.JUDGE_ALLOW_UNHARDENED_NODES) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["JUDGE_ALLOW_UNHARDENED_NODES"],
      message: "JUDGE_ALLOW_UNHARDENED_NODES=true is not allowed in production.",
    });
  }
});

export type Env = z.infer<typeof schema>;

let cached: Env | null = null;

export function env(): Env {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid server environment:\n${issues}`);
  }
  cached = parsed.data;
  return cached;
}

export const isProduction = () => process.env.NODE_ENV === "production";
