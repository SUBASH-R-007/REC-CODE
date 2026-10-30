import { metricByName } from "./metrics";
import { ALL_METRIC_NAMES } from "./metrics-registry";

/**
 * The alert rules, as data (Phase 10b).
 *
 * SPEC §10 names eight alerts in one sentence. They live here rather than
 * only in `infra/monitoring/alerts.yml` for the same reason the metric names
 * do: a YAML file full of PromQL is unreadable to a test, so the file is
 * GENERATED from this list and a fence fails if the two drift. What a
 * reviewer then has to check is this file, in a language the rest of the
 * repo is written in.
 *
 * Three decisions are worth stating before the list.
 *
 * **Every rule has a `for:`.** Without one, a single scrape at the wrong
 * moment pages somebody — queue depth spikes every time a contest starts,
 * and a depth of 201 for ten seconds is a platform working correctly.
 *
 * **Every rule has a `runbook_url`,** pointing at a `docs/RUNBOOK.md`
 * heading named after the alert. An alert that does not say what to do is a
 * pager that teaches people to silence it, and the fence refuses a rule
 * whose heading does not exist.
 *
 * **Every rule carries the number it is asserted against** (`threshold`)
 * and a `reduce` that reads that number out of the metrics the expression
 * reads. `scripts/ops/fire-alerts.ts` produces each condition against the
 * live stack and uses `reduce` to assert the number crosses — and
 * `test/alerts.test.ts` asserts each one fires just above the threshold and
 * stays quiet just below it. That pair is the honest limit of what can be
 * checked here: `reduce` mirrors the expression, it does not evaluate it.
 * PromQL syntax is checked by `promtool check rules` in CI, which is the
 * only thing that can.
 */

/** One sample line from an exposition: a name, its labels, its value. */
export interface MetricSample {
  readonly name: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly value: number;
}

/**
 * Parse the sample LINES of an exposition (comments skipped).
 *
 * `parseExposition` in `./metrics-registry` collects label keys for the
 * privacy fence; this one keeps the values and the numbers, because an alert
 * is about a number. Deliberately strict: a line it cannot read is skipped
 * rather than guessed at, and a rule that found no samples reduces to null,
 * which the harness reports as "the metric is not being published" — a
 * different failure from "the number is too low".
 */
export function parseSamples(text: string): MetricSample[] {
  const out: MetricSample[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    const match = /^([A-Za-z_:][A-Za-z0-9_:]*)(?:\{([^}]*)\})?\s+(-?[0-9.eE+]+|NaN|\+Inf|-Inf)/.exec(trimmed);
    if (!match?.[1] || match[3] === undefined) continue;
    const labels: Record<string, string> = {};
    for (const pair of (match[2] ?? "").split(",")) {
      const eq = pair.indexOf("=");
      if (eq <= 0) continue;
      const key = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim().replace(/^"|"$/g, "");
      if (key) labels[key] = value;
    }
    const value = match[3] === "NaN" ? Number.NaN : Number(match[3].replace("+Inf", "Infinity"));
    out.push({ name: match[1], labels, value });
  }
  return out;
}

/** Samples of one metric, optionally filtered by a label value. */
function series(samples: readonly MetricSample[], name: string, label?: { key: string; value: string }): MetricSample[] {
  return samples.filter((s) => s.name === name && (!label || s.labels[label.key] === label.value));
}

/** The largest value of a metric across its label sets, or null if absent. */
function maxOf(samples: readonly MetricSample[], name: string): number | null {
  const found = series(samples, name);
  return found.length === 0 ? null : Math.max(...found.map((s) => s.value));
}

/** The sum of a counter's values, or null if the metric is absent. */
function sumOf(samples: readonly MetricSample[], name: string, label?: { key: string; value: string }): number | null {
  const found = series(samples, name, label);
  return found.length === 0 ? null : found.reduce((total, s) => total + s.value, 0);
}

/**
 * A counter's increase between two scrapes.
 *
 * Negative means the process restarted and the counter reset; Prometheus's
 * `rate()` handles that by treating it as a reset, and so does this: the
 * increase is the later value, because everything before the restart is
 * gone. Returning the negative number would read as "the rate fell", which
 * is the one thing a counter cannot do.
 */
function increase(before: number | null, after: number | null): number | null {
  if (after === null) return null;
  if (before === null) return after;
  return after >= before ? after - before : after;
}

/**
 * `histogram_quantile` over bucket increases, the same linear
 * interpolation Prometheus does.
 *
 * Written out rather than approximated because the rule it serves is SPEC's
 * own latency SLO: if this disagreed with Prometheus, the harness would
 * cheerfully confirm a rule that never fires. The buckets come from the
 * metric contract, so a bucket ladder changed in `metrics.ts` changes this
 * calculation too.
 */
export function quantileFromBuckets(
  quantile: number,
  buckets: ReadonlyArray<{ le: number; count: number }>,
): number | null {
  const sorted = [...buckets].sort((a, b) => a.le - b.le);
  const total = sorted.at(-1)?.count ?? 0;
  if (total <= 0) return null;
  const want = quantile * total;
  let previousLe = 0;
  let previousCount = 0;
  for (const bucket of sorted) {
    if (bucket.count >= want) {
      if (!Number.isFinite(bucket.le)) return previousLe;
      const span = bucket.count - previousCount;
      if (span <= 0) return bucket.le;
      return previousLe + ((want - previousCount) / span) * (bucket.le - previousLe);
    }
    previousLe = bucket.le;
    previousCount = bucket.count;
  }
  return sorted.at(-1)?.le ?? null;
}

/** Cumulative bucket increases of a histogram between two scrapes. */
function bucketIncreases(
  before: readonly MetricSample[],
  after: readonly MetricSample[],
  name: string,
): Array<{ le: number; count: number }> {
  const key = (sample: MetricSample) => sample.labels.le ?? "";
  const beforeByLe = new Map(series(before, `${name}_bucket`).map((s) => [key(s), s.value]));
  return series(after, `${name}_bucket`).map((sample) => ({
    le: key(sample) === "+Inf" ? Number.POSITIVE_INFINITY : Number(key(sample)),
    count: increase(beforeByLe.get(key(sample)) ?? null, sample.value) ?? 0,
  }));
}

/** What `reduce` is given: two scrapes and the seconds between them. */
export interface AlertReading {
  readonly before: readonly MetricSample[];
  readonly after: readonly MetricSample[];
  readonly elapsedSeconds: number;
}

export const ALERT_SEVERITIES = ["critical", "warning"] as const;
export type AlertSeverity = (typeof ALERT_SEVERITIES)[number];

/**
 * Whether `scripts/ops/fire-alerts.ts` can produce the real condition on
 * this hardware, and what it does instead when it cannot.
 */
export const ALERT_PRODUCTION = ["live", "synthetic"] as const;
export type AlertProduction = (typeof ALERT_PRODUCTION)[number];

export interface AlertSpec {
  /** PascalCase, unique, and the name of its `docs/RUNBOOK.md` heading. */
  readonly name: string;
  readonly severity: AlertSeverity;
  /** The `for:` duration, Prometheus syntax. */
  readonly pending: string;
  readonly expr: string;
  /** The number in the expression, asserted from both sides. */
  readonly threshold: number;
  readonly summary: string;
  readonly description: string;
  /** The words in SPEC §10 this rule implements, verbatim. */
  readonly spec: string;
  readonly produced: AlertProduction;
  /** How the harness produces the condition, or why it cannot. */
  readonly how: string;
  /** The number the expression computes, read out of the metrics. */
  reduce(reading: AlertReading): number | null;
}

const IE_VERDICT = { key: "verdict", value: "IE" } as const;

export const ALERTS: readonly AlertSpec[] = Object.freeze([
  {
    name: "JudgeQueueBacklog",
    severity: "critical",
    pending: "2m",
    expr: "max by (queue) (judge_queue_depth) > 200",
    threshold: 200,
    summary: "A judge lane has more than 200 jobs waiting",
    description:
      "Students are queued behind a backlog this platform cannot clear at its current capacity. Either a worker has stopped taking jobs or a contest is larger than the hosts provisioned for it.",
    spec: "queue depth >200 for 2 min",
    produced: "live",
    how: "250 jobs enqueued into one lane with no worker consuming it, then published by the scheduler's own observer.",
    reduce: ({ after }) => maxOf(after, "judge_queue_depth"),
  },
  {
    /**
     * The ninth rule, and the only one SPEC §10 does not name — for the
     * same reason `auth_login_failures_total` exists: the thing it watches
     * did not exist when the list of eight was written.
     *
     * A lane has two queues now (Phase 12k), and the two engines fail
     * SEPARATELY: an isolate host and a SQL host are different machines
     * with different failure modes. A lane whose total is comfortable can
     * have one engine draining normally and the other stopped dead, and
     * `JudgeQueueBacklog` — which reads the sum — would say nothing until
     * the stopped half alone passed 200.
     *
     * Lower threshold and a longer `for:` than the lane rule, deliberately:
     * this is "one half of the fleet is not keeping up", which is a warning
     * somebody acts on today, not a page.
     */
    name: "JudgeEngineBacklog",
    severity: "warning",
    pending: "5m",
    expr: "max by (queue, engine) (judge_engine_queue_depth) > 100",
    threshold: 100,
    summary: "One judging engine has more than 100 jobs waiting on a lane",
    description:
      "The two engines fail separately: the lane total can look fine while one engine's queue is not being drained at all. Read the Engines table on /admin/judge first — \"nodes online\" for that engine is the usual answer, and for the SQL engine it is usually the sandbox cluster rather than the judge process.",
    spec: "queue depth >200 for 2 min (the per-engine half of it, Phase 12k)",
    produced: "live",
    how: "120 jobs enqueued onto the SQL practice queue with no SQL judge consuming it, then published by the scheduler's own observer.",
    reduce: ({ after }) => maxOf(after, "judge_engine_queue_depth"),
  },
  {
    name: "JudgeOldestJobStale",
    severity: "critical",
    /**
     * A shorter `for:` than the backlog rule on purpose. A deep queue that
     * is draining is a platform working hard; a job that has sat for a
     * minute and is still sitting there a minute later is a student watching
     * a spinner, which is the thing SPEC §10 says this number measures —
     * "the number a student feels".
     */
    pending: "1m",
    expr: "max by (queue) (judge_oldest_job_age_seconds) > 60",
    threshold: 60,
    summary: "The oldest job in a judge lane has waited more than 60 seconds",
    description:
      "Nothing is dispatching this lane. Check the judge nodes' heartbeats and lane restrictions before capacity: a stale lane with an empty-looking queue is usually a node that stopped claiming, not a load problem.",
    spec: "oldest job >60s",
    produced: "live",
    how: "one job enqueued with no worker consuming it, then left to age past 60 seconds.",
    reduce: ({ after }) => maxOf(after, "judge_oldest_job_age_seconds"),
  },
  {
    name: "JudgeWorkerHeartbeatStale",
    severity: "critical",
    pending: "1m",
    expr: "max by (worker) (judge_worker_heartbeat_age_seconds) > 90",
    threshold: 90,
    summary: "A judge node has not checked in for more than 90 seconds",
    description:
      "The node is down, partitioned, or wedged. Its leases expire and the reconciler re-enqueues what it held, so no submission is lost; what is lost is capacity. Reported by the scheduler from JudgeNode, never self-reported, so a dead node's series rises rather than disappearing.",
    spec: "worker heartbeat >90s",
    produced: "live",
    how: "a JudgeNode row whose lastHeartbeatAt is two minutes old, published by the scheduler's own observer.",
    reduce: ({ after }) => maxOf(after, "judge_worker_heartbeat_age_seconds"),
  },
  {
    name: "JudgeInternalErrorRate",
    severity: "critical",
    pending: "5m",
    expr: 'sum(rate(judge_verdict_total{verdict="IE"}[5m])) / sum(rate(judge_verdict_total[5m])) > 0.02',
    threshold: 0.02,
    /**
     * No minimum-volume guard, and that is deliberate. The obvious addition
     * — "and at least ten verdicts in the window" — would silence this
     * during exactly the quiet hour somebody picks to upgrade a judge host's
     * kernel. An IE is never normal; one of them in a quiet period is worth
     * a look, and SPEC §10 says why: otherwise it is discovered from student
     * complaints.
     */
    summary: "More than 2% of verdicts are INTERNAL_ERROR",
    description:
      "The canary for a broken compiler image or a cgroup misconfiguration after a host upgrade. Check judge_sandbox_init_failures_total on each worker and the node self-check results; a node whose self-check fails quarantines itself, so a rising IE rate with every node still ONLINE points at the image rather than the kernel.",
    spec: "INTERNAL_ERROR rate >2% over 5 min",
    produced: "synthetic",
    how: "a real IE needs a problem whose checker exits 3 and a submission run through the whole pipeline; that is the mid-contest judge drill in 10f, not something a script should create in a database. Asserted here against samples of the contract's own counter.",
    reduce: ({ before, after }) => {
      const ies = increase(sumOf(before, "judge_verdict_total", IE_VERDICT), sumOf(after, "judge_verdict_total", IE_VERDICT));
      const all = increase(sumOf(before, "judge_verdict_total"), sumOf(after, "judge_verdict_total"));
      if (all === null || all <= 0) return null;
      return (ies ?? 0) / all;
    },
  },
  {
    name: "HostDiskNearlyFull",
    severity: "warning",
    pending: "10m",
    expr:
      'max by (instance, mountpoint) (1 - node_filesystem_avail_bytes{fstype!~"tmpfs|ramfs|overlay"} / node_filesystem_size_bytes{fstype!~"tmpfs|ramfs|overlay"}) > 0.8',
    threshold: 0.8,
    summary: "A host's filesystem is more than 80% full",
    description:
      "80% is act-today, not wake-up, which is why this is a warning. On the database host the first casualty is WAL archiving; on a judge host it is the blob cache, which evicts itself but whose ceiling (RECX_CACHE_MAX_BYTES) may be set above what the disk can give.",
    spec: "disk >80%",
    produced: "synthetic",
    how: "filling a disk to 80% on a development laptop is not a test, it is an outage. Asserted against samples in the node exporter's own shape.",
    reduce: ({ after }) => {
      const sizes = new Map(series(after, "node_filesystem_size_bytes").map((s) => [`${s.labels.instance}|${s.labels.mountpoint}`, s.value]));
      const used: number[] = [];
      for (const sample of series(after, "node_filesystem_avail_bytes")) {
        const size = sizes.get(`${sample.labels.instance}|${sample.labels.mountpoint}`);
        if (size === undefined || size <= 0) continue;
        used.push(1 - sample.value / size);
      }
      return used.length === 0 ? null : Math.max(...used);
    },
  },
  {
    name: "PostgresConnectionsHigh",
    severity: "warning",
    pending: "5m",
    expr: "sum(pg_stat_database_numbackends) / max(pg_settings_max_connections) > 0.8",
    threshold: 0.8,
    summary: "More than 80% of Postgres connections are in use",
    description:
      "The next connection to be refused belongs to a student mid-submission. The web app runs a bounded pool, so a number this high usually means something outside it — a migration, a psql session left open, or the scheduler's single connection multiplied by a restart loop.",
    spec: "DB connections >80%",
    produced: "synthetic",
    how: "the condition is producible here but nothing exports it: postgres_exporter needs root to install on this machine. Asserted against samples in the exporter's own shape.",
    reduce: ({ after }) => {
      const backends = sumOf(after, "pg_stat_database_numbackends");
      const limit = maxOf(after, "pg_settings_max_connections");
      if (backends === null || limit === null || limit <= 0) return null;
      return backends / limit;
    },
  },
  {
    name: "FailedLoginBurst",
    severity: "warning",
    pending: "2m",
    expr: "sum(rate(auth_login_failures_total[1m])) * 60 > 100",
    threshold: 100,
    summary: "More than 100 sign-ins are being refused every minute",
    description:
      "Credential stuffing, or a broken integration retrying. The rate limiter is already refusing these — per account and per hashed IP — so this is a signal, not an outage; it counts rate-limited attempts too, because a run against one account shows up as a handful of credential failures and then hundreds of refusals.",
    spec: "failed logins >100/min",
    produced: "live",
    how: "120 wrong-password posts to /api/auth/login against one seeded account, then read back from the token-guarded /metrics.",
    reduce: ({ before, after, elapsedSeconds }) => {
      const delta = increase(sumOf(before, "auth_login_failures_total"), sumOf(after, "auth_login_failures_total"));
      if (delta === null || elapsedSeconds <= 0) return null;
      return (delta / elapsedSeconds) * 60;
    },
  },
  {
    name: "SubmissionLatencyP95High",
    severity: "critical",
    pending: "5m",
    expr: "histogram_quantile(0.95, sum by (le) (rate(submission_e2e_latency_seconds_bucket[5m]))) > 30",
    threshold: 30,
    summary: "95th-percentile submit-to-verdict is over 30 seconds",
    description:
      "The number a student experiences, measured where their wait ends rather than where the judge's work ends. Read judge_queue_depth and judge_run_duration_seconds next: a high p95 with short run durations is queueing, and a high p95 with long run durations is a problem's limits or a slow host.",
    spec: "e2e p95 >30s",
    produced: "synthetic",
    how: "producing a real 31-second verdict means making the judge slow, which is a load test rather than an alert test (scripts/load/ does that). Asserted against observations of the contract's own histogram, buckets included.",
    reduce: ({ before, after }) =>
      quantileFromBuckets(0.95, bucketIncreases(before, after, "submission_e2e_latency_seconds")),
  },
] as const satisfies readonly AlertSpec[]);

export function alertByName(name: string): AlertSpec | undefined {
  return ALERTS.find((alert) => alert.name === name);
}

/**
 * Metric names an expression reads, our own and the exporters'.
 *
 * Used by the fence to refuse a rule written against a metric that does not
 * exist — the single most common way an alert rule becomes a comment. It is
 * a lexer, not a parser: it strips label matchers and string literals, drops
 * PromQL's own vocabulary, and returns what is left. Over-reporting would be
 * a false fence failure, so the keyword list below has to stay complete;
 * under-reporting is caught by `promtool check rules`.
 */
const PROMQL_WORDS = new Set([
  "abs", "absent", "absent_over_time", "and", "avg", "avg_over_time", "bool", "by", "ceil", "changes",
  "clamp", "clamp_max", "clamp_min", "count", "count_over_time", "delta", "deriv", "exp", "floor",
  "group_left", "group_right", "histogram_quantile", "hour", "idelta", "ignoring", "increase", "inf",
  "irate", "label_join", "label_replace", "last_over_time", "ln", "log2", "log10", "max", "max_over_time",
  "min", "min_over_time", "minute", "nan", "offset", "on", "or", "predict_linear", "present_over_time",
  "quantile", "quantile_over_time", "rate", "resets", "round", "scalar", "sgn", "sort", "sort_desc",
  "sqrt", "stddev", "stdvar", "sum", "sum_over_time", "time", "timestamp", "topk", "unless", "vector",
  "without",
]);

export function metricNamesIn(expr: string): string[] {
  const stripped = expr
    .replace(/"[^"]*"/g, '""')
    // Label matchers, range selectors, and the grouping clauses: `by (queue)`
    // names a LABEL, and a lexer that kept it would report `queue` as a
    // metric nobody publishes.
    .replace(/\{[^}]*\}/g, "")
    .replace(/\[[^\]]*\]/g, "")
    .replace(/\b(?:by|without|ignoring|on|group_left|group_right)\s*\([^)]*\)/g, "");
  const found = new Set<string>();
  for (const match of stripped.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) {
    const word = match[0];
    if (PROMQL_WORDS.has(word.toLowerCase())) continue;
    found.add(word);
  }
  return [...found].sort();
}

/**
 * Label names an expression mentions: in a matcher, and in a grouping
 * clause.
 *
 * The complement of `metricNamesIn`, and it exists for the dashboards. A
 * panel is exactly where somebody reaches for `by (userId)` to answer a
 * support question — the metric does not carry that label, so the panel
 * renders empty, but it gets committed and reviewed as if it worked. A
 * substring search over the expression cannot be used for this:
 * `submission_e2e_latency_seconds` contains the word `submission`.
 */
export function labelNamesIn(expr: string): string[] {
  const found = new Set<string>();
  for (const matcher of expr.matchAll(/{([^}]*)}/g)) {
    for (const pair of (matcher[1] ?? "").split(",")) {
      const name = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?:=~|!~|!=|=)/.exec(pair)?.[1];
      if (name) found.add(name);
    }
  }
  for (const clause of expr.matchAll(/\b(?:by|without|ignoring|on|group_left|group_right)\s*\(([^)]*)\)/g)) {
    for (const name of (clause[1] ?? "").split(",")) {
      const trimmed = name.trim();
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(trimmed)) found.add(trimmed);
    }
  }
  return [...found].sort();
}

/**
 * Metric names the rules may read that this repo does not produce.
 *
 * Everything here comes from an exporter on the host, and the name is that
 * exporter's, not ours: node_exporter 1.8 for the filesystem gauges,
 * postgres_exporter 0.15 for the connection ones. Listed explicitly so a
 * typo in an exporter's metric name is a fence failure rather than a rule
 * that silently never fires — which is exactly how these go wrong.
 */
export const EXPORTER_METRICS: readonly string[] = Object.freeze([
  "node_filesystem_avail_bytes",
  "node_filesystem_size_bytes",
  "pg_settings_max_connections",
  "pg_stat_database_numbackends",
]);

/** A metric name an expression may read: ours (any suffix) or an exporter's. */
export function isKnownMetric(name: string): boolean {
  if (EXPORTER_METRICS.includes(name)) return true;
  if (ALL_METRIC_NAMES.includes(name)) return true;
  // A histogram is read through its generated series.
  for (const suffix of ["_bucket", "_sum", "_count"] as const) {
    if (!name.endsWith(suffix)) continue;
    const base = name.slice(0, -suffix.length);
    if (metricByName(base)?.type === "histogram") return true;
  }
  return false;
}

/**
 * The default `runbook_url` prefix: this repository's own `docs/RUNBOOK.md`.
 *
 * Overridable when the file is generated (`RECX_RUNBOOK_BASE`), because the
 * link is for whoever is holding the pager at 10:40 on the morning of a
 * drive: if the college publishes the runbook somewhere they can open
 * without a GitHub account, that is the URL that belongs in the rule.
 */
export const RUNBOOK_BASE_DEFAULT = "https://github.com/SUBASH-R-007/REC-CODE/blob/main/docs/RUNBOOK.md";

export const ALERT_GROUP = "recx";
/** Matches the scrape interval in `infra/monitoring/prometheus.yml`. */
export const ALERT_EVAL_INTERVAL = "30s";

/** The anchor of an alert's `docs/RUNBOOK.md` heading (GitHub's rule). */
export function runbookAnchor(alert: AlertSpec): string {
  return `#${alert.name.toLowerCase()}`;
}

const GENERATED_HEADER = `# GENERATED FILE — do not edit.
#
# Rendered from packages/shared/src/alerts.ts, where each rule is written
# with the number it is asserted against and the SPEC §10 phrase it
# implements. Regenerate with:
#
#   RECX_UPDATE_DOCS=1 pnpm --filter @recx/shared exec vitest run test/monitoring-files.test.ts
#
# That test fails if this file and the rule list disagree.`;

/** YAML-safe single-quoted scalar (PromQL uses double quotes inside). */
function quoted(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * The Prometheus rule file.
 *
 * Generated rather than hand-written so the thresholds in the YAML and the
 * thresholds the harness asserts cannot drift apart — the failure that makes
 * a monitoring repo worthless, because every rule still looks right.
 */
export function renderAlertRules(runbookBase: string = RUNBOOK_BASE_DEFAULT): string {
  const lines: string[] = [GENERATED_HEADER, "", "groups:", `  - name: ${ALERT_GROUP}`, `    interval: ${ALERT_EVAL_INTERVAL}`, "    rules:"];
  for (const alert of ALERTS) {
    lines.push(
      `      - alert: ${alert.name}`,
      `        expr: ${quoted(alert.expr)}`,
      `        for: ${alert.pending}`,
      "        labels:",
      `          severity: ${alert.severity}`,
      `          spec: ${quoted(alert.spec)}`,
      "        annotations:",
      `          summary: ${quoted(alert.summary)}`,
      `          description: ${quoted(alert.description)}`,
      `          runbook_url: ${quoted(`${runbookBase}${runbookAnchor(alert)}`)}`,
    );
  }
  return `${lines.join("\n")}\n`;
}
