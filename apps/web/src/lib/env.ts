import "server-only";
import { z } from "zod";
import { aiAllowedEndpoints } from "@recx/shared";
import { hydrateFileBackedSecrets } from "@recx/shared/env-file";

/**
 * Validated server environment. Parsed lazily (first access) so `next build`
 * can run without a live database, and parsed once so every request sees the
 * same configuration.
 */
const shape = {
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  APP_URL: z.string().url().default("http://localhost:3000"),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required."),
  REDIS_URL: z.string().min(1).default("redis://127.0.0.1:6379"),
  /** Pepper for ipHash = sha256(ip + pepper). Never store a raw IP. */
  IP_HASH_PEPPER: z.string().min(16, "IP_HASH_PEPPER must be at least 16 characters."),
  /**
   * HMAC key for the signed profile export (Phase 9f). Its OWN secret, not a
   * reuse of anything else the server holds: a verify key is the one secret
   * exercised by strangers on a public route, so it is the one most likely to
   * be found wrong — and a key that could also mint a session or read the IP
   * pepper would turn that into an account compromise. The worst a leaked
   * verify key can do is let somebody forge a statement about their own
   * practice record.
   *
   * 32 characters rather than 16: unlike the pepper, this key signs claims
   * that leave the platform and are read by third parties.
   */
  EXPORT_SIGNING_SECRET: z
    .string()
    .min(32, "EXPORT_SIGNING_SECRET must be at least 32 characters.")
    .default("dev-only-export-signing-secret-change-me"),
  /**
   * The root secret every REC Exam Browser sitting key is derived from
   * (Phase 14b). Its OWN secret, like the export key above and for a
   * sharper reason: a sitting key is what tells the server a request came
   * from inside the exam browser, so a secret that could also sign a
   * profile export or mint a session would turn one leak into both.
   *
   * Derivation is the point — `hmac(EXAM_BROWSER_SECRET, sittingId)` is
   * recomputed per request and no sitting key is ever written down, so a
   * dump of the database contains nothing that can sign anything
   * (docs/EXAM-BROWSER.md §5). Rotating this ends every live sitting at
   * once, which is the intended emergency control and a thing to know
   * before doing it mid-exam.
   */
  EXAM_BROWSER_SECRET: z
    .string()
    .min(32, "EXAM_BROWSER_SECRET must be at least 32 characters.")
    .default("dev-only-exam-browser-secret-change-me"),
  /**
   * Where the published REC Exam Browser installers live (Phase 14i).
   *
   * UNSET MEANS NO DOWNLOADS, which is the right default for a deployment
   * that has not published a build: `/exam-browser` then says to ask the
   * department, exactly as it did before this existed. It is a path and
   * not a URL because the application serves the bytes itself -- that is
   * what makes the super-admin's switch a switch over the download rather
   * than over a link beside it (lib/exam/exam-browser-downloads.ts).
   */
  EXAM_BROWSER_DOWNLOAD_DIR: z.string().optional(),
  /**
   * Bearer token for GET /api/metrics (Phase 10a). UNSET DISABLES the
   * endpoint, which is the safe default on the one host with a public
   * listener — "no token means no check" is how a metrics endpoint ends up
   * open to the internet.
   */
  METRICS_TOKEN: z.string().min(24, "METRICS_TOKEN must be at least 24 characters.").optional(),
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
   * The AI helper's API key (Phase 12b). UNSET DISABLES the helper, however
   * the super-admin's setting reads, because an assistant with no key cannot
   * answer and a half-configured one must fail closed rather than at the
   * student.
   *
   * It lives here and never in `PlatformSetting`: a key in a settings row is
   * a key in every database dump, every backup and every admin's screen, and
   * the super-admin surface deliberately chooses only WHICH model answers.
   * In production it arrives as `AI_API_KEY_FILE` like every other
   * credential (`@recx/shared/env-file`).
   */
  AI_API_KEY: z.string().min(8, "AI_API_KEY looks too short to be a key.").optional(),
  /**
   * The addresses an OpenAI-compatible model may be reached at: one URL, or
   * SEVERAL separated by commas (Phase 15g). A super-admin picks among them
   * on /super/settings/ai and cannot add one.
   *
   * It is a deployment setting and not a super-admin's field for the same
   * reason the key is: an address chosen from a settings page is where the
   * college's key and a student's draft would be sent, so a free-text one
   * is an exfiltration setting wearing a deployment hat. A list makes
   * adding a vendor a line of config rather than a code change, which is
   * what that reasoning was costing.
   *
   * `aiAllowedEndpoints` is what reads it, and it drops what it cannot use
   * — so the refinement here is only that SOMETHING usable is left, which
   * catches the single mistyped URL that would otherwise look like "no
   * endpoint configured" much later and somewhere else. https, or loopback
   * for a model on the same box.
   */
  AI_BASE_URL: z
    .string()
    .trim()
    .min(1)
    .refine((value) => aiAllowedEndpoints(value).length > 0, {
      message:
        "AI_BASE_URL must be one https URL, or several separated by commas (http is allowed only on localhost).",
    })
    .optional(),
  /**
   * The model an OpenAI-compatible deployment falls back to when the
   * super-admin has named none of its own. Before Phase 15g this was the
   * only way to name that model at all.
   */
  AI_MODEL: z.string().min(1).max(200).optional(),
  /**
   * Development only: let judge nodes whose kernel hardening check fails
   * (a WSL2 dev kernel) serve every lane. Refused outright in production.
   */
  JUDGE_ALLOW_UNHARDENED_NODES: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
} as const;

const schema = z.object(shape).superRefine((value, ctx) => {
  /**
   * The dev default is a KNOWN string, so a production deployment that never
   * set the variable would be signing public claims with a key published in
   * this repository. Refused outright, the same way the unhardened-judge
   * override is.
   */
  if (value.NODE_ENV === "production" && value.EXPORT_SIGNING_SECRET.startsWith("dev-only-")) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["EXPORT_SIGNING_SECRET"],
      message: "EXPORT_SIGNING_SECRET is still the development default; set a real secret in production.",
    });
  }
  /**
   * Same rule, same reason: the dev default is a known string published in
   * this repository, and a deployment that never set it would be deriving
   * every sitting key from it — which is the shared-key flaw
   * `docs/EXAM-BROWSER.md` §5 exists to avoid, reintroduced by omission.
   */
  if (value.NODE_ENV === "production" && value.EXAM_BROWSER_SECRET.startsWith("dev-only-")) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["EXAM_BROWSER_SECRET"],
      message: "EXAM_BROWSER_SECRET is still the development default; set a real secret in production.",
    });
  }
  if (value.NODE_ENV === "production" && value.JUDGE_ALLOW_UNHARDENED_NODES) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["JUDGE_ALLOW_UNHARDENED_NODES"],
      message: "JUDGE_ALLOW_UNHARDENED_NODES=true is not allowed in production.",
    });
  }
});

export type Env = z.infer<typeof schema>;

/**
 * Every variable above may arrive as `KEY_FILE` instead — the Docker-secret
 * convention `deploy/compose.app.yml` uses, because
 * `tests/repo/deploy-topology.test.ts` refuses a credential written as a
 * value (`@recx/shared/env-file`). The whole schema is eligible rather than
 * a hand-kept subset: which variables are secret is a property of the
 * deployment, not of this file.
 */
export const FILE_BACKED = Object.keys(shape);

/**
 * Variables whose DEVELOPMENT DEFAULT is not merely unhelpful in production
 * but silently wrong, so an unset variable is refused there rather than
 * defaulted:
 *
 * - `APP_URL` would make every absolute link and every judge callback point
 *   at `localhost:3000`.
 * - `REDIS_URL` would point the rate limiter and the queues at a Redis that
 *   is not there. The limiter fails OPEN by design (a cache outage must not
 *   become a sign-in outage), so the failure mode is a production deployment
 *   with no rate limiting at all and nothing on fire to say so.
 *
 * A deployment that genuinely runs Redis on the loopback still sets the
 * variable; only *forgetting* it is refused.
 */
const REQUIRED_IN_PRODUCTION = ["APP_URL", "REDIS_URL"] as const;

let cached: Env | null = null;

export function env(): Env {
  if (cached) return cached;
  // Fills in any KEY whose value arrived as KEY_FILE, in process.env itself,
  // so that readers which resolve the environment on their own — Prisma with
  // DATABASE_URL — see the same values this schema validates.
  hydrateFileBackedSecrets(FILE_BACKED);
  const source = process.env;
  if (source.NODE_ENV === "production") {
    const missing = REQUIRED_IN_PRODUCTION.filter((key) => !source[key]);
    if (missing.length > 0) {
      const issues = missing.map((key) => `  - ${key}: is required in production (it has a development default).`);
      throw new Error(`Invalid server environment:\n${issues.join("\n")}`);
    }
  }
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid server environment:\n${issues}`);
  }
  cached = parsed.data;
  return cached;
}

export const isProduction = () => process.env.NODE_ENV === "production";
