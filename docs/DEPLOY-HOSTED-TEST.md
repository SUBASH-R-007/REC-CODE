# A hosted test deployment: Vercel + Render

**NOT RUN HERE.** Nothing in this document has been applied yet; it is
written from Vercel's and Render's own references, and the first apply is
the test of it. The files it describes are `apps/web/vercel.json` and
`render.yaml`.

This is a **temporary** deployment for trying the platform out with real
people on real URLs. The final deployment is a Linux server you control:
`deploy/compose.app.yml`, `compose.db.yml`, `compose.judge.yml`, with
`docs/RUNBOOK.md` §2.13 for backups and deploys. Everything below is
chosen for "cheap, quick, throw it away afterwards", and §6 lists every
way it differs from the real thing, because a test deployment that is
mistaken for production is worse than no test deployment.

---

## 1. What runs where

| Piece | Where | Why there |
|---|---|---|
| `apps/web` (Next.js) | **Vercel** | it is a Next.js app; Vercel builds and serves it with no work from us |
| PostgreSQL 17 | **Render** | Postgres is truth (§2.1); everything else is replaceable |
| Key Value (Redis) | **Render** | BullMQ queues, the sliding-window rate limiter, progress pub/sub — transport only |
| `apps/scheduler` | **Render** worker | the reconciler every 10 s, the nightly sweeps, the daily challenge, leaderboard freezes |
| `apps/judge-worker` | **nowhere here** | see §4 — a managed container platform cannot run the sandbox |

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

Two secrets must be **identical** in both halves, or the two halves
disagree about the same data: `IP_HASH_PEPPER` (an IP hash written by the
scheduler must equal the one the web app computes) and
`EXPORT_SIGNING_SECRET` (a signed export minted by one is verified by the
other). Generate each once:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Keep them in your password manager for the life of the deployment. Never
in the repository, never in a Vercel or Render log.

### 3.2 Render: the database, the queue and the scheduler

1. Push the branch you want to deploy.
2. Render → **Blueprints** → **New Blueprint Instance** → pick this
   repository. It reads `render.yaml`.
3. It will ask for the three `sync: false` values: `APP_URL`,
   `IP_HASH_PEPPER`, `EXPORT_SIGNING_SECRET`. `APP_URL` is not known yet —
   put `https://example.invalid` for now and correct it in 3.5.
4. Apply. Note, from the Render dashboard:
   - the database's **external** connection string (for migrations and the
     seed, which you run from your machine),
   - the Key Value **external** URL (`rediss://…`) if you will attach a
     judge worker (§4); the scheduler uses the internal one automatically.

The scheduler is on the `starter` plan because Render has no free worker.
If you do not want to pay for it, delete that service block before you
apply — but know what sleeps without it: no reconciler (a submission whose
BullMQ job is lost is never re-enqueued), no judge node ever marked
`OFFLINE`, no daily challenge, no leaderboard freeze, no inactivity sweep,
no email drain. You can also run it from your own machine for an hour at a
time, which is enough for a demo:

```bash
npx pnpm@9.15.9 --filter @recx/scheduler build
```

then `node apps/scheduler/dist/main.js` with `DATABASE_URL_DIRECT`,
`DATABASE_URL` and `REDIS_URL` set to the hosted values (`--once` for a
single tick, which is also how you prove it can reach everything).

### 3.3 Migrate and seed, from your machine

Migrations are a direct, non-pooled connection and are never run by the
web app. With the external connection string in hand:

```bash
DATABASE_URL="<render external url>" DATABASE_URL_DIRECT="<render external url>" npx pnpm@9.15.9 db:migrate
```

Then the seed, which creates the accounts, the language configs, the
default theme and the published `two-sum` problem. It reads
`apps/web/.env.local`, so set the hosted URLs and the two passwords for
that one command rather than editing the file:

```bash
DATABASE_URL="<render external url>" DATABASE_URL_DIRECT="<render external url>" REDIS_URL="<render external rediss url>" npx pnpm@9.15.9 db:seed
```

The seed is idempotent and never resets an existing account's password.
`SEED_ADMIN_PASSWORD` and `SEED_STUDENT_PASSWORD` come from
`apps/web/.env.local`; for a deployment other people can reach, set them to
something that is not your development password — they are the sign-in
credentials for `RECADMIN01`, `RECADMIN02`, `RECSUPER02` and the seeded
students (§1.3 of the runbook lists them).

### 3.4 Vercel: the web app

1. Vercel → **Add New Project** → this repository.
2. **Root Directory: `apps/web`.** That is the whole monorepo
   configuration: Vercel sees the pnpm workspace, installs from the
   repository root, and `apps/web/vercel.json` gives it the rest.
3. Node version: **22** (`.node-version` at the repository root; set it in
   the project settings too if Vercel does not pick it up).
4. Set the environment variables in §5, for every environment you will
   use (Production and Preview both, if you deploy previews).
5. Deploy.

### 3.5 Close the loop

Set `APP_URL` on Vercel **and** on the Render scheduler to the deployment's
real URL (`https://<project>.vercel.app`), then redeploy both. It is not
cosmetic: `APP_URL` is what the app uses to build absolute links, and what
a judge worker is told to dial back to.

### 3.6 Prove it, in this order

```bash
curl -s https://<project>.vercel.app/api/health
```

`{"ok":true,"db":"up","redis":"up","migrations":"current"}` — anything else
stops here. `"db":"down"` is almost always the connection string (§5 note
on `connection_limit`), `"migrations"` not `current` means 3.3 did not run
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
   `RECX_APP_URL=https://<project>.vercel.app`, `REDIS_URL=<render
   external rediss url>`, and keep `RECX_DEV_ALLOW_UNHARDENED_HOST=1`.
3. Start it the usual way (runbook §1.5).

What you get: `RUN`, `PRACTICE` and `REJUDGE` are judged for real.
`ASSESSMENT` and `CONTEST` stay queued, because those lanes are withheld
from a node that fails the kernel hardening check, and the override that
allows them (`JUDGE_ALLOW_UNHARDENED_NODES`) is refused outright with
`NODE_ENV=production`. That is the correct behaviour: an exam must not be
judged on a laptop.

Expect it to be slower than local: every claim, blob fetch and result is a
round trip to Vercel instead of to `localhost`.

## 5. Environment variables

### Vercel (`apps/web`)

| Variable | Value | Notes |
|---|---|---|
| `DATABASE_URL` | Render external URL **plus** `?connection_limit=1&pool_timeout=20` (`&` if the URL already has a query) | Render has no connection pooler and every serverless invocation opens its own client; without the limit the free database runs out of connections under a handful of users |
| `DATABASE_URL_DIRECT` | the same URL, without `connection_limit` | referenced by `packages/db/prisma/schema.prisma`; set it so nothing has to guess |
| `REDIS_URL` | Render Key Value **external** `rediss://…` | the default is `redis://127.0.0.1:6379`, which on Vercel is nothing at all |
| `IP_HASH_PEPPER` | the shared secret from 3.1 | ≥ 16 characters; the same value as Render's |
| `EXPORT_SIGNING_SECRET` | the shared secret from 3.1 | ≥ 32 characters; the app **refuses to start** in production if this is still the `dev-only-…` default |
| `APP_URL` | `https://<project>.vercel.app` | |
| `TRUST_PROXY` | `true` | without it there is no client IP at all, so the per-address rate limit never applies. Safe here because Vercel overwrites `X-Forwarded-For` at its edge |
| `TESTDATA_DRIVER` | `s3` (see §5.1) | `local` writes to the filesystem, which on Vercel is read-only and per-invocation |
| `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_REGION` | your bucket | required when the driver is `s3`; the app throws on the first use otherwise |
| `METRICS_TOKEN` | **leave unset** | unset disables `/api/metrics`, which is what you want on a public test URL; the numbers would be wrong anyway (§6) |
| `JUDGE_ALLOW_UNHARDENED_NODES` | **never set it** | refused with `NODE_ENV=production` |
| `MAIL_TRANSPORT` | — | the web app does not send mail; the scheduler drains the outbox |

`NODE_ENV=production` is set by Vercel; do not set it yourself.

### Render

The blueprint wires `DATABASE_URL`, `DATABASE_URL_DIRECT` and `REDIS_URL`
from the database and the Key Value instance, and asks for `APP_URL`,
`IP_HASH_PEPPER` and `EXPORT_SIGNING_SECRET`. Nothing else is needed.

### 5.1 Test data needs object storage

Problem test cases are content-addressed blobs
(`apps/web/src/lib/testdata/`). The `local` driver writes them to disk,
which works on one Linux server with a volume and cannot work on Vercel.
Any S3-compatible bucket does: Cloudflare R2, Backblaze B2, AWS S3, a
MinIO you already run. Create a **private** bucket, make an access key
scoped to it, and set the five `S3_*` variables.

If you skip this, the deployment still signs in, browses, and runs
contests and aptitude — but anything that reads or writes test cases
(authoring, importing, judging) fails on first use. Set it before you seed,
because the seed writes `two-sum`'s test data through the same store.

## 6. How this differs from the real deployment

| | Hosted test (this document) | The Linux server (`deploy/`) |
|---|---|---|
| Judging | nothing here can judge; attach your own machine (§4) | dedicated judge hosts, isolate 2.7, hardened kernel, sensitive lanes allowed |
| Web process | serverless, replicated per invocation | one container behind Caddy |
| Metrics | gauges are meaningless (each invocation has its own registry) and the endpoint is disabled | one process per metric owner, scraped by Prometheus (§2.12) |
| Database | Render free Postgres, **deleted after 30 days**, no pooler, no backups | PostgreSQL 17 with PgBouncer and pgBackRest (§2.13) |
| Redis | free Key Value, no persistence | AOF `everysec` |
| Test data | an S3 bucket you create by hand | the store configured in `compose.app.yml` |
| Secrets | Vercel and Render environment variables | Docker secrets, no credential anywhere in `deploy/` |
| Backups | **none** | nightly full, hourly incremental, verified, restore-drilled |
| Exams | do not run an assessment here: the sensitive lanes have no node | the only place an assessment belongs |

## 7. Taking it down

Delete the Vercel project, then the Render blueprint instance (which
deletes the database and the Key Value instance with it). Rotate anything
you put in their environment variables — a test deployment's secrets are
not test secrets once a student has signed in with them. If you attached a
judge node, remove it from `/admin/judge` first so the fleet is not left
with a node that will never answer again.
