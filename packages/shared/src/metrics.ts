/**
 * The metric contract (Phase 10a).
 *
 * SPEC §10 names ten metrics. They are here as DATA — name, type, labels and
 * help text — for the same reason `PLACEMENT_EXPORT_COLUMNS` is data: a test
 * can assert the LIVE registry against this list, instead of a reviewer
 * reading two lists side by side and believing they match.
 *
 * ── The label rule, which is a privacy rule ─────────────────────────────
 *
 * No metric may carry a label whose value identifies a person: no user id, no
 * college id, no handle, no attempt id, no submission id. That is not about
 * cardinality. Prometheus is scraped by a separate VM, retained for months,
 * and rendered on dashboards that people screenshot and paste into chat — it
 * is the least controlled datastore in the system, and the one no retention
 * policy reaches.
 *
 * It is also what settles `proctor_event_total`: the TYPE only. A per-attempt
 * proctor counter would be a per-student behavioural record sitting exactly
 * there.
 *
 * `{queue}` is a judge lane and `{worker}` is a host name. Both are bounded
 * and neither is a person.
 *
 * ── Which process owns a metric ─────────────────────────────────────────
 *
 * A GAUGE must live on a process there is exactly one of, or its value
 * depends on which instance was scraped: the queue depths are on the
 * scheduler for that reason, and `sse_connections_active` is a legitimate
 * per-replica gauge because the connections really are per replica.
 *
 * A COUNTER may live on a replicated process, because Prometheus sums across
 * instances and `rate()` handles a restart's reset. That is why
 * `judge_verdict_total` is on web, at the one point every verdict passes
 * through, rather than on the scheduler, which would have to query for
 * deltas and would miscount a skipped tick.
 */

export const METRIC_TYPES = ["counter", "gauge", "histogram"] as const;
export type MetricType = (typeof METRIC_TYPES)[number];

/** Which process is the one that may report a metric. */
export const METRIC_OWNERS = ["web", "judge-worker", "scheduler"] as const;
export type MetricOwner = (typeof METRIC_OWNERS)[number];

export interface MetricSpec {
  readonly name: string;
  readonly type: MetricType;
  readonly owner: MetricOwner;
  readonly labels: readonly string[];
  readonly help: string;
  /** Histogram buckets, in the metric's own unit. */
  readonly buckets?: readonly number[];
}

/**
 * Latency buckets in seconds.
 *
 * Chosen around the limits that matter rather than as a round decade: the
 * judge's own wall-clock ceiling is 15s (SPEC's "no >15s problems"), the
 * end-to-end alert fires at a p95 of 30s, and the interesting region for a
 * single run is one to five seconds. A 0.5–2.5–10 ladder would put every
 * normal run and every slow one in the same bucket.
 */
const RUN_BUCKETS = Object.freeze([0.1, 0.25, 0.5, 1, 2, 3, 5, 8, 12, 15, 30]);
const E2E_BUCKETS = Object.freeze([0.5, 1, 2, 3, 5, 8, 12, 20, 30, 45, 60]);

export const METRICS: readonly MetricSpec[] = Object.freeze([
  {
    name: "judge_queue_depth",
    type: "gauge",
    owner: "scheduler",
    labels: ["queue"],
    help: "Jobs waiting in each judge lane.",
  },
  {
    /**
     * The twelfth, and the one Phase 12k needed (slice 5).
     *
     * `judge_queue_depth` is labelled by lane and nothing else, and it
     * stays that way: the alert rules are written against those labels,
     * and a lane's backlog is what a student feels regardless of which
     * engine will take the job. Adding an `engine` label to it would turn
     * `max by (queue)` into a per-engine maximum — 150 waiting on each of
     * two engines would stop firing a rule that fires at 200 — so the
     * split is a SEPARATE series instead.
     *
     * It exists because "why is PRACTICE backed up" is almost always one
     * engine rather than both, and because every SQL node being offline
     * looks exactly like a load problem until somebody can see the split.
     * `engine` is a closed set of two.
     */
    name: "judge_engine_queue_depth",
    type: "gauge",
    owner: "scheduler",
    labels: ["queue", "engine"],
    help: "Jobs waiting in each lane, by judging engine. judge_queue_depth is the sum of these.",
  },
  {
    name: "judge_oldest_job_age_seconds",
    type: "gauge",
    owner: "scheduler",
    labels: ["queue"],
    help: "Age of the oldest waiting job in each lane. The number a student feels.",
  },
  {
    name: "judge_run_duration_seconds",
    type: "histogram",
    owner: "judge-worker",
    labels: [],
    help: "Wall-clock time to run one submission's tests inside the sandbox.",
    buckets: RUN_BUCKETS,
  },
  {
    /**
     * On WEB, not on the scheduler, and the distinction is the one that
     * matters when deciding where any metric lives: every verdict in the
     * system passes through `POST /api/judge/result`, so counting it there
     * is exact and costs nothing, whereas the scheduler would have to query
     * for deltas and would miscount the moment a tick were skipped.
     *
     * Two web replicas are not a problem for a COUNTER — Prometheus sums
     * across instances, and a restart's reset is handled by `rate()`. It is
     * GAUGES that cannot live on a replicated process: `judge_queue_depth`
     * read from either replica would be the same Redis number reported
     * twice, which is why those are on the scheduler.
     */
    name: "judge_verdict_total",
    type: "counter",
    owner: "web",
    labels: ["verdict", "language"],
    help: "Verdicts reached, by verdict and language. Both are closed sets.",
  },
  {
    /**
     * Derived by the SCHEDULER from `JudgeNode.lastHeartbeatAt`, never
     * self-reported.
     *
     * A worker that has died cannot report that its own heartbeat is old,
     * and this metric exists for exactly that case: self-reported, it goes
     * MISSING rather than HIGH, and an alert on a missing series is a
     * different and much easier-to-get-wrong rule.
     */
    name: "judge_worker_heartbeat_age_seconds",
    type: "gauge",
    owner: "scheduler",
    labels: ["worker"],
    help: "Seconds since each judge node last checked in, as the scheduler sees it.",
  },
  {
    name: "judge_sandbox_init_failures_total",
    type: "counter",
    owner: "judge-worker",
    labels: [],
    help: "Sandbox initialisations that failed. The canary for a cgroup or kernel change after a host upgrade.",
  },
  {
    name: "judge_compile_cache_hits_total",
    type: "counter",
    owner: "judge-worker",
    labels: [],
    help: "Compilations served from the cache rather than run.",
  },
  {
    name: "submission_e2e_latency_seconds",
    type: "histogram",
    owner: "web",
    labels: [],
    help: "Submit to final verdict, as the student experiences it.",
    buckets: E2E_BUCKETS,
  },
  {
    /**
     * The TYPE only. See the label rule above: a per-attempt proctor counter
     * would put a per-student behavioural record in the least controlled
     * datastore in the system.
     */
    name: "proctor_event_total",
    type: "counter",
    owner: "web",
    labels: ["type"],
    help: "Proctor signals recorded, by type. Never by attempt or by student.",
  },
  {
    /**
     * The eleventh, and the only one SPEC §10's metric list does not name.
     *
     * It is there because that same paragraph asks for an alert on "failed
     * logins >100/min", and an alert needs a series: without this counter
     * the rule could only be written against logs, which is a different
     * system with a different ruler and a different failure mode. The list
     * of ten is what the spec REQUIRES, not a ceiling.
     *
     * `reason` is the sign-in failure code (`credentials`, `rate-limited`,
     * `inactive`, and the validation codes) — a closed set of nine,
     * declared in `apps/web/src/lib/auth/sign-in-errors.ts`. Never the
     * identifier, never the account, never the hashed IP: a per-account
     * failure counter would be a login-attempt log in the one datastore no
     * retention policy reaches, and the audit trail already records the
     * failures that matter, against the account, where access is controlled.
     */
    name: "auth_login_failures_total",
    type: "counter",
    owner: "web",
    labels: ["reason"],
    help: "Sign-in attempts refused, by failure code. Never by account or by address.",
  },
  {
    name: "sse_connections_active",
    type: "gauge",
    owner: "web",
    labels: [],
    help: "Open verdict streams on this web replica.",
  },
] as const satisfies readonly MetricSpec[]);

export type MetricName = (typeof METRICS)[number]["name"];

/**
 * Label names that may never appear on any metric.
 *
 * Checked against the LIVE registry rather than against `METRICS`, because
 * the registry is what gets scraped — a metric registered directly, bypassing
 * this list, is exactly what the fence is for.
 */
export const FORBIDDEN_METRIC_LABELS: readonly string[] = Object.freeze([
  "user",
  "userId",
  "userid",
  "student",
  "studentId",
  "collegeId",
  "handle",
  "email",
  "attempt",
  "attemptId",
  "submission",
  "submissionId",
  "ip",
  "ipHash",
  "name",
  "section",
]);

/** The forbidden labels a given label set uses, if any. */
export function forbiddenLabels(labels: readonly string[]): string[] {
  const lower = new Map(FORBIDDEN_METRIC_LABELS.map((label) => [label.toLowerCase(), label]));
  return [...new Set(labels.filter((label) => lower.has(label.toLowerCase())))].sort();
}

export function metricsFor(owner: MetricOwner): MetricSpec[] {
  return METRICS.filter((metric) => metric.owner === owner);
}

export function metricByName(name: string): MetricSpec | undefined {
  return METRICS.find((metric) => metric.name === name);
}

/**
 * The health endpoint's shape.
 *
 * `activeContest` is on a HEALTH endpoint because the deploy script needs
 * exactly one call: SPEC §10 blocks a deploy while a contest or assessment is
 * live, and the job reads it from here. It is a scheduling fact rather than a
 * health fact, which is why it is documented rather than left to be inferred.
 */
export interface HealthReport {
  /** False when a dependency is down. The endpoint still answers 200. */
  readonly ok: boolean;
  readonly version: string;
  readonly db: "up" | "down";
  readonly redis: "up" | "down";
  /**
   * Whether the running image's migrations match what the database applied.
   * The one number that explains "the code is deployed but the page is
   * broken".
   */
  readonly migrations: "current" | "behind" | "unknown";
  /** A deploy is refused while either is true, unless FORCE_DEPLOY=1. */
  readonly activeContest: boolean;
  readonly activeAssessment: boolean;
  /** How many, for the operator. Never which ones, and never whose. */
  readonly activeContests: number;
  readonly activeAssessments: number;
}

/**
 * Why the endpoint answers 200 even when it is not ok.
 *
 * A health endpoint that returns 500 tells a load balancer to stop asking,
 * and tells a deploy script nothing it can act on. The STATUS says "I
 * answered"; the BODY says what is wrong. The deploy gate reads the body.
 */
export const HEALTH_ALWAYS_200 = true;
