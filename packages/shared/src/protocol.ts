import { z } from "zod";
import { LANGUAGE_KEYS, TOOLCHAIN_ID_PATTERN } from "./languages";
import { LIMITS } from "./limits";
import { VERDICTS } from "./verdict";
import { functionSignatureSchema } from "./harness/signature";

/**
 * The judge wire protocol between apps/web (the only process holding database
 * credentials) and apps/judge-worker (which holds none). Bump the version on
 * ANY change to these shapes. The web app refuses claims, blobs and results
 * from a worker reporting a different version (HTTP 426), so a half-upgraded
 * fleet can never write a result the server would misread.
 *
 * 3 (Phase 4): no new fields, new semantics — a stricter functionSignature
 * schema, structured comparison of every FUNCTION problem's output, Java
 * FUNCTION harness, SET_EQUAL / ROWS_ANY_ORDER judged, CUSTOM_CHECKER output
 * canonicalised before the checker runs, JVM run flags. A v2 worker would
 * turn such jobs into permanent internal errors, so it gets 426 and drains.
 */
export const JUDGE_PROTOCOL_VERSION = 3;

export const JUDGE_HEADERS = {
  protocol: "x-recx-judge-protocol",
  node: "x-recx-judge-node",
} as const;

// ── Lanes and queues ────────────────────────────────────────────────────

export const JUDGE_LANES = ["ASSESSMENT", "CONTEST", "RUN", "PRACTICE", "REJUDGE"] as const;
export type JudgeLane = (typeof JUDGE_LANES)[number];

/**
 * BullMQ queue names. The prompt calls these judge:assessment etc.; BullMQ 5
 * rejects ':' in queue names (it is its own key separator), so the separator
 * on the wire is '-'. Same five queues, same semantics.
 */
export const QUEUE_NAME: Readonly<Record<JudgeLane, string>> = {
  ASSESSMENT: "judge-assessment",
  CONTEST: "judge-contest",
  RUN: "judge-run",
  PRACTICE: "judge-practice",
  REJUDGE: "judge-rejudge",
};

/**
 * Worker-side weighted slot allocation (BullMQ priority alone provably starves
 * the low lane). Shares are fractions of the node's slots:
 *  - ASSESSMENT may use up to 60 %;
 *  - RUN keeps at least 2 HARD-reserved slots so the editor's Run button is
 *    never slow during a contest;
 *  - CONTEST may use up to 50 %;
 *  - PRACTICE has a 25 % floor (never starved to zero);
 *  - REJUDGE may use at most 20 %, dropping to 0 while the assessment backlog
 *    exceeds 50 jobs.
 * Soft reservations (everything except RUN's) release after 2 s idle so an
 * idle lane never wastes capacity.
 */
export const LANE_ALLOCATION = {
  ASSESSMENT: { maxShare: 0.6 },
  RUN: { hardReservedSlots: 2 },
  CONTEST: { maxShare: 0.5 },
  PRACTICE: { minShare: 0.25 },
  REJUDGE: { maxShare: 0.2, pauseWhenAssessmentDepthAbove: 50 },
  softReservationIdleMs: 2_000,
} as const;

/** Lanes a node may serve only while calibrated, hardened and self-checked. */
export const SENSITIVE_LANES: readonly JudgeLane[] = ["ASSESSMENT", "CONTEST"];

/** BullMQ priority (lower = sooner) — informational; the slot allocator decides. */
export const LANE_PRIORITY: Readonly<Record<JudgeLane, number>> = {
  ASSESSMENT: 1,
  RUN: 3,
  CONTEST: 5,
  PRACTICE: 10,
  REJUDGE: 20,
};

export const COMPARE_MODES = ["EXACT", "TOKEN", "FLOAT", "CHECKER", "INTERACTIVE"] as const;
export type CompareMode = (typeof COMPARE_MODES)[number];

export const SCORING_MODES = ["ICPC", "SUBTASK", "PER_TEST"] as const;
export type ScoringMode = (typeof SCORING_MODES)[number];

export const IO_MODES = ["STDIN", "FUNCTION"] as const;
export type IoMode = (typeof IO_MODES)[number];

/** Infrastructure retries only: attempts 3, exponential from 2s. */
export const JUDGE_RETRY = { attempts: 3, backoffMs: 2_000 } as const;
/**
 * BullMQ options for every judge job — the single source shared by the web
 * enqueuer and the scheduler's reconciler. jobId = the row id (dedupe).
 */
export function judgeJobOptions(lane: JudgeLane, id: string) {
  return {
    jobId: id,
    priority: LANE_PRIORITY[lane],
    // Infrastructure retries only: the worker never throws for a
    // deterministic verdict, so these never re-judge student code.
    attempts: JUDGE_RETRY.attempts,
    backoff: { type: "exponential" as const, delay: JUDGE_RETRY.backoffMs },
    removeOnComplete: { age: 3600, count: 10_000 },
    removeOnFail: { age: 86_400 },
  };
}

/** Lease length written by the claim UPDATE. */
export const JUDGE_LEASE_SECONDS = 120;
export const JUDGE_HEARTBEAT_MS = 5_000;
/** A node whose last heartbeat is older than this is OFFLINE; leases reclaimed. */
export const JUDGE_OFFLINE_AFTER_MS = 20_000;
export const RECONCILER_INTERVAL_MS = 10_000;

// ── Building blocks ─────────────────────────────────────────────────────

const sha256 = z.string().regex(/^[0-9a-f]{64}$/, "sha256 must be 64 lowercase hex characters.");

export const blobRefSchema = z.object({
  sha256,
  sizeBytes: z.number().int().nonnegative(),
});
export type BlobRef = z.infer<typeof blobRefSchema>;

export const verdictSchema = z.enum(VERDICTS);
export const languageKeySchema = z.enum(LANGUAGE_KEYS);

export const languageRuntimeSchema = z.object({
  key: languageKeySchema,
  label: z.string(),
  toolchainId: z.string(),
  version: z.string(),
  extraToolchainIds: z.array(z.string()),
  sourceFile: z.string().regex(/^[A-Za-z][A-Za-z0-9_]*\.[a-z]+$/),
  compile: z.object({ argv: z.array(z.string()).min(1), slow: z.boolean() }).nullable(),
  run: z.object({ argv: z.array(z.string()).min(1) }),
  env: z.record(z.string(), z.string()),
  family: z.enum(["native", "managed"]),
  processes: z.number().int().min(1).max(LIMITS.processes.ceiling),
  openFiles: z.number().int().min(16).max(LIMITS.openFiles.ceiling),
  fallbackMultiplier: z.number(),
  fallbackExtraMs: z.number(),
  editorLanguage: z.string(),
  enabledByDefault: z.boolean(),
});

export const testSpecSchema = z.object({
  index: z.number().int().nonnegative(),
  isSample: z.boolean(),
  input: blobRefSchema,
  /** Null only for custom runs, which have no expected output. */
  output: blobRefSchema.nullable(),
  points: z.number().int().nonnegative().nullable(),
  subtask: z.number().int().nonnegative().nullable(),
});
export type TestSpec = z.infer<typeof testSpecSchema>;

/**
 * submission — a graded or practice submission; run — the editor's Run button;
 * validation — a reference solution judged at authoring time to measure
 * per-language limits and prove model / deliberately-wrong solutions behave.
 */
export const jobKindSchema = z.enum(["submission", "run", "validation"]);
export type JobKind = z.infer<typeof jobKindSchema>;

/** The BullMQ job payload. Deliberately tiny: Postgres is truth. */
export const judgeJobDataSchema = z.object({
  kind: jobKindSchema,
  id: z.string().min(1).max(64),
});
export type JudgeJobData = z.infer<typeof judgeJobDataSchema>;

// ── Claim ───────────────────────────────────────────────────────────────

export const claimRequestSchema = z.object({
  protocolVersion: z.number().int(),
  kind: jobKindSchema,
  id: z.string().min(1).max(64),
});
export type ClaimRequest = z.infer<typeof claimRequestSchema>;

export const SUBTASK_AGGREGATIONS = ["MIN", "SUM_FRACTION"] as const;
export type SubtaskAggregation = (typeof SUBTASK_AGGREGATIONS)[number];

export const subtaskSpecSchema = z.object({
  index: z.number().int().nonnegative(),
  points: z.number().nonnegative(),
  /** MIN: earn the points only if every test passes (fraction = min over tests). SUM_FRACTION: points × passed / total. */
  aggregation: z.enum(SUBTASK_AGGREGATIONS),
  /** Subtasks that must be fully passed first; otherwise this one is SKIPPED. */
  dependsOn: z.array(z.number().int().nonnegative()).max(32),
});
export type SubtaskSpec = z.infer<typeof subtaskSpecSchema>;

/** A testlib-compatible checker, compiled by the worker (cached by sha256). */
export const checkerSpecSchema = z.object({
  source: blobRefSchema,
  language: z.literal("cpp20"),
  /** Pinned testlib toolchain directory id (TESTLIB_ID, e.g. "testlib-0.9.41"). */
  testlibId: z.string().regex(TOOLCHAIN_ID_PATTERN),
});
export type CheckerSpec = z.infer<typeof checkerSpecSchema>;

export const judgeJobSpecSchema = z.object({
  protocolVersion: z.literal(JUDGE_PROTOCOL_VERSION),
  kind: jobKindSchema,
  id: z.string(),
  lane: z.enum(JUDGE_LANES),
  claimToken: z.string().min(16),
  attempt: z.number().int().min(1),
  language: languageRuntimeSchema,
  source: z.string().max(LIMITS.source.ceilingBytes),
  ioMode: z.enum(IO_MODES),
  functionSignature: functionSignatureSchema.nullable(),
  compareMode: z.enum(COMPARE_MODES),
  floatEpsilon: z.number().positive().nullable(),
  scoringMode: z.enum(SCORING_MODES),
  stopOnFirstFailure: z.boolean(),
  timeLimitMs: z.number().int().min(LIMITS.cpuTime.floorMs).max(LIMITS.cpuTime.ceilingMs),
  memoryLimitKb: z.number().int().min(16 * 1024).max(LIMITS.memory.ceilingKb),
  tests: z.array(testSpecSchema).max(500),
  /** SUBTASK scoring only; empty otherwise. */
  subtasks: z.array(subtaskSpecSchema).max(64).default([]),
  /** compareMode CHECKER only. */
  checker: checkerSpecSchema.nullable().default(null),
  /**
   * Blobs delivered inline with the claim instead of via /api/judge/blob —
   * only a custom run's stdin (≤ 64 KB), which is not a stored TestBlob.
   * Keyed by sha256; the worker verifies the hash like any other blob.
   */
  inlineBlobs: z.record(sha256, z.string().max(LIMITS.customRun.stdinBytes)).default({}),
});
export type JudgeJobSpec = z.infer<typeof judgeJobSpecSchema>;

/** Why a claim was refused. The worker treats all of these as "job done". */
export const claimRefusalSchema = z.object({
  refused: z.literal(true),
  reason: z.enum(["NOT_CLAIMABLE", "LEASED_ELSEWHERE", "ATTEMPTS_EXHAUSTED", "CANCELLED", "NOT_FOUND"]),
});
export type ClaimRefusal = z.infer<typeof claimRefusalSchema>;

// ── Results ─────────────────────────────────────────────────────────────

export const compileResultSchema = z.object({
  ok: z.boolean(),
  /** Sanitised (no /box/, no /opt/toolchains/, no host paths), ≤ 8 KB. */
  output: z.string().max(LIMITS.compile.outputBytes + 256),
  timeMs: z.number().int().nonnegative(),
  cached: z.boolean(),
  resourceExceeded: z.boolean(),
});
export type CompileResult = z.infer<typeof compileResultSchema>;

export const testResultSchema = z.object({
  i: z.number().int().nonnegative(),
  v: verdictSchema,
  ms: z.number().int().nonnegative(),
  kb: z.number().int().nonnegative(),
  exitCode: z.number().int().nullable().optional(),
  signal: z.string().max(32).nullable().optional(),
  /** Admin-visible: wall limit hit while CPU idle. Still TLE to the student. */
  idle: z.boolean().optional(),
  /** Visible (sample / custom-run) cases only. Never sent for hidden tests. */
  stdout: z.string().max(LIMITS.customRun.stdoutBytes + 256).optional(),
  stderr: z.string().max(LIMITS.stderrCapture.ceilingBytes + 256).optional(),
  message: z.string().max(512).optional(),
});
export type TestResult = z.infer<typeof testResultSchema>;

export const resultRequestSchema = z.object({
  protocolVersion: z.number().int(),
  kind: jobKindSchema,
  id: z.string(),
  claimToken: z.string().min(16),
  verdict: verdictSchema,
  compile: compileResultSchema.nullable(),
  tests: z.array(testResultSchema).max(500),
  passedCases: z.number().int().nonnegative(),
  totalCases: z.number().int().nonnegative(),
  maxTimeMs: z.number().int().nonnegative(),
  maxMemoryKb: z.number().int().nonnegative(),
  firstFailedIndex: z.number().int().nonnegative().nullable(),
  /** Points earned (ICPC: 1 or 0; PER_TEST / SUBTASK: sum of points). Null for runs. */
  score: z.number().nonnegative().nullable(),
  /** Points available. Null for runs. */
  maxScore: z.number().nonnegative().nullable(),
  /** SUBTASK scoring only. */
  subtasks: z
    .array(
      z.object({
        index: z.number().int().nonnegative(),
        earned: z.number().nonnegative(),
        max: z.number().nonnegative(),
        verdict: verdictSchema,
      }),
    )
    .max(64)
    .default([]),
  /** Sum of per-test CPU ms — the user's daily CPU budget is charged this. */
  cpuMs: z.number().int().nonnegative(),
  judgeNodeId: z.string(),
  calibrationScore: z.number().nullable(),
});
export type ResultRequest = z.infer<typeof resultRequestSchema>;

/** Infrastructure failure after a claim: clear the lease so a retry can claim. */
export const releaseRequestSchema = z.object({
  protocolVersion: z.number().int(),
  kind: jobKindSchema,
  id: z.string(),
  claimToken: z.string().min(16),
  reason: z.string().max(500),
  /**
   * The job can never succeed on any node (unsupported compare mode, corrupt
   * spec): finalise INTERNAL_ERROR now instead of spending three attempts.
   */
  permanent: z.boolean().default(false),
});
export type ReleaseRequest = z.infer<typeof releaseRequestSchema>;

// ── Node lifecycle ──────────────────────────────────────────────────────

export const JUDGE_NODE_STATUSES = ["ONLINE", "DRAINING", "OFFLINE", "QUARANTINED"] as const;
export type JudgeNodeStatus = (typeof JUDGE_NODE_STATUSES)[number];

export const heartbeatRequestSchema = z.object({
  protocolVersion: z.number().int(),
  hostname: z.string().max(255),
  workerVersion: z.string().max(64),
  isolateVersion: z.string().max(64),
  driver: z.enum(["isolate", "docker", "mock"]),
  languages: z.array(languageKeySchema),
  slots: z.number().int().min(0).max(256),
  /** Score of the 1-second calibration benchmark (higher = faster), refreshed every 6 h. */
  calibrationScore: z.number().nullable(),
  calibratedAt: z.string().nullable(),
  /** Adversarial self-check suite, at boot and every 6 h. */
  selfCheck: z
    .object({ ok: z.boolean(), at: z.string(), failures: z.array(z.string().max(500)).max(50) })
    .nullable(),
  /** Kernel hardening (sysctl + module blacklist) verified at boot. */
  hostHardening: z.object({ ok: z.boolean(), failures: z.array(z.string().max(500)).max(50) }).nullable(),
  /** Median CPU ms of hello-world ×20 per language, measured at boot: the startup credit. */
  startupMs: z.record(languageKeySchema, z.number().int().nonnegative()).default({}),
  busySlots: z.number().int().min(0).max(256),
});
export type HeartbeatRequest = z.infer<typeof heartbeatRequestSchema>;

export const heartbeatResponseSchema = z.object({
  status: z.enum(JUDGE_NODE_STATUSES),
  serverTime: z.string(),
  /**
   * Lanes this node may serve right now. ASSESSMENT and CONTEST are withheld
   * from a node whose calibration deviates > 10 % from the fleet median, whose
   * self-check is failed or stale, or whose host hardening check failed.
   */
  lanes: z.array(z.enum(JUDGE_LANES)),
  /** Why sensitive lanes are withheld, for the worker's log. */
  laneRestrictions: z.array(z.string()).default([]),
});
export type HeartbeatResponse = z.infer<typeof heartbeatResponseSchema>;

// ── Live progress (Redis pub/sub → SSE) ─────────────────────────────────

export const progressChannel = (kind: JobKind, id: string) => `recx:${kind}:${id}`;

export const progressEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("state"), state: z.enum(["QUEUED", "COMPILING", "RUNNING"]) }),
  z.object({ type: z.literal("subtask"), index: z.number().int(), v: verdictSchema }),
  z.object({
    type: z.literal("test"),
    i: z.number().int(),
    v: verdictSchema,
    done: z.number().int(),
    total: z.number().int(),
  }),
  z.object({ type: z.literal("final") }),
]);
export type ProgressEvent = z.infer<typeof progressEventSchema>;
