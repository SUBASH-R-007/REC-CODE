/**
 * Write a LOCAL Prometheus configuration that loads the real alert rules
 * (Phase 16v, `docs/ROADMAP.md` §1.4).
 *
 * §1.4: *"`promtool test rules` passes in CI, but **Prometheus has never
 * evaluated these rules against a live series**."* And
 * `scripts/ops/fire-alerts.ts` says the same thing from the other side:
 * *"`reduce` mirrors each PromQL expression; it does not evaluate it.
 * Nothing on this machine can."* That was true while there was no
 * Prometheus on this machine.
 *
 * This generates the one file that cannot live in the repository, because
 * it carries a bearer token: a scrape config pointed at the development
 * stack over plain HTTP, with `rule_files` pointing at
 * `infra/monitoring/alerts.yml` **unmodified** — the real rules, the real
 * expressions, the real `for:` durations. The generated file goes to the
 * scratchpad, never into the checkout.
 *
 *   node scripts/dev/prom-local.mjs --out <dir>
 *
 * Then, from that directory:
 *
 *   docker run --rm -p 9090:9090 \
 *     -v "<dir>/prometheus.local.yml:/etc/prometheus/prometheus.yml:ro" \
 *     -v "<repo>/infra/monitoring/alerts.yml:/etc/prometheus/alerts.yml:ro" \
 *     prom/prometheus:v2.55.1 --config.file=/etc/prometheus/prometheus.yml
 *
 * and read `http://localhost:9090/api/v1/rules`, where each rule's `state`
 * is `inactive`, `pending` or `firing` — evaluated by Prometheus itself.
 *
 * **On the token.** It is read from `apps/web/.env.local` and written only
 * into the generated file, which is outside the repository. It is never
 * printed: the script reports the token's LENGTH so an operator can see it
 * was found without seeing it.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const REPO = path.resolve(import.meta.dirname, "..", "..");

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

/** Prometheus reads YAML paths with forward slashes on every platform. */
const toPosix = (p) => p.split(path.sep).join("/");

const outDir = path.resolve(arg("out", path.join(tmpdir(), "recx-prom")));
if (outDir === REPO || outDir.startsWith(REPO + path.sep)) {
  console.error(`--out must be outside the repository (${REPO}): the generated file carries a bearer token`);
  process.exit(64);
}

/** A minimal KEY=value reader; only the key asked for, never printed. */
function readEnv(file, key) {
  if (!existsSync(file)) return undefined;
  for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const at = line.indexOf("=");
    if (at <= 0) continue;
    if (line.slice(0, at).trim() !== key) continue;
    let value = line.slice(at + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    return value;
  }
  return undefined;
}

const envFile = path.join(REPO, "apps", "web", ".env.local");
const token = readEnv(envFile, "METRICS_TOKEN");
if (!token) {
  console.error(`METRICS_TOKEN is not set in ${envFile}. /api/metrics is behind a bearer token.`);
  process.exit(78);
}

const rulesPath = path.join(REPO, "infra", "monitoring", "alerts.yml");
if (!existsSync(rulesPath)) {
  console.error(`${rulesPath} is missing: there would be nothing to evaluate.`);
  process.exit(78);
}

/**
 * The scrape and evaluation intervals are the REAL ones (30 s), because the
 * rules' `for:` durations are multiples of them — shortening either here
 * would be evaluating different rules than the ones CI checks.
 *
 * TWO jobs, and which metric lives where matters:
 *
 *   * the WEB app publishes `judge_verdict_total` and
 *     `auth_login_failures_total` behind a bearer token, because it is the
 *     one process with a public listener;
 *   * the SCHEDULER publishes `judge_queue_depth`,
 *     `judge_oldest_job_age_seconds` and
 *     `judge_worker_heartbeat_age_seconds`, because it is the one process
 *     with exactly one instance — a gauge read from either of two web
 *     replicas would be the same Redis number reported twice. It needs
 *     `METRICS_PORT` set; it is 0 (off) by default.
 *
 * `--host` is the address Prometheus reaches them on, and the default is
 * loopback because the stack binds loopback. Running Prometheus NATIVELY
 * beside the stack is therefore the simple path; a container needs an
 * address the container can route to, which on a WSL2 stack is not
 * `host.docker.internal`.
 *
 * Four of the nine rules read exporters that are not on a development
 * machine at all (node_exporter, postgres_exporter). Those stay `inactive`,
 * and saying which ones is part of the result rather than a gap in it.
 */
const host = arg("host", "127.0.0.1");
const webPort = arg("web-port", "3000");
const schedulerPort = arg("scheduler-port", "9101");

const config = `# GENERATED by scripts/dev/prom-local.mjs — do not commit.
# It carries a bearer token and points at a development stack.
global:
  scrape_interval: 30s
  scrape_timeout: 10s
  evaluation_interval: 30s
  external_labels:
    platform: recx
    environment: development-laptop

rule_files:
  - ${JSON.stringify(arg("rules-path", toPosix(rulesPath)))}

scrape_configs:
  - job_name: recx-web
    metrics_path: /api/metrics
    scheme: http
    authorization:
      type: Bearer
      credentials: ${JSON.stringify(token)}
    static_configs:
      - targets: ["${host}:${webPort}"]
        labels:
          host: app

  - job_name: recx-scheduler
    scheme: http
    static_configs:
      - targets: ["${host}:${schedulerPort}"]
        labels:
          host: app
`;

mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, "prometheus.local.yml");
writeFileSync(outFile, config, "utf8");

console.log(`[prom-local] wrote ${outFile}`);
console.log(`[prom-local] METRICS_TOKEN found (${token.length} characters; not printed)`);
console.log(`[prom-local] rules: ${rulesPath}`);
console.log("");
console.log("Run Prometheus beside the stack (it binds loopback, so native is simplest):");
console.log(`  prometheus --config.file=${toPosix(outFile)} --web.listen-address=127.0.0.1:9090`);
console.log("");
console.log("Then read the rules Prometheus itself evaluated:");
// The jq filter interpolates, so its backslashes are escaped twice: once
// for this string and once for jq. Printed wrong, it silently reports
// "() ()" for every rule, which looks like Prometheus having no rules.
console.log(
  "  curl -s http://127.0.0.1:9090/api/v1/rules | jq -r '.data.groups[].rules[] | \"\\(.name) \\(.state)\"'",
);
console.log("");
console.log("The scheduler needs METRICS_PORT set (it is 0 by default), or");
console.log("judge_queue_depth has no publisher and five of the nine rules stay inactive.");
