# Phase 10 design: ops, observability, performance, hardening

Coordinator working notes. Delete `docs/handoff/phase10/` once Phase 10 is
gated.

Source of truth: `docs/handoff/SPEC.md` §5 "Phase 10 — Ops, observability,
performance, hardening", bound by §0 (ground rules), §4 (data model and the
retention rules) and §7 (anti-requirements).

Phase 10 is the phase most likely to be *rebuilt* rather than built: six of
the ten things its spec section names are already in the repository, shipped
by Phases 1–5 as part of their own gates. §0 below is therefore the most
important section in this document. Everything listed there is finished; a
slice that re-derives it has spent itself on nothing.

The shape of the phase is: **the measurement harnesses exist, the
measurements are recorded, and almost nothing is wired to an operator.**
There is no `/api/health`, no Prometheus metric, no alert rule, no backup
script, no Dockerfile, no Caddyfile and no restore drill. That is the work.

---

## 0. What is already built

### Front-end budgets and the reference device

- **`pnpm size` is the size-limit gate.** `apps/web/scripts/size-budget.mjs`
  against `apps/web/size-budgets.json`, run as its own CI step in
  `.github/workflows/ci.yml` (job `verify`, step "Front-end size budgets").
  It measures per-route first-load JS, the Monaco and CodeMirror lazy sets,
  the Monaco-free route list and `/login` served with zero JavaScript, with
  self-checks so the detectors cannot go blind. Measurements are recorded in
  `docs/CAPACITY.md` §7.1. **Phase 10 adds budgets; it does not build a
  budget tool.**
- **The axe gate exists.** `apps/web/e2e/a11y.spec.ts` (Playwright project
  `a11y`, `@axe-core/playwright`), zero serious or critical violations,
  light and dark theme × 1366×768 and 375×812, over 30-plus routes
  including every `/admin` and `/super` page. It runs in CI
  (`.github/workflows/ci.yml`, job `e2e`). Phase 10 adds rows for its one
  new page.
- **The keyboard journey exists** and runs in CI:
  `apps/web/e2e/keyboard-journey.spec.ts` (project `keyboard`).
- **The reference device is already encoded as a test profile.**
  `apps/web/e2e/perf-workspace.spec.ts` (project `perf`) drives Chrome at
  1366×768 with CPU throttled 4× and the network at 3 Mbps down / 1 Mbps up
  / 150 ms RTT over CDP, and enforces `textareaTypableMs: 2_500`,
  `monacoColdMs: 7_000`, `monacoWarmMs: 4_000`, `cls: 0.05` against a
  production build (`E2E_PERF_ENFORCE=1`), writing JSON with `E2E_PERF_OUT`.
  Results are in `docs/CAPACITY.md` §7.2. **Missing: LCP, INP, TBT and TTFB
  budgets, the statement's separate 2.5 s LCP allowance, and the project is
  not in CI.** Phase 10 closes exactly those gaps.

### Security posture

- **CSP with per-request nonces and `strict-dynamic`, and no
  `'unsafe-inline'` in `script-src`** — `apps/web/src/middleware.ts`, unit
  tested in `apps/web/test/csp.test.ts` (the one inline script, the theme
  script, is allow-listed by content hash and the test recomputes it).
  Documented in `docs/SECURITY.md` §5.
- **The `style-src 'unsafe-inline'` trade-off is already taken, tested and
  written down** — `docs/SECURITY.md` §5 (with the reasoning: once
  `style-src` carries a nonce the browser ignores `'unsafe-inline'`, and
  every React `style` attribute and Monaco's runtime stylesheet is then
  blocked) and §12 as an accepted Low finding with its revisit condition.
  The spec's instruction is "do not spend a week on this". **Phase 10 spends
  zero days on it.** See decision 9.
- Other headers from `apps/web/next.config.ts`: `nosniff`,
  `X-Frame-Options: DENY`, `Referrer-Policy`, `Permissions-Policy` with
  camera, microphone, geolocation and display-capture all empty,
  `X-Powered-By` off.
- **Argon2id** (`@node-rs/argon2`) and **server-side session rows** — the
  `Session` model (`packages/db/prisma/schema.prisma:410`),
  `docs/SECURITY.md` §2–§3. Force-logout mid-assessment already works
  because sessions are rows.
- **The Redis sliding-window rate limiter is built**, including the atomic
  Lua script that decides on Redis's own clock —
  `apps/web/src/lib/rate-limit.ts` (`SLIDING_WINDOW_SCRIPT`,
  `LOGIN_RATE_LIMITS` = 5/15 min per account and 20/15 min per hashed IP,
  fail-open with a logged warning). **Phase 10 adds rule sets and call
  sites, not a limiter.**
- **`hashIp()`** — `apps/web/src/lib/ip.ts`, sha256(ip + pepper), with
  `requestIp()` reading forwarding headers only under `TRUST_PROXY=true`.
  A raw IP is stored nowhere, and Phase 10 adds nothing that would.
- **Server-side sanitisation** of problem statements —
  `packages/shared/src/sanitize.ts`, `apps/web/src/lib/markdown.ts`.
- **Supply chain partly in place**: `pnpm install --frozen-lockfile` in CI,
  `engine-strict` on Node 22, isolate pinned by tag *and* commit, toolchains
  by GPG signature *and* sha256, Monaco `0.52.2` self-hosted, Prisma
  `6.16.2` exact (`docs/SECURITY.md` §10).
- **The judge is already credential-free and dependency-light** —
  `tests/repo/judge-isolation.test.ts` forbids `@recx/db`,
  `@prisma/client` and `DATABASE_URL` in `apps/judge-worker`.
- **The audit hash chain and its verifier exist** —
  `apps/web/src/lib/audit-chain.ts`,
  `apps/web/src/server/queries/super-audit.ts` (`terminalHashOf`, line 78),
  `apps/web/src/server/actions/super-audit.ts`, surfaced on
  `/super/audit`. The chain is tamper-evident. **Missing: the off-box
  export of each day's terminal hash** (`docs/SECURITY.md` §11 and the
  Medium accepted finding in §12).
- **`docs/SECURITY.md` §11 "Planned (Phase 10)" is the authoritative to-do
  list** for the security half of this phase: OIDC, sops+age, rate limits
  everywhere, Dependabot, the terminal-hash export, Redis ACLs for judge
  nodes. Phase 10 empties that table and deletes it.

### Operations already shipped

- **Postgres is truth, Redis is transport, and the reconciler already does
  the hard part.** `apps/scheduler/src/reconciler.ts` holds one advisory
  lock (`LOCK_NAMESPACE`/`RECONCILER_LOCK`) and every tick: marks nodes
  OFFLINE past their heartbeat, reclaims expired leases, re-enqueues
  `QUEUED` rows with no live job, withdraws lanes from nodes with a stale
  self-check, finalises exhausted attempts as `INTERNAL_ERROR`, expires
  `RunRequest` rows, and runs the retention purge — all reported into
  `SchedulerJobStatus` (`packages/db/prisma/schema.prisma:1508`) and
  suspended by `PlatformSetting` key `retention` `{ legalHold: true }`.
  **The two manual checks in Phase 10's "Done when" (pull the plug on a
  judge host; restart Redis) test this existing code.** Phase 10 performs
  and records them; it does not write the mechanism.
- **Judge node heartbeat, `DRAINING`/`QUARANTINED`, calibration and the
  self-check suite** — `apps/judge-worker/src/heartbeat.ts`,
  `selfcheck/`, `JudgeNode` (`schema.prisma:1302`), `/admin/judge`
  (`docs/RUNBOOK.md` §2.2, §2.8).
- **Judge hosts are already cattle** — `infra/judge/cloud-init.yaml`,
  `install-isolate.sh`, `verify-host.sh`, `nftables.conf`,
  `sysctl/99-recjudge.conf`, `systemd/recjudge-worker.service`,
  `toolchains/*` (`docs/RUNBOOK.md` §2.3, §2.6). The weekly rebuild is a
  runbook procedure over existing scripts.
- **`pino` is already the logger in all three processes** (`apps/web`,
  `apps/judge-worker/src/logger.ts`, `apps/scheduler`) and already emits
  JSON. Phase 10 adds a redaction list and a Loki shipper, not a logger.
- **`compose.yaml`** runs development Postgres 17, Redis 7 **with AOF
  `everysec`** and MinIO with its bucket, all health-checked.
- **CI has three jobs** (`.github/workflows/ci.yml`): `verify` (lint,
  typecheck, test, build on ubuntu-24.04 **and** windows-latest, with
  migrations applied from scratch, `pnpm size`, and the burst harness),
  `e2e` (axe + keyboard + rbac + judge against a seeded stack) and
  `judge-integration` (real isolate 2.7 and every pinned toolchain, with
  two caches). **Missing from CI: the drift check, Lighthouse CI, the
  `perf` project, `pnpm audit`.**
- **`ProctorEvent` is already partitioned monthly** with partitions created
  through 2027-09 plus `proctor_event_default` —
  `packages/db/prisma/migrations/20261019160000_phase6b_attempt_engine/migration.sql`.
  Phase 10 adds the *maintenance* job (create ahead, detach past the
  boundary, alert on a non-empty default), not the partitioning.
- **Retention has a working skeleton**: `RETENTION_RULES` and the batched
  purge in `apps/scheduler/src/reconciler.ts` (today: `SubmissionTestDetail`
  at `LIMITS.detail.retentionDays` = 30), `classifyRetentionAge` in
  `apps/scheduler/src/classify.ts`, `retentionSettingSchema`, and the
  `legalHold` suspension. Phase 10 extends the table; it does not invent the
  pattern.
- **The capacity model and the burst harness** — `docs/CAPACITY.md` §1–§6,
  `scripts/load/` (`burst.ts`, `burst-plan.ts`, typechecked and unit-tested
  in CI), measurements in `docs/capacity/*.json`.
- **`scripts/dev/linux-gate.sh`** runs the full Linux gate in the WSL2
  mirror (`docs/RUNBOOK.md` §1.4, §1.6).

### Caching and leaderboard reads

- **The `unstable_cache` + `revalidateTag` pattern is established** —
  `apps/web/src/lib/brand/theme.ts` (`PLATFORM_THEME_TAG`) and
  `apps/web/src/server/queries/judge-languages.ts`
  (`LANGUAGE_CONFIG_TAG`), both with the "never caches a throw" reasoning
  in comments. Phase 10 copies this for the `problems` tag.
- **The leaderboard is already XpBucket-only and already an index scan** —
  `apps/web/src/server/queries/leaderboard.ts`: top-N by
  `(period, periodKey, xp DESC, lastXpAt ASC)`, "my rank" as an index-only
  `count(*)`, neighbours by keyset, snapshots for closed weeks, with
  `tests/repo/xp-ledger.test.ts` forbidding any page from aggregating
  `XpEvent`. **Phase 10 does not add the Redis ZSET** — see open question 3.
- **The beacon-endpoint pattern `/api/vitals` copies** —
  `apps/web/src/app/api/activity/route.ts` (session cookie, `isSameOrigin`,
  a `MAX_BODY_BYTES` cap, `cache-control: no-store`, a 202 for a throttled
  ping that is not an error).

### Docs that exist and are extended, never rewritten

`docs/CAPACITY.md` (§7 front-end budgets), `docs/RUNBOOK.md` (§1 local
development, §2.1–§2.11 operations, §3 the dated gate log),
`docs/SECURITY.md` (§1–§12), `docs/ACCESSIBILITY.md` (§5 the two stated
exceptions — the workspace's two-dimensional layout under the SC 1.4.10
carve-out, and Monaco's Tab capture with the documented Esc / Ctrl+M escape
— and §6 how it is verified), `docs/ARCHITECTURE.md`, `docs/JUDGE.md`,
`docs/PROCTORING.md`, `docs/OPEN-QUESTIONS.md`. **`docs/ACCESSIBILITY.md`
has both stated exceptions already; what it lacks is the named human
contact.**

### Repeatedly re-proposed, already finished — outside Phase 10, listed so it is not touched

`Accommodation` in full with its state machine, SUPER_ADMIN approval, expiry
and audit (`schema.prisma:1627`, Phase 4); `ProctorEventKind` with its
complete kind list (`schema.prisma:265`, Phase 4);
`tests/repo/forbidden-words.test.ts`, `tests/repo/student-exposure.test.ts`,
`tests/repo/action-guards.test.ts`, `apps/web/test/capability-matrix.test.ts`
and the generated role × capability table in `docs/SECURITY.md` §4.

---

## 1. Key decisions

1. **The liveness probe never touches the database; the readiness probe
   does.** `GET /api/health` answers from process state alone — version,
   image digest, git sha, uptime. A liveness probe that reads Postgres turns
   a 10-second database blip into a rolling restart of every replica, which
   is the outage the probe was supposed to prevent. `GET /api/ready` is the
   one that reads: `SELECT 1`, Redis `PING`, and `_prisma_migrations` at
   head, with a 2-second budget each, returning 503 with a per-check body.
   Caddy gates the rolling restart on `/api/ready`; the load balancer
   watches `/api/health`.
2. **`activeContest` is behind the ops token, and the deploy gate is a pure
   function.** The spec's deploy job "queries `/api/health` for
   `activeContest`", so the field lives on `/api/health` — but a public
   endpoint that announces when the college is mid-exam is a reconnaissance
   gift, so the counts appear only when the request carries
   `x-recx-ops-token`. The decision itself is
   `deployDecision()` in `packages/shared/src/deploy-gate.ts`, so the CI
   deploy job, the shell script and the `DeployEvent` CHECK constraint
   cannot disagree about what "a contest is live" means.
3. **The ops token is an environment secret compared in constant time, not
   a database row.** Judge-node tokens are hashed rows because nodes are
   enrolled and rotated per host; the ops token authenticates `/api/health`,
   `/api/ready` and `/api/metrics`, which must keep answering *while the
   database is unavailable* — that is the whole point of them. It arrives
   via Docker secrets (sops+age at rest) and is validated by
   `requireOpsToken()` in `apps/web/src/lib/ops/token.ts`.
4. **Heartbeat age and queue depth are exported by the web and scheduler
   processes, not by the worker.** A dead worker exports nothing, and
   `judge_worker_heartbeat_age_seconds{worker}` is precisely the metric that
   must survive the worker's death. So: queue depth, oldest job age,
   heartbeat age, e2e latency, proctor-event counts and active SSE
   connections come from the processes holding Postgres and Redis; run
   duration, sandbox-init failures and compile-cache hits are worker-local
   and come from the worker's own scrape port — which needs no database
   credentials and so does not weaken the judge host's credential-free
   posture.
5. **Metric names live in one table in `packages/shared`, and the alert
   rules are generated from a second.** Three processes, a Prometheus
   config, eight alert expressions and a Grafana dashboard that disagree
   about a metric name produce an alert that silently never fires.
   `METRIC_SPECS` (`observability.ts`) and `ALERT_RULES` (`alerts.ts`) are
   the single sources; `renderPrometheusRules()` generates
   `infra/monitoring/rules/recx.rules.yml`, and a test fails if the
   committed file differs from the generated one. A second test asserts
   every metric named by a rule is in `METRIC_SPECS` and every spec'd metric
   has an owning process.
6. **No metric label, and no vitals column, ever identifies a student.**
   Unbounded label cardinality is an operational failure and a privacy one
   at the same time. `proctor_event_total{type}` is labelled by kind only;
   `WebVitalSample` has no `userId`, no `ipHash` and no free-text route —
   the client sends a Next *route pattern* from a closed list
   (`ROUTE_PATTERNS`), because the resolved path carries a problem slug and,
   on an assessment, an attempt reference.
7. **An alert pages a human and does nothing else.** `failed logins
   >100/min` raises an alert; it does not restrict an account. §0 and §7 are
   absolute: no signal auto-penalises, and no job hard-disables an account.
   The `INTERNAL_ERROR` rate alert exists because it is the canary for a
   broken compiler image or a cgroup misconfiguration after a host upgrade —
   the alternative is learning about it from student complaints — and an
   `INTERNAL_ERROR` submission is excluded from scoring with a one-click
   admin rejudge, which is Phase 2 behaviour and not a penalty.
8. **One backup set, and the data refuses an incomplete one.** The spec's
   reasoning is carried verbatim into a CHECK: a dump restored next to a
   test-data snapshot from a different hour leaves submissions judged
   against test cases that no longer exist, and that is only ever discovered
   mid-incident. So `BackupSet` cannot be marked finished-and-successful
   unless `databaseDumpSha256`, `testdataArchiveSha256` **and**
   `manifestSha256` are all present, and `offsiteUploadedAt` cannot be set
   while `encryption = 'NONE'`.
9. **`style-src` is a closed question, and Phase 10 reopens it for one
   hour.** The nonce-only policy was tried, Monaco's runtime stylesheet and
   React's `style` attributes broke, and the finding is recorded as Low in
   `docs/SECURITY.md` §5 and §12 with its revisit condition. The spec says
   plainly: a non-working editor is a product failure, a Low finding is not.
   Phase 10's entire work here is a test asserting `script-src` still
   carries no `'unsafe-inline'`, and one paragraph restating the trade-off
   where an auditor will look for it.
10. **The deploy workflow is `workflow_dispatch` only, and migrations are a
    separate supervised step.** `RUN_MIGRATIONS=false` by default,
    expand/contract so the previous image still serves, a backup set
    recorded before the step, and the migration applied once from one place
    — auto-migrating on boot runs migrations N times concurrently during a
    rolling restart and applies a bad migration before anyone has read the
    error. An automatic deploy on push to college hardware is the same class
    of mistake one layer up.
11. **The web application never executes a shell command and never reaches
    another host.** `/super/ops` reads rows and renders them; the only write
    is a human recording a restore drill they performed. Backups, pruning,
    restores and deploys are scripts run by a person on the host that owns
    the data, which report back by writing a row (`/api/ops/deploys`) or by
    `psql`. A "run backup now" button is a remote-execution channel in the
    process that holds `DATABASE_URL`.
12. **The restore drill is the deliverable, so it is a row with a name on
    it.** `RestoreDrill` carries `performedOn`, `performedByName`,
    `scratchDatabase`, `rpoSeconds` and `rtoSeconds`, and a CHECK refuses
    `outcome = 'PASSED'` unless RPO ≤ 300 s and RTO ≤ 7200 s. A second CHECK
    refuses a `scratchDatabase` that is not named `recx_scratch…`, because a
    drill that restored over the live database is an incident, not a drill.
    The row is append-only: a correction is a new row.
13. **Immutable statement keys, nothing ever invalidated.** Problem
    statements are read under `problem:{id}:v{statementVersion}` with
    `Cache-Control: public, max-age=300, stale-while-revalidate=86400`.
    Nothing is invalidated, only orphaned — which deletes the entire class of
    "a student saw the old statement" bugs and makes a reload on bad campus
    wifi instant. The frozen-version rule (§4a) is what makes this sound: a
    published version never changes, so a stale key can only be *old*, never
    *wrong*.
14. **`authenticatedCacheKey()` throws without a user id.** "Never cache an
    authenticated payload without `userId` in the key" is a rule nobody
    remembers at 2 a.m., so it is a function that cannot be called the wrong
    way, plus a static test that every `unstable_cache` call in an
    authenticated path goes through it.
15. **HTTP/2 at Caddy is a correctness requirement, not a performance
    nicety.** SSE over HTTP/1.1 hits the ~6-connection-per-origin cap, so a
    student with several tabs starves their own page loads. The Caddyfile
    comment says this, because the first person to debug a reverse proxy
    will otherwise "simplify" it.
16. **No PgBouncer at two replicas, but the URL is pooler-shaped from day
    one.** The spec sets the threshold at more than four web replicas.
    `DATABASE_URL` keeps `?pgbouncer=true&connection_limit=10` so adding the
    pooler is a compose change rather than an application change, and the
    scheduler and the judge dispatcher keep `DATABASE_URL_DIRECT` because
    advisory locks and `SKIP LOCKED` leases do not survive transaction
    pooling.
17. **Field vitals are sampled, anonymous and 90 days old at most.** Lab
    Lighthouse on a known profile answers "did we regress"; only real
    machines answer "is it usable in the lab at 11 a.m.". 10 % of sessions
    report, the payload is ≤ 1 KB, `web-vitals@^4` is lazy-loaded after
    first paint and is budgeted so it cannot enter the shared chunk — a
    measurement tool that costs 8 KB on the critical path of a 4 GB laptop
    has made the thing it measures worse.
18. **Caddy's access log does not retain a client address.** The
    application hashes IPs (`hashIp()`); a reverse-proxy log that keeps the
    raw address next to a request path undoes that. The log format drops
    `request>remote_ip`, and `pino`'s `redact` list covers
    `req.headers.cookie`, `authorization`, `x-recx-ops-token`, `ip` and
    `password`, with a unit test over the redaction list.

---

## 2. Sequencing

Six slices. Each is green on lint, typecheck, test and build — on Windows
and Linux — before the next begins. Only 10f closes the phase.

| Slice | Contents |
|---|---|
| **10a Health, the deploy gate and the supply chain** | `deploy-gate.ts`; `requireOpsToken()`; `GET /api/health`, `GET /api/ready`; `POST /api/ops/deploys`; `DeployEvent` + its four CHECKs and its immutability trigger; `prisma migrate diff --exit-code` drift check in CI; `.github/dependabot.yml` (weekly, pnpm + Actions + Docker); `pnpm audit --audit-level=high` as a blocking CI step; `tests/repo/judge-deps.test.ts` (judge under 20 direct dependencies) |
| **10b Metrics and alert rules** | `observability.ts` (`METRIC_SPECS`) and `alerts.ts` (`ALERT_RULES`, `evaluateAlertRule`, `renderPrometheusRules`); prom-client registries in web, scheduler and judge-worker; `src/lib/ops/collectors.ts`; `GET /api/metrics` (ops token); the worker scrape port; `infra/monitoring/` — scrape config, generated rule file, Grafana dashboard JSON, the monitoring-host compose file, the Postgres tuning snippet (`log_min_duration_statement=500ms`, `pg_stat_statements`, `auto_explain` > 2 s); the registry and synthetic-firing tests |
| **10c Field vitals, Lighthouse CI and caching** | `vitals.ts` (`REFERENCE_DEVICE`, `VITAL_TARGETS`, `ROUTE_PATTERNS`, `rateVital`, `p75`); `WebVitalSample` + CHECKs; `POST /api/vitals`; the lazy reporter; `lighthouserc.json` + the `lighthouse` CI job on the reference-device profile; the `perf` project in CI with the full p75 table; `cache-keys.ts`; the statement `Cache-Control` and immutable key; the `problems` tag with `revalidateTag` on publish; `authenticatedCacheKey()` and its static fence; new size budgets |
| **10d Backups, the drill, retention and partitions** | `backup.ts` (`backupSetKey`, `renderManifest`/`parseManifest`, `retentionPlan`, `isSetComplete`); `partitions.ts`; `BackupSet`, `RestoreDrill`, `BackupKind`, `BackupEncryption`, `RestoreDrillOutcome` with every CHECK and trigger in §3; `infra/backup/{backup,prune,restore-drill,pre-contest-snapshot}.sh`; `infra/db/pgbackrest.conf`; the scheduler's partition-maintenance job; the retention registry and the new rules; `infra/db/submission-partition.sql` committed **unapplied** with its 25 M-row / 80 GB trigger |
| **10e Topology, secrets and rate limits** | `Dockerfile` for web, scheduler and judge-worker (base images by digest); `infra/compose/{app,db,monitoring}.yaml`; `infra/caddy/Caddyfile` (HTTP/2, `/api/metrics` and `/api/ops/*` source-restricted, the log format without a client address); sops+age (`.sops.yaml`, `infra/secrets/*.enc.yaml`) and Docker secrets; Redis ACLs for judge nodes; `rate-policy.ts` plus the 120/min/session API limit and the 10/min admin-bulk limit at their call sites; the audit terminal-hash off-box export; `pino` redaction; optional OIDC behind `OIDC_ISSUER`, disabled by default, local password auth unchanged |
| **10f The ops surface, the docs and the gate** | `/super/ops` (read-only) and `recordRestoreDrill`; `src/server/queries/super-ops.ts`, `src/server/actions/super-ops.ts`; axe rows and a size budget for the new page; `docs/CAPACITY.md` §8 (the reference device as the definition of done, the p75 table, the measured field vitals), `docs/RUNBOOK.md` §4 (deploy, backup, restore drill, alert response, the weekly judge rebuild) and §3 gate rows, `docs/SECURITY.md` (§11 emptied, §5 and §12 restated), `docs/ACCESSIBILITY.md` (WCAG 2.2 AA, the two stated exceptions, the named human contact); the manual checks |

Why this order: 10a gives every later slice a health endpoint and a deploy
story. 10b must precede 10d because the backup and partition jobs emit
metrics and alerts. 10c is independent and can run in parallel with 10b if
two people are working. 10e touches the most files and depends on the
secrets names that 10a and 10b introduce. 10f is the only slice that writes
prose into the four shipping documents, which keeps the merge surface on
`docs/` to one slice.

---

## 3. New Prisma models and enums

Six enums, four models. Every rule below is enforced by the database, not
only by the code path, so it holds for a migration, a script or a `psql`
session as well as for a server action.

### Enums

```prisma
enum BackupKind        { FULL_DAILY WEEKLY MONTHLY PRE_CONTEST INCREMENTAL MANUAL }
enum BackupEncryption  { AGE GPG NONE }
enum RestoreDrillOutcome { PASSED PARTIAL FAILED }
enum DeployOutcome    { STARTED SUCCEEDED FAILED ROLLED_BACK }
enum WebVitalMetric   { LCP INP CLS TTFB FCP TBT }
enum ConnectionClass  { SLOW_2G TWO_G THREE_G FOUR_G UNKNOWN }
```

`BackupEncryption.GPG` exists because the college may require it; `AGE` is
the default and the only value the scripts produce (open question 11).

### `BackupSet`

One row per timestamped set. Columns: `id`, `setKey @unique`
(`20261019T021500Z`), `kind`, `host`, `startedAt`, `finishedAt?`,
`databaseDumpSha256?`, `databaseDumpBytes? BigInt`,
`testdataArchiveSha256?`, `testdataArchiveBytes? BigInt`,
`manifestSha256?`, `pgBackRestLabel?`, `walLsn?`, `encryption`,
`offsiteUploadedAt?`, `offsiteLocation?`, `contestId?`, `assessmentId?`,
`failureReason?`, `prunedAt?`, `prunedReason?`, `createdAt`.
Indexes: `[kind, startedAt DESC]`, `[startedAt DESC]`, `[prunedAt]`.

- `BackupSet_complete_triple_check` —
  `"finishedAt" IS NULL OR "failureReason" IS NOT NULL OR ("databaseDumpSha256" IS NOT NULL AND "testdataArchiveSha256" IS NOT NULL AND "manifestSha256" IS NOT NULL)`.
  The database form of "DB and test data captured together, always".
- `BackupSet_sha256_format_check` — each non-null digest matches
  `^[0-9a-f]{64}$`.
- `BackupSet_bytes_positive_check` — each non-null byte count `> 0`. A
  zero-byte dump is the classic silent backup failure, and it has to fail
  loudly at write time rather than at restore time.
- `BackupSet_offsite_encrypted_check` —
  `"offsiteUploadedAt" IS NULL OR "encryption" <> 'NONE'`. Encrypted before
  offsite upload, enforced.
- `BackupSet_pre_contest_ref_check` —
  `"kind" <> 'PRE_CONTEST' OR "contestId" IS NOT NULL OR "assessmentId" IS NOT NULL`.
- `BackupSet_prune_pair_check` — `prunedAt` and `prunedReason` set together.
- Trigger `BackupSet_artifacts_immutable` — once `finishedAt` is set,
  `setKey`, `kind`, `host`, `startedAt`, `finishedAt`, every digest and every
  byte count are frozen; `offsiteUploadedAt`, `offsiteLocation`, `prunedAt`
  and `prunedReason` may each be set once. **DELETE is refused**: pruning an
  artefact sets `prunedAt`, because the ledger of what backups existed is
  what an incident review reads.
- Trigger `BackupSet_no_truncate` (the existing `recx_refuse_truncate()`).

### `RestoreDrill`

Columns: `id`, `backupSetId` (FK `ON DELETE RESTRICT`), `performedOn
@db.Date`, `performedByName`, `performedByUserId?`, `scratchDatabase`,
`rpoSeconds Int`, `rtoSeconds Int`, `outcome`, `rowCounts Json @default("{}")`,
`notes`, `recordedAt`, `recordedByUserId`.
Index: `[performedOn DESC]`.

- `RestoreDrill_passed_objectives_check` —
  `"outcome" <> 'PASSED' OR ("rpoSeconds" <= 300 AND "rtoSeconds" <= 7200)`.
  RPO 5 min and RTO 2 h are the stated objectives; a drill that missed them
  is `PARTIAL` or `FAILED`, and no one can quietly record it as a pass.
- `RestoreDrill_name_check` —
  `char_length(btrim("performedByName")) >= 3`. "Recorded in the runbook
  with a date and a name" — the name is half the deliverable.
- `RestoreDrill_scratch_only_check` —
  `"scratchDatabase" LIKE 'recx\_scratch%'`.
- `RestoreDrill_seconds_check` — both durations `>= 0` and `< 604800`.
- Trigger `RestoreDrill_append_only` — no UPDATE, no DELETE, no TRUNCATE. A
  correction is a new row referencing the same `BackupSet` with a note.

### `DeployEvent`

Columns: `id`, `imageDigest`, `gitSha`, `startedAt`, `finishedAt?`,
`outcome`, `replicasRestarted Int @default(0)`, `migrationsApplied Boolean
@default(false)`, `migrationNames String[]`, `forced Boolean @default(false)`,
`forcedReason?`, `activeContestCount Int`, `activeAssessmentCount Int`,
`actorName`, `backupSetId?` (FK `RESTRICT`), `createdAt`.
Index: `[startedAt DESC]`.

- `DeployEvent_digest_check` — `"imageDigest" ~ '^sha256:[0-9a-f]{64}$'`.
  Deploy by digest; a tag is not a deployment identity.
- `DeployEvent_live_requires_force_check` —
  `("activeContestCount" = 0 AND "activeAssessmentCount" = 0) OR "forced"`.
  The spec's deploy block, held in the data as well as in the script.
- `DeployEvent_forced_reason_check` —
  `"forced" = false OR char_length(btrim("forcedReason")) >= 10`. A deploy
  forced over a live exam is never unexplained.
- `DeployEvent_migrations_need_backup_check` —
  `"migrationsApplied" = false OR "backupSetId" IS NOT NULL`. "Migrations
  are a separate supervised step … preceded by a backup" — so a migrating
  deploy cannot be recorded without the backup set it was preceded by.
- Trigger `DeployEvent_immutable` — only `finishedAt`, `outcome` and
  `replicasRestarted` may change, and `finishedAt` once; no DELETE, no
  TRUNCATE.

### `WebVitalSample`

Columns: `id BigInt @default(autoincrement()) @id`, `metric WebVitalMetric`,
`value Float`, `routePattern String`, `connection ConnectionClass @default(UNKNOWN)`,
`deviceMemoryGb Int?`, `hardwareConcurrency Int?`, `viewportWidth Int?`,
`appVersion String`, `occurredAt DateTime @default(now())`.
Indexes: `[metric, routePattern, occurredAt]`, `[occurredAt]`.

- **No identity column exists**: no `userId`, no `sessionId`, no `ipHash`, no
  resolved URL. A DB test asserts the table has no foreign key to `User` and
  no column whose name matches `/user|ip|session|email|roll/i`.
- `WebVitalSample_value_check` — `"value" >= 0 AND "value" <= 600000`.
- `WebVitalSample_cls_check` —
  `"metric" <> 'CLS' OR "value" <= 10`. A CLS of 400 is a broken client, not
  a layout shift, and it would wreck every percentile.
- `WebVitalSample_route_check` —
  `"routePattern" ~ '^/[A-Za-z0-9/_\[\]().-]{0,119}$'`. Combined with the
  closed `ROUTE_PATTERNS` list at the zod boundary, cardinality is bounded by
  construction and no slug or attempt reference can land in the column.
- Trigger `WebVitalSample_append_only` — no UPDATE; DELETE is allowed only
  for the retention job (90 days), the same shape as
  `SubmissionTestDetail`.

### Retention and partitioning changes (no new model)

- `RETENTION_RULES` in `apps/scheduler/src/reconciler.ts` gains
  `WebVitalSample` at 90 days, and `SubmissionSource` archival
  (`archivedAt` for non-accepted `PRACTICE` at 18 months — set, never
  deleted: the verdict row is kept forever because profile counters,
  acceptance rates and similarity history depend on it).
- A new test `tests/repo/retention-registry.test.ts` asserts that every
  table named in SPEC §4 "Retention" has either a rule in
  `RETENTION_RULES` or a recorded owning phase, and that **no rule targets
  `User`** — a student is never hard-deleted; `GRADUATED`/`ARCHIVED` plus
  anonymisation is the only path, and past standings stay honest.
- The scheduler's new `partitions` job uses `partitions.ts` to create
  `ProctorEvent` partitions three months ahead, `DETACH PARTITION` + drop
  past the 180-day boundary (never while an `IntegrityFlag` on an attempt in
  that month is still open), and raise `recx_partition_default_rows` when
  `proctor_event_default` is non-empty.
- `infra/db/submission-partition.sql` is committed **unapplied**: the
  monthly `RANGE (createdAt)` conversion with `@@id([id, createdAt])`, its
  documented trigger (25 M rows or 80 GB) and the
  `submission_row_estimate` metric that fires the row-count alert. SPEC §7:
  do not partition `Submission` at launch.

---

## 4. Pure modules in `packages/shared`

Arithmetic, policy and ordering go here, unit-tested, never inside a
component or a query.

| Module | Exports | Why pure |
|---|---|---|
| `observability.ts` | `METRIC_SPECS` (the ten spec'd metrics with type, labels and owning process), `METRIC_NAMES`, `assertBoundedLabels()`, `assertNoIdentityLabel()` | One name table for three processes, a scrape config, eight rules and a dashboard |
| `alerts.ts` | `ALERT_RULES` (the eight rules with threshold, `for`, severity and runbook anchor), `evaluateAlertRule(rule, samples, now)`, `renderPrometheusRules(rules)`, `alertFiringWindow()` | The firing decision is testable against synthetic series; the committed YAML is generated from the same table |
| `vitals.ts` | `REFERENCE_DEVICE`, `VITAL_TARGETS`, `ROUTE_PATTERNS`, `rateVital(metric, value, routeClass)`, `percentile(values, p)`, `p75(values)`, `vitalSampleSchema` | Percentiles are the arithmetic most often wrong (interpolation, empty input, a single sample); the targets are policy |
| `backup.ts` | `backupSetKey(date)`, `renderManifest(set)`, `parseManifest(text)`, `isSetComplete(set)`, `retentionPlan(sets, now)`, `BACKUP_RETENTION` (7 daily / 4 weekly / 12 monthly) | The keep/prune decision over a two-year fixture is pure ordering and the single easiest thing to get wrong in the phase |
| `deploy-gate.ts` | `deployDecision({ activeContestCount, activeAssessmentCount, force })` → `{ allow, reason }`, `DEPLOY_BLOCK_REASONS` | CI, the shell script and the CHECK must agree |
| `cache-keys.ts` | `problemStatementKey(problemId, statementVersion)`, `STATEMENT_CACHE_CONTROL`, `PROBLEMS_TAG`, `PROBLEM_LIST_REVALIDATE_SECONDS`, `authenticatedCacheKey(parts, userId)` (throws on a missing/blank id) | A key format is policy; the throwing constructor is the fence |
| `rate-policy.ts` | `API_RATE_LIMITS` (120/min/session), `ADMIN_BULK_RATE_LIMIT` (10/min), `rateLimitKey(scope, subject)` | The numbers are policy; `apps/web/src/lib/rate-limit.ts` keeps the Redis mechanics and imports these |
| `partitions.ts` | `monthlyPartitionName(table, date)`, `partitionRange(date)`, `partitionsNeeded(existing, from, aheadMonths)`, `partitionsPastRetention(existing, boundary)` | Month-boundary arithmetic across a year end, with no database in the test |

Each module is appended to `packages/shared/src/index.ts`. **That file is
shared with other phases: append the export line as the first commit of the
slice and rebase, do not merge.**

---

## 5. Routes, pages and guards

| Route | Method | Guard | Notes |
|---|---|---|---|
| `/api/health` | GET | none (liveness) / `requireOpsToken()` for the extra fields | No database read on the unauthenticated path. With the token: `activeContestCount`, `activeAssessmentCount`, `migrationsAtHead`, `replicaId`. `cache-control: no-store`, `runtime = "nodejs"`, `dynamic = "force-dynamic"` |
| `/api/ready` | GET | none | `SELECT 1`, Redis `PING`, migrations at head, 2 s each; 200 or 503 with a per-check body. Caddy's rolling-restart gate |
| `/api/metrics` | GET | `requireOpsToken()` **and** Caddy source restriction | `text/plain; version=0.0.4`; prom-client registry held on `globalThis` so hot reload and multiple route invocations share one registry; never aggregated across replicas in-process |
| `/api/vitals` | POST | session cookie (`requireActionUser()`), `isSameOrigin()`, `API_RATE_LIMITS` | Body ≤ 1 KB, `vitalSampleSchema`, 204 on accept, 202 when sampled out. Stores no identity |
| `/api/ops/deploys` | POST | `requireOpsToken()` | Writes `DeployEvent` and an `audit()` row at `SECURITY` sensitivity. The only write the deploy script makes |
| `/super/ops` | page | `requireSuperAdmin()` | Backup sets with their completeness, the latest `RestoreDrill` with its date and name, deploy history, alert state, partition health, field-vitals p75 per route. Read-only except the drill form |
| `/admin/judge` | page | unchanged | Already shows node health; gains a link to `/super/ops` for SUPER_ADMIN only |

Server code placement follows `docs/CONVENTIONS.md` "Sensitive paths":
reads in `src/server/queries/super-ops.ts`, the one mutation in
`src/server/actions/super-ops.ts` (the `super-` prefix is what carries the
rule), components in `src/components/super/ops/**`.

**Sharp edge.** `src/app/api/health`, `/ready`, `/metrics`, `/vitals` and
`/ops/**` sit under `src/app/api/**` outside `admin/**` and `judge/**`, so
`tests/repo/student-exposure.test.ts` treats each `route.ts` as a *student
entry* and walks its whole import closure. None of them may reach a
sensitive module. Queue depth and oldest-job age therefore come from a
purpose-built `src/lib/ops/collectors.ts` that reads `Submission` counters
and BullMQ only — importing `src/lib/judge/claim.ts` for convenience would
break the fence, correctly.

Pages export `metadata = { title: … }`; the drill form is a leaf
`"use client"` component with `useToast()`; the action returns
`ActionResult<T>` through `runAction()` and calls `audit()`.

---

## 6. Tests the phase is gated on

From the spec's "Done when" — four gates green; Lighthouse CI, axe,
size-limit and the keyboard journey pass in CI; a restore drill completes
into a scratch database and is recorded with a date; alert rules fire
correctly against synthetic conditions — plus what the design above implies.

1. **The four gates**, `pnpm lint && pnpm typecheck && pnpm test && pnpm
   build`, green on Windows and Linux, each run on its own with its exit
   code and its test counts asserted (`docs/CONVENTIONS.md`: a pnpm version
   switch failure exits 0 while running nothing).
2. **Schema drift**: `prisma migrate diff --from-migrations --to-schema-datamodel
   --exit-code` green in CI, including over the hand-written partition SQL.
3. **Lighthouse CI** green on the reference-device profile (1366×768, 4×
   CPU, 3 Mbps/1 Mbps/150 ms) against the production build, asserting the
   p75 targets: LCP ≤ 2.0 s (≤ 2.5 s on the problem statement), TBT ≤ 200
   ms, CLS ≤ 0.05, TTFB ≤ 600 ms. The accessibility category is **reported,
   never the gate** — axe is the gate.
4. **The `perf` project in CI** with `E2E_PERF_ENFORCE=1`: textarea typable
   ≤ 2.5 s always, Monaco interactive ≤ 4.0 s warm / ≤ 7 s cold, CLS ≤ 0.05,
   and the ordering assertion (textarea before Monaco). The cold-Monaco
   budget is 7 s because Monaco is ~1.0 MB gzipped — about three seconds of
   transfer alone on 3 Mbps — and the honest number is the one that goes in
   the budget.
5. **`pnpm size`** green with new budgets for `/super/ops` and for the
   vitals reporter, including an assertion that `web-vitals` is lazy and
   appears in no shared chunk.
6. **axe** zero serious or critical on `/super/ops`, light and dark, at both
   viewports; **the keyboard journey** unchanged and green.
7. **Alert rules fire correctly against synthetic conditions**: per-rule
   unit tests over `evaluateAlertRule` (fires at the threshold, does not
   fire one step below it, honours `for`, recovers), a test that
   `infra/monitoring/rules/recx.rules.yml` is byte-identical to
   `renderPrometheusRules(ALERT_RULES)`, `promtool check rules` plus its
   unit-test file in CI, and one recorded live firing of each rule against
   the staging stack (`docs/RUNBOOK.md` §4).
8. **Metric registry**: every metric in SPEC §5's required list is in
   `METRIC_SPECS` with an owning process and is actually registered by that
   process; every metric named by an alert rule exists; no label is a user
   identifier; `/api/metrics` refuses a request without the ops token.
9. **Backup-set completeness, in the database**: a set cannot be finished
   successfully without all three digests; `offsiteUploadedAt` cannot be set
   with `encryption = 'NONE'`; a zero-byte artefact is refused; a
   `PRE_CONTEST` set without a contest or assessment is refused; a finished
   set's digests cannot be changed and the row cannot be deleted — each
   through Prisma **and** through raw SQL.
10. **Manifest and retention arithmetic**: `renderManifest`/`parseManifest`
    round-trip; `retentionPlan` over a two-year fixture keeps exactly 7
    daily, 4 weekly and 12 monthly sets, never prunes a set a
    `RestoreDrill` references, and is idempotent.
11. **The restore drill**: a `PASSED` row with `rpoSeconds > 300` or
    `rtoSeconds > 7200` is refused; a non-`recx_scratch…` database is
    refused; a blank name is refused; the row is append-only. And the real
    thing — a drill performed into a scratch database, its row written, and
    a dated, named row in `docs/RUNBOOK.md` §3. **The drill is the
    deliverable, not the script.**
12. **The deploy gate**: `deployDecision` unit tests; a `DeployEvent` with a
    live contest and `forced = false` is refused by the CHECK; `forced`
    without a reason is refused; `migrationsApplied` without a `backupSetId`
    is refused; a non-digest image reference is refused.
13. **Caching**: `authenticatedCacheKey()` throws without a user id; a
    static test that no `unstable_cache` call in an authenticated path omits
    it; the statement response carries
    `public, max-age=300, stale-while-revalidate=86400` and a key containing
    `statementVersion`; `revalidateTag(PROBLEMS_TAG)` is called on publish
    and the list reflects a newly published problem within its 60 s window.
14. **Privacy fences**: `WebVitalSample` has no identity column and no FK to
    `User` (DB test); the vitals endpoint rejects a route pattern outside
    `ROUTE_PATTERNS`; the `pino` redaction list covers cookies,
    `authorization`, `x-recx-ops-token` and `ip`; `hashIp()` remains the
    only path to an IP-derived value; the Caddy log format contains no
    client address.
15. **Supply chain**: `pnpm audit --audit-level=high` blocking; every base
    image in every Dockerfile pinned by digest (repo test over the
    Dockerfiles); `apps/judge-worker` under 20 direct dependencies;
    Dependabot configured weekly for pnpm, Actions and Docker.
16. **CSP**: `script-src` contains no `'unsafe-inline'` (extends
    `apps/web/test/csp.test.ts`), and the theme-script hash still matches.
17. **Rate limits**: the 120/min/session API limit and the 10/min
    admin-bulk limit are enforced at their call sites and fail open with a
    logged warning when Redis is unreachable, exactly as sign-in does.
18. **Retention registry**: every SPEC §4 retention table has a rule or a
    recorded owner, and no rule targets `User`.
19. **Partitions**: `partitionsNeeded`/`partitionsPastRetention` across a
    year boundary; the maintenance job does not drop a month with an open
    `IntegrityFlag`; a non-empty default partition raises its metric.
20. **`tests/repo/forbidden-words.test.ts` green** over every new document,
    comment, UI string, Caddyfile, compose file, shell script and commit
    message. Proctoring is **monitored and recorded**; the audit chain and
    the backup ledger are **tamper-evident**; judging uses **layered
    containment**.

**Manual, recorded in `docs/RUNBOOK.md` §3 with a date:**

- Pull the plug on a judge host mid-contest: leases reclaim, the reconciler
  re-enqueues, **no submission is lost** — and the queue-depth, oldest-job
  and heartbeat-age alerts all fire and then recover.
- Restart Redis mid-contest: the same, with zero submissions lost; queue
  position is the only casualty.
- A rolling restart with a contest live is refused without `FORCE_DEPLOY=1`,
  and the forced path records a `DeployEvent` with a reason.
- A migration deploy without a preceding backup set is refused.
- The quarterly restore drill, with its date, its name and its
  RPO/RTO numbers.

### Accessibility requirements, not polish

- **WCAG 2.2 AA is the stated target**, with exactly the two documented
  exceptions already in `docs/ACCESSIBILITY.md` §5 (the workspace's
  two-dimensional layout under the SC 1.4.10 carve-out; Monaco's Tab
  capture with the documented Esc / Ctrl+M escape) and **a named human
  contact**, which the file does not yet have. A test asserts the contact
  line exists and is not the placeholder text — otherwise the placeholder
  ships.
- `/super/ops` status is **never colour alone**: backup state, alert state
  and drill outcome each render as icon + text + shape through `Badge`, with
  a legend. An "Accepted"-style colour-only badge is forbidden
  repo-wide.
- The backup, deploy and vitals tables carry a `<caption>` and real
  `<th scope="col">`; figures use `tabular-nums` with units in the header.
- The alert tile polls and announces through one `aria-live="polite"`
  region **at most once per 30 seconds** — never a per-second live region,
  for the same reason the Phase 6 exam timer announces at exactly four
  moments: a screen reader that speaks every second is unusable.
- `prefers-reduced-motion` is honoured by every updating tile.
- **CLS ≤ 0.05 is an accessibility requirement as much as a performance
  one** and is met by *reserving explicit heights* for the editor, the
  console, the heatmap and avatars — content that jumps under a magnifier or
  a switch user is a barrier. The `perf` project's CLS assertion is the
  gate.
- The vitals reporter must not delay first input: lazy, after first paint,
  and out of the shared chunk (gate item 5 above).

---

## 7. Open questions to record in `docs/OPEN-QUESTIONS.md`

Each with the narrower reading, per SPEC §0 "ask before inventing".

1. **How much does `/api/health` tell an unauthenticated caller?** The spec
   has the deploy job read `activeContest` from it. *Narrower reading:*
   unauthenticated liveness returns `{ ok, version }` only; the
   `activeContestCount` / `activeAssessmentCount` fields require
   `x-recx-ops-token`. An endpoint that announces when the college is
   mid-exam is reconnaissance, and the deploy job can hold a token.
2. **OIDC/SAML scope.** The spec calls it "optional … with local admin
   password auth as a documented fallback". *Narrower reading:* implement
   **OIDC only** (the college Entra or Google tenant), inactive unless
   `OIDC_ISSUER` is set, with local password auth unchanged as the primary
   path. SAML is not built. Revisit if the tenant offers only SAML.
3. **The leaderboard Redis ZSET.** SPEC §5 mentions "XpBucket + a Redis
   ZSET for `ZREVRANK`". *Narrower reading:* **do not add it.** The shipped
   path (`apps/web/src/server/queries/leaderboard.ts`) is already one
   ordered index scan with an index-only rank count, and a ZSET would be a
   second source of truth that can disagree with the bucket rows. Revisit
   when "my rank" p95 exceeds 150 ms on the full board — with the
   measurement, not the hunch.
4. **Where the monitoring stack lives.** Prometheus, Grafana, Loki and
   GlitchTip run on a separate monitoring VM so the dashboards load while
   the app host is on fire. *Narrower reading:* this repository commits the
   *configuration* — scrape config, generated rule file, dashboard JSON, a
   compose file for the monitoring host, and the runbook — and does not
   provision the VM, hold its credentials, or treat it as a deploy target.
5. **`style-src`.** *Narrower reading:* the question is already answered in
   `docs/SECURITY.md` §5 and §12 and stays answered. Phase 10 adds the
   `script-src` assertion and restates the trade-off. SPEC: "Do not spend a
   week on this."
6. **Retention ownership across phases.** SPEC §4 names tables that Phases
   7–9 own (`CodeFingerprint` pseudonymisation at 24 months,
   `AccountRestriction`, the proctoring-evidence window). *Narrower
   reading:* Phase 10 ships the retention **registry test** naming an owner
   for every table in the §4 list, and implements rules only for tables
   that exist when slice 10d lands. The registry turns a missing rule into
   a failing test in whichever phase adds the model.
7. **`Submission` partitioning.** *Narrower reading:* commit
   `infra/db/submission-partition.sql` **unapplied**, with the 25 M-row /
   80 GB trigger documented in `docs/CAPACITY.md` and a
   `submission_row_estimate` metric with an alert at 20 M. SPEC §7: do not
   partition `Submission` at launch.
8. **Field-vitals identity and volume.** *Narrower reading:* 10 % session
   sampling, no identity column of any kind, a closed `ROUTE_PATTERNS`
   list, and 90-day retention. We can answer "is the problem page slow in
   the labs"; we deliberately cannot answer "which student has a slow
   laptop", because nothing in the product needs that and the data would
   outlive its purpose.
9. **PgBouncer at two replicas.** SPEC §4 specifies
   `?pgbouncer=true&connection_limit=10` for web; SPEC §5 says no PgBouncer
   until web replicas exceed four. *Narrower reading:* `DATABASE_URL` keeps
   the pooler-shaped parameters so introducing PgBouncer later is a compose
   change only, and no pooler container runs at two replicas. The scheduler
   and the judge dispatcher keep `DATABASE_URL_DIRECT` — advisory locks and
   `SKIP LOCKED` leases do not survive transaction pooling, and that is not
   negotiable at any replica count.
10. **Deploy automation.** *Narrower reading:* `infra/deploy/deploy.sh` plus
    a `workflow_dispatch`-only GitHub Actions job. Never on push. The deploy
    gate is checked twice — by the script before it starts and by the
    `DeployEvent` CHECK when it reports — because the window in between is
    exactly when an assessment starts.
11. **Backup encryption: age or gpg?** *Narrower reading:* age only; `GPG`
    stays in `BackupEncryption` because the college may require it, and the
    scripts never emit it. Keys are managed with sops+age alongside the
    deployment secrets, and the key custodians are named in
    `docs/RUNBOOK.md` §4 — an encrypted offsite backup whose key has one
    holder is a single point of failure.
12. **The named accessibility contact.** A repository cannot invent a
    person. *Narrower reading:* `docs/ACCESSIBILITY.md` carries a role plus
    a named individual and an address, and the gate test fails while the
    placeholder is still there, so the phase cannot close with a nameless
    contact.
13. **Weekly judge-host rebuild.** The spec says judge hosts are rebuilt
    weekly from image. *Narrower reading:* a runbook procedure over the
    existing `infra/judge` scripts, performed one host at a time with the
    host set to `DRAINING` first and the fleet never below two online
    nodes — not a cron job. Rebuilding on a timer is how a fleet goes to
    zero during an exam.


---

## Review findings — fix before implementing
An independent pass over this document against `docs/handoff/SPEC.md` and the
actual repository returned **needs-revision**. Nothing below has been applied yet: this
design is a DRAFT, and these are the items to settle first, when Phase 10 starts
and the codebase is whatever it is by then. Each one was checkable against a
file or a spec line when it was written (2026-10-19).

### Contradicts the spec or the codebase (6)

1. Open question 3 refuses a component the spec names outright. Spec: "Global leaderboard from XpBucket + a Redis ZSET for ZREVRANK." The design answers "*Narrower reading:* **do not add it.**" §0's "Ask before inventing ... implement the narrower reading" governs AMBIGUITY; "XpBucket + a Redis ZSET for ZREVRANK" is an unambiguous named element, and the stated reason ("a ZSET would be a second source of truth that can disagree with the bucket rows") is an argument against the spec, not a narrower reading of it. Either build it or get the deviation signed off - it cannot be carried as a settled design decision.

2. The design contradicts its own gate. Gate item 8 asserts that "every metric named by an alert rule exists" and "is actually registered by that process", yet two of the eight spec'd alerts (disk >80%, DB connections >80%) are over metrics that no process in this system can register and that appear in no scrape target the design commits. As written, slice 10b cannot be both complete and green.

3. Open question 10 claims "[t]he deploy gate is checked twice - by the script before it starts and by the `DeployEvent` CHECK when it reports", and decision 2 claims the CHECK means the three paths "cannot disagree about what \"a contest is live\" means". That is false. DeployEvent_live_requires_force_check reads activeContestCount / activeAssessmentCount out of the row the deploy script itself wrote. A script that reports 0 (because it queried /api/health before the assessment started, or because it queried nothing) passes the CHECK. It is one real check plus a self-consistency assertion on self-reported numbers - and the design identifies the dangerous window ("exactly when an assessment starts") without closing it: nothing re-queries immediately before each replica restart.

4. "Phase 10 adds the *maintenance* job ... not the partitioning" is right about ProctorEvent, but the retention boundary it introduces conflicts with its own guard. The partitions job is to "`DETACH PARTITION` + drop past the 180-day boundary (never while an `IntegrityFlag` on an attempt in that month is still open)" - yet §3 commits ProctorEvent partitions only "through 2027-09 plus `proctor_event_default`", and the 180-day proctoring-evidence window is attributed to Phases 7-9 in open question 6 ("implements rules only for tables that exist when slice 10d lands"). The doc therefore both defers the evidence-window rule and hard-codes 180 days into the drop logic, with no reconciliation.

5. "`BackupSet_prune_pair_check`" plus "**DELETE is refused**: pruning an artefact sets `prunedAt`" makes the BackupSet table itself unprunable and unbounded, which is fine - but the design then lists `[prunedAt]` as an index and never gives BackupSet a retention rule while gate item 18 asserts "every SPEC §4 retention table has a rule or a recorded owner". Backups are a §4-adjacent retention concern the spec explicitly caps ("not \"forever\""), and the ledger's own growth is unaddressed.

6. Decision 6 says WebVitalSample has "no free-text route" because the client sends "a Next *route pattern* from a closed list (`ROUTE_PATTERNS`)", but the CHECK written to back it up, `"routePattern" ~ '^/[A-Za-z0-9/_\\[\\]().-]{0,119}$'`, admits a 119-character arbitrary path including a problem slug - any raw-SQL or script insert (the path the design says CHECKs exist for: "enforced by the database, not only by the code path, so it holds for a migration, a script or a `psql` session") bypasses the closed list entirely. The fence the decision claims is the zod schema alone.


### Spec requirements the design does not cover (13)

1. Required metric NAMES. Spec: "Required metrics: judge_queue_depth{queue}, judge_oldest_job_age_seconds{queue}, judge_run_duration_seconds, judge_verdict_total{verdict,language}, judge_worker_heartbeat_age_seconds{worker}, judge_sandbox_init_failures_total, judge_compile_cache_hits_total, submission_e2e_latency_seconds, proctor_event_total{type}, sse_connections_active". Eight of the ten names appear NOWHERE in the doc - only proctor_event_total and judge_worker_heartbeat_age_seconds are written out (grep confirms judge_queue_depth=0, judge_verdict_total=0, judge_run_duration=0, judge_sandbox_init=0, judge_compile_cache=0, submission_e2e_latency=0, sse_connections_active=0, judge_oldest_job=0). The design describes METRIC_SPECS as "the ten spec'd metrics with type, labels and owning process" and justifies it in decision 5 as the cure for "[t]hree processes, a Prometheus config, eight alert expressions and a Grafana dashboard that disagree about a metric name" - but it never writes the table, so the authoritative name list has no names and the label sets ({queue}, {verdict,language}, {worker}, {type}) are unspecified.

2. judge_verdict_total{verdict,language} is missing even from the ownership split. Decision 4 enumerates "queue depth, oldest job age, heartbeat age, e2e latency, proctor-event counts and active SSE connections" (web/scheduler) plus "run duration, sandbox-init failures and compile-cache hits" (worker) - nine of ten. The verdict counter is assigned to no process anywhere in the document.

3. Every alert threshold but one. Spec: "Alerts: queue depth >200 for 2 min; oldest job >60s; worker heartbeat >90s; INTERNAL_ERROR rate >2% over 5 min ...; disk >80%; DB connections >80%; failed logins >100/min; e2e p95 >30s." Only ">100/min" appears (line 253). The strings ">200", "80%", "2%", "30 s" and the 60 s / 90 s / 2 min / 5 min windows appear nowhere. ALERT_RULES is described as "the eight rules with threshold, `for`, severity and runbook anchor" and gate item 7 promises a test that each "fires at the threshold, does not fire one step below it, honours `for`" - neither is writable from this document.

4. No source for the disk >80% and DB connections >80% alerts. Spec names both. node_exporter and postgres_exporter appear zero times, and slice 10b's infra/monitoring/ contents are listed exhaustively as "scrape config, generated rule file, Grafana dashboard JSON, the monitoring-host compose file, the Postgres tuning snippet" - no host or Postgres exporter, and METRIC_SPECS holds only app/judge metrics.

5. The three backup artefact filenames. Spec: "one timestamped set containing database.dump + testdata.tar.zst + MANIFEST.txt". None of the three strings appears in the design. §3 defines databaseDumpSha256 / testdataArchiveSha256 / manifestSha256 and §4 exports renderManifest/parseManifest, but the MANIFEST.txt format, its required fields and the dump/archive filenames are left undefined - and the manifest is the thing the restore script reads mid-incident.

6. The pre-contest snapshot has no trigger and the contest-time incrementals have no mechanism. Spec: "a full snapshot immediately before every contest and 5-minute incrementals during it." The only artefacts are infra/backup/pre-contest-snapshot.sh and the PRE_CONTEST / INCREMENTAL enum members, while decision 11 states "Backups, pruning, restores and deploys are scripts run by a person on the host that owns the data". Nothing reads Contest.startsAt to fire the snapshot, and no 5-minute incremental cadence is specified anywhere (the string "5-minute" is absent; the two "5 min" hits are the login rate limit and the RPO). A snapshot "immediately before every contest" that depends on a human remembering is not the requirement.

7. DPDP-matched offsite retention. Spec: "off-host and encrypted (age/gpg) before offsite upload with retention matching the DPDP schedule, not \"forever\"". The word DPDP appears zero times. BACKUP_RETENTION is 7/4/12 and the offsite copy gets offsiteUploadedAt / offsiteLocation columns, but no rule, script or retention entry ever prunes the offsite copies, which is precisely the "forever" the spec forbids.

8. INP has no number and no gate. Spec target (p75): "INP ≤200ms". The design mentions INP exactly twice - in "Missing: LCP, INP, TBT and TTFB budgets" and as a WebVitalMetric enum member - and never states 200 ms. Gate item 3 asserts only "LCP ≤ 2.0 s (≤ 2.5 s on the problem statement), TBT ≤ 200 ms, CLS ≤ 0.05, TTFB ≤ 600 ms"; INP is field-only, so it can come only from /api/vitals, and no gate item asserts the field INP p75 against a target.

9. GlitchTip is not built. Spec: "GlitchTip self-hosted, not Sentry SaaS, so stack traces containing student data stay on college infrastructure." One mention in the whole doc (open question 4), listing it among things that run on the monitoring VM. No slice wires any process to it - 10b ships prom-client registries, /api/metrics, the worker scrape port and infra/monitoring/; 10e's logging work is "`pino` redaction". There is no exception-capture client, no DSN env var, no scrubbing of student data from captured frames, and no gate item. The requirement's entire stated purpose (where stack traces land) is unaddressed.

10. "health-gated rolling restart one replica at a time" (spec, CI/CD). The phrase and the sequencing are absent. Decision 1 says Caddy gates the restart on /api/ready and DeployEvent records replicasRestarted as a count, but nothing states that replica 2 restarts only after replica 1 reports ready, infra/deploy/deploy.sh's sequencing is undefined, and no gate or manual item tests it.

11. The Loki shipper has no owner. §0 says "Phase 10 adds a redaction list and a Loki shipper, not a logger", but no slice in §2 contains a shipper (10e lists only "`pino` redaction"), there is no promtail/alloy artefact in infra/monitoring/, and no gate item in §6 covers log shipping. Spec: "pino JSON → Loki".

12. Production Redis AOF everysec. Spec app-host topology: "Redis AOF everysec". The design verifies this only for the development compose.yaml in §0; slice 10e's infra/compose/app.yaml is described without any Redis persistence configuration and no gate item asserts appendfsync everysec in the production compose - the easiest thing to lose when a second compose file is written.

13. The judge host's firewall is never opened for the worker scrape port. Decision 4 puts judge_run_duration_seconds, judge_sandbox_init_failures_total and judge_compile_cache_hits_total on "the worker's own scrape port", but infra/judge/nftables.conf's input chain accepts only loopback, established/related, tcp/22 from $ADMIN_CIDR and DHCP. No slice modifies nftables.conf (10e's judge-host work is "Redis ACLs for judge nodes"), so those three required metrics are unreachable from the monitoring VM as designed.

