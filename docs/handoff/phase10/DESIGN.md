# Phase 10 — Ops, observability, performance, hardening

Design, written before any Phase 10 code. The spec paragraph this implements
is `docs/handoff/SPEC.md` lines 615–625.

## 0. What this phase is, and what makes it different

Every phase so far shipped something a student or a staff member can open.
This one ships almost nothing they can see. What it ships is the answer to
one question: **when this breaks at 10:40 on the morning of a placement
drive, how does anybody find out, and what do they do?**

That changes how the phase has to be judged. A metric that exists but was
never seen to move is not observability; an alert rule that was never fired
against a synthetic condition is a comment; a backup script that has never
been restored is a file. So the gate for this phase is unusually heavy on
*demonstration* rather than on tests:

- the restore drill is the deliverable, not the script;
- every alert rule is fired against a condition this repo can produce;
- every metric is read off a live `/metrics` while the thing it measures is
  happening.

And one honest constraint, stated at the top because it shapes every
decision below: **this development machine is a Windows laptop with a WSL2
mirror.** It has no second host, no monitoring VM, no object store on its own
hardware and no offsite anything. So the phase splits cleanly in two, and the
split is recorded in every section:

- **Buildable and verifiable here**: metrics, the health endpoint, alert
  rules fired against synthetic conditions, caching, field vitals, the CI
  additions, the backup *script set* and a real restore drill into a scratch
  database, and the four documents.
- **Written, reviewed, but not run here**: the multi-host compose topology,
  pgBackRest WAL archiving, the monitoring VM, offsite upload, and the
  mid-contest plug-pull on a judge host.

Nothing in the second group is skipped. Each is written as the artefact the
college's ops person will use, with a `docs/RUNBOOK.md` row saying *not run
here, and what would have to be true to run it*. A row that says NOT RUN is
worth more than a row that says PASS about a thing that was never tried.

## 1. What already exists

Phase 10 is the smallest phase by new code, because earlier phases built most
of its security half already. Taking stock first, so nothing is rebuilt:

| Spec requirement | State | Where |
|---|---|---|
| Argon2id | **Done** (Phase 1) | `apps/web/src/lib/auth/password.ts`, `@node-rs/argon2` |
| Server-side session rows, force-logout | **Done** (Phase 1/4) | `Session`, `destroyAllSessions()` |
| CSP with nonces, no `unsafe-inline` for `script-src` | **Done** (Phase 3) | `apps/web/src/middleware.ts` |
| Server-side sanitisation of statements | **Done** (Phase 3) | `packages/shared/src/sanitize.ts` |
| Rate limits (Redis sliding window) | **Done** (Phase 1/4) | `apps/web/src/lib/rate-limit.ts` |
| Lockfile committed, pinned toolchains | **Done** | `pnpm-lock.yaml`, `infra/judge/toolchains/*` |
| Judge under 20 direct dependencies | **Done** (asserted) | `tests/repo/judge-deps.test.ts` |
| CI: lint, typecheck, test, build, size, axe, keyboard, isolate | **Done** (Phase 1–7) | `.github/workflows/ci.yml` |
| Judge host hardening, nftables, blacklist | **Done** (Phase 2) | `infra/judge/*` |
| `docs/CAPACITY.md`, `RUNBOOK.md`, `SECURITY.md`, `ACCESSIBILITY.md` | Exist, incomplete | `docs/` |

So the new work is: **observability** (nothing exists), **the health
endpoint** (nothing exists), **topology** (nothing exists), **backups**
(nothing exists), **field vitals** (nothing exists), **caching** (partial),
**two CI additions**, and **completing four documents**.

## 2. Sequencing

Six slices. Each green on lint, typecheck, test and build before the next
starts; only 10f closes the phase.

| Slice | Contents |
|---|---|
| **10a Health and metrics** | `packages/shared/src/metrics.ts` (the metric names and help text as data), `apps/web/src/lib/metrics.ts` and `apps/judge-worker/src/metrics.ts` (prom-client registries), `/api/health` with `activeContest`, `/metrics` on web, worker and scheduler. Unit tests over the registry: every spec-named metric exists with the right type and labels, and no metric carries a label that could identify a student. |
| **10b Alerts, fired** | `infra/monitoring/alerts.yml` (Prometheus rules), `infra/monitoring/prometheus.yml`, `infra/monitoring/grafana/*.json`. Plus `scripts/ops/fire-alerts.ts`: a harness that drives each rule's condition against a live stack and asserts the rule's expression evaluates true. The harness is the gate item, not the file. |
| **10c Caching** | Immutable `problem:{id}:v{statementVersion}` keys, `Cache-Control: public, max-age=300, stale-while-revalidate=86400`; the problem list under `unstable_cache` tag `problems` with `revalidateTag` on publish; the global leaderboard from `XpBucket` plus a Redis ZSET for `ZREVRANK`. A fence: no `unstable_cache` key without `userId` where the payload is authenticated. |
| **10d Field vitals and the reference device** | `web-vitals@^4` reporting to `POST /api/vitals`, a `WebVital` table (or a Redis histogram — decided in §7), the reference-device targets written into `docs/CAPACITY.md` as the definition of done, and Lighthouse CI in the workflow against the budgets. |
| **10e Topology, backups and the drill** | `deploy/compose.app.yml`, `compose.db.yml`, `compose.judge.yml`, `deploy/Caddyfile`, `deploy/pgbackrest.conf`; `scripts/ops/backup.sh`, `restore.sh`, `verify-backup.sh`; the deploy script with its health gate and `FORCE_DEPLOY`. **The restore drill runs here**, into a scratch database, and is recorded with a date. |
| **10f The documents, and the phase gate** | `docs/CAPACITY.md`, `RUNBOOK.md`, `SECURITY.md`, `ACCESSIBILITY.md` complete; `docs/OPEN-QUESTIONS.md` entries; the drift check in CI; both platforms' gates; the manual items recorded as PASS or NOT RUN with a reason. |

## 3. Observability (10a, 10b)

### 3.1 The metric names are data

The spec names ten metrics. They go in `packages/shared/src/metrics.ts` as a
frozen list with type, labels and help text, for the same reason
`PLACEMENT_EXPORT_COLUMNS` is data: a test can then assert the live registry
against the spec instead of a reviewer reading two lists side by side.

```
judge_queue_depth{queue}                     gauge
judge_oldest_job_age_seconds{queue}          gauge
judge_run_duration_seconds                   histogram
judge_verdict_total{verdict,language}        counter
judge_worker_heartbeat_age_seconds{worker}   gauge
judge_sandbox_init_failures_total            counter
judge_compile_cache_hits_total               counter
submission_e2e_latency_seconds               histogram
proctor_event_total{type}                    counter
sse_connections_active                       gauge
```

**The label rule, and it is a privacy rule rather than a cardinality one.**
No metric may carry a label whose value is a user id, a college id, a handle,
an attempt id or a submission id. Prometheus is scraped by a separate VM,
stored for months and rendered on dashboards people screenshot — it is the
least controlled datastore in the system. `{worker}` is a host name and
`{queue}` is a lane; both are bounded and neither is a person. A fence
asserts this over the registry rather than over the spec list, because the
registry is what is exposed.

That also settles `proctor_event_total{type}`: the TYPE only. A per-attempt
proctor metric would be a per-student behavioural record in the one place no
retention policy reaches.

### 3.2 Who exposes what

Three processes, three registries, and deliberately not one shared one:

- **web** — `sse_connections_active`, `submission_e2e_latency_seconds`,
  `proctor_event_total`. It is the only process that sees an SSE connection
  or a proctor event.
- **judge-worker** — `judge_run_duration_seconds`,
  `judge_sandbox_init_failures_total`, `judge_compile_cache_hits_total`, and
  its own `judge_worker_heartbeat_age_seconds` is NOT self-reported (see
  below).
- **scheduler** — `judge_queue_depth`, `judge_oldest_job_age_seconds`,
  `judge_verdict_total`, `judge_worker_heartbeat_age_seconds`.

**Why the heartbeat age is reported by the scheduler and not by the worker.**
A worker that has died cannot report that its heartbeat is old. The metric
exists precisely to catch a dead worker, so it is derived by the scheduler
from `JudgeNode.lastHeartbeatAt` — the same row the reconciler reads. A
self-reported heartbeat-age gauge is the classic monitoring mistake: it goes
*missing* rather than *high*, and an alert on a missing series is a different,
easier-to-get-wrong rule.

Likewise `judge_queue_depth` comes from the scheduler, which already holds a
Redis connection and already runs every minute. Putting it on web would make
the number depend on which of two replicas was scraped.

### 3.3 `/metrics` is not public

`/metrics` carries queue depths, verdict counts and host names. It is bound
to the monitoring network in compose and, on web, additionally guarded by a
bearer token (`METRICS_TOKEN`, its own secret) because the web host is the
one with a public listener. The judge worker's `/metrics` is on its private
interface only — the judge host has no public listener at all, which Phase 2
already established.

### 3.4 `/api/health`, and the one field that is not about health

```
GET /api/health → 200 { ok, version, db, redis, activeContest, activeAssessment, migrations }
```

`activeContest` is in there because the spec's deploy job reads it: deploys
are blocked while a contest or assessment is live. That is a scheduling fact
rather than a health fact, and it lives on the health endpoint because the
deploy script should need exactly one call. The endpoint is unauthenticated
but says nothing a visitor could not infer — no counts, no names, no ids;
`activeContest` is a boolean and a slug-free count.

`migrations` reports whether the running image's migration folder matches
what the database has applied, which is the one number that explains "the
code is deployed but the page is broken".

### 3.5 Alerts, and the harness that fires them

The eight rules the spec names go in `infra/monitoring/alerts.yml`. Each is
written with `for:` and a `runbook_url` pointing at a `docs/RUNBOOK.md`
anchor, because an alert that does not say what to do is a pager that teaches
people to silence it.

`scripts/ops/fire-alerts.ts` is the deliverable. For each rule it produces
the condition against the local stack and asserts the expression is true:

| Rule | How the harness produces it |
|---|---|
| queue depth > 200 for 2 min | enqueue 250 jobs with no worker running |
| oldest job > 60s | enqueue one job, no worker, wait |
| worker heartbeat > 90s | insert a `JudgeNode` with an old `lastHeartbeatAt` |
| INTERNAL_ERROR rate > 2% / 5 min | submit against a problem whose checker is deliberately broken |
| disk > 80% | **not producible** — asserted against a synthetic sample instead |
| DB connections > 80% | open connections up to the configured fraction |
| failed logins > 100/min | 120 wrong-password posts against one account |
| e2e p95 > 30s | observe the histogram with a synthetic 31s sample |

Two of the eight are asserted against synthetic samples rather than real
conditions, and the table says which. Filling a disk to 80% on a development
laptop is not a test, it is an outage.

## 4. Caching (10c)

The spec's caching paragraph is mostly already true; this slice closes three
gaps.

**Problem statements** become immutable by key:
`problem:{id}:v{statementVersion}`, `Cache-Control: public, max-age=300,
stale-while-revalidate=86400`. Nothing is ever invalidated — only orphaned.
That eliminates the whole class of "the student saw the old statement" bugs
and makes a reload on bad campus wifi instant. It needs
`Problem.statementVersion`, which does not exist yet: a counter bumped by the
publish path, NOT the frozen `ProblemVersion.id` (a statement typo fix must
not require a new frozen version, and a new frozen version must bump the
key).

**The problem list** goes under `unstable_cache` with tag `problems`, 60s,
`revalidateTag("problems")` on publish and on retire.

**The global leaderboard** reads `XpBucket` plus a Redis ZSET for
`ZREVRANK`, so a student's own rank is O(log n) rather than a scan. The ZSET
is a cache of `XpBucket`, rebuilt by the existing nightly job, and the page
falls back to the table when Redis is down — a leaderboard that 500s because
a cache is cold is worse than a slow one.

**The fence.** `tests/repo/cache-keys.test.ts`: no `unstable_cache` call
whose key omits a user id in a module that reads an authenticated payload,
and no `Cache-Control: public` on a route that runs a session guard. This is
the one caching mistake that leaks another student's data rather than merely
being stale, so it is a fence and not a convention.

## 5. Performance and field vitals (10d)

The reference device goes into `docs/CAPACITY.md` as the definition of done,
with the targets the spec gives. Two of them need the honest footnote the
spec itself asks for:

- **editor interactive ≤4.0s warm / ≤7s cold**, with the textarea typable
  ≤2.5s always. Monaco is ~1.0 MB gzipped after stripping the TS service —
  about three seconds of transfer alone on 3 Mbps. The budget is stated as
  warm-and-cold rather than implying a cold four seconds.
- **LCP ≤2.0s, ≤2.5s for the problem statement.** The statement page is
  slower and the budget says so rather than averaging the two.

**Field vitals** report through `web-vitals@^4` to `POST /api/vitals`. The
decision that matters is where they land, and it is a privacy decision:

> Vitals go to a **Redis histogram keyed by route and metric**, not to a
> table keyed by user.

A `WebVital` row per page view per student is a browsing history with a
performance column. The questions this data answers — "is LCP p75 within
budget on the problem page" — need the route and the number, and nothing
else. So the endpoint accepts `{ metric, value, route }`, drops anything
else, and increments a bucketed Redis counter. There is no user id in the
key, which also means the endpoint needs no session and can be sampled from a
signed-out public page.

Rate limited per IP hash, because an unauthenticated POST endpoint that
writes is an invitation.

**Lighthouse CI** runs in the workflow against a production build with the
reference-device throttling, asserting the budgets above. It is a separate
job from the axe one: Lighthouse is slow and flaky under contention, and a
flaky gate on the same job as the a11y gate makes people re-run both.

## 6. Topology, backups, deploys (10e)

### 6.1 Compose files

Three, one per host role, named for the host rather than the environment —
`deploy/compose.app.yml`, `compose.db.yml`, `compose.judge.yml`. The spec's
topology verbatim:

- **app host**: Caddy with **HTTP/2** (SSE over HTTP/1.1 hits the
  ~6-connection-per-origin cap and a student with several tabs starves their
  own page loads), 2 web replicas, scheduler, Redis with AOF `everysec`,
  MinIO.
- **db host**: PG17 + pgBackRest. **No PgBouncer** until web replicas exceed
  4 — written into the file as a comment so nobody adds it "while they are in
  there".
- **judge hosts**: 2–3, rebuilt weekly from the Phase 2 image.

Base images pinned by digest. Secrets through `sops+age` and Docker secrets;
no `.env` in git, which `tests/repo/` already enforces.

### 6.2 Backups: one timestamped set, always together

```
recx-backup-YYYYMMDDTHHMMSSZ/
  database.dump        pg_dump -Fc
  testdata.tar.zst     the test-data store at the same instant
  MANIFEST.txt         both digests, the migration head, the image digest, the host
```

The spec's reasoning, carried because it is the whole point: **a dump
restored next to a test-data snapshot from a different hour leaves
submissions judged against test cases that no longer exist, and that is only
ever discovered mid-incident.** So `backup.sh` captures both or neither, and
`verify-backup.sh` refuses a set whose MANIFEST digests do not match its
files.

Plus pgBackRest WAL archiving: RPO 5 min, RTO 2 hours, a full snapshot
immediately before every contest and 5-minute incrementals during it.
Retention 7 daily / 4 weekly / 12 monthly, encrypted with `age` **before**
leaving the host, with offsite retention matching the DPDP schedule rather
than "forever".

**The drill is the deliverable.** `scripts/ops/restore-drill.sh` restores a
set into a scratch database, runs the drift check against it, counts a
handful of rows that must be there, and prints a line for the runbook. It
runs *here*, in the WSL mirror, against a real backup of the dev database —
that part needs no second host, and it is the part that has historically been
skipped.

### 6.3 Deploys

Deploy by image digest, health-gated rolling restart one replica at a time.
Migrations are a **separate supervised step** with `RUN_MIGRATIONS=false` by
default, preceded by a backup, using expand/contract so the previous image
still runs.

The spec's reason, which is the reason this is not negotiable:
auto-migrating on boot runs migrations N times concurrently during a rolling
deploy, and applies a bad migration before anyone reads the error.

`scripts/ops/deploy.sh` queries `/api/health` for `activeContest` and refuses
while one is live unless `FORCE_DEPLOY=1`.

## 7. Open questions this phase must record

1. **`Problem.statementVersion` is a new column on a Phase 1 table.** A
   counter the publish path bumps. The alternative — keying the cache on the
   frozen `ProblemVersion.id` — was rejected: a statement typo fix would need
   a new frozen version, and authors would stop fixing typos.
2. **Field vitals have no user id, deliberately**, so "which students see a
   slow editor" is unanswerable. The trade is stated: a per-student vitals
   table would answer it and would also be a browsing history.
3. **Two of the eight alert rules cannot be produced on a laptop.** Named,
   with what is asserted instead.
4. **The monitoring VM does not exist here.** The Prometheus and Grafana
   configuration is written and validated by `promtool check rules`, which
   runs without a server; the scrape itself is NOT RUN.
5. **GlitchTip, not Sentry SaaS**, so stack traces containing student data
   stay on college infrastructure. Configured, not run here.
6. **`style-src 'unsafe-inline'` stays.** Monaco injects a runtime stylesheet
   through `document.createElement('style')` that a nonce cannot cover. The
   spec's instruction is explicit: try the nonce-only policy, and if the
   editor breaks keep `style-src 'unsafe-inline'` and document the trade-off
   rather than spending a week on it. A low-severity finding against a
   non-working editor is not a trade worth making.

## 8. Tests the phase is gated on

1. **Every spec-named metric exists**, with the right type and label set,
   asserted against the live registry rather than a list.
2. **No metric label can identify a student** — over the registry, and a
   mutation check that the rule bites.
3. **`/api/health` answers while the database is down**, with `ok: false` and
   a 200 (a health endpoint that 500s tells a load balancer to stop asking).
4. **`activeContest` is true during a live contest** and false outside it,
   against a seeded contest.
5. **Every alert rule fires** against its condition, six real and two
   synthetic, by `scripts/ops/fire-alerts.ts`.
6. **`promtool check rules`** passes over `alerts.yml`.
7. **No authenticated payload is cached without a user id in the key** —
   `tests/repo/cache-keys.test.ts`, with a mutation check.
8. **A statement's cache key changes when the statement changes** and not
   when anything else does.
9. **The leaderboard renders with Redis down**, from `XpBucket`.
10. **`/api/vitals` stores no user id**, accepts only the three fields, and
    is rate limited.
11. **`verify-backup.sh` refuses a tampered set** — a changed byte in either
    file, and a MANIFEST that disagrees.
12. **The restore drill completes into a scratch database**, with no drift,
    recorded with a date and a name.
13. **The drift check** (`prisma migrate diff --exit-code`) passes in CI.
14. **Lighthouse CI** meets the reference-device budgets.

Manual, from the spec's own line: pull the plug on a judge host mid-contest
and confirm leases reclaim, the reconciler re-enqueues and no submission is
lost; restart Redis and confirm the same. **Both are producible here** — the
WSL mirror runs a real worker and a real Redis, and `kill -9` on the worker
is the plug. Recorded in `docs/RUNBOOK.md` §3 with a date.

## 9. Sharp edges — the five things most likely to be built wrongly

1. **A self-reported `judge_worker_heartbeat_age_seconds`.** It goes missing
   rather than high when the worker dies, which is the one case it exists
   for. Derive it from `JudgeNode` in the scheduler.
2. **A metric label carrying an id.** `judge_verdict_total{verdict,language}`
   is bounded; `{submissionId}` would be unbounded AND a per-student record
   in the least controlled datastore in the system.
3. **`/metrics` exposed publicly.** Queue depths and host names are an
   attacker's reconnaissance and a student's distraction.
4. **A cached authenticated payload.** `unstable_cache` with no user id in
   the key is the one caching bug that serves another student's data. Hence a
   fence rather than a convention.
5. **A backup script that has never been restored.** Every such script in the
   world works until the morning it is needed. The drill is the gate item.
