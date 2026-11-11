import { describe, expect, it } from "vitest";
import {
  ALERTS,
  ALERT_SEVERITIES,
  EXPORTER_METRICS,
  RUNBOOK_BASE_DEFAULT,
  alertByName,
  isKnownMetric,
  labelNamesIn,
  metricNamesIn,
  parseSamples,
  quantileFromBuckets,
  renderAlertRules,
  runbookAnchor,
  type AlertReading,
} from "../src/alerts";
import { METRICS, metricByName } from "../src/metrics";

/**
 * The alert rules (Phase 10b).
 *
 * The test that matters here is the two-sided one at the bottom: for every
 * rule, a reading just BELOW its threshold must not cross it and a reading
 * just ABOVE must. A one-sided assertion passes on a rule that fires
 * constantly, which is worse than no rule — it is a rule somebody will
 * silence, and then the real one is silent too.
 *
 * Everything else here exists to stop a rule becoming a comment: an
 * expression against a metric nobody publishes, a threshold in the YAML that
 * disagrees with the number the harness asserts, a `runbook_url` pointing at
 * a heading that was never written.
 */

/** The eight phrases SPEC §10 uses, verbatim. */
const SPEC_EIGHT = [
  "queue depth >200 for 2 min",
  "oldest job >60s",
  "worker heartbeat >90s",
  "INTERNAL_ERROR rate >2% over 5 min",
  "disk >80%",
  "DB connections >80%",
  "failed logins >100/min",
  "e2e p95 >30s",
];

/**
 * Rules this repository added because the thing they watch did not exist
 * when SPEC's eight were written. Each still names the SPEC phrase it
 * extends, so the list above stays the list above.
 */
const BEYOND_SPEC = ["queue depth >200 for 2 min (the per-engine half of it, Phase 12k)"];

describe("the rules are SPEC's rules", () => {
  it("implements each of the eight, once, and says which rules go beyond them", () => {
    const spec = ALERTS.map((a) => a.spec).filter((phrase) => !BEYOND_SPEC.includes(phrase));
    expect(spec).toEqual(SPEC_EIGHT);
    expect(ALERTS.map((a) => a.spec).filter((phrase) => BEYOND_SPEC.includes(phrase))).toEqual(BEYOND_SPEC);
    expect(new Set(ALERTS.map((a) => a.name)).size, "names are unique").toBe(ALERTS.length);
  });

  it("writes the threshold into the expression it is asserted against", () => {
    /**
     * The drift that makes a monitoring repo worthless: the YAML says 200
     * and the harness asserts 20, and every rule still looks right. The
     * number in `threshold` has to appear in the expression text.
     */
    for (const alert of ALERTS) {
      expect(alert.expr, alert.name).toContain(String(alert.threshold));
    }
  });

  it("gives every rule a `for`, a severity and words somebody can act on", () => {
    for (const alert of ALERTS) {
      expect(alert.pending, alert.name).toMatch(/^\d+[smh]$/);
      expect(ALERT_SEVERITIES, alert.name).toContain(alert.severity);
      expect(alert.summary.length, alert.name).toBeGreaterThan(20);
      // The description is the first thing read at 10:40 in the morning: it
      // has to say what to look at next, which does not fit in a sentence.
      expect(alert.description.length, alert.name).toBeGreaterThan(120);
      expect(alert.how.length, alert.name).toBeGreaterThan(40);
    }
  });

  it("points every rule at a runbook heading named after it", () => {
    for (const alert of ALERTS) {
      expect(runbookAnchor(alert)).toBe(`#${alert.name.toLowerCase()}`);
      // Digits are allowed (P95); nothing else, so the lowercased name is a
      // valid GitHub anchor without any further mangling.
      expect(alert.name, "PascalCase, so the anchor is predictable").toMatch(/^[A-Z][A-Za-z0-9]+$/);
    }
  });

  it("says, for each rule, whether the condition can be produced here", () => {
    const live = ALERTS.filter((a) => a.produced === "live").map((a) => a.name);
    const synthetic = ALERTS.filter((a) => a.produced === "synthetic").map((a) => a.name);
    /**
     * Four and four, and the four are not a shortcut. Two need an exporter
     * that cannot be installed without root on this machine, one needs a
     * deliberately broken checker running through the whole pipeline, and
     * one needs the judge to be slow on purpose. The alternative to saying
     * so is a table of eight PASSes, two of which would be untrue.
     */
    expect(live).toEqual([
      "JudgeQueueBacklog",
      // Phase 12k: 120 jobs onto the SQL practice queue, which this machine
      // can do for real because nothing here consumes that queue either.
      "JudgeEngineBacklog",
      "JudgeOldestJobStale",
      "JudgeWorkerHeartbeatStale",
      "FailedLoginBurst",
    ]);
    expect(synthetic).toEqual([
      "JudgeInternalErrorRate",
      "HostDiskNearlyFull",
      "PostgresConnectionsHigh",
      "SubmissionLatencyP95High",
    ]);
  });

  it("finds each rule by name", () => {
    expect(alertByName("JudgeQueueBacklog")?.threshold).toBe(200);
    expect(alertByName("NoSuchAlert")).toBeUndefined();
  });
});

describe("every expression reads a metric that exists", () => {
  it("names only contract metrics and declared exporter metrics", () => {
    for (const alert of ALERTS) {
      for (const name of metricNamesIn(alert.expr)) {
        expect(isKnownMetric(name), `${alert.name}: ${name}`).toBe(true);
      }
    }
  });

  it("would catch a typo in a metric name", () => {
    // The failure this test exists for: an exporter's metric renamed
    // upstream, or ours misspelled. Either way the rule never fires and
    // nothing says so.
    expect(isKnownMetric("judge_queue_dept")).toBe(false);
    expect(isKnownMetric("node_filesystem_available_bytes")).toBe(false);
    expect(metricNamesIn("max by (queue) (judge_queue_dept) > 200")).toEqual(["judge_queue_dept"]);
  });

  it("reads a histogram through its generated series", () => {
    expect(isKnownMetric("submission_e2e_latency_seconds_bucket")).toBe(true);
    expect(isKnownMetric("submission_e2e_latency_seconds_count")).toBe(true);
    // Only for a metric that really is a histogram.
    expect(isKnownMetric("judge_queue_depth_bucket")).toBe(false);
    expect(metricByName("submission_e2e_latency_seconds")?.type).toBe("histogram");
  });

  it("strips PromQL's own vocabulary, label matchers and ranges", () => {
    expect(metricNamesIn('sum(rate(judge_verdict_total{verdict="IE"}[5m])) > 0.02')).toEqual(["judge_verdict_total"]);
    expect(
      metricNamesIn('histogram_quantile(0.95, sum by (le) (rate(submission_e2e_latency_seconds_bucket[5m]))) > 30'),
    ).toEqual(["submission_e2e_latency_seconds_bucket"]);
    // `fstype` and `tmpfs` are inside a matcher; `instance` and `mountpoint`
    // are grouping labels. None of them is a metric.
    expect(metricNamesIn(alertByName("HostDiskNearlyFull")!.expr)).toEqual([
      "node_filesystem_avail_bytes",
      "node_filesystem_size_bytes",
    ]);
  });

  it("reads label names out of matchers and grouping clauses", () => {
    /**
     * The complement of the metric lexer, and the fence the dashboards need:
     * a substring search cannot be used to refuse `by (userId)`, because
     * `submission_e2e_latency_seconds` contains the word `submission`.
     */
    expect(labelNamesIn('sum by (verdict) (rate(judge_verdict_total{verdict="IE"}[5m]))')).toEqual(["verdict"]);
    expect(labelNamesIn(alertByName("HostDiskNearlyFull")!.expr)).toEqual(["fstype", "instance", "mountpoint"]);
    expect(labelNamesIn("histogram_quantile(0.95, sum by (le) (rate(submission_e2e_latency_seconds_bucket[5m])))")).toEqual(["le"]);
    expect(labelNamesIn("sum by (userId) (rate(proctor_event_total[5m]))"), "what the dashboard fence refuses").toEqual([
      "userId",
    ]);
    expect(labelNamesIn("sum(rate(auth_login_failures_total[1m])) * 60 > 100"), "no labels at all").toEqual([]);
  });

  it("declares exporter metrics with the exporter's own names", () => {
    for (const name of EXPORTER_METRICS) {
      expect(METRICS.map((m) => m.name), `${name} is not ours`).not.toContain(name);
      expect(name).toMatch(/^(node|pg)_/);
    }
  });
});

describe("parseSamples", () => {
  it("reads names, labels and values, and skips comments", () => {
    const samples = parseSamples(
      [
        "# HELP judge_queue_depth Jobs waiting in each judge lane.",
        "# TYPE judge_queue_depth gauge",
        'judge_queue_depth{queue="CONTEST"} 201',
        'judge_queue_depth{queue="PRACTICE"} 0',
        "sse_connections_active 3",
        "",
      ].join("\n"),
    );
    expect(samples).toEqual([
      { name: "judge_queue_depth", labels: { queue: "CONTEST" }, value: 201 },
      { name: "judge_queue_depth", labels: { queue: "PRACTICE" }, value: 0 },
      { name: "sse_connections_active", labels: {}, value: 3 },
    ]);
  });

  it("reads several labels, and the values Prometheus can print", () => {
    const samples = parseSamples(
      [
        'judge_verdict_total{verdict="AC",language="cpp"} 1200',
        'judge_run_duration_seconds_bucket{le="+Inf"} 44',
        "judge_oldest_job_age_seconds 2945.135",
        "broken_line_without_a_value",
      ].join("\n"),
    );
    expect(samples[0]?.labels).toEqual({ verdict: "AC", language: "cpp" });
    expect(samples[1]?.labels.le).toBe("+Inf");
    expect(samples[2]?.value).toBeCloseTo(2945.135, 3);
    expect(samples, "a line it cannot read is skipped, not guessed at").toHaveLength(3);
  });
});

describe("quantileFromBuckets", () => {
  it("interpolates inside the bucket the quantile falls in", () => {
    // 20 observations, 18 at or under 30s and 20 at or under 45s: the 19th
    // (0.95 × 20) is halfway through that bucket.
    const p95 = quantileFromBuckets(0.95, [
      { le: 30, count: 18 },
      { le: 45, count: 20 },
      { le: Number.POSITIVE_INFINITY, count: 20 },
    ]);
    expect(p95).toBeCloseTo(37.5, 6);
  });

  it("returns the last finite boundary when the quantile is in +Inf", () => {
    expect(
      quantileFromBuckets(0.95, [
        { le: 30, count: 1 },
        { le: Number.POSITIVE_INFINITY, count: 20 },
      ]),
    ).toBe(30);
  });

  it("is null when nothing was observed, rather than zero", () => {
    // Zero would read as "the p95 is excellent" on a histogram with no
    // samples at all, which is the state a just-restarted process is in.
    expect(quantileFromBuckets(0.95, [{ le: 30, count: 0 }])).toBeNull();
    expect(quantileFromBuckets(0.95, [])).toBeNull();
  });
});

// ── The two-sided test ──────────────────────────────────────────────────

const E2E_BUCKETS = metricByName("submission_e2e_latency_seconds")!.buckets!;

/** Cumulative bucket lines for a histogram, from counts per boundary. */
function buckets(name: string, cumulative: Readonly<Record<string, number>>): string {
  const lines = E2E_BUCKETS.map((le) => `${name}_bucket{le="${le}"} ${cumulative[String(le)] ?? 0}`);
  lines.push(`${name}_bucket{le="+Inf"} ${cumulative["+Inf"] ?? 0}`);
  return lines.join("\n");
}

const EMPTY_E2E = buckets("submission_e2e_latency_seconds", {});

/** A below-threshold and an above-threshold reading for one rule. */
interface Fixture {
  readonly below: AlertReading;
  readonly above: AlertReading;
}

const scrape = (before: string, after: string, elapsedSeconds = 60): AlertReading => ({
  before: parseSamples(before),
  after: parseSamples(after),
  elapsedSeconds,
});

const FIXTURES: Readonly<Record<string, Fixture>> = {
  JudgeQueueBacklog: {
    below: scrape("", 'judge_queue_depth{queue="CONTEST"} 200\njudge_queue_depth{queue="RUN"} 7'),
    above: scrape("", 'judge_queue_depth{queue="CONTEST"} 201\njudge_queue_depth{queue="RUN"} 7'),
  },
  JudgeEngineBacklog: {
    // The lane total is comfortably under JudgeQueueBacklog's 200 in both
    // readings: this rule exists for exactly that case.
    below: scrape(
      "",
      'judge_engine_queue_depth{queue="PRACTICE",engine="isolate"} 20\njudge_engine_queue_depth{queue="PRACTICE",engine="postgres"} 100',
    ),
    above: scrape(
      "",
      'judge_engine_queue_depth{queue="PRACTICE",engine="isolate"} 20\njudge_engine_queue_depth{queue="PRACTICE",engine="postgres"} 101',
    ),
  },
  JudgeOldestJobStale: {
    below: scrape("", 'judge_oldest_job_age_seconds{queue="PRACTICE"} 60'),
    above: scrape("", 'judge_oldest_job_age_seconds{queue="PRACTICE"} 60.5'),
  },
  JudgeWorkerHeartbeatStale: {
    below: scrape("", 'judge_worker_heartbeat_age_seconds{worker="judge-1"} 90'),
    above: scrape("", 'judge_worker_heartbeat_age_seconds{worker="judge-1"} 91'),
  },
  JudgeInternalErrorRate: {
    // 2 of 102 is 1.96%; 3 of 103 is 2.9%.
    below: scrape(
      'judge_verdict_total{verdict="AC",language="cpp"} 0\njudge_verdict_total{verdict="IE",language="cpp"} 0',
      'judge_verdict_total{verdict="AC",language="cpp"} 100\njudge_verdict_total{verdict="IE",language="cpp"} 2',
    ),
    above: scrape(
      'judge_verdict_total{verdict="AC",language="cpp"} 0\njudge_verdict_total{verdict="IE",language="cpp"} 0',
      'judge_verdict_total{verdict="AC",language="cpp"} 100\njudge_verdict_total{verdict="IE",language="cpp"} 3',
    ),
  },
  HostDiskNearlyFull: {
    below: scrape(
      "",
      'node_filesystem_size_bytes{instance="db:9100",mountpoint="/"} 100\nnode_filesystem_avail_bytes{instance="db:9100",mountpoint="/"} 20',
    ),
    above: scrape(
      "",
      'node_filesystem_size_bytes{instance="db:9100",mountpoint="/"} 100\nnode_filesystem_avail_bytes{instance="db:9100",mountpoint="/"} 19',
    ),
  },
  PostgresConnectionsHigh: {
    below: scrape(
      "",
      'pg_settings_max_connections 100\npg_stat_database_numbackends{datname="recx"} 60\npg_stat_database_numbackends{datname="postgres"} 20',
    ),
    above: scrape(
      "",
      'pg_settings_max_connections 100\npg_stat_database_numbackends{datname="recx"} 61\npg_stat_database_numbackends{datname="postgres"} 20',
    ),
  },
  FailedLoginBurst: {
    below: scrape(
      'auth_login_failures_total{reason="credentials"} 0',
      'auth_login_failures_total{reason="credentials"} 60\nauth_login_failures_total{reason="rate-limited"} 40',
    ),
    above: scrape(
      'auth_login_failures_total{reason="credentials"} 0',
      'auth_login_failures_total{reason="credentials"} 60\nauth_login_failures_total{reason="rate-limited"} 41',
    ),
  },
  SubmissionLatencyP95High: {
    // 20 verdicts: with 19 of them at or under 20s the p95 is 20s; with two
    // over 30s it is 37.5s.
    below: scrape(EMPTY_E2E, buckets("submission_e2e_latency_seconds", { "20": 19, "30": 20, "45": 20, "60": 20, "+Inf": 20 })),
    above: scrape(EMPTY_E2E, buckets("submission_e2e_latency_seconds", { "20": 18, "30": 18, "45": 20, "60": 20, "+Inf": 20 })),
  },
};

describe("each rule fires above its threshold and stays quiet below it", () => {
  it("has a fixture for every rule, so none is silently unchecked", () => {
    expect(Object.keys(FIXTURES).sort()).toEqual(ALERTS.map((a) => a.name).sort());
  });

  for (const alert of ALERTS) {
    it(`${alert.name}: ${alert.spec}`, () => {
      const fixture = FIXTURES[alert.name]!;
      const below = alert.reduce(fixture.below);
      const above = alert.reduce(fixture.above);
      expect(below, "the below-threshold reading produced no number").not.toBeNull();
      expect(above, "the above-threshold reading produced no number").not.toBeNull();
      expect(below! > alert.threshold, `${alert.name} fired at ${below}, threshold ${alert.threshold}`).toBe(false);
      expect(above! > alert.threshold, `${alert.name} stayed quiet at ${above}, threshold ${alert.threshold}`).toBe(true);
    });
  }

  it("reports a metric that is not published as null, not as zero", () => {
    /**
     * The distinction the harness reports differently: "the number is below
     * the threshold" is a working alert, and "the metric is absent" is a
     * broken pipeline. A reducer that returned 0 for an absent metric would
     * make every rule look healthy on a stack where nothing is publishing.
     */
    const nothing = scrape("", "");
    for (const alert of ALERTS) {
      expect(alert.reduce(nothing), alert.name).toBeNull();
    }
  });

  it("treats a counter reset as a reset rather than a negative rate", () => {
    const alert = alertByName("FailedLoginBurst")!;
    // The process restarted between scrapes: 900 before, 101 after.
    const reading = scrape(
      'auth_login_failures_total{reason="credentials"} 900',
      'auth_login_failures_total{reason="credentials"} 101',
      60,
    );
    expect(alert.reduce(reading)).toBeCloseTo(101, 6);
  });
});

describe("the generated rule file", () => {
  const yaml = renderAlertRules();

  it("renders every rule with its for, severity and runbook link", () => {
    for (const alert of ALERTS) {
      expect(yaml).toContain(`- alert: ${alert.name}`);
      expect(yaml).toContain(`expr: '${alert.expr}'`);
      expect(yaml).toContain(`for: ${alert.pending}`);
      expect(yaml).toContain(`severity: ${alert.severity}`);
      expect(yaml).toContain(`runbook_url: '${RUNBOOK_BASE_DEFAULT}${runbookAnchor(alert)}'`);
    }
  });

  it("says it is generated, and how to regenerate it", () => {
    expect(yaml.startsWith("# GENERATED FILE")).toBe(true);
    expect(yaml).toContain("RECX_UPDATE_DOCS=1");
    expect(yaml.endsWith("\n")).toBe(true);
  });

  it("takes a runbook base, because the link is for whoever holds the pager", () => {
    const custom = renderAlertRules("https://ops.example/runbook");
    expect(custom).toContain("runbook_url: 'https://ops.example/runbook#judgequeuebacklog'");
    expect(custom).not.toContain(RUNBOOK_BASE_DEFAULT);
  });

  it("quotes every expression, so PromQL cannot be read as YAML", () => {
    // `{`, `}` and `>` all mean something in YAML. An unquoted expression
    // parses as a flow mapping or fails the file, and either way the rules
    // do not load.
    for (const line of yaml.split("\n").filter((l) => l.trim().startsWith("expr:"))) {
      expect(line, line).toMatch(/^\s+expr: '.*'$/);
    }
  });
});
