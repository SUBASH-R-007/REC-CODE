import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ALERTS, isKnownMetric, labelNamesIn, metricNamesIn, renderAlertRules, runbookAnchor } from "../src/alerts";
import { FORBIDDEN_METRIC_LABELS } from "../src/metrics";

/**
 * The committed monitoring files, against the rules they are supposed to
 * carry (Phase 10b).
 *
 * In `packages/shared/test` rather than `tests/repo` for a plain reason: the
 * repository-wide fences run from the root, which has no dependency on
 * `@recx/shared`, and these assertions need the rule list itself. The
 * generator lives here, so the drift check does too.
 *
 * What it is for: `infra/monitoring/alerts.yml` is generated, and a
 * generated file that somebody edits by hand is worse than a hand-written
 * one — it looks authoritative and is ignored by the code. So the file is
 * compared with the render, and `RECX_UPDATE_DOCS=1` rewrites it.
 */

const repo = (rel: string) => fileURLToPath(new URL(`../../../${rel}`, import.meta.url));

const ALERTS_FILE = repo("infra/monitoring/alerts.yml");
const PROMETHEUS_FILE = repo("infra/monitoring/prometheus.yml");
const DASHBOARDS = ["infra/monitoring/grafana/judge-pipeline.json", "infra/monitoring/grafana/student-experience.json"];
const RUNBOOK = repo("docs/RUNBOOK.md");
const CI_WORKFLOW = repo(".github/workflows/ci.yml");

const read = (file: string) => readFileSync(file, "utf8").replace(/\r\n/g, "\n");

describe("infra/monitoring/alerts.yml", () => {
  it("is exactly what the rule list renders (RECX_UPDATE_DOCS=1 rewrites it)", () => {
    const expected = renderAlertRules();
    const actual = existsSync(ALERTS_FILE) ? read(ALERTS_FILE) : null;
    if (actual !== expected && process.env.RECX_UPDATE_DOCS === "1") {
      writeFileSync(ALERTS_FILE, expected, "utf8");
      return;
    }
    expect(actual, "infra/monitoring/alerts.yml is stale: run with RECX_UPDATE_DOCS=1").toBe(expected);
  });

  it("carries all eight rules, each with a for and a severity", () => {
    const yaml = read(ALERTS_FILE);
    expect(yaml.match(/^ {6}- alert: /gm) ?? []).toHaveLength(ALERTS.length);
    for (const alert of ALERTS) {
      expect(yaml, alert.name).toContain(`- alert: ${alert.name}`);
      expect(yaml, alert.name).toContain(`for: ${alert.pending}`);
    }
  });
});

describe("infra/monitoring/prometheus.yml", () => {
  const config = read(PROMETHEUS_FILE);

  it("loads the rule file next to it", () => {
    // A rules file nobody loads is the quietest way to have no alerting at
    // all: every rule still reviews fine.
    expect(config).toMatch(/^rule_files:\n(?:\s*#.*\n)*\s+- alerts\.yml$/m);
  });

  it("scrapes every process that publishes a metric, and the two exporters", () => {
    for (const job of ["recx-web", "recx-scheduler", "recx-judge", "node", "postgres"]) {
      expect(config, job).toContain(`job_name: ${job}`);
    }
  });

  it("reads the web token from a file and never carries a secret itself", () => {
    /**
     * `/metrics` on web is behind a bearer token because web is the one host
     * with a public listener. The token is a Docker secret on the monitoring
     * host; an inline `credentials:` here would put it in git, which
     * tests/repo already refuses for `.env` and would be no better in YAML.
     */
    expect(config).toContain("credentials_file: /run/secrets/recx_metrics_token");
    expect(config, "no inline bearer token").not.toMatch(/^\s+credentials:\s*\S/m);
    expect(config).toContain("metrics_path: /api/metrics");
  });

  it("evaluates rules no faster than it scrapes", () => {
    // A `for:` shorter than the scrape interval fires on a single sample,
    // which is the thing every `for:` in alerts.yml exists to prevent.
    const scrape = /scrape_interval:\s*(\d+)s/.exec(config)?.[1];
    const evaluate = /evaluation_interval:\s*(\d+)s/.exec(config)?.[1];
    expect(scrape).toBeDefined();
    expect(evaluate).toBe(scrape);
    const seconds = Number(scrape);
    for (const alert of ALERTS) {
      const pending = /^(\d+)([smh])$/.exec(alert.pending)!;
      const multiplier = pending[2] === "s" ? 1 : pending[2] === "m" ? 60 : 3600;
      expect(Number(pending[1]) * multiplier, `${alert.name} is shorter than one scrape`).toBeGreaterThanOrEqual(seconds);
    }
  });
});

describe("the Grafana dashboards", () => {
  interface Panel {
    title?: string;
    description?: string;
    targets?: Array<{ expr?: string }>;
    fieldConfig?: { defaults?: { thresholds?: { steps?: Array<{ value?: number | null }> } } };
  }
  interface Dashboard {
    uid?: string;
    title?: string;
    panels?: Panel[];
    templating?: { list?: Array<{ name?: string; type?: string }> };
  }

  const dashboards = DASHBOARDS.map((rel) => ({ rel, json: JSON.parse(read(repo(rel))) as Dashboard }));

  it("are valid dashboards with a uid and a title", () => {
    for (const { rel, json } of dashboards) {
      expect(json.uid, rel).toMatch(/^recx-/);
      expect(json.title, rel).toContain("REC Code");
      expect(json.panels?.length, rel).toBeGreaterThan(3);
    }
    expect(new Set(dashboards.map((d) => d.json.uid)).size, "uids are unique").toBe(dashboards.length);
  });

  it("take the datasource as a variable, so they import without editing", () => {
    for (const { rel, json } of dashboards) {
      const variable = json.templating?.list?.find((v) => v.type === "datasource");
      expect(variable?.name, rel).toBe("datasource");
    }
  });

  it("plot only metrics that exist", () => {
    /**
     * The failure this catches is the one nobody notices: a panel whose
     * expression names a metric that was renamed, or never existed, renders
     * as an empty graph. An empty graph during an incident reads as "nothing
     * is happening".
     */
    let plotted = 0;
    for (const { rel, json } of dashboards) {
      for (const panel of json.panels ?? []) {
        for (const target of panel.targets ?? []) {
          if (!target.expr) continue;
          plotted++;
          for (const name of metricNamesIn(target.expr)) {
            expect(isKnownMetric(name), `${rel} / ${panel.title}: ${name}`).toBe(true);
          }
        }
      }
    }
    expect(plotted, "the dashboards plot something").toBeGreaterThan(10);
  });

  it("draws a threshold line at the rule's own number, where a panel names a rule", () => {
    /**
     * A panel that names an alert and draws its line at a different number
     * is the quietest kind of wrong: the graph says the platform is fine up
     * to 180 while the rule pages at 200, and both were reviewed. Only
     * panels that mention a rule are checked — two of the eight read
     * exporters and have no panel here.
     */
    let checked = 0;
    for (const { rel, json } of dashboards) {
      for (const panel of json.panels ?? []) {
        const named = ALERTS.filter((alert) => (panel.description ?? "").includes(alert.name));
        for (const alert of named) {
          const steps = panel.fieldConfig?.defaults?.thresholds?.steps ?? [];
          const values = steps.map((step) => step.value).filter((value): value is number => typeof value === "number");
          expect(values, `${rel} / ${panel.title} names ${alert.name}`).toContain(alert.threshold);
          checked++;
        }
      }
    }
    expect(checked, "no panel names a rule, so this fence checked nothing").toBeGreaterThanOrEqual(5);
  });

  it("group by no label that could identify a person", () => {
    // The same rule as the registry fence, one layer out: a dashboard is
    // where somebody would reach for `by (userId)` to answer a support
    // question, and the metric does not carry it — but the panel would be
    // committed and reviewed as if it did.
    for (const { rel, json } of dashboards) {
      for (const panel of json.panels ?? []) {
        for (const target of panel.targets ?? []) {
          for (const label of labelNamesIn(target.expr ?? "")) {
            expect(FORBIDDEN_METRIC_LABELS, `${rel} / ${panel.title}: by (${label})`).not.toContain(label);
          }
        }
      }
    }
  });
});

describe("every alert says what to do", () => {
  const runbook = read(RUNBOOK);

  it("has a docs/RUNBOOK.md heading named after each rule", () => {
    for (const alert of ALERTS) {
      expect(runbook, `${alert.name} has no runbook section`).toContain(`#### ${alert.name}`);
      // The anchor the rule's runbook_url points at is this heading,
      // lowercased — GitHub's rule, and the reason the names are PascalCase
      // with no spaces.
      expect(runbookAnchor(alert)).toBe(`#${alert.name.toLowerCase()}`);
    }
  });

  it("gives each section the threshold and something to look at", () => {
    for (const alert of ALERTS) {
      const start = runbook.indexOf(`#### ${alert.name}`);
      const next = runbook.indexOf("\n#### ", start + 1);
      const section = runbook.slice(start, next === -1 ? undefined : next);
      expect(section.length, `${alert.name}: the section is a heading and little else`).toBeGreaterThan(400);
      expect(section, `${alert.name}: the section never mentions the threshold`).toContain(String(alert.threshold));
    }
  });
});

describe("CI checks the rules Prometheus will load", () => {
  it("runs promtool against both files", () => {
    /**
     * The one thing that cannot be checked here: whether the PromQL parses.
     * `reduce` in alerts.ts mirrors each expression and the harness asserts
     * the number crosses, but neither is a PromQL engine, and Prometheus
     * cannot be installed on this machine without root. So promtool runs in
     * CI, and this test fails if somebody removes it.
     */
    const workflow = read(CI_WORKFLOW);
    expect(workflow).toContain("promtool check config infra/monitoring/prometheus.yml");
    expect(workflow).toContain("promtool check rules infra/monitoring/alerts.yml");
  });
});
