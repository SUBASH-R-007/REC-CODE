# A hosted test deployment: Vercel + Render, free tiers only

**NOT RUN HERE.** Nothing in this document has been applied yet; it is
written from Vercel's and Render's own references, and the first apply is
the test of it. The files it describes are `apps/web/vercel.json` and
`render.yaml`.

This is a **temporary** deployment for trying the platform out with real
people on real URLs, on free plans and nothing else. The final deployment
is a Linux server you control: `deploy/compose.app.yml`,
`compose.db.yml`, `compose.judge.yml`, with `docs/RUNBOOK.md` §2.13 for
backups and deploys. Everything below is chosen for "free, quick, throw it
away afterwards", and §6 lists every way it differs from the real thing,
because a test deployment that is mistaken for production is worse than no
test deployment.

---

## 1. What runs where

| Piece | Where | Why there |
|---|---|---|
| `apps/web` (Next.js) | **Vercel**, free | it is a Next.js app; Vercel builds and serves it with no work from us |
| PostgreSQL 17 | **Render**, free | Postgres is truth (§2.1 of the runbook); everything else is replaceable |
| Key Value (Redis) | **Render**, free | BullMQ queues, the sliding-window rate limiter, progress pub/sub — transport only |
| `apps/scheduler` | **you tick it** (§3.3) | Render has no free worker, and a free web service sleeps; §3.3 is the hole this leaves and how to fill it |
| `apps/judge-worker` | **nowhere here** | see §2 — a managed container platform cannot run the sandbox |

Total cost: nothing. Total durability: none — the free database is deleted
after 30 days and the free Key Value has no persistence at all.

## 2. The one thing that does not work, and the one way around it

**No managed platform can run the judge.** A submission is executed by
`isolate` 2.7, which needs a setuid binary, cgroup v2 delegation, kernel
namespaces and a tmpfs box root on a host you control. Vercel is
serverless; Render runs unprivileged containers. Neither can give isolate
what it needs, and the platform is built so that student code **never**
runs in the web process — that is not a limitation to work around, it is
the design (`docs/JUDGE.md`).

So in this deployment, a submission is accepted, queued, and stays
`QUEUED`. That is a state the product already handles honestly: `/judge`
reports the fleet, the student's workspace says the judge is unavailable
rather than inventing a verdict, and nothing is penalised for waiting.

**The way around it, and it is a good one:** run the judge worker on your
own Linux machine — the WSL2 mirror you develop in — pointed at the hosted
stack. The sandbox is real, the verdicts are real, and the only cost is
that your laptop must be awake. §4 has the commands.

Do **not** reach for `RECX_DRIVER=mock` to make verdicts appear. The
worker refuses to start with `RECX_DRIVER=mock` and `NODE_ENV=production`
(`apps/judge-worker/src/boot.ts`), and that refusal is deliberate: a
fabricated `AC` in front of a student or a recruiter is worse than a
submission that is honestly still queued.

## 3. Standing it up

### 3.1 Secrets, first

Two secrets must be **identical** everywhere they are used, or the pieces
disagree about the same data: `IP_HASH_PEPPER` (an IP hash written by a
scheduler tick must equal the one the web app computes) and
`EXPORT_SIGNING_SECRET` (a signed export minted by one is verified by the
other). Generate each once:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Keep them in your password manager for the life of the deployment. Never
in the repository, never in a Vercel or Render log.

### 3.2 Render: the database and the queue

1. Push the branch you want to deploy.
2. Render → **Blueprints** → **New Blueprint Instance** → pick this
   repository. It reads `render.yaml`, which asks for nothing: it creates a
   free PostgreSQL 17 database and a free Key Value instance, and no
   service that takes an environment variable.
3. Apply, then note from the dashboard:
   - the database's **external** connection string — Vercel dials in from
     outside Render, and so do your migrations and the seed,
   - the Key Value **external** URL (`rediss://…`).

If Render will not give you an externally reachable Key Value on the free
plan, use any free Redis that speaks the real protocol (Upstash's
Redis-protocol endpoint, for instance) and set `REDIS_URL` to that instead.
What BullMQ needs is blocking commands and Lua, which an HTTP-only Redis
API cannot provide.

### 3.3 The scheduler: what sleeps, and two free ways to tick it

`render.yaml` deliberately creates no scheduler, because Render has no free
worker plan and a free web service sleeps after fifteen minutes without
traffic — which for a process whose whole job is to tick is worse than not
running it. Nothing below runs unless you run it:

| Job | What its absence looks like |
|---|---|
| reconciler (every 10 s) | a submission whose BullMQ job was lost — a Key Value restart, and the free plan has no persistence — is never re-enqueued, so it sits at `QUEUED` for ever |
| judge node sweep | a worker you detached stays `ONLINE` in `/admin/judge` and keeps being offered jobs it will never claim; its leases are never expired |
| daily challenge | `/dashboard` has no challenge for today |
| leaderboard freeze | the weekly and monthly boards are never frozen, so last period's standings never become final |
| contest ranking | a finished contest's final ranks and rating changes are never applied |
| attempt sweep | an assessment attempt a student abandoned is never auto-submitted at its deadline |
| integrity SLA | the 72-hour review clock never fires, so a flagged submission is never released to the public leaderboard as `CLEARED` — the one case where a missing tick is worse for a student than for the platform |
| mock sweep | aptitude mock sittings are not auto-submitted and pattern statistics are never restated |
| inactivity sweep (02:00) | nobody is ever restricted or reactivated by policy; the whole Phase 8 engine is inert |
| readiness snapshot (02:30) | placement readiness tiers never refresh |
| email drain | queued security emails are never sent (harmless with `MAIL_TRANSPORT=log`, which is all a test deployment should use) |

A tick runs whatever is due, so one `--once` run does all of the above that
is currently owed. Build it first:

```bash
npx pnpm@9.15.9 --filter @recx/scheduler build
```

**From your own machine, while you are testing.** One tick, with the
hosted values (this is also the quickest proof that the scheduler can reach
everything):

```bash
DATABASE_URL_DIRECT="<render external url>" REDIS_URL="<render external rediss url>" IP_HASH_PEPPER="<the shared pepper>" node apps/scheduler/dist/main.js --once
```

Drop `--once` to leave it running in a loop for as long as your machine is
awake. `--dry-run` reports what it would do and changes nothing.

**From a scheduled GitHub Actions workflow,** if you want the deployment to
keep itself tidy without your laptop. Free for a public repository; the
granularity is coarse (GitHub's schedules are best-effort and no finer than
five minutes), which is fine for every job above except the reconciler's
10-second window. Put the three values in the repository's **secrets** and
add a workflow of your own — it is not committed here, because a scheduled
job that talks to somebody's database belongs to whoever owns the database:

```yaml
name: scheduler tick
on:
  schedule:
    - cron: "*/10 * * * *"
  workflow_dispatch:
jobs:
  tick:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 9.15.9 }
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: pnpm install --frozen-lockfile
      - run: pnpm --filter @recx/scheduler build
      - run: node apps/scheduler/dist/main.js --once
        env:
          DATABASE_URL_DIRECT: ${{ secrets.HOSTED_DATABASE_URL }}
          REDIS_URL: ${{ secrets.HOSTED_REDIS_URL }}
          IP_HASH_PEPPER: ${{ secrets.HOSTED_IP_HASH_PEPPER }}
```

A tick that fails exits non-zero, so a red run in that workflow is the
signal that something in the hosted stack is unreachable.

### 3.4 Migrate and seed, from your machine

Migrations are a direct, non-pooled connection and are never run by the web
app. With the external connection string in hand:

```bash
DATABASE_URL="<render external url>" DATABASE_URL_DIRECT="<render external url>" npx pnpm@9.15.9 db:migrate
```

Then the seed, which creates the accounts, the language configs, the
default theme and the published `two-sum` problem:

```bash
DATABASE_URL="<render external url>" DATABASE_URL_DIRECT="<render external url>" REDIS_URL="<render external rediss url>" npx pnpm@9.15.9 db:seed
```

The seed reads `apps/web/.env.local` for the rest, is idempotent, and never
resets an existing account's password. `SEED_ADMIN_PASSWORD` and
`SEED_STUDENT_PASSWORD` are the sign-in credentials for `RECADMIN01`,
`RECADMIN02`, `RECSUPER02` and the seeded students (§1.3 of the runbook
lists them) — for a deployment other people can reach, set them to
something that is not your development password.

Seed **after** §5.1, because the seed writes `two-sum`'s test data through
the same object store the app reads it from.

### 3.5 Vercel: the web app

1. Vercel → **Add New Project** → this repository.
2. **Root Directory: `apps/web`.** That is the whole monorepo
   configuration: Vercel sees the pnpm workspace, installs from the
   repository root, and `apps/web/vercel.json` gives it the rest.
3. Node version: **22** (`.node-version` at the repository root; set it in
   the project settings too if Vercel does not pick it up).
4. Set the environment variables in §5, for every environment you will use
   (Production and Preview both, if you deploy previews).
5. Deploy.

### 3.6 Close the loop

Set `APP_URL` on Vercel to the deployment's real URL
(`https://<project>.vercel.app`) and redeploy. It is not cosmetic:
`APP_URL` is what the app uses to build absolute links, and what a judge
worker is told to dial back to.

### 3.7 Prove it, in this order

```bash
curl -s https://<project>.vercel.app/api/health
```

`{"ok":true,"db":"up","redis":"up","migrations":"current"}` — anything else
stops here. `"db":"down"` is almost always the connection string (§5's note
on `connection_limit`); `"migrations"` not `current` means §3.4 did not run
against this database.

Then, in a browser: sign in as `RECADMIN01` → `/admin`, sign in as a seeded
student → `/dashboard`. Sign-in exercises Argon2id (a native module),
Redis (the rate limiter), Postgres (the account) and the session cookie in
one request, so it is the single best smoke test this platform has. If it
answers "Something went wrong … quote reference …", the reference is in the
Vercel function log next to the exception.

## 4. Judging in the hosted deployment, for real

Your WSL2 machine already has isolate 2.7 and the toolchains. Point it at
the hosted stack and it becomes the deployment's judge node.

1. Register a node against the hosted database (writes only the token's
   sha256; the token itself is shown once):

```bash
DATABASE_URL="<render external url>" npx pnpm@9.15.9 --filter @recx/web judge-node
```

2. In the mirror's `apps/judge-worker/.env.local` (inside WSL2, never
   committed): `RECX_NODE_ID` and `RECX_NODE_TOKEN` from step 1,
   `RECX_APP_URL=https://<project>.vercel.app`, `REDIS_URL=<render external
   rediss url>`, and keep `RECX_DEV_ALLOW_UNHARDENED_HOST=1`.
3. Start it the usual way (runbook §1.5).

What you get: `RUN`, `PRACTICE` and `REJUDGE` are judged for real.
`ASSESSMENT` and `CONTEST` stay queued, because those lanes are withheld
from a node that fails the kernel hardening check, and the override that
allows them (`JUDGE_ALLOW_UNHARDENED_NODES`) is refused outright with
`NODE_ENV=production`. That is the correct behaviour: an exam must not be
judged on a laptop.

Expect it to be slower than local: every claim, blob fetch and result is a
round trip to Vercel instead of to `localhost`. And when you detach it,
remove it from `/admin/judge` yourself — with no scheduler ticking, nothing
else will notice it is gone (§3.3).

## 5. Environment variables

### Vercel (`apps/web`)

| Variable | Value | Notes |
|---|---|---|
| `DATABASE_URL` | Render external URL **plus** `?connection_limit=1&pool_timeout=20` (`&` if the URL already has a query) | Render has no connection pooler and every serverless invocation opens its own client; without the limit the free database runs out of connections under a handful of users |
| `DATABASE_URL_DIRECT` | the same URL, without `connection_limit` | referenced by `packages/db/prisma/schema.prisma`; set it so nothing has to guess |
| `REDIS_URL` | Render Key Value **external** `rediss://…` | the default is `redis://127.0.0.1:6379`, which on Vercel is nothing at all |
| `IP_HASH_PEPPER` | the shared secret from §3.1 | ≥ 16 characters |
| `EXPORT_SIGNING_SECRET` | the shared secret from §3.1 | ≥ 32 characters; the app **refuses to start** in production if this is still the `dev-only-…` default |
| `APP_URL` | `https://<project>.vercel.app` | |
| `TRUST_PROXY` | `true` | without it there is no client IP at all, so the per-address rate limit never applies. Safe here because Vercel overwrites `X-Forwarded-For` at its edge |
| `TESTDATA_DRIVER` | `s3` (see §5.1) | `local` writes to the filesystem, which on Vercel is read-only and per-invocation |
| `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_REGION` | your bucket | required when the driver is `s3`; the app throws on the first use otherwise |
| `METRICS_TOKEN` | **leave unset** | unset disables `/api/metrics`, which is what you want on a public test URL; the numbers would be wrong anyway (§6) |
| `JUDGE_ALLOW_UNHARDENED_NODES` | **never set it** | refused with `NODE_ENV=production` |

`NODE_ENV=production` is set by Vercel; do not set it yourself.

### A scheduler tick (§3.3)

`DATABASE_URL_DIRECT`, `REDIS_URL` and `IP_HASH_PEPPER` — the same pepper
as Vercel's. Add `MAIL_TRANSPORT=log` if you want the email drain to do
something visible and harmless.

### Render

Nothing. The blueprint creates a database and a Key Value instance, and
neither takes an environment variable from us.

### 5.1 Test data needs object storage

Problem test cases are content-addressed blobs
(`apps/web/src/lib/testdata/`). The `local` driver writes them to disk,
which works on one Linux server with a volume and cannot work on Vercel.
Any S3-compatible bucket does: Cloudflare R2, Backblaze B2, AWS S3, a
MinIO you already run. Create a **private** bucket, make an access key
scoped to it, and set the five `S3_*` variables.

If you skip this, the deployment still signs in, browses, and runs contests
and aptitude — but anything that reads or writes test cases (authoring,
importing, judging) fails on first use.

## 6. How this differs from the real deployment

| | Hosted test (this document) | The Linux server (`deploy/`) |
|---|---|---|
| Judging | nothing here can judge; attach your own machine (§4) | dedicated judge hosts, isolate 2.7, hardened kernel, sensitive lanes allowed |
| The scheduler | nothing ticks unless you tick it (§3.3) | one worker, every 10 s, with the nightly jobs |
| Web process | serverless, replicated per invocation | one container behind Caddy |
| Metrics | gauges are meaningless (each invocation has its own registry) and the endpoint is disabled | one process per metric owner, scraped by Prometheus (§2.12) |
| Database | Render free Postgres, **deleted after 30 days**, no pooler, no backups, open to the internet | PostgreSQL 17 with PgBouncer and pgBackRest (§2.13), reachable only from the app network |
| Redis | free Key Value, no persistence | AOF `everysec` |
| Secrets | Vercel environment variables | Docker secrets, read as `*_FILE` (`packages/shared/src/env-file.ts`), no credential anywhere in `deploy/` |
| Backups | **none** | nightly full, hourly incremental, verified, restore-drilled |
| Exams | do not run an assessment here: no node serves the sensitive lanes, and no sweep auto-submits an abandoned attempt | the only place an assessment belongs |

## 7. Taking it down

Delete the Vercel project, then the Render blueprint instance (which
deletes the database and the Key Value instance with it). Delete any
scheduled workflow and the repository secrets it used. Rotate anything you
put in an environment variable — a test deployment's secrets are not test
secrets once a student has signed in with them. If you attached a judge
node, remove it from `/admin/judge` first.
