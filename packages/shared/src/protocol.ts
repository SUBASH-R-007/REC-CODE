import { z } from "zod";
import { LANGUAGE_KEYS, TOOLCHAIN_ID_PATTERN } from "./languages";
import { SQL_LIMITS, sqlResultSetSchema } from "./sql-problem";
// Type-only in the other direction (sql-language imports `type IoMode`), so
// this is not a runtime cycle.
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
 *
 * 4 (Phase 12k): a second ENGINE. The shape was settled across the
 * phase's slices and released once — slice 1 introduced it, slice 3 moved
 * a SQL case's dataset from the version to the case — so there is no
 * intermediate version for a fleet to be half-upgraded to. Every spec now says which engine judges
 * it — `isolate` for a program, `postgres` for a SQL query — and a SQL job
 * carries a different spec shape (no compile, no memory limit, a setup
 * script and a result set per case) behind the same routes, the same lease
 * and the same result payload. An isolate node never sees a SQL job
 * (separate queues), but the version still moves: a v3 worker predates the
 * union, and the honest thing for a worker that cannot parse what the
 * server might send is to drain rather than guess.
 *
 * 5 (Phase 12l): interactive problems. A spec may carry an `interactor`,
 * which a v4 worker would ignore — and a job whose verdict comes from a
 * program that never ran is the worst thing this protocol could allow.
 *
 * 6 (Phase 12n): output-only problems. `language` is now NULLABLE, and
 * null exactly when `ioMode` is OUTPUT_ONLY: the submission is the answer
 * itself, so there is no program, no compile and no run — and inventing a
 * runtime that never runs would mislead the first person to read a spec.
 * A v5 worker would fail to parse such a spec, which is the honest
 * outcome: it drains and upgrades.
 */
export const JUDGE_PROTOCOL_VERSION = 6;

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
 * The engines that judge a job. `isolate` runs a program in a sandbox;
 * `postgres` runs one SQL statement against a per-submission ephemeral
 * schema in a cluster that holds no application data (Phase 12k).
 */
export const JUDGE_ENGINES = ["isolate", "postgres"] as const;
export type JudgeEngine = (typeof JUDGE_ENGINES)[number];

/**
 * SQL jobs have their own queues, one per lane (Phase 12k).
 *
 * Not a flag on the job in the shared queues: `claimJob()` leases by id
 * with no engine condition, so an isolate node WOULD claim a SQL
 * submission and have to refuse it — and a refusal counts an attempt, so
 * three of them would fail the job. Separate queues mean a node only ever
 * hears about work it can do.
 */
export const SQL_QUEUE_NAME: Readonly<Record<JudgeLane, string>> = {
  ASSESSMENT: "judge-sql-assessment",
  CONTEST: "judge-sql-contest",
  RUN: "judge-sql-run",
  PRACTICE: "judge-sql-practice",
  REJUDGE: "judge-sql-rejudge",
};

/** The queue a job belongs in, by engine and lane. */
export function queueNameFor(engine: JudgeEngine, lane: JudgeLane): string {
  return engine === "postgres" ? SQL_QUEUE_NAME[lane] : QUEUE_NAME[lane];
}

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

/**
 * How a job's output is compared. `ROWS` is a SQL version's result-set
 * comparison (Phase 12k) and is judged by the `postgres` engine only — an
 * isolate worker that is ever handed one refuses the job permanently
 * rather than guessing at it.
 */
export const COMPARE_MODES = ["EXACT", "TOKEN", "FLOAT", "CHECKER", "INTERACTIVE", "ROWS"] as const;
export type CompareMode = (typeof COMPARE_MODES)[number];

export const SCORING_MODES = ["ICPC", "SUBTASK", "PER_TEST"] as const;
export type ScoringMode = (typeof SCORING_MODES)[number];

/**
 * `SQL` is a problem answered with one statement against a dataset rather
 * than with a program (Phase 12k). `engineForIoMode()` in `sql-language.ts`
 * is the one place that turns this into which engine judges it.
 *
 * `OUTPUT_ONLY` is a problem answered with the ANSWER (Phase 12n): one
 * case, no program, and the student's submitted text compared with the
 * expected output — or judged by the author's checker. It is judged by the
 * ISOLATE fleet like every other program problem, because a CHECKER
 * answer-problem runs the author's program and that may only ever happen
 * in a box.
 */
export const IO_MODES = ["STDIN", "FUNCTION", "SQL", "OUTPUT_ONLY"] as const;
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

/**
 * An interactive problem's interactor (protocol 5, Phase 12l).
 *
 * The same shape as a checker's, because it is the same kind of thing: a
 * testlib C++ program the AUTHOR wrote, compiled by the node with the
 * pinned compiler and cached by its source hash. The difference is when it
 * runs — beside the solution, talking to it — and that it is the one who
 * decides the verdict, with the checker's own exit codes.
 */
export const interactorSpecSchema = checkerSpecSchema;
export type InteractorSpec = z.infer<typeof interactorSpecSchema>;

/**
 * The isolate spec's fields, without the cross-field rule below.
 *
 * Exported only because `anyJobSpecSchema` is a DISCRIMINATED union, and
 * zod can discriminate plain objects only: a refined schema is a
 * `ZodEffects` and cannot carry the `engine` discriminator. The rule it is
 * missing is checked where it decides something — in `buildJudgeJobSpec`,
 * which builds the spec, and in the worker, which parses it.
 */
export const judgeJobSpecObject = z.object({
  protocolVersion: z.literal(JUDGE_PROTOCOL_VERSION),
  /** Protocol 4: which engine this spec is for. */
  engine: z.literal("isolate").default("isolate"),
  kind: jobKindSchema,
  id: z.string(),
  lane: z.enum(JUDGE_LANES),
  claimToken: z.string().min(16),
  attempt: z.number().int().min(1),
  /**
   * The program's runtime — null exactly for an OUTPUT_ONLY job
   * (protocol 6), which has no program to compile or run. The refinement
   * below holds both halves of that.
   */
  language: languageRuntimeSchema.nullable(),
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
  /** compareMode INTERACTIVE only (protocol 5). */
  interactor: interactorSpecSchema.nullable().default(null),
  /**
   * Blobs delivered inline with the claim instead of via /api/judge/blob —
   * only a custom run's stdin (≤ 64 KB), which is not a stored TestBlob.
   * Keyed by sha256; the worker verifies the hash like any other blob.
   */
  inlineBlobs: z.record(sha256, z.string().max(LIMITS.customRun.stdinBytes)).default({}),
});

export const judgeJobSpecSchema = judgeJobSpecObject
  /**
   * Phase 12n. An output-only job is the one isolate job with no program:
   * its `source` is the student's ANSWER, its single case is compared (or
   * checked) against the expected output, and nothing is compiled or run.
   * Both halves are asserted, because a spec with a runtime that never
   * runs and a spec with no runtime for a job that needs one are each a
   * job no node could judge correctly.
   */
  .superRefine((spec, ctx) => {
    const answerOnly = spec.ioMode === "OUTPUT_ONLY";
    if (answerOnly === (spec.language === null)) return;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["language"],
      message: answerOnly
        ? "An output-only job has no program, so it carries no language runtime."
        : "A job that runs a program needs its language runtime.",
    });
  });
export type JudgeJobSpec = z.infer<typeof judgeJobSpecSchema>;

// ── The SQL engine's spec (protocol 4) ──────────────────────────────────

/**
 * One SQL case: its dataset and its expected result set, each a blob.
 *
 * Both are per case, with no version-level default — slice 3 settled that,
 * because a `TestCase` already carries an input blob and an output blob,
 * and two ways to say where the dataset comes from is one way too many.
 * Cases that share a dataset share the blob: `TestBlob` is keyed by
 * sha256, so the bytes are stored once however many cases name them.
 *
 * The expected result set is a blob the author's own reference query
 * produced during validation — never rows typed by hand, for the same
 * reason expected stdout is not typed by hand.
 */
export const sqlCaseSpecSchema = z.object({
  index: z.number().int().nonnegative(),
  visible: z.boolean(),
  /** The schema and seed rows this case starts from. */
  setup: blobRefSchema,
  /**
   * The expected result set. Null on a CAPTURE run, which is the run that
   * produces it: an author never types expected rows, for the same reason
   * they never type expected stdout.
   */
  expected: blobRefSchema.nullable(),
  /** Compared in order, or as a multiset. The problem's choice, per case on the wire. */
  ordered: z.boolean(),
});
export type SqlCaseSpec = z.infer<typeof sqlCaseSpecSchema>;

export const sqlJobSpecSchema = z.object({
  protocolVersion: z.literal(JUDGE_PROTOCOL_VERSION),
  engine: z.literal("postgres"),
  kind: jobKindSchema,
  id: z.string(),
  lane: z.enum(JUDGE_LANES),
  claimToken: z.string().min(16),
  attempt: z.number().int().min(1),
  /** The only dialect; stated rather than inferred. */
  dialect: z.literal("postgres17"),
  /** The student's statement. */
  source: z.string().max(SQL_LIMITS.submissionBytes),
  cases: z.array(sqlCaseSpecSchema).min(1).max(100),
  /**
   * A capture run: execute the author's REFERENCE query against each case
   * and report the result sets instead of comparing them. This is what a
   * validation run on a SQL version is — the author's query is the only
   * definition of the right answer, and running it is how the expected
   * result sets come to exist.
   */
  capture: z.boolean().default(false),
  stopOnFirstFailure: z.boolean(),
  /** Enforced by the database, not by a timer in the service. */
  statementTimeoutMs: z.literal(SQL_LIMITS.statementTimeoutMs),
  /** A result set larger than this is refused rather than compared. */
  maxRows: z.literal(SQL_LIMITS.rows),
});
export type SqlJobSpec = z.infer<typeof sqlJobSpecSchema>;

/**
 * What a claim may answer with. The route validates against this; each
 * engine's service parses only its own half, because a worker that could
 * parse the other engine's spec would eventually try to run it.
 */
export const anyJobSpecSchema = z.discriminatedUnion("engine", [
  judgeJobSpecObject.extend({ engine: z.literal("isolate") }),
  sqlJobSpecSchema,
]);
export type AnyJobSpec = z.infer<typeof anyJobSpecSchema>;

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
  /**
   * A SQL capture run's result sets, one per case (Phase 12k). Accepted on
   * a VALIDATION job for a SQL version and nowhere else: the server writes
   * them as the version's expected results, so a submission that could
   * send them would be a submission that could choose its own answer.
   */
  sqlCaptured: z
    .array(z.object({ index: z.number().int().nonnegative(), resultSet: sqlResultSetSchema }))
    .max(100)
    .optional(),
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
  /**
   * Protocol 4: `postgres` is the SQL sandbox (Phase 12k). Its
   * `isolateVersion` is empty — there is no isolate on that host — and the
   * engine's own version goes in `engineVersion` rather than into a column
   * named after another engine.
   */
  driver: z.enum(["isolate", "docker", "mock", "postgres"]),
  /** e.g. "PostgreSQL 17.6". Optional: a v3 worker never sent one. */
  engineVersion: z.string().max(64).default(""),
  /**
   * The languages this node judges. A toolchain key for an isolate node;
   * `sql17` for a SQL one, which judges a language that is not a toolchain
   * (Phase 12k). Widening rather than a protocol bump: a v3 worker sends a
   * subset of this set, and the field is stored for display only.
   */
  /**
   * What the node reports it can run. Validated as bounded strings rather
   * than against the key list on purpose: this is a REPORT, not an
   * authority — the server matches these keys against its own
   * `LanguageConfig` rows, so a key it does not know simply never matches
   * a problem. Keeping the list out of this module also keeps `protocol`
   * free of a dependency on the student-facing language modules, which is
   * what made a bundler's barrel optimisation able to evaluate this file
   * before them (Phase 12n found it the hard way: `z.enum` of an
   * uninitialised list threw on every submission).
   */
  languages: z.array(z.string().min(1).max(32)).max(64),
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
