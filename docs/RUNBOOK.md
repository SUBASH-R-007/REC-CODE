# REC Code — Runbook

How to run REC Code locally, how to operate it, and the record of every
phase gate. The audience is whoever is on the hook when something breaks the
evening before an assessment.

---

## 1. Local development (Windows + WSL2)

### Topology

| Piece | Where it runs | Why |
|---|---|---|
| `apps/web` (Next.js) | Windows, natively | the editor loop; `http://localhost:3000` |
| `apps/scheduler` | Windows, natively (or WSL2) | reconciler + node sweep |
| PostgreSQL 17 | WSL2, **port 5433** | a Windows-native Postgres (the LMS's) usually owns 5432 |
| Redis 7 | WSL2, port 6379 | AOF `everysec`, as in production |
| isolate 2.7, toolchains, `apps/judge-worker` | WSL2 | Linux-only: cgroup v2, namespaces, setuid isolate |

Windows reaches the WSL2 services at `127.0.0.1` — not at `localhost`, which
Windows resolves to `::1` first, where nothing in WSL2 is listening (§1.1).
The distribution also has to be held open, or those services are up only
while some `wsl` command happens to be running (§1.5). Docker
Desktop does not start on the main development machine, so these services
run natively in WSL2 (`docs/OPEN-QUESTIONS.md` item 9); `compose.yaml` is the
container alternative on machines where Docker works (§1.7).

Windows and Linux `node_modules` cannot be shared (Prisma engines, argon2,
esbuild and rollup are native), so Linux work happens in a **native mirror**
of the checkout at `~/recx` inside WSL2, refreshed by
`scripts/dev/linux-sync.sh`.

### 1.1 One-time setup — WSL2 side

1. Install Ubuntu 24.04 under WSL2 (the distribution is named `Ubuntu`
   below). Use **mirrored networking**, so `localhost` works in both
   directions — the judge worker in WSL2 must reach the web app on Windows.
   In `%UserProfile%\.wslconfig`:

   ```ini
   [wsl2]
   networkingMode=mirrored
   ```

   then `wsl --shutdown`. Without it, WSL2 cannot reach Windows'
   `localhost:3000`; use the Windows host address instead
   (`ip route show default | awk '{print $3}'` inside WSL2) in
   `RECX_APP_URL`, and allow port 3000 through the Windows firewall for the
   WSL adapter.

   Two things about this direction — Windows reaching WSL2 — are worth
   knowing before they cost an afternoon, because both look like a broken
   application and neither is (§1.8 has the symptoms):

   - **Dial `127.0.0.1`, never `localhost`.** Windows resolves `localhost`
     to `::1` first and WSL2 serves only the IPv4 loopback, so a connection
     to `localhost:5433` waits for a timeout on `::1` and Prisma reports
     `P1001 Can't reach database server` with the database running. Every
     `.env.example` here is written with `127.0.0.1` for that reason.
   - **The distribution does not stay up by itself.** WSL stops it within
     seconds of its last session exiting — systemd being PID 1 does not
     prevent it — and PostgreSQL, Redis and isolate go with it. Hold it open
     with `scripts/dev/stack-up.ps1` (§1.5), once per Windows session.

2. Services — PostgreSQL 17 (PGDG), Redis 7, Node 22 (checksum-verified),
   the `recx` role and the `recx` + `recx_test` databases:

   ```bash
   cd /mnt/c/Users/<you>/OneDrive/Documents/GitHub/REC-CODE
   sudo bash scripts/dev/wsl-services.sh
   ```

3. The sandbox — isolate pinned by tag and commit, its config, the RAM box
   root and the synthetic `/etc` (`RECJUDGE_SLOTS` sizes the box root;
   default 4):

   ```bash
   sudo bash infra/judge/install-isolate.sh
   ```

4. Toolchains — every pinned toolchain into `/opt/toolchains` (§2.6): GCC
   13.2.0 (+ precompiled `<bits/stdc++.h>`) and CPython 3.12.6 + numpy 1.26.4
   built from GPG-verified sources (GCC takes 15–25 min on 8+ cores), then
   Temurin 21.0.4+7 (+ AppCDS archive), Kotlin 2.0.21, PyPy 7.3.17, Node.js
   22.11.0, Go 1.23.2 (+ prebuilt standard library) and testlib 0.9.41 from
   checksum-verified vendor releases (a few minutes). Logs in
   `/var/tmp/build-*.log`; already-installed toolchains are skipped:

   ```bash
   sudo bash infra/judge/toolchains/build-all.sh            # everything
   sudo bash infra/judge/toolchains/build-all.sh node go    # selected steps
   ```

   From PowerShell, root inside WSL2 is
   `wsl -d Ubuntu -u root -- bash /mnt/c/…/REC-CODE/infra/judge/toolchains/build-all.sh`.
   Then prove them inside isolate (§2.6):
   `bash infra/judge/toolchains/verify-toolchains.sh` from the mirror (§1.4).

If bash reports `$'\r': command not found`, a script has Windows line
endings: the checkout should be LF (`.gitattributes`), but files written on
Windows before the first commit may not be. Fix the copy with
`sed -i 's/\r$//' <script>` and re-run.

### 1.2 One-time setup — Windows side

The globally installed pnpm 10 fails to self-switch on Windows, so every
command runs as `npx pnpm@9.15.9 …` (`docs/OPEN-QUESTIONS.md` item 8).

```powershell
npx pnpm@9.15.9 install
```

Environment files (all gitignored; see the root `.env.example` for the map):

| Copy | To | Fill in |
|---|---|---|
| `apps/web/.env.example` | `apps/web/.env.local` | `IP_HASH_PEPPER`, `SEED_ADMIN_PASSWORD`, `SEED_STUDENT_PASSWORD`, `JUDGE_DEV_NODE_TOKEN` |
| `apps/judge-worker/.env.example` | `apps/judge-worker/.env.local` | `RECX_NODE_TOKEN` (= `JUDGE_DEV_NODE_TOKEN`) |
| the Prisma lines of `.env.example` | `packages/db/.env` | nothing (development values) |

Generate each secret with
`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
The scheduler needs no file of its own: in development it falls back to
`apps/web/.env.local`.

### 1.3 Database

```powershell
npx pnpm@9.15.9 db:migrate        # apply migrations to recx (packages/db/.env)
npx pnpm@9.15.9 db:migrate:dev    # only when changing schema.prisma
npx pnpm@9.15.9 --filter @recx/web exec tsx --conditions=react-server scripts/seed.ts
```

The seed (`apps/web/scripts/seed.ts`) is idempotent and needs the
`react-server` condition because it reuses the app's server-only modules.
It reads `apps/web/.env.local`: `SEED_ADMIN_PASSWORD` and
`SEED_STUDENT_PASSWORD` set the passwords of the seeded staff (super-admins
`RECADMIN01` and `RECSUPER02`; `RECADMIN02`, an admin scoped to CSE, every
batch) and students (CSE 2027: `2116231001001`–`004`; ECE 2026:
`2116226002001`, `2116226002002`) — only when an account is created, so
re-running never resets a password — and `JUDGE_DEV_NODE_ID` / `JUDGE_DEV_NODE_TOKEN` register the
development judge node (only the token's sha256 is stored). It also creates
the `LanguageConfig` rows, the default theme and the published two-sum
problem. It is for local development only.

For the opt-in database tests, migrate `recx_test` once by overriding the
URLs for one command:

```powershell
$env:DATABASE_URL = "postgresql://recx:recx-dev-only@127.0.0.1:5433/recx_test"
$env:DATABASE_URL_DIRECT = $env:DATABASE_URL
npx pnpm@9.15.9 db:migrate
Remove-Item Env:DATABASE_URL, Env:DATABASE_URL_DIRECT
```

### 1.4 Running Linux commands in the WSL2 mirror

Every Linux command uses exactly this form from PowerShell: it syncs the
Windows checkout into `~/recx` (installing Linux dependencies on first use),
then runs `<command>` there. Substitute your own checkout path. Use single
quotes; for anything with nested double quotes, write a script file and run
that instead, because PowerShell mangles them.

```powershell
wsl -d Ubuntu -- bash -lc 'RECX_SRC=/mnt/c/Users/SUBASH/OneDrive/Documents/GitHub/REC-CODE bash <(sed "s/\r$//" /mnt/c/Users/SUBASH/OneDrive/Documents/GitHub/REC-CODE/scripts/dev/linux-sync.sh) && cd ~/recx && <command>'
```

> **`RECX_SRC` is not optional in that form, and leaving it out is
> destructive.** `linux-sync.sh` falls back to a source derived from its own
> `$0`, and under `bash <(…)` `$0` is `/dev/fd/63`, whose `../..` is `/` — so
> the script runs `rsync -a --delete / ~/recx/`, mirroring the root
> filesystem into the mirror and deleting the checkout's own top-level files
> on the way (2026-10-19: `docs`, `tests`, `infra`, `package.json`,
> `pnpm-lock.yaml` and more went, and ~3 GB of `/etc`, `/usr`, `/var`
> arrived; `node_modules` and the three mirror-only `.env` files survived,
> because the script excludes them).
>
> The variable is also easy to lose by accident:
> `RECX_SRC=… bash <(sed … "$RECX_SRC/…")` does NOT work, because the process
> substitution is expanded before the assignment takes effect.
>
> So prefer passing the script as a **file path** rather than a process
> substitution, which makes the `$0` fallback correct in the first place:
>
> ```powershell
> wsl -d Ubuntu -- bash -lc 'export RECX_SRC=/mnt/c/Users/SUBASH/OneDrive/Documents/GitHub/REC-CODE; bash "$RECX_SRC/scripts/dev/linux-sync.sh" && cd ~/recx && <command>'
> ```
>
> The recovery, if it happens, is the sync itself: run it once with
> `RECX_SRC` set correctly and `--delete` removes the root-filesystem
> directories and restores the missing files. Verify the three `.env` files
> afterwards (`apps/web`, `apps/judge-worker`, `packages/db`) rather than
> assuming they are there.


The sync never copies `.env` / `.env.local` files and never deletes them
from the mirror, so the judge worker's environment is set up once inside
WSL2:

```bash
cp /mnt/c/Users/<you>/OneDrive/Documents/GitHub/REC-CODE/apps/judge-worker/.env.local ~/recx/apps/judge-worker/.env.local
# then, in that copy:
#   RECX_CACHE_DIR=/var/tmp/recjudge-blobs   (the default needs root)
#   RECX_APP_URL=http://<windows-host>:3000  (only without mirrored networking)
```

### 1.4b When `next build` fails on a `.nft.json` that is not there

This checkout lives under OneDrive, and OneDrive syncs `apps/web/.next` while
the build is writing it. The symptom is a build that compiles and then dies in
"Collecting build traces":

```
[Error: ENOENT: no such file or directory, open '…pps\web\.next\server\pages\_app.js.nft.json']
```

It reads like a code failure and is not one. The tell is the compile time
beside it: 2026-10-19 this build reported **21.8 minutes** (it is normally
20-35 seconds), which is filesystem contention, not compilation.

Clean and rebuild:

```bash
rm -rf apps/web/.next && npx pnpm@9.15.9 build
```

The durable fix is to stop OneDrive syncing the build output: right-click
`apps/web/.next` → "Always keep on this device" **off**, or better, exclude it
from the sync folder entirely. `.next` is already in `.gitignore`, so nothing
of value is in it. The WSL2 mirror is unaffected — `~/recx` is on the Linux
filesystem, which is one more reason the Linux gate is the authoritative one.

### 1.5 Starting everything

| Process | Command | Notes |
|---|---|---|
| WSL2 stack | `powershell -ExecutionPolicy Bypass -File scripts/dev/stack-up.ps1` | **first, once per Windows session.** Holds the distribution open (it stops seconds after the last `wsl` session exits, taking all three services with it), starts PostgreSQL, Redis and isolate, and proves from Windows that 5433 and 6379 answer. `-Stop` releases it |
| WSL2 services | `wsl -d Ubuntu -- systemctl is-active postgresql redis-server isolate` | all three start with WSL2 (systemd). Note that this command *starts* the distribution in order to run, so on its own it always looks healthy — which is why the script checks the ports from the Windows side instead |
| Web | `npx pnpm@9.15.9 dev` | Windows; <http://localhost:3000> |
| Scheduler | `npx pnpm@9.15.9 scheduler:dev` | Windows; reconciler every 10 s |
| Judge worker | the §1.4 form with `<command>` = `pnpm --filter @recx/judge-worker dev` | WSL2, `RECX_DRIVER=isolate`. The mirror is a copy: after editing worker code on Windows, stop and re-run the command so it re-syncs |

**Never run a `RECX_DRIVER=mock` worker against the dev queues.** The mock
driver answers AC for everything, and it claims from the same Redis as the
real one: two workers, and whichever claims a job decides the verdict. It
cost an hour in Phase 10c — the authoring journey reported that a
deliberately wrong model had passed, and three reference solutions that
print three different things were all AC on the same four tests. If a
verdict looks impossible, run `ps -eo pid,etime,args | grep judge-worker`
before suspecting the judge: a mock worker left behind by a metrics or
protocol check is indistinguishable from a broken comparator, and
`recx-stack.sh stop` only stops the one whose pid it wrote. Start a mock
worker with its own `RECX_QUEUES` or its own Redis, or not at all.

**Warm the routes before running the suite**, with the script CI uses:

```bash
bash scripts/dev/warm-routes.sh http://localhost:3000     # two passes
```

`next dev` compiles a route on its first request and the suite visits about
sixty, so without this the first navigation to each one pays for a compile
inside an assertion — and it is also where the heap restart below is
absorbed. The route list lives in that one script so a developer, the runbook
and CI warm the same set.

**Running the e2e suite against this stack needs two flags on the web
server** (Phase 4; not needed before it). `next dev` restarts itself on a
pure V8 heap check — `used_heap_size > 0.8 × heap_size_limit` in
`next/dist/server/lib/start-server.js` — and the in-flight request then dies
as `ERR_EMPTY_RESPONSE`, which surfaces as a Playwright failure on whichever
page happened to be loading. Phase 4 added ~40 `/admin` and `/super` routes,
and rendering them all in one server lifetime passes that threshold:

```bash
corepack pnpm@9.15.9 --filter @recx/web exec next dev -p 3000 --disable-source-maps
```

- `--disable-source-maps` drops the `--enable-source-maps` that `next dev`
  adds by default. The retained maps for several thousand modules are the
  bulk of the growth, and this alone is most of the fix.
- Optionally `NODE_OPTIONS=--max-old-space-size=5120`. Left alone,
  `next-dev.js` sets the limit to 50% of total memory (3,874 MB of WSL's
  7.7 GB, so the guard fires near 3.1 GB). **Do not raise it much further:**
  at 6144 with source maps still on, the heap outgrew what WSL could supply
  and the Linux OOM killer took the process instead of V8 restarting it, so
  the server stayed down (`ERR_CONNECTION_REFUSED`) rather than coming back.
- **Warm the routes, then restart the server.** Warming compiles the routes
  into `.next` on disk but also retains them in heap, so a suite started
  right after warming begins already near the threshold. A restart keeps the
  on-disk cache and gives the run a fresh heap. With warm-then-restart the
  `rbac` project went from failing on its 40-URL sweep to 6/6 with zero
  restarts.

The app cannot be run in production mode to avoid this while a judge is
attached: `lib/env.ts` refuses to boot with `JUDGE_ALLOW_UNHARDENED_NODES=true`
under `NODE_ENV=production`, and `lib/judge/lanes.ts` then quarantines the
unhardened WSL2 node outright, so nothing is judged.

On a Windows-only machine the worker can run with `RECX_DRIVER=mock`. The
mock driver **executes nothing and fabricates every verdict**; it exists to
exercise the UI and protocol, and the worker refuses to start with it when
`NODE_ENV=production`.

**The WSL2 kernel cannot be hardened**, so on the development box the worker's
host hardening check fails (`docs/JUDGE.md` §10). Two development-only
switches, both refused with `NODE_ENV=production`:

| Where | Setting | Effect |
|---|---|---|
| the mirror's `apps/judge-worker/.env.local` | `RECX_DEV_ALLOW_UNHARDENED_HOST=1` | the worker takes jobs despite the failed check (loud warning) |
| `apps/web/.env.local` | `JUDGE_ALLOW_UNHARDENED_NODES=true` | the web app does not withhold ASSESSMENT / CONTEST from an unhardened node (needed to judge those lanes locally, e.g. with the burst, §2.7) |

The worker serves the queues in `RECX_QUEUES` (default practice + run); for
the sensitive lanes add `judge-assessment,judge-contest`, and for validation
jobs `judge-rejudge`. `RECX_SLOTS` (default 1) sets the slots; leave
`RECX_SLOT_CPUS` unset on a development box.

### 1.6 The gate

`pnpm lint && pnpm typecheck && pnpm test && pnpm build` must be green on
Windows **and** Linux before a phase closes (`docs/CONVENTIONS.md`).

```powershell
# Windows
npx pnpm@9.15.9 lint; if ($?) { npx pnpm@9.15.9 typecheck }; if ($?) { npx pnpm@9.15.9 test }; if ($?) { npx pnpm@9.15.9 build }

# Linux (WSL2 mirror): use the §1.4 form with <command> =
#   pnpm lint && pnpm typecheck && pnpm test && pnpm build
# plus, on Linux only:
#   RECX_DB_TESTS=1 RECX_REDIS_TESTS=1 pnpm test                            (database + Redis tests)
#   RECX_ISOLATE_INTEGRATION=1 pnpm --filter @recx/judge-worker test:integration   (real sandbox)
```

Also, outside the root scripts (not yet wired into `pnpm typecheck` /
`pnpm test`):

```powershell
npx tsc --noEmit -p scripts/load/tsconfig.json     # the burst harness
npx vitest run --root scripts/load                 # its unit tests (plan, stats, safety)
```

CI (`.github/workflows/ci.yml`) runs the gate plus those two on
`ubuntu-24.04` and `windows-latest`, and on `ubuntu-24.04` the judge
integration job: isolate, the toolchains (two caches: the from-source pair and
the vendor releases, each keyed on its own scripts), `verify-toolchains.sh`,
and every sandbox integration suite under
`apps/judge-worker/test/integration/`.

### 1.7 Containers instead of WSL2 services

Where Docker works, `docker compose up -d` starts Postgres 17 (host port
5433), Redis 7 (AOF everysec) and MinIO (S3 API 9000, console 9001, bucket
`recx-testdata`) with the same development credentials, so the `.env.local`
files are unchanged. `docker compose down -v` deletes the data. The judge
still needs a Linux host with isolate.

### 1.8 Troubleshooting

| Symptom | Cause / fix |
|---|---|
| A student says they cannot sign in and have never had a password | expected, and now answerable: a roster import creates accounts without one. Send them to `/forgot-password`; the link is mailed, lasts an hour and works once (`docs/SECURITY.md` §2). In development `MAIL_TRANSPORT=log` means the mail is printed by the scheduler instead of sent — read the link out of its log |
| The reset link never arrives | the mail is queued in `EmailOutbox` and sent by the scheduler, so check that the scheduler is running (§1.5) and what `/super/settings/integrations` says about the outbox. A queued row with `status=FAILED` keeps its last error |
| A long local Playwright run starts answering 500s, and the dev log says `P1001 … can't reach 127.0.0.1:5433` | the WSL2 loopback can still drop under a run that holds many connections for minutes, with the distribution up and `pg_isready` happy inside it (seen on a 14-minute `--project=rbac`). `scripts/dev/stack-up.ps1` reports it and it clears on its own; the Linux gate and CI do not have this boundary at all (docs/CONVENTIONS.md) |
| A local e2e navigation times out and the dev log says `Compiled /problems in 84.9s` | `next dev` compile time on a loaded machine, not the page. Warm first — `scripts/dev/warm-routes.sh` — which is what the CI job does before Playwright starts |
| Sign-in answers "Something went wrong. Please try again — if it keeps happening, quote reference …" | an unexpected error reached `POST /api/auth/login`; the reference is printed beside the exception in the web log. In development it is almost always the database — check `/api/health` first, and the two rows below |
| `/api/health` says `"db":"down"`, or Prisma `P1001 Can't reach database server`, while `pg_isready` inside WSL2 answers happily | either `DATABASE_URL` dials `localhost` (Windows tries `::1`, which WSL2 does not serve) — use `127.0.0.1` — or the distribution had stopped and the `wsl` command you checked with is what started it again. `scripts/dev/stack-up.ps1` settles both (§1.1, §1.5) |
| Services were up a minute ago and are refused now | the WSL2 distribution stopped when the last `wsl` session exited. Hold it open: `scripts/dev/stack-up.ps1` |
| `ECONNREFUSED 127.0.0.1:5432` | wrong port: local Postgres is on **5433** |
| `ERR_PNPM_…` / pnpm cannot switch version | use `npx pnpm@9.15.9 …` |
| Prisma: query engine for the wrong platform | a Windows `node_modules` used from Linux (or the reverse); Linux work happens in `~/recx` only |
| `$'\r': command not found` | CRLF in a shell script (§1.1) |
| Worker: `ECONNREFUSED …:3000` from WSL2 | NAT networking: enable mirrored networking or use the Windows host address (§1.1) |
| Worker: `EACCES … /var/cache/recjudge` | set `RECX_CACHE_DIR` in the mirror's `.env.local` (§1.4) |
| `isolate --init` fails: "Device or resource busy" | something is mounted inside the box root; only the box root itself is a tmpfs (`docs/OPEN-QUESTIONS.md` item 4) |
| `isolate --cg` errors about the control group | `sudo systemctl restart isolate` (it holds the cgroup tree) |
| `verify-host.sh` fails on the dev box | expected: the WSL2 kernel is not a hardened judge host |
| Worker on the dev box takes no jobs: "host hardening check failed" | expected on WSL2: set `RECX_DEV_ALLOW_UNHARDENED_HOST=1` in the mirror's worker `.env.local` (§1.5) |
| ASSESSMENT / CONTEST rows stay queued locally | the node's sensitive lanes are withheld (`/admin/judge` shows why): `JUDGE_ALLOW_UNHARDENED_NODES=true` in `apps/web/.env.local`, and the worker must serve those queues (`RECX_QUEUES`) |
| `verify-toolchains.sh`: "tsx not found" | run it from a checkout with Linux `node_modules` (the WSL2 mirror, §1.4), not from `/mnt/c/…` |
| `verify-toolchains.sh`: a language FAILs | the indented lines above the table show isolate's status, the program's stderr and stdout; §2.6 lists the known cases |

---

## 2. Operations

### 2.1 Postgres is truth; Redis is transport

**Restarting Redis is safe: Redis is transport only; Postgres is truth; the
reconciler re-enqueues QUEUED rows and reclaims expired leases within
~10 s; a Redis flush loses queue position and zero submissions.**

Every submission and run is committed to Postgres as `QUEUED` before it is
enqueued. The scheduler's reconciler (every 10 s, one instance at a time via
an advisory lock) re-derives the queues from the rows: it dispatches
`QUEUED` rows that have no live job, returns `JUDGING` rows whose 120 s lease
lapsed to the queue (or, on the third attempt, marks them `INTERNAL_ERROR`,
excluded from scoring), and deletes expired Run requests. While Redis is
down, submissions still commit and simply wait; live progress resumes when
it returns. Sign-in rate limiting fails open during the outage
(`docs/SECURITY.md` §2).

Postgres is the one thing that must not be lost. If it is down, nothing can
be submitted or judged; workers keep retrying and lose nothing they had not
yet reported (their leases expire and the work is re-judged).

### 2.2 Judge node lifecycle

| Status | Meaning | Claims new jobs? | Entered by | Left by |
|---|---|---|---|---|
| `ONLINE` | heartbeating, healthy | yes (sensitive lanes only while calibrated, self-checked and hardened — `docs/JUDGE.md` §3) | first heartbeat after `OFFLINE`; an admin's "Return to service" | silence, an admin, auto-drain, a failed self-check or hardening check |
| `DRAINING` | finishes the jobs it holds; takes nothing new | no | an admin, or **automatically after 3 consecutive releases** (audited `judge.node.auto_drain`) | an admin only |
| `OFFLINE` | no heartbeat for 20 s; its leases are reclaimed in the same reconciler tick | no | the scheduler's node sweep | its next heartbeat (→ `ONLINE`) |
| `QUARANTINED` | must not judge; treat the host as suspect. Results it still posts are discarded and the jobs re-queued (audited `judge.result.discarded_quarantined`) | no | **a failed self-check or host hardening check in a heartbeat** (audited `judge.node.quarantined`, SECURITY), or an admin | an admin only, after the host is rebuilt and passes its self-check |

Status changes are made on **`/admin/judge`** (§2.8), never with SQL: every
change there is validated server-side and audited with the admin's reason.
The page refuses transitions that would not hold — a node whose last
self-check failed (or, outside development, whose hardening check failed)
cannot be returned to service, because its next heartbeat would quarantine it
again; an OFFLINE node returns by itself on its next heartbeat; a node that
is not heartbeating is returned as OFFLINE so its next heartbeat decides.

**Drain** (planned maintenance, a host to retire, a noisy node):

1. `/admin/judge` → the node's card → **Drain**, with a reason (at least 5
   characters; it goes into the audit log as `judge.node.drained`).
2. Watch its busy slots fall to 0 on the card (the page refreshes every
   10 s). Jobs it holds finish normally; nothing is re-queued unless a lease
   expires.
3. Do the maintenance — for a judge host that means **rebuild** (§2.3).
4. **Return to service** (audited `judge.node.returned`; clears the
   auto-drain counter). A node drained automatically after 3 consecutive
   releases is returned the same way, once its logs explain the releases.

**Quarantine** (anything suspicious: a failed or stale self-check you cannot
explain, unexpected processes or files on the host, a kernel CVE touching
namespaces, cgroups, eBPF or io_uring):

1. `/admin/judge` → **Quarantine**, with the reason (audited, SECURITY). The
   node stops taking work at once; any result it still posts is discarded and
   the job re-queued for another node.
2. Read why, if the node quarantined itself: the card shows the self-check or
   hardening failures (also `JudgeNode.selfCheckFailures` /
   `hardeningFailures`), and the worker log
   (`sudo journalctl -u recjudge-worker -b`).
3. Keep evidence if the incident warrants it (the worker journal, process
   list, the incident log), then **destroy the host and rebuild it** (§2.3).
   A quarantined host is never repaired in place.
4. The rebuilt node boots, passes host verification, the self-check and
   calibration, and heartbeats; then **Return to service** (refused until its
   self-check has passed). Sensitive lanes come back only once its
   calibration is within 10 % of the fleet median.

### 2.3 Judge hosts are cattle

A judge host holds no data and no credentials beyond its node token. It is
never patched or repaired in place: it is destroyed and rebuilt from
`infra/judge/cloud-init.yaml`, in under 10 minutes with the prebuilt
toolchain archive. Rebuild when: verification fails, the node is
`QUARANTINED`, a kernel CVE touches namespaces, cgroups, eBPF or io_uring,
or on a routine schedule (weekly) to pick up patches.

**Rebuild:**

1. Drain the node (§2.2) and wait until it holds no jobs (or let leases
   expire; nothing is lost).
2. Destroy the instance.
3. Boot a new one with `cloud-init.yaml`, its `@PLACEHOLDER@`s substituted
   (the list is at the top of the file). Reuse the node id and token, or
   rotate them (§2.4). Requirements: Ubuntu 24.04, kernel ≥ 6.6, ≥ 60 GB
   disk (the blob cache defaults to 40 GiB), the app host serving NTP to
   the judge subnet. Pick `@RECX_SLOT_CPUS@` from the instance type's
   topology (`lscpu -e`: one CPU per slot, each on a different physical
   core, CPU 0 left to housekeeping); check the choice first with
   `RECX_SLOT_CPUS=… bash infra/judge/install-isolate.sh --print-config` on a
   host of the same type (no root, changes nothing).
4. The bootstrap installs isolate (with CPU pinning), the toolchains and the
   worker, runs `verify-toolchains.sh` (a toolchain failure stops the
   bootstrap before the reboot), and ends with a reboot through the hardened
   boot path: shallow C-states, the performance governor and turbo off
   (`recjudge-cpu-tuning.service`), then `verify-host.sh` before the worker
   starts. Check: `sudo journalctl -u recjudge-worker -b`,
   `sudo journalctl -u recjudge-cpu-tuning -b`,
   `sudo bash /opt/recjudge/infra/judge/verify-host.sh`, and the node's card
   on `/admin/judge` (self-check, calibration, lanes).
5. Return the node to service if it was drained or quarantined.

**The toolchain archive** (once per toolchain change): on any host that ran
`infra/judge/toolchains/build-all.sh` and passed `verify-toolchains.sh`,
`tar -C /opt -cJf toolchains.tar.xz toolchains && sha256sum toolchains.tar.xz`;
upload it to object storage and put its URL and sha256 into the
provisioning values. A toolchain upgrade adds a directory and a
`LanguageConfig` row; it never rebuilds an existing directory
(`docs/JUDGE.md` §7).

### 2.4 Registering a node or rotating its token

From a machine with the web app's database access (`apps/web/.env.local`
or the production environment); both commands are audited:

```powershell
npx pnpm@9.15.9 --filter @recx/web exec tsx --conditions=react-server scripts/judge-node.ts add judge-01 judge-01
npx pnpm@9.15.9 --filter @recx/web exec tsx --conditions=react-server scripts/judge-node.ts rotate judge-01
```

The fresh token is printed **once**; only its sha256 is stored. A new node
starts `OFFLINE` and its first heartbeat makes it `ONLINE`. Put the token
into the host's provisioning values (it lands in `/etc/recjudge/worker.env`,
root 0600) and rebuild, or edit that file and
`sudo systemctl restart recjudge-worker`. Rotation invalidates the old token
immediately: the worker's next request gets 401.

### 2.5 Common incidents

| Symptom | First check |
|---|---|
| Submissions stay "Queued" | `/admin/judge`: any `ONLINE` node serving that lane (its lanes and restrictions on the card; `RECX_QUEUES`)? scheduler running? Redis up? |
| ASSESSMENT / CONTEST queue grows while nodes idle | every node's sensitive lanes are withheld: the card's restrictions say why (calibration more than 10 % off the fleet median, self-check stale or failed, hardening) |
| Many `INTERNAL_ERROR` results | one node failing? (`consecutiveIe`, auto-drain in the audit log, the "Internal errors (7 days)" table); worker logs: `journalctl -u recjudge-worker` |
| An IE marked "permanent failure" | the problem, not the node: a checker that does not compile or reported FAIL, an unsupported compare mode — fix the problem version, then rejudge |
| A node keeps going `OFFLINE` | its egress to the app host (nftables, `/etc/hosts`, TLS), clock skew (chrony) |
| A node is `QUARANTINED` | the card's self-check / hardening failures; the quarantine procedure (§2.2), rebuild (§2.3) |
| Worker exits at start | `verify-host.sh` output in `journalctl -u recjudge-worker`; a wrong setting means the host image drifted: rebuild |
| Worker warns "RECX_SLOT_CPUS does not match the isolate per-box cpuset" | `install-isolate.sh` ran with a different `RECX_SLOT_CPUS` (or none): rebuild with matching values |
| Timing dispute on a TLE | `Submission.judgeNodeId` and `calibrationScore`; rejudge on another node from `/admin/judge` (`docs/JUDGE.md` §11) |
| Live progress missing, results still arrive | Redis pub/sub or the SSE route; results are read from Postgres regardless |

**A worker that was killed, not stopped (Phase 10f).** `kill -9`, an OOM
kill or a host that lost power leaves that worker's isolate boxes allocated.
The restarted worker's `isolate --init` then fails on those boxes ("This box
is currently in use by another process"), every claim it makes is released
instead of judged, and after three consecutive releases the node
**auto-drains itself** — which is the mechanism working: it stops the node
after three bad jobs rather than letting it burn every submission's three
attempts.

Recovery, in this order:

1. `isolate --cg --cleanup --box-id N` for the node's job boxes (slot boxes
   `BASE..BASE+slots`, compile `BASE+100..`, checker `BASE+200..`), or rebuild
   the host (§2.3 — judge hosts are cattle).
2. Restart the worker and check its log for `self-check passed`.
3. `/admin/judge` → **Return to ONLINE**, with a reason.

Submissions are not lost while this is happening: the reconciler keeps the
queue in step with Postgres and re-enqueues them every tick. What they do
lose is attempts — anything that reached three attempts against the broken
sandbox is marked INTERNAL_ERROR, which is why step 1 comes before step 3.

### 2.6 Toolchains: install, verify, upgrade

Every toolchain lives in `/opt/toolchains/<id>` exactly as
`LANGUAGE_CATALOG` (`packages/shared/src/languages.ts`) names it, root-owned
and read-only. Scripts in `infra/judge/toolchains/` (all idempotent, run as
root; `build-all.sh` runs them in order and logs to
`/var/tmp/build-<step>.log`):

| Step | Script | `/opt/toolchains/…` | Verified against |
|---|---|---|---|
| `cpython` | `build-cpython.sh` | `cpython-3.12.6` (+ numpy 1.26.4) | release manager's GPG signature + pinned sha256 |
| `gcc`, `gcc-pch` | `build-gcc.sh`, `build-gcc-pch.sh` | `gcc-13.2.0` (+ `<bits/stdc++.h>` PCH) | GNU keyring GPG signature + pinned sha256 |
| `temurin` | `install-temurin.sh` | `temurin-21.0.4+7` (+ `lib/recx-appcds.jsa`) | pinned sha256 = Adoptium's `.sha256.txt` |
| `kotlin` | `install-kotlin.sh` (after `temurin`) | `kotlin-2.0.21` | pinned sha256 = JetBrains' `.sha256` |
| `pypy` | `install-pypy.sh` | `pypy-7.3.17` | pinned sha256 = pypy.org/checksums.html |
| `node` | `install-node.sh` | `node-22.11.0` | pinned sha256 = `SHASUMS256.txt` |
| `go` | `install-go.sh` | `go-1.23.2` (+ prebuilt standard library, `bin/recx-go-build`) | pinned sha256 = go.dev's published value |
| `testlib` | `install-testlib.sh` | `testlib-0.9.41/testlib.h` | fetched by commit `68f9f300b6ab…` (tag 0.9.41), pinned sha256 per file |

A pinned sha256 that no longer matches what the vendor publishes stops the
install: the upstream artefact changed — investigate, never re-pin blindly.

**Verify** after any install, on every new host image, and whenever a
language behaves oddly:

```bash
bash infra/judge/toolchains/verify-toolchains.sh              # all languages + testlib
bash infra/judge/toolchains/verify-toolchains.sh java21 go123 # a subset
```

It compiles and runs a hello-world per language inside isolate (boxes
800–899) with the catalog's exact argv and the worker's own argv builder,
checks every toolchain directory is root-owned and read-only, that the Java
AppCDS archive maps in a box, that the Go binary is static and that a testlib
checker returns the right exit codes, and prints a table (compile CPU/wall,
run CPU, memory). Exit 0 = all pass, 1 = a failure (the indented lines above
the table show why). A row `go123*` is the proposed cache-free Go build, not
the catalog. To try a catalog environment change before making it:
`RECX_VERIFY_EXTRA_ENV="py312:OPENBLAS_NUM_THREADS=1" bash …/verify-toolchains.sh py312`
(those rows are labelled NOT THE CATALOG and the script exits 3).

Known results (2026-10-10, `docs/JUDGE.md` §7): every language passes except
`py312` (numpy needs `OPENBLAS_NUM_THREADS=1` in the catalog environment)
and `go123` (the catalog's `go build` cannot run in a box; `go123*` with
`bin/recx-go-build` passes) — both catalog changes, pending.

**Upgrade** a toolchain: write a new script (or a copy with the new pinned
version) that installs into a **new** directory id, add its catalog entry
and a new `LanguageConfig` row (the old row stays for rejudges), rebuild the
toolchain archive (§2.3), verify, roll the hosts. Never edit a directory in
place: a submission must rejudge on the toolchain it was judged with.

### 2.7 Capacity burst (development only)

`scripts/load/burst.ts` writes N submissions / runs for the seeded students
against published problems (each problem's AC model solution, so verdicts
should be AC), enqueues them through BullMQ exactly as the web app does,
waits for every verdict, and reports per lane: count, queue wait p50 / p95 /
max, service time, end-to-end p95, verdicts, internal errors — and whether
PRACTICE was ever starved while a slot it may use was idle. It refuses
`NODE_ENV=production` and any `DATABASE_URL` / `REDIS_URL` not on this
machine, and bypasses the per-user caps by writing rows directly (the judged
rows still count toward the seeded students' daily usage).

Before a run: web app, scheduler and at least one worker on isolate running
(§1.5); for the ASSESSMENT / CONTEST share, the two development overrides
set and the worker serving `judge-assessment,judge-contest` (§1.5);
`RECX_SLOTS` as large as you want to measure.

```powershell
cd apps/web
npx tsx ../../scripts/load/burst.ts --dry-run                       # the plan only: writes nothing
npx tsx ../../scripts/load/burst.ts --count 200 --spread 60 --json burst.json --markdown
npx tsx ../../scripts/load/burst.ts --count 200 --instant            # everything at once
npx tsx ../../scripts/load/burst.ts --mix practice=60,run=40 --languages cpp20
npx tsx ../../scripts/load/burst.ts --help
```

Defaults: 200 jobs, 15 % ASSESSMENT / 15 % CONTEST / 45 % PRACTICE / 25 %
RUN (Run-button `RunRequest`s), arrivals spread uniformly over 60 s, seed 1,
15-minute timeout. The run id it prints marks every source
(`recx-burst:<run id>`); remove the run's finished rows afterwards with
`npx tsx ../../scripts/load/burst.ts --cleanup <run id>`. The exit code is
non-zero if any job did not finish or ended IE. Record the result in
`docs/CAPACITY.md` §6.2.

### 2.8 The judge admin page (`/admin/judge`)

ADMIN and SUPER_ADMIN only (checked server-side); refreshes every 10 s.

* **Summary** — nodes online, backlog now, worst p95 wait and internal errors
  over the last hour.
* **Nodes** — one card per node: status, slots and busy slots, heartbeat,
  versions, languages, calibration, self-check and hardening results with
  their failures, the lanes it may serve and why sensitive lanes are
  withheld. Actions: **Drain**, **Quarantine**, **Return to service** (§2.2),
  each with a required reason, audited.
* **Lanes** — queue depth now; latency, throughput and internal errors over
  the last hour.
* **Waiting too long** — rows queued or judging for more than 2 minutes, with
  a per-submission **Rejudge** (audited `judge.rejudge`, previous verdict
  recorded; the rejudge goes onto the REJUDGE lane). Bulk and problem-wide
  rejudges need a super admin and a second approver (Phase 4).
* **Internal errors (7 days)** — infrastructure failures after 3 attempts and
  permanent failures, excluded from scoring until rejudged.
* **Languages / verdicts (24 h)** — submissions per language and the verdict
  mix.
* **Language configuration** — one row per language and pinned toolchain;
  enable or disable a language (audited `judge.language.enabled_changed`).
  Enable a language only after `verify-toolchains.sh` passes for it on every
  node and its catalog entry is final.
* **Judge caps** — the per-student defaults (`LIMITS.userCaps`) and active
  overrides; a super admin can grant an override with a reason and an expiry
  (audited `judge.quota.override`).

### 2.9 Judge protocol upgrades (protocol 5, Phase 12l)

`JUDGE_PROTOCOL_VERSION` has moved twice since the Phase 4 note below, and
the ROLLOUT is the same each time — deploy the web app first, then rebuild
every judge host — because the mechanism is the same: an older worker gets
426 on claim, blob and result, treats it as fatal and exits, and Postgres
keeps the jobs QUEUED until a new worker claims them.

| Version | Phase | What it added | What an older worker would have done |
|---|---|---|---|
| 4 | 12k | the `engine` discriminator and the SQL job spec | a v3 worker cannot parse a SQL spec at all |
| 5 | 12l | the `interactor` on the job spec, and INTERACTIVE as a judgeable mode | a v4 worker turns every interactive job into a permanent internal error |

For protocol 5 there is one extra thing to check after the rollout, and it
is the thing that makes an interactive problem work at all: a judge host
needs testlib (`/opt/toolchains/testlib-*/testlib.h`) and the pinned C++
compiler, exactly as a CHECKER problem does. A node without them releases
an interactive job as an infrastructure failure — retryable, so the job
moves to a node that has them — and `/admin/judge` shows the release
reason on the node's card.

### 2.9b Judge protocol 3 (Phase 4), kept for the record

`JUDGE_PROTOCOL_VERSION` is 3 since Phase 4: the wire shapes are unchanged,
but FUNCTION problems are judged by structured comparison on the worker (all
six comparators, SET_EQUAL and ROWS_ANY_ORDER included), the Java FUNCTION
harness exists, CUSTOM_CHECKER output is canonicalised before the checker
runs, the function-signature schema is stricter, and JVM runs get `-Xmx` /
`-Xss`. A protocol-2 worker would turn such jobs into permanent internal
errors, so the app refuses it (HTTP 426) instead.

**Rollout — deploy the web app and every worker together:**

1. Build the new worker image (or toolchain archive and worker build) first,
   so the rebuild in step 3 is quick.
2. Deploy the web app. From now on protocol-2 workers get 426 on claim,
   blob and result calls; they stop taking work (the worker treats a
   protocol mismatch as fatal and exits). Nothing is lost: Postgres keeps the
   jobs `QUEUED`, and the reconciler re-enqueues them every 10 s.
3. Rebuild every judge host with the new worker (§2.3 — hosts are cattle).
   Each comes back through verification, the self-check and calibration,
   then claims the waiting jobs.
4. Check `/admin/judge`: every node `ONLINE` on the new worker version, the
   queue depth falling, no burst of `INTERNAL_ERROR`.

A job a protocol-2 worker had already claimed when the app switched cannot
post its result (426); its lease expires and the job is claimed again by a
protocol-3 worker. **Do not deploy the worker before the web app**: a
protocol-3 worker would get 426 from a protocol-2 app.

Structured comparison also applies to FUNCTION versions published before
Phase 4. Their content does not change; to apply the fix to old verdicts
(e.g. a string answer that token comparison wrongly accepted), rejudge the
problem from `/admin/judge`.

### 2.10 Problem authoring: import, check-approved, bundle repair

Authoring itself happens in `/admin/problems` (docs/AUTHORING.md). These are
the operator commands around it. All run from `apps/web` with the
react-server condition, need `.env.local`, and are audited with via
`cli:<operator>`.

**Bulk import from a directory or a zip:**

```bash
cd apps/web
npx tsx --conditions=react-server scripts/import-problems.ts ../../content/batch-07.zip --as RECADMIN01
npx tsx --conditions=react-server scripts/import-problems.ts ../../content/batch-07/ --as RECADMIN01
```

- `--as` must be an ADMIN or SUPER_ADMIN account; it is recorded as the
  uploader and the drafts' creator.
- The command prints one line per problem directory: CREATED, NEW_REVISION,
  UNCHANGED or FAILED, with every issue and its file. It exits 1 if any
  directory failed.
- Re-running is safe: imported directories come back UNCHANGED, so fixing
  the failed ones and re-running is how an import is resumed.
- The web upload (`/admin/problems/import`) spools the zip to
  `IMPORT_SPOOL_DIR` (default `<tmp>/recx-imports`, created mode 0700) and
  deletes it when the import ends.
- An import still PROCESSING after 30 minutes was interrupted (a restart).
  It shows as interrupted, and the uploader's next upload marks it FAILED.
  Just upload again.
- Imported problems are drafts. Start validation with "Validate imported
  drafts" on the import page or with `validate-and-publish.ts`. The runs use
  the REJUDGE lane (at most 20 % of slots), so a node with `RECX_SLOTS` < 5
  that also serves other lanes never runs them.

**Validate and publish one problem (operator):**

```bash
npx tsx --conditions=react-server scripts/validate-and-publish.ts <slug> [--new-revision] [--approve]
```

Publishing needs an approval. Without `--approve`, a second admin approves
the revision in `/admin/problems/<id>` first. With `--approve`, the operator
submits the draft for review and approves it. The approval is recorded with
no approver id, via `cli:<operator>`, and the operator attests that the
content is originally authored. Use it only for seeded content and for
content whose review happened outside the app.

**Re-check every APPROVED revision after any toolchain, language or judge change:**

```bash
npx tsx --conditions=react-server scripts/check-approved.ts [--revoke] [--timeout-min=30]
```

- Starts a fresh validation round for every approved, unpublished revision,
  waits, and lists each revision whose reference solutions no longer get
  their expected verdict in every enabled language. It exits 1 if any
  failed.
- `--revoke` moves each failing revision back to In review
  (`problem.review.approval_revoked`), so it cannot be published until it
  is fixed and re-approved.
- It needs a judge node serving the REJUDGE lane. A timeout is reported and
  never revoked.

**Repair a published revision's test bundle:**

```bash
npx tsx --conditions=react-server scripts/check-approved.ts --repair-bundles
```

Publishing pins the bundle's key and manifest hash when it freezes a
revision, and writes the bytes after the commit. If that write failed, there
is a `problem.bundle.write_failed` audit row (SENSITIVE). The repair:

- recomputes the deterministic bytes from the frozen tests;
- writes any bundle missing from the test-data store (`problem.bundle.repaired`);
- reports MISMATCH for a bundle the frozen tests no longer rebuild, and
  writes nothing for it.

The judge never reads bundles (blobs are served per test), so a missing
bundle does not affect judging. A revision published while its key already
held other bytes (a pre-Phase-4 draft bundle in a dev database) has no
bundle at all, by design.

### 2.11 Super-admin governance: privileged operations, email, the sweep

Everything here is under `/super` (SUPER_ADMIN only; the strip reads
"Super-admin — all actions are audited"). Every action is in the audit log.

**Privileged operations (two-person approval).** Bulk status changes over
25 accounts, submission purges, global rejudges, PII exports and problem or
draft-revision deletions are requests, not actions:

1. A super-admin requests it (Users, Data, Judge settings, or the problem
   page). The exact target set is fixed now and shown with its digest.
2. Every other ACTIVE super-admin gets an in-app notification. One of them
   opens `/super`, checks the summary, reason and digest, and approves
   (it runs at once) or rejects it. Requests expire after 24 hours.
3. The result (or the error) is on the operation card and in the audit log
   (`privileged.executed` / `privileged.failed`).

With only one super-admin available in an emergency, the requester can
**break glass**: self-approve with a written justification. Every ACTIVE
super-admin is emailed and notified, and it is a SECURITY audit row. The
`breakGlassSelfApproval` flag (`/super/flags`) switches it off.

A global rejudge only re-queues rows (lane REJUDGE); the scheduler's
reconciler dispatches them, and the lane's slot ceiling keeps it from
starving other lanes. A PII export is downloaded from `/super/data` by the
requester only, within 24 hours, at most 3 times.

**Email transport (scheduler).** Security email is queued in `EmailOutbox`
and sent by the scheduler's `outbox` job:

| `MAIL_TRANSPORT` | Behaviour |
|---|---|
| `smtp` | sends through `SMTP_URL` (`smtp://` or `smtps://`, credentials in the URL; never logged) from `MAIL_FROM` |
| `log` | writes subject and body to the scheduler log, never the address. Development only: the scheduler refuses to start with it in production |
| `disabled` | sends nothing; rows stay `PENDING` and `/super` shows "N security emails undelivered" |

The default is `log` in development and `disabled` elsewhere. A failed send
is retried with backoff (30 s doubling, at most 6 h); after 8 attempts the
row is `FAILED`, and for `security.*` mail an `email.delivery_failed`
SECURITY audit row is written. `/super/settings/integrations` shows the
transport the scheduler last used and can queue a test email to yourself.

**Governance sweep (scheduler).** The `governance` job, every tick:
expires PENDING requests past their 24 hours (`privileged.expired`, the
requester is notified), fails operations stuck `EXECUTING` for more than 15
minutes (the process running them stopped: request again), and ends lapsed
impersonations (`impersonation.ended`, `EXPIRED`). It selects rows by the
database clock, so it is safe with two scheduler instances.

**Job health.** Each scheduler job upserts `SchedulerJobStatus` after every
tick (never with `--dry-run`); `/super/jobs` shows them, stale after three
reconciler intervals without a finished tick.

**Impersonation.** `/super/impersonate`: find the account, give a reason,
start. The browser lands on the user's home with a banner; nothing can be
changed until "End impersonation" (or 15 minutes, or sign-out).

### 2.12 Alerts: what each one means, and what to do (Phase 10b)

Nine rules: the eight SPEC §10 names, plus `JudgeEngineBacklog` (Phase 12k,
for the second judging engine). They live as data in
`packages/shared/src/alerts.ts` and `infra/monitoring/alerts.yml` is
**generated** from that list — edit the TypeScript, then:

```bash
RECX_UPDATE_DOCS=1 pnpm --filter @recx/shared exec vitest run test/monitoring-files.test.ts
```

Every rule carries a `for:`, a `severity`, the SPEC phrase it implements, and
a `runbook_url` pointing at the heading below with its name. `severity:
critical` means students are affected now; `severity: warning` means act
today, not tonight.

**Firing them.** `scripts/ops/fire-alerts.ts` produces each condition against
a local stack and asserts the number crosses the rule's threshold:

```bash
# Postgres and Redis up; the scheduler and the worker NOT running
# (the harness publishes the gauges itself and consumes nothing).
pnpm --filter @recx/scheduler exec tsx ../../scripts/ops/fire-alerts.ts
pnpm --filter @recx/scheduler exec tsx ../../scripts/ops/fire-alerts.ts --only JudgeQueueBacklog
```

Five of the nine are produced for real; four are asserted against samples,
and the harness prints which and why — the exporters the other two read
(node_exporter, postgres_exporter) cannot be installed on the development
machine without root, a real INTERNAL_ERROR needs a problem whose checker
exits 3, and a real 31-second verdict means making the judge slow on purpose.
`promtool` checks the PromQL itself, in CI: nothing on this machine can
evaluate a Prometheus expression, and `reduce` in `alerts.ts` mirrors each
expression rather than running it.

#### JudgeQueueBacklog

More than **200** jobs waiting in one lane for two minutes. Students are
queued behind a backlog the platform cannot clear at its current capacity.

1. `/admin/judge` — how many nodes are ONLINE, and what are their lanes?
   A node DRAINED or lane-restricted during a contest is the usual cause.
2. If every node is ONLINE and busy, this is capacity, not a fault: the lane
   priorities (`LANE_PRIORITY`) already put ASSESSMENT and CONTEST ahead of
   PRACTICE, so a contest is being served and practice is waiting. Say so on
   the status page rather than adding hosts mid-contest.
3. If nodes are ONLINE and idle, the queue is not being dispatched: see
   **JudgeOldestJobStale** below, which will also be firing.

Do not flush the queue. Every job in it belongs to a submission row that the
reconciler will re-enqueue within a tick, so a flush buys a minute and then
the same backlog returns, minus any job whose submission has since been
cleaned up.

#### JudgeEngineBacklog

More than **100** jobs waiting on one lane for ONE ENGINE, for five minutes.

A lane has two queues (Phase 12k): `judge-<lane>` for programs and
`judge-sql-<lane>` for SQL. The lane figures — and `JudgeQueueBacklog` —
are the SUM, so one engine can be completely stopped while the lane total looks
survivable. This rule is the half that says which.

1. `/admin/judge` → the **Engines** table. "Nodes online" for the engine
   that is backed up is the answer four times out of five; the row turns
   red by itself when work is waiting and no node of that engine is online.
2. For the SQL engine, the usual cause is not the judge process but the
   cluster behind it: the judge quarantines itself when its boot checks or
   its adversarial self-check fail, and the node card says which check and
   what it reported.
3. For the isolate engine, treat it exactly as **JudgeQueueBacklog** below:
   the per-engine rule simply fired first.

Do not move SQL work onto an isolate node — there is no such thing. The two
engines judge different problems and a job sits on its engine's queue until
a node of that engine takes it, which is why a stranded engine is a
different incident from a busy lane.

#### JudgeOldestJobStale

The oldest waiting job in a lane has been waiting more than **60** seconds.
SPEC calls this "the number a student feels", and it is the one queue metric
that cannot be explained away by load: a deep queue that is draining is a
platform working hard, and a job that has sat for a minute while the queue
drains around it is a job nobody will take.

1. Check `judge_worker_heartbeat_age_seconds` first. A lane with a stale
   oldest job and a node that stopped checking in is one incident, not two.
2. `/admin/judge` → is the lane restricted on every node? A node that serves
   only PRACTICE cannot take the CONTEST job at the head of the queue.
3. Check the job's own attempt count in `Submission.attemptCount`: a job on
   its third attempt is being claimed and dropped, which is a node problem
   (self-check, toolchain) rather than a dispatch problem.

The age is read from the head of the `waiting`, `prioritized` and `delayed`
lists. Every judge job carries a lane priority, so it is the `prioritized`
list that normally answers — a reading of zero with a non-zero depth means
the gauge is being read wrongly, not that the queue is young.

#### JudgeWorkerHeartbeatStale

A judge node has not checked in for more than **90** seconds. The scheduler's
node sweep marks it OFFLINE at 20 s and reclaims its leases in the same tick,
so by the time this fires the work it held has already been re-enqueued:
nothing is lost, and what is gone is capacity.

1. Is the host up? `ssh judge-N`, then `systemctl status recx-judge`.
2. If the service is running but silent, read its log for `host hardening`
   and `self-check`: a node whose self-check fails quarantines itself and
   stops claiming, which looks identical from the dashboard.
3. If the host is gone, rebuild rather than repair (§2.3 — judge hosts are
   cattle). A rebuilt node registers itself and starts claiming.

This number is derived by the scheduler from `JudgeNode.lastHeartbeatAt` and
is never self-reported. That is deliberate: a dead worker cannot report that
its own heartbeat is old, so a self-reported series would go *missing*
instead of *high*, and an alert on a missing series fires on every restart
until somebody silences it.

#### JudgeInternalErrorRate

More than **0.02** of verdicts — 2% over five minutes — are INTERNAL_ERROR.
SPEC calls this the canary for a broken compiler image or a cgroup
misconfiguration after a host upgrade, "otherwise discovered from student
complaints".

1. `judge_sandbox_init_failures_total` on each worker. Rising there means
   `isolate --init` is being refused: a kernel or cgroup change, almost
   always after an upgrade or a reboot into a new kernel.
2. Flat there, but IEs rising, points at the image: a toolchain that no
   longer exists, a checker that cannot be executed, a missing
   `/var/lib/recjudge/etc`.
3. `/admin/judge` → a node with three consecutive IEs is quarantined
   automatically. If every node is still ONLINE and the rate is climbing, the
   fault is shared, so it is the image or the problem, not the host.

There is no minimum-volume guard on this rule, so one IE in a quiet hour can
fire it. That is the intent: the quiet hour is exactly when somebody upgrades
a judge host.

#### HostDiskNearlyFull

A filesystem is more than **0.8** — 80% — full. A warning, not a page: 80% is
act-today.

1. On the **db** host the first casualty is WAL archiving, and a failed
   archive is a backup that silently stops being restorable. Check
   `pgbackrest info` before freeing space.
2. On a **judge** host it is usually the blob cache. It evicts itself, but
   `RECX_CACHE_MAX_BYTES` may be set above what the disk can actually give;
   lower it rather than deleting the cache by hand.
3. On the **app** host, look at the container log driver and MinIO before
   anything else.

Never free space by deleting a backup set. `verify-backup.sh` refuses a set
whose MANIFEST digests do not match its files, and half a set is worse than
none — it looks restorable.

#### PostgresConnectionsHigh

More than **0.8** — 80% — of `max_connections` are in use for five minutes.
The next connection to be refused belongs to a student mid-submission.

1. `SELECT state, count(*) FROM pg_stat_activity GROUP BY 1;` — `idle in
   transaction` is the one to chase. A session left open by a migration or a
   psql window holds locks as well as a connection.
2. The web app runs a bounded pool and the scheduler holds a single
   connection, so a number this high is usually something outside them: a
   restart loop multiplying the scheduler's connection, or a long-running
   query somebody started by hand.
3. Do not raise `max_connections` to clear the alert. PgBouncer is the answer
   when web replicas exceed four, and `deploy/compose.db.yml` says so in a
   comment; before that, the honest fix is to find what is holding them.

#### FailedLoginBurst

More than **100** sign-ins a minute are being refused. Credential stuffing,
or an integration retrying a wrong password in a loop. A warning rather than
a page: the rate limiter is already refusing these, per account and per
hashed client address.

1. `/super/audit`, filter `auth.login_failed` — the audit trail records
   failures against the account, which the metric deliberately does not.
2. The dashboard's breakdown by `reason` tells the two cases apart:
   `rate-limited` climbing while `credentials` stays flat is one account
   being sprayed and the limiter holding; `credentials` climbing across many
   accounts is a list being tried.
3. A single account under attack needs nothing done to it — the limiter
   already refuses it. If the source is one network, block it at Caddy; the
   platform never stores a raw address, so the audit trail gives you a hash,
   not an address to block.

Do not raise the sign-in rate limits to quieten this. They are what is
working.

#### SubmissionLatencyP95High

95th-percentile submit-to-verdict is over **30** seconds. Measured where the
student's wait ends, not where the judge's work ends, so it includes the
queue.

1. Compare it with `judge_run_duration_seconds`. A high p95 with short run
   durations is queueing: go to **JudgeQueueBacklog**. A high p95 with long
   run durations is the problem's limits or a slow host.
2. One problem with a 15-second limit and a hundred submissions will move
   this on its own; check the recent submissions' problems before treating it
   as a platform fault.
3. If both numbers are normal and the p95 is still high, the gap is between
   the result arriving and the student seeing it: check the SSE path
   (`sse_connections_active`) and the Redis publish, not the judge.

### 2.13 Backups, restores and deploys (Phase 10e)

Five scripts in `scripts/ops/`, and three compose files in `deploy/` — one
per host role. The compose files, the Caddyfile and the pgBackRest config
have **never been started**: there is one development laptop and no second
host. Each says so at the top, and §3 records it with what would have to be
true to run it. What does run here, and must keep running, is the restore
drill.

#### A backup is one set, or it is nothing

```bash
# Postgres and the test-data store, captured together.
DATABASE_URL_DIRECT=... TESTDATA_DIR=.../storage/testdata \
  scripts/ops/backup.sh --out ~/recx-backups

scripts/ops/verify-backup.sh ~/recx-backups/recx-backup-YYYYMMDDTHHMMSSZ
```

A set is `database.dump` (pg_dump -Fc), `testdata.tar.zst` and
`MANIFEST.txt` with both digests, the migration head, the image and the
host. If either half fails, the directory is removed — there is no partial
set to find later and believe.

**The reason it is one set:** a problem's test cases live in
content-addressed blobs, and a submission records which problem VERSION
judged it. A dump restored next to a test-data snapshot from a different
hour leaves submissions judged against test cases that no longer exist, and
that is only ever discovered mid-incident by somebody trying to explain a
verdict.

`verify-backup.sh` recomputes both digests, checks both sizes, reads
pg_dump's own table of contents and decompresses the test data. It refuses a
set with a changed byte in either file, a manifest that disagrees with its
own files, or a missing half — all four demonstrated, §3.

#### Restoring

```bash
# Into a scratch database. The target must be empty, or named *_scratch /
# *_restore / *_drill / *_test, or forced with --force and a typed name.
scripts/ops/restore.sh ~/recx-backups/recx-backup-… \
  --into postgresql://…/recx_scratch --testdata /tmp/testdata
```

It verifies first, every time: the moment somebody is restoring is the moment
they are least likely to check by hand. Without `--testdata` it says, loudly,
that the database is restored WITHOUT its blobs — a platform served from that
state judges against test cases it cannot read.

#### The drill, which is the deliverable

```bash
DATABASE_URL_DIRECT=... TESTDATA_DIR=... scripts/ops/restore-drill.sh
```

Takes a set, verifies it, restores it into `recx_drill`, and then asks the
three questions that decide whether a restore is usable: does the schema
match the code (`prisma migrate diff --exit-code`), are the rows there (the
tables whose absence would make the platform look fine and be empty), and
does the unpacked test-data store agree with the restored rows about which
blobs are stored rather than inline. It prints a line for §3 and drops the
scratch database.

**Run it monthly, and before every contest week.** A backup script that has
never been restored is a file.

#### Deploying

```bash
# By digest, never by tag. Refuses while a contest or an assessment is live.
RECX_WEB_IMAGE=registry/recx-web@sha256:… scripts/ops/deploy.sh

# Migrations are a separate, supervised step — and take a backup first.
RUN_MIGRATIONS=true RECX_WEB_IMAGE=…@sha256:… scripts/ops/deploy.sh
```

Four rules, each because the alternative has bitten somebody:

1. **A digest, not a tag.** A platform that redeploys "the same tag" and
   behaves differently is a platform nobody can reason about.
2. **It refuses while a contest or an assessment is live**, by reading
   `/api/health` — which is partly why `activeContest` is on a health
   endpoint at all. `FORCE_DEPLOY=1` overrides it, prints what it is
   overriding, and says so in the deploy log.
3. **Migrations are off by default.** Auto-migrating on boot runs them N
   times concurrently during a rolling deploy and applies a bad migration
   before anyone reads the error. With `RUN_MIGRATIONS=true` the script takes
   a backup, applies them once, and only then restarts replicas. Whether a
   migration is expand/contract-safe is a review step, not something the
   script can check.
4. **One replica at a time, health-gated** on the BODY (`/api/health`
   answers 200 even when it is not ok). A bad image takes out one replica
   rather than the platform, and the previous digest is in the deploy log.

#### What is NOT run here, and what would have to be true

| Artefact | What it needs |
|---|---|
| `deploy/compose.app.yml` | a host, a registry with the image, a public hostname and a certificate |
| `deploy/compose.db.yml` | a second host, and `initdb --data-checksums` at creation (it cannot be turned on later) |
| `deploy/compose.judge.yml` | a judge host; the worker itself runs natively in WSL2 here, which is how every judging test in this repository runs |
| `deploy/Caddyfile` | a public hostname for ACME |
| pgBackRest WAL archiving, offsite | an object store, an `age` key and somewhere offsite to put it |

### Inactivity: a policy engine, not a kill switch (Phase 8)

**Read this before touching the thresholds, and before anybody asks you to
turn on automatic disabling.** The same paragraphs are rendered on
`/super/settings/inactivity`, above the switch, so the argument is wherever
the decision is made.

A student who stops submitting has usually not stopped caring. They are ill,
or sitting university exams, or at home for a bereavement, or stuck on a
problem and too embarrassed to say so. A system that reads silence as
misconduct and closes the account has not identified a problem; it has
created one, and it has taught everybody watching that the platform is
something to be afraid of.

So: the purpose is to make non-progress **visible to a named human who can
intervene**, not to punish it. The maximum automatic consequence is a pause
that one solved problem undoes, with nobody's permission.

**What the college asked for, and what ships.** The ask was "five days of
inactivity, then the account is disabled". That is not what ships, and the
gap is deliberate. On the shipped defaults:

| Counted days | Stage | What the student notices |
|---|---|---|
| 3 | Nudged | A nudge on the dashboard. Nothing else changes. |
| 5 | Warned | The student is told, and so is their mentor. |
| 10 | Soft-restricted | Off the public leaderboard, no contest entry, no new XP on the boards. Signing in, reading problems, solving and sitting a scheduled assessment all still work. |
| 30 | — | Never reached: `autoDisableEnabled` is false, so the top rung has no threshold at all. |

Day five is therefore a **warning**, not a restriction, and no account is
closed by a job. Every number above is editable on the settings page, which
is the spec's own answer to the mismatch: tighten the policy without a
deploy, and own the decision in an audit row. A super-admin who wants day
five to restrict sets `softRestrictAfterDays: 5`.

**Counted days are not calendar days.** The counter excludes, in this order
of precedence: holidays, exam weeks, semester breaks and placement weeks
(structural — never counted, whatever the settings say); non-working days
such as Sundays, when `excludeNonWorkingDays` is on; days the student was
active; and days covered by an **approved** leave, when
`excludeApprovedLeave` is on. A `REQUESTED` leave excuses nothing, or a
student could stop the counter by asking.

**An incomplete calendar stops the engine, by design.** Every day with no
`CalendarDay` row counts, which is the harshest possible reading — so the
sweep refuses to escalate anybody at all while the calendar does not cover
the evaluation window, reports `calendarIncomplete`, and raises an
administrative item instead. If `/super/calendar` says days are unentered,
the policy is reaching nobody. That is the correct failure direction and it
is the one to fix by entering the term, not by relaxing the rule.

**Two signals in the settings do nothing, and say so.** `countsAsActivity`
has four keys because the spec's field list does. `submission` reads
`ActivityDay.submissions` and `solve` reads `ActivityDay.solved`; `login` has
no column to read (and a policy counting logins teaches a daily one-minute
login that pollutes the engagement data worse than inactivity does), and
`lesson` lives in the LMS, which REC Code does not read. Both are accepted,
ignored, and recorded as unavailable in the evidence — a student is never
counted idle because a signal nobody collects did not fire.

**A version is never edited.** Changing a threshold writes a new
`InactivityPolicy` row and retires the old one; the database refuses both an
UPDATE of any column but `isActive` and a DELETE outright. Every automatic
decision cites the version it was taken under, so an editable row would turn
old evidence into a lie. One live version per scope, resolved
most-specific-first: department+batch, then batch, then department, then
global.

**`notifyParentEmail` cannot be turned on.** A CHECK refuses it. The column
exists because the spec's field list has it; a parent address is third-party
personal data and the consent record it needs is not built in any phase of
this plan. It is dropped by the migration of whatever phase builds consent,
never by a flag flip.

**Automatic disabling.** `autoDisableEnabled` defaults false and the database
refuses a system `DISABLED` event unless the cited policy version has it
true — so a future job, a future migration and a future `psql` session all
hit the same refusal. Turning it on requires typing `I ACCEPT THIS
THRESHOLD`, audits at `SECURITY`, and emails every super-admin. There is
**no** floor on the threshold in the database, deliberately: a constant in a
CHECK is a constant that needs a migration, which is the one thing the spec
says must not be required. A threshold under 14 days needs the same typed
confirmation, because dengue keeps somebody off a laptop for two weeks and
typhoid for three, and neither of them did anything wrong.

The platform works without this switch. Nothing in the spec, and nothing the
placement cell has asked for, needs it.

---

### 2.14 Preparing a lab machine for a sitting (Phase 11c)

`docs/PROCTORING.md` §4 lists "a supervised lab on college-managed
machines" as the first control that actually enforces anything.
`deploy/lab-policy/` is that control as files: `chrome-policy.json` for
Linux and ChromeOS, `recx-exam-policy.reg` for Windows, and a README
explaining every key and what it does not do.

This is also the answer to "can proctor mode require a private window so no
extensions load". It cannot: a page cannot detect private mode (Chrome
closes each leak as a bug, and the heuristics that remain misreport Guest
mode and some ordinary profiles), a private window is not extension-free
anyway (*Allow in incognito* is a per-extension toggle), and a page cannot
enumerate extensions at all. "No extensions" is available to the owner of
the machine and to nobody else, which is why it lives here in operations
rather than in the exam client. `deploy/lab-policy/README.md` has the long
form.

**Per image, once.** Replace `exam.rec.invalid` with the real exam host
first — it is a reserved name that can never resolve, so a machine deployed
with the placeholder fails visibly instead of quietly allowing some other
domain.

```sh
# Linux (Google Chrome). Chromium: /etc/chromium/policies/managed/
sudo install -D -m 0644 deploy/lab-policy/chrome-policy.json \
  /etc/opt/chrome/policies/managed/recx-exam.json
ls -l /etc/opt/chrome/policies/managed/recx-exam.json   # root-owned, 0644
```

Windows: import `recx-exam-policy.reg` as an administrator, or push the same
keys through Group Policy with Google's ADMX templates. ChromeOS: set them
in the Admin console against the device organisational unit. Restart Chrome
either way.

The file must be root-owned and not writable by the account the candidate
signs in as. That ownership *is* the enforcement — a policy file a candidate
can edit is a suggestion. Check it; do not assume it.

**Per hall, before the sitting.** Five minutes, and the last two matter most:

1. `chrome://policy` → **Reload policies**. Every key from the file is
   listed with source **Platform** and status **OK**. A missing key, or one
   whose source reads **Cloud** or **User**, is not in force.
2. `chrome://extensions` is empty, and says extensions are blocked by the
   administrator.
3. The exam host loads; anything else does not.
4. The candidate's own account cannot write the policy file (above).
5. Record that you did this. From the invigilation page, *Record what you
   saw* against any candidate in the hall writes an `INVIGILATOR_NOTE` —
   context for a reviewer, and by design unable to raise a band on its own.
   A sitting whose hall check was never recorded is not wrong; it is
   unevidenced, and that is what the note fixes.

**What this does not do**, in the same breath as installing it: nothing
about a phone on the candidate's lap, a second laptop, a VM, a remote
desktop, or a helper on a messaging app on another device. `docs/PROCTORING.md`
§2 calls the second device the largest hole and says it is unclosable by
software. The policy raises the cost of the easy routes on the machine the
college owns. The invigilator in the room is still the control that matters
most.

---

### 2.15 Building the application image (Phase 11e)

`deploy/compose.app.yml` has always taken `RECX_WEB_IMAGE` by digest and
nothing built it. The `Dockerfile` at the repository root does, and one image
carries all three entrypoints the deployment runs:

| Service | Command |
|---|---|
| web (×2) | `node apps/web/server.js` |
| scheduler (×1) | `node apps/scheduler/dist/main.js` |
| judge worker | `node apps/judge-worker/dist/main.js` (only on a judge host, which supplies isolate and the toolchains) |

```sh
docker build -t recx-web:"$(git rev-parse --short HEAD)" .
docker push …                                   # then read the digest back
RECX_WEB_IMAGE=registry/recx-web@sha256:… scripts/ops/deploy.sh
```

`deploy.sh` refuses a tag: everything is deployed by digest (§2.13).

**What the image does and does not contain.** It contains the Next standalone
build, the Prisma client generated for Debian's OpenSSL 3, the migrations
folder (the health endpoint counts it), and the two bundled services with
their production dependencies. It contains **no compiler, no interpreter and
no isolate** — nothing in it can execute student code. A judge host is built
from `infra/judge` and runs the worker entrypoint on top of that.

**Credentials never enter it.** Every secret arrives at run time as a file
(`DATABASE_URL_FILE`, `IP_HASH_PEPPER_FILE`, …) that
`packages/shared/env-file` reads, and `.dockerignore` keeps `.env` files out
of the build context so a careless `COPY` cannot bake one into a layer.

**The one thing to know if you change the install.** The build installs with
`--config.node-linker=hoisted`. pnpm's default layout is a symlink farm whose
links are absolute paths into the build directory, and `next build` copies
those links into `.next/standalone` as links — so the tree resolves only
while that exact path exists. Copied into the runtime stage it fails on the
first require, as `Cannot find module 'styled-jsx/package.json'`. Hoisting
makes them real directories. `tests/repo/deploy-topology.test.ts` holds the
flag in place.

**The other two traps, both in the image's `node_modules`.** The bundles'
dependencies are not the web app's: `pino` and `nodemailer` are in the
scheduler and nowhere in the standalone tree, so each service gets its own
production tree from `pnpm deploy` (hoisted, for the reason above). And
`pnpm deploy` re-runs the db package's postinstall in that new tree, which
writes a 40 KB **stub** Prisma client in place of the ~50 MB generated one —
`Prisma.sql` and `Prisma.raw` are simply absent, and the scheduler dies on
its first raw query with `Prisma2.raw is not a function`. The build copies
the real client over it and asserts it landed.

**What has and has not been run.** `docker build` has not: there is no
engine on the development machine. Everything the Dockerfile decides was
verified another way — a clean `git archive` tree, the same hoisted install,
the same generate and builds, the same `pnpm deploy`, assembled into the
same layout, and then both entrypoints started from it. The web answered
`/login` 200, `/api/health` with `"migrations":"current"`, a `.next/static`
chunk 200 and `/monaco/vs/loader.js` 200; the scheduler connected to
Postgres and Redis and ran a tick; the judge worker loaded, ran its
hardening check and refused for the right reason (no Linux, no isolate).
What remains unproven is the base image itself: the Debian packages, and the
Prisma query engine built for `debian-openssl-3.0.x` rather than Windows.
Run it once against a registry and record it in §3.

---

### 2.16 Turning the AI helper on (Phase 12b)

A student stuck on a **practice** problem can ask the assistant what they
have got wrong, or how to approach it. It never appears in a contest or an
assessment, and it ships **off**.

Two switches, deliberately in different places, and both must be on:

| Switch | Where | Who owns it |
|---|---|---|
| Whether a model can be reached at all | `AI_API_KEY` in the server environment | whoever runs the deployment |
| Whether the helper answers, and which model | `/super/settings/ai` | the super-admin |

The key is not in the database on purpose: a key in a settings row is a key
in every backup, every `pg_dump` and on every admin's screen. The
super-admin surface chooses *which* model answers and can switch the whole
thing off on the next request; it cannot read, set or clear the key.

**On the host.**

```sh
# The key, owned by root and readable by nobody else.
install -D -m 0600 /dev/null /run/recx/secrets/ai_api_key
printf '%s' 'sk-…' > /run/recx/secrets/ai_api_key
```

Then uncomment `AI_API_KEY_FILE` in the web service's environment in
`deploy/compose.app.yml`, the matching `- ai_api_key` under that service's
`secrets:`, and the `ai_api_key:` definition at the foot of the file. They
are commented rather than wired because an empty secret file **throws**
(`packages/shared/env-file`, by design — a silently missing secret looks
exactly like one that was never configured), so wiring them would make
every deployment invent a key for a feature it may not want.

For a college-hosted, OpenAI-compatible endpoint, also set `AI_BASE_URL`
and `AI_MODEL`, and pick *College-hosted model* on the settings page.
Anthropic's own endpoint is not configurable: a configurable one is an
exfiltration setting wearing a deployment hat.

**On the settings page.** `/super/settings/ai` → the assistant **On**, a
model, questions per student per day, longest answer. Saving asks for a
reason and writes a SECURITY audit row, like the governance kill switches,
because turning it on starts sending students' draft code to a third party.
Switching it off takes effect on the very next request.

**What leaves the college, every time a student asks**: the public problem
statement, that student's own draft code, the verdict of their own last
practice submission, and the sample case it failed — the one the product
already shows them. Never hidden test data, never another student's work,
never anything that says who the student is. One module makes that call
(`apps/web/src/lib/ai/provider.ts`) and `tests/repo/ai-helper-posture.test.ts`
fails the build if a second one appears.

**What it costs a student.** Asking makes a later *first* solve ASSISTED:
it still counts as solved and still pays XP at the assisted rate, but it is
excluded from the unassisted evidence a readiness score is built on — the
same rule a tier-3 hint and the editorial already follow. Without it every
readiness number in the college would quietly inflate. The button unlocks
only after one judged submission or ten minutes of work on that problem.

**If students say it is broken.** `/super/settings/ai` shows answered and
failed counts for the last 30 days. A failure is recorded with no answer
and costs the student no quota. The page also says, in a banner, when the
deployment cannot answer at all — no key, or a college-hosted model with no
`AI_BASE_URL`. While that is true the Assistant tab does not render, so
students see no button rather than a button that fails.

**To stop it immediately**: `/super/settings/ai` → **Off** → save. No deploy,
no restart; the setting is read per request. Removing the key does the same
thing and needs a restart.

---

### 2.17 Running a mock interview (Phase 12h)

A mentor offers an hour; a student takes it; at the time both open the same
room and the mentor watches the student code. There is no switch — the
feature is on, and the only thing an operator does is understand the clock.

**The mentor's side** is `/mentor/mock-interviews`. "Offer a slot" takes a
start time (IST, as every admin form does) and a length between 15 and 120
minutes. The slot appears to every student until somebody takes it; until
then the mentor can call it off with a reason.

**The student's side** is `/mock-interviews`, under ASSESS. Open slots are
listed with the mentor's name and the time. A student holds at most **two**
booked slots at once — the refusal says so, and the fix is to sit one or
hand one back.

**The clock, which is where every support question comes from:**

| When | What is possible |
|---|---|
| until 60 minutes before | the student may hand the slot back; it becomes open again |
| from 60 to 10 minutes before | neither: the student is committed. The way out is to call it off with a reason, which the mentor reads |
| from 10 minutes before to the end | both sides can open the room; the mentor presses Start |
| from 10 minutes after the start | the mentor may mark a no-show (not before — a slow lift is not a no-show on somebody's record) |
| after the end | the room is closed. An interview left running is finished by the mentor writing it up |

**What the mentor sees while it runs** is the student's editor, updating a
few seconds behind, and nothing else — no camera, no microphone, no screen.
Both sides are expected to be on a call of their own choosing; the platform
does not place one and records nothing. The mirror is **read-only**: there
is no way for an interviewer to type into a candidate's editor, and that is
deliberate (`docs/OPEN-QUESTIONS.md`, Phase 12h).

**Finishing** asks for three ratings and a written note. It goes to the
student and counts for nothing else: no XP, no leaderboard, no readiness
input, no band. If a mentor asks what the ratings "do", the answer is that
the student reads them.

**If the mirror says "Reconnecting…"** and stays there: the stream is an
`EventSource` on `/api/mock/[interviewId]/live`, which closes itself when
the interview is no longer running and after ten minutes in any case (the
page reopens it). A mentor who is not that interview's mentor gets nothing
from it, by design — check who offered the slot before looking further.

---

### 2.18 Written and system-design questions (Phase 12i)

A TA writes a question and the rubric it is marked against; students
answer in prose; a TA marks it. There is no switch -- the feature is on,
and nothing about it runs code.

**Writing one** is `/mentor/written`. The form takes a kind (system
design, or a written answer), a title, the question in markdown, roughly
how long it should take, and **two to eight criteria** with a weight of
1-5 each. It saves as a **draft**: nobody can see it or answer it until
"Publish it".

**The rubric is published with the question and frozen when it opens.**
If a criterion is wrong, retire the question and write another one -- a
student marked 12 of 16 against four criteria did not get that score
against five, and the database refuses the alternative.

**Retiring is not deleting.** A retired question leaves every student's
list except that of somebody who answered it, and their answer and its
mark stay readable. A question's author may retire it, and so may an
ADMIN or SUPER_ADMIN -- a TA who leaves must not take a published
question with them.

**Marking** is the queue on `/mentor/written`, shared between everybody
who can mark and ordered oldest-first. Open a row and the page shows the
question, the answer and the rubric together. Every criterion starts
*unmarked*: a default would be a mark nobody made, and the save is
refused until all of them carry one. Two ways to finish:

| What | When to use it | What the student sees |
|---|---|---|
| Save the mark | there is something to say per criterion | the weighted total with its denominator, each criterion's mark and note, and the overall note |
| Hand it back unmarked | a mark would say less than a sentence | the sentence, and their own draft back to work on |

**What the mark does: nothing.** No XP, no leaderboard, no readiness, no
band, nothing a recruiter sees. If a TA asks what the percentage is for,
the answer is that the student reads it.

**The one thing to tell a student** who asks whether this is anonymous:
it is not. The person marking sees their name, the page says so above
the box, and that is deliberate -- an answer is coursework, unlike an
interview archive entry (Phase 12e), which is anonymous precisely
because every student reads it.

---

### 2.19 The SQL sandbox and its judge (Phase 12k)

SQL problems are judged by `apps/sql-judge`, a judge node with a
PostgreSQL sandbox instead of an isolate box. It is the only process in the
platform that holds a database credential other than the app and the
scheduler, and the credential is the sandbox's — never the application's.

**Starting it in development:**

```powershell
node scripts/dev/sql-sandbox-up.mjs   # creates recx_sql_sandbox + two roles
npx pnpm@9.15.9 --filter @recx/sql-judge dev
```

The script writes `apps/sql-judge/.env.local` (gitignored) with both
connection strings and generates the passwords; it is idempotent and keeps
the passwords it already wrote. In development the node id defaults to
`sql-dev-1`; the seed registers only ONE development judge node, so either
register a second one or run the SQL judge with the dev node's credentials
while the isolate worker is stopped (the `JudgeNode` row's `driver` column
shows whichever process beat last).

**What it does at boot, in order:**

| Step | What it means when it fails |
|---|---|
| refuses application secrets in its environment | somebody gave a judge host the app's `.env`; fix the unit file, not the check |
| checks the cluster | `REFUSING TO RUN` means the "sandbox" is the application's database. Not overridable |
| sweeps stale `job_…` schemas | a judge died mid-case. One schema is a leaked dataset; a growing count every boot means the host is being killed |
| runs the adversarial self-check | a grant somebody loosened by hand. The node keeps working and the fleet withholds the sensitive lanes |
| heartbeats as `driver: postgres` | the app host is down, or the node token is wrong |

**The two things that go wrong in the sandbox, and what they look like:**

* **A schema left behind.** `SELECT nspname FROM pg_namespace WHERE nspname
  LIKE 'job\_%'` as the owner. The next boot drops them; dropping them by
  hand is safe at any time, because no live job's schema outlives its case
  by more than a few milliseconds.
* **A student's query that will not die.** It cannot outlive
  `statement_timeout` (five seconds) — if one appears to, the connection is
  stuck rather than the query, and the judge closes it after three seconds
  and destroys the socket. A connection count that climbs without jobs
  running is the thing to look at (`SELECT count(*) FROM pg_stat_activity
  WHERE application_name = 'recx-sql-judge'`).

**Rotating the sandbox credentials:** re-run the script with the two URL
lines removed from `.env.local` (it generates new passwords and re-applies
them), then restart the judge. Nothing else in the platform holds them.

**What it must never have:** the application's `DATABASE_URL`, `AUTH_SECRET`,
`IP_HASH_PEPPER`, an object-store key, or a connection to the application's
cluster. The process refuses to start with any of them, and that refusal is
a feature rather than an inconvenience.

**Bringing one up in production** (`deploy/compose.sql-judge.yml`, never
run here — there is no such host):

```bash
# 1. the cluster, then the role whose whole definition is what it may NOT do
docker compose -f deploy/compose.sql-judge.yml --env-file deploy/sql-judge.env up -d sandbox-db
sudo scripts/ops/sql-sandbox-provision.sh

# 2. register the node on the app host and drop its token in place
#    (/run/recx/secrets/sql_judge_node_token), then
docker compose -f deploy/compose.sql-judge.yml --env-file deploy/sql-judge.env up -d
```

The cluster is on the judge host, not the database host, and is in no
backup: it holds per-submission schemas and nothing else, so losing it
costs a rerun. `synchronous_commit=off` and `full_page_writes=off` are set
for the same reason — a crash loses work that is seconds old and
reproducible by definition.

**Reading the fleet page with two engines** (`/admin/judge`):

| What you see | What it means |
|---|---|
| **Engines** table, a red row | work is waiting on that engine and no node of it is online. This is the state the `JudgeEngineBacklog` alert fires on |
| a node whose Engine says `postgres` | its **Judge / engine** row is the judge's version and PostgreSQL's, not isolate's |
| Calibration: "Not measured for the SQL engine" | not a gap in that node's reporting. The SQL engine has no hello-world benchmark, because a query's limit is the database's own `statement_timeout` |
| a SQL node that never serves ASSESSMENT or CONTEST | deliberate, and the restriction says so in words. Until there is a benchmark for the query engine, an exam is not judged on one |

The lane figures above the table are the SUM of both engines' queues. A
lane that looks busy with the Engines table showing one engine idle is one
engine's problem, not a capacity problem.

---

## 3. Gate log

Each phase closes only when the gate (§1.6) is green on Windows and Linux.
Every extra check and every manual verification is recorded here with its
date, its result and who verified it. Rows are filled in by the phase
coordinator from actual runs — never in advance.

| Phase | Date | Gate | Result | Verified by |
|---|---|---|---|---|
| 1 | 2026-10-10 | `pnpm lint && pnpm typecheck && pnpm test && pnpm build` — Windows 11 (pnpm 9.15.9 via npx, Node 22.17.1) | PASS (lint 0 warnings; 869 unit/structural tests (DB/Redis suites skipped by default); build incl. `next build`) | Claude (coordinator) |
| 1 | 2026-10-10 | Same four gates — Linux (WSL2 Ubuntu 24.04 native mirror, fresh `pnpm install --frozen-lockfile`) via `scripts/dev/linux-gate.sh` | PASS | Claude |
| 1 | 2026-10-10 | `RECX_DB_TESTS=1 RECX_REDIS_TESTS=1` suites (frozen-version guard + DB triggers; scheduler reconciler against Postgres/Redis) | PASS (db 32/32, scheduler 53/53) | Claude |
| 1 | 2026-10-10 | `RECX_ISOLATE_INTEGRATION=1 … test:integration` — real isolate 2.7, GCC 13.2.0, CPython 3.12.6: C++ and Python two-sum AC 14/14, deliberate WA at test 0 then SKIPPED, CE remapped to the student's line, MLE, TLE, early-trip OLE, RE (SIGSEGV) | PASS 15/15 | Claude |
| 1 | 2026-10-10 | Unit gates: argv never contains `--share-net`; judge-worker has no dependency path to `@recx/db`; web has no `child_process`; `#6d28d9` reproduces the verbatim palette (ΔE2000 0, threshold 2); MockJudgeDriver exits non-zero with `NODE_ENV=production` | PASS | Claude |
| 1 | — | CI green on GitHub Actions | NOT RUN — nothing has been pushed to the remote; the WSL2 mirror served as the Linux runner | — |
| 1 | 2026-10-10 | Manual (in-app browser → web, worker on real isolate, scheduler — all live): signed in as seeded student 2116231001001; two-sum C++20 → AC 14/14 streamed over one SSE connection (Running → Accepted ≈5 s); Python 3.12 → AC 14/14; a Python solution failing only the duplicate-values case → WA at "Hidden test 3" (index 2), 2/14 passed, rest SKIPPED; `/api/submissions/{id}` hidden entries carry exactly `{i, v, ms, kb}` and no hidden input appears on the page; Run → 2/2 samples | PASS | Claude |
| 1 | 2026-10-10 | Manual: dark mode — toggled dark, reloaded: `<html class="dark">` set by the pre-paint script (in `<head>` before `<body>`), first captured frame (plain-textarea phase, before hydration) already dark; no console/CSP errors; dark tokens verbatim (`--primary #8b5cf6`, background `#12101c`) | PASS | Claude |
| 1 | 2026-10-10 | Manual: JS disabled — the in-app browser has no JS switch, so the server HTML was rendered in an `<iframe sandbox="allow-same-origin">` (scripts cannot execute) with every `<script>` stripped: brand colours correct (`--primary #6d28d9`, `--muted #6f6a87`, background `#f7f5fb`, Easy badge `#15803d`) and `/problems` fully readable. This found that the streaming `loading.tsx` skeletons never resolve without JS; both were removed (an unknown slug now returns HTTP 404) and the check re-run | PASS (after fix) | Claude |
| 2 | 2026-10-10 | `pnpm lint && pnpm typecheck && pnpm test && pnpm build` — Windows 11 | PASS (1,267 tests; DB/Redis suites skipped by default) | Claude (coordinator) |
| 2 | 2026-10-10 | Same four gates — Linux (WSL2 mirror, fresh install) via `scripts/dev/linux-gate.sh`, plus `RECX_DB_TESTS=1 RECX_REDIS_TESTS=1` suites | PASS (db 34, scheduler 98, web 337 incl. DB pipeline tests) | Claude |
| 2 | 2026-10-10 | Real-isolate suites on Linux: two-sum (15), Phase 2 judging — testlib checker AC/WA/FAIL, subtasks with dependencies, compile cache (9), adversarial — TLE with CPU ≥ limit and box torn down, MLE via cg-oom-killed, socket/connect, fork bomb with cgroup killed and no stray processes, output flood → OLE, fallocate 10 GB, /etc/shadow, cross-slot box read, compile bomb → CE, sanitisation, full self-check (11) | PASS 35/35 | Claude |
| 2 | 2026-10-10 | Live node boot on WSL2: hardening check reports 9 failures (dev kernel; dev override in use), self-check 12/12 fixtures passed, calibration measured, startup credit per language measured; with `next start` (production) the web app refused the dev override and QUARANTINED the node — the production rail works | PASS (as designed) | Claude |
| 2 | 2026-10-10 | Authoring pipeline on real isolate: bracket-cleanup (testlib checker), study-pairs (subtasks; deliberate O(n²) matches TLE via PARTIAL), two-sum r2 — validated, measured per-language limits written, published; two-sum r1 stays frozen | PASS | Claude |
| 2 | 2026-10-10 | Manual: 200-submission synthetic burst, uniform over 60 s, 8 slots — assessment p95 wait 292 ms (< 2 s), practice p95 282 ms (< 5 s), PRACTICE never starved (longest wait with a usable slot free 467 ms), 0 IE, 200/200 AC. Instantaneous variant also recorded (saturation: waits bound by capacity, priorities and floor held). Details: `docs/CAPACITY.md` §6.2 | PASS (spread profile) | Claude |
| 2 | 2026-10-10 | Manual (in-app browser): checker problem accepts a correct answer printed in a different order than the expected output (token compare would reject it); `/admin/judge` shows node health, lanes and waits, stuck/IE lists, language toggles, cap overrides | PASS | Claude |
| 3 | 2026-10-10 | `pnpm lint && pnpm typecheck && pnpm test && pnpm build` + `pnpm size` — Windows 11 (pnpm 9.15.9 via npx, Node 22.17.1) | PASS (lint 0 warnings; 1,882 tests passed, 136 DB/Redis tests skipped by default: shared 252, judge-worker 376, db 24, design 84, scheduler 111, web 901, repo 134; `next build`; all size budgets met) | Claude (coordinator) |
| 3 | 2026-10-10 | Same four gates — Linux (WSL2 mirror, fresh `pnpm install --frozen-lockfile`) via `scripts/dev/linux-gate.sh`, plus `RECX_DB_TESTS=1 RECX_REDIS_TESTS=1` suites and `pnpm size` on the Linux build | PASS (db 47, scheduler 138, web 988 incl. DB suites; size budgets met, zero-JS `/login` confirmed from the served build) | Claude |
| 3 | 2026-10-10 | Real-isolate suites on Linux (two-sum, Phase 2 judging, adversarial, self-check) | PASS 35/35 | Claude |
| 3 | 2026-10-10 | Content: six originally-authored problems validated on real isolate and published with hints and editorials (two-sum r3, bracket-cleanup r2, study-pairs r2, handle-maker, lab-power-budget, second-swipe); study plans rec-starter-sheet (6 items) and arrays-hashing-basics (4) | PASS | Claude |
| 3 | 2026-10-10 | `@axe-core/playwright` against the live WSL stack (`E2E_JUDGE=1`): 12 pages (incl. `/login`, `/dashboard`, `/problems`, `/problems/two-sum` with the console open and the mobile Code/Result tabs, `/leaderboard`) × light/dark × 1366×768/375×812 — zero violations of any impact (48/48 scans). Fixed on the way: dark Monaco/CodeMirror keyword contrast, dark danger button, focusable scroll regions, Run/Submit dropping focus to `<body>` while busy, Submit-after-Run verdict never announced | PASS | Claude |
| 3 | 2026-10-10 | Keyboard-only solving journey (Playwright, live judge): filter → open → read → enter editor → type → Ctrl+M on/off, Esc out of Monaco → Run (Accepted) → Submit wrong (WA, failing sample reviewed) → Submit correct (Accepted) → next problem; 3 consecutive passes plus the final run (49/49 e2e incl. axe) | PASS | Claude |
| 3 | 2026-10-10 | Size budgets (`apps/web/scripts/size-budget.mjs`, gzip): `/login` 0 KB (zero-JS Pages Router page — 0 `<script src>` in the served production HTML), `/dashboard` 117.0, `/problems` 122.5, `/leaderboard` 139.3, `/problems/[slug]` shell 169.2, shared first-party 12.5, Monaco chunk 942.1 (loader + editor.main + largest grammar; ≤ 1,050), Monaco editor worker 112.0 (own budget ≤ 120), CodeMirror 148.8; zero Monaco bytes on `/problems`, `/dashboard`, `/leaderboard` and admin lists. The Monaco reading (worker budgeted separately) is recorded in OPEN-QUESTIONS. Details: `docs/CAPACITY.md` §7.1 | PASS | Claude |
| 3 | 2026-10-10 | Manual (Playwright-driven, production build): 1366×768, 4× CPU, 3 Mbps — textarea fallback typable before Monaco in all 16 runs (cold p50 2.2 s); the console overlay never hides the caret (editor scrolls the caret line above the drawer; no squeeze — editor height unchanged); plain-textarea fallback likewise. Judged solve on the dev stack throttled: typed before Monaco, Run → Accepted, Submit → Accepted, caret checked 10× (7 with the console open), never under it. Not met on this loaded development laptop (OneDrive sync at a full core): the perf spec's own p75 timing targets (cold Monaco 7.57 s vs 7 s, warm Monaco 5.2 s vs 4 s, cold typable 2.66 s vs 2.5 s) — targets for the reference device, not spec gate items; re-measure there. `docs/CAPACITY.md` §7.2–7.3 | PASS (spec items); timing targets open | Claude |
| 3 | — | CI green on GitHub Actions (incl. the new size-budget step) | NOT RUN — nothing has been pushed | — |
| 4 | 2026-10-19 | `pnpm lint && pnpm typecheck && pnpm test && pnpm build` — Windows 11 (pnpm 9.15.9 via npx, Node 22.17.1). Each gate run separately, exit code checked. This is the closing run, after the live stage, the review and the §5 item-3 leftovers | PASS (lint 0 warnings; **4,485 tests passed, 0 failed**, 407 DB/Redis tests skipped by default: shared 497, judge-worker 403, db 138, design 84, scheduler 123, web 2,637, repo 603; `next build`) | Claude (coordinator) |
| 4 | 2026-10-18 | Lint gate repaired before the run: `docs/handoff/phase4/p4-review.workflow.js` (committed coordinator notes) failed `no-undef` on the Workflow runtime's injected `agent`/`parallel`/`pipeline`/`log`, so `pnpm lint` was red at the Phase 4 handoff commit. `docs/handoff/**` is now in the eslint `ignores`. Also found: a globally installed pnpm that cannot switch to 9.15.9 prints its error and **exits 0**, so `pnpm <gate>` looks green while running nothing — every gate here was therefore run as `npx pnpm@9.15.9 …` with its exit code asserted (`docs/CONVENTIONS.md`, Stack) | PASS (after fix) | Claude |
| 4 | 2026-10-19 | Same four gates — Linux (WSL2 Ubuntu 24.04.4, Node 22.17.1, fresh `pnpm install --frozen-lockfile` in the native mirror) via `scripts/dev/linux-gate.sh`, plus `migrate deploy` to `recx_test` and the `RECX_DB_TESTS=1 RECX_REDIS_TESTS=1` suites (PostgreSQL 17.11 on 5433, Redis 7.0.15). Closing run, same state as the Windows row. The dev stack must be stopped first: the script refuses to start while a Next server holds the mirror's `.next` | PASS 7/7 steps (lint, typecheck, test, build, migrate-test-db, services-tests, isolate-integration). With the services suites every test runs, none skipped: shared 497, judge-worker 403, db 354, design 84, scheduler 159, web 2,793, repo 603 | Claude |
| 4 | 2026-10-18 | Real-isolate suites on Linux (`RECX_ISOLATE_INTEGRATION=1`, `RECX_GOLDEN_EXTRA_LANGUAGES=java21`) — isolate 2.7, cgroup v2, toolchains under `/opt/toolchains` (GCC 13.2.0, CPython 3.12.6, Temurin 21.0.4+7, Go 1.23.2, Kotlin 2.0.21, PyPy 7.3.17, testlib 0.9.41) | PASS 260/260, including the golden suite with java21 (every java21 reference solution judged through its FUNCTION harness) | Claude |
| 4 | 2026-10-18 | Size budgets (`apps/web/scripts/size-budget.mjs`, gzip) on the Windows production build. Gate items: the new `/judge` line and `/dashboard` staying ≤ 160 KB after the announcement banner added a client button | PASS — all budgets met: `/judge` **116.8** (≤ 125; server-rendered, own chunks 0.2 KB = Next's page stub only), `/dashboard` **120.1** (≤ 160; was 117.0 in Phase 3), `/login` 0 (zero-JS, confirmed from the served build; detector self-check sees 10 `<script src>` on `/offline`), `/problems` 122.5, `/leaderboard` 139.3, `/problems/[slug]` shell 171.6, shared first-party 12.4, Monaco chunk 942.1, Monaco editor worker 112.0, CodeMirror 148.7. Monaco-free over 31 routes incl. `/judge` and every `/admin` page. Details and Phase 3 deltas: `docs/CAPACITY.md` §7.1 | PASS | Claude |
| 4 | 2026-10-18 | Phase 4 leftovers (spec §5 "Done when", item 3): `schema.prisma` `///` comments for Accommodation, Announcement, ImpersonationSession and PrivilegedOperation now state the rules migration `20261010100200` added (comments only — Prisma models no CHECK or trigger, so the migrate-diff drift check is untouched); `docs/CONVENTIONS.md` documents the sensitive-path placement and the `admin-`/`super-` filename convention that `tests/repo/student-exposure.test.ts` enforces; the optional `tests/repo/render-read-only.test.ts` is in (39 tests — W1 delegate writes, W2 `$executeRaw`, W3 raw SQL writes, over `app/**` render entries, `server/queries/**` and `components/**`; verified by injecting a write into `app/layout.tsx`, which it caught, then reverting). Open question resolved: Accommodation `requestedAt` gets **no** insert window — the other two anchor a database-enforced expiry, this one anchors nothing clock-gated (`docs/OPEN-QUESTIONS.md`) | PASS | Claude |
| 4 | 2026-10-19 | Review of the Phase 4 change — a **focused** read of the two highest-severity surfaces, not the six-dimension workflow in `docs/handoff/phase4/p4-review.workflow.js` (that is multi-agent and needs its own go-ahead; it stays available). (a) Two-person privileged approval: the rail holds at four independent layers — zod at the server boundary (`.max(25)` plus a dedupe refinement, so the direct path cannot be fed a padded array), the pure `policy.ts` checks, a conditional `UPDATE … WHERE status='PENDING' AND "payloadSha256"=$ AND "requestedById" <> $ AND "expiresAt" > now()` that makes the decision TOCTOU-safe, and the `PrivilegedOperation_two_person` CHECK. `bulkStatusRoute` counts a server-resolved row set, never client input. Break-glass requires `requestedById = actor`, sets `breakGlass = true`, and emails plus notifies every super-admin. (b) AdminScope: branded types mean only `buildStudentScope` mints a scope and only `scope.ts` mints a `ScopedStudentId`; it fails closed; the raw-SQL alias is regex-validated and grant values are bound parameters; `scopeCovers` correctly refuses to let a single-batch grant authorise an all-batches audience. **No defect found**; one unreachable fail-open recorded in `docs/OPEN-QUESTIONS.md` (`normaliseGrant`, malformed `batchYear`), code unchanged | PASS (no findings to fix) | Claude |
| 4 | 2026-10-18 | Live stage, stack up: web + scheduler + judge worker all in the WSL mirror (worker `RECX_DRIVER=isolate`, `RECX_SLOTS=8`, all five queues incl. `judge-rejudge`; scheduler `MAIL_TRANSPORT=log`). Worker came up through host verification (9 expected WSL2 hardening failures, dev override), self-check 12/12, calibration and per-language startup credit measured, lane allocator serving all five lanes | PASS | Claude (coordinator) |
| 4 | 2026-10-18 | Seed, then `validate-and-publish.ts <slug> --approve` for the six new problems on the real judge. Validation behaved correctly throughout: model solutions AC at the measured ceiling, deliberately-wrong solutions WA, brute-force solutions TLE at the derived limits | PASS — REC-0007 conveyor-shift, REC-0008 playlist-fold, REC-0009 bench-blackout, REC-0010 session-order, REC-0011 exact-change-pair, REC-0012 no-neighbour-seating all published at revision 1 with per-language limits; REC-0001–0012 now live | Claude |
| 4 | 2026-10-19 | Playwright against the live WSL stack with `E2E_JUDGE=1` (Chrome on Windows → `localhost:3000`), each project run on a fresh web-server heap after warming (see §1.5) | PASS — `a11y` **140/140** (axe WCAG 2.0/2.1/2.2 A+AA, zero serious or critical, light/dark × 1366×768/375×812, incl. the 22 Phase 4 `/admin`, `/super` and `/judge` rows); `rbac` 6/6; `judge` 2/2; `keyboard` 1/1 incl. the live-verdict steps 7–9 (Run Accepted, Submit WA with the failing case reached by Tab, Submit Accepted); `authoring` 1/1 — the full 10-step journey: author, validation fails on a wrong model ("produced WA") with Publish disabled, fix, second-admin approval by RECADMIN02, publish r1, student solve Accepted, publish r2, the older submission still shows Revision 1, the content-leak crawl over HTML/RSC/JSON finds no hidden test or reference canary, retire | Claude |
| 4 | 2026-10-19 | Manual (spec) governance checks, driven through the real `/super` UI with the sessions `global-setup` had already stored (no credential handled by the runner), against a 30-account cohort created out of band for the check and removed afterwards. (a) Two-person: a 30-account DISABLED request shows its exact size and digest, the requester is offered only "Cancel request" / "Break glass" and sees "Nothing to decide", RECSUPER02 approves → executed, 30 accounts DISABLED. (b) Break-glass: the requester self-approves the restore with a written justification → executed with `breakGlass = true`. Never quiet, verified in the database and the scheduler log: `privileged.break_glass` audit row at **SECURITY** (and `privileged.approved` SECURITY for the two-person path), one `EmailOutbox` row per ACTIVE super-admin (`security.break_glass`, `SENT`, transport `log`), one `privileged.break_glass` notification each, and the scheduler logged subject and body with no address | PASS | Claude |
| 4 | 2026-10-19 | Impersonation read-only (spec manual check) — covered by the `rbac` project: RECADMIN01 starts a 15-minute read-only view of the ECE student on a fresh session with a 20+ character reason, the banner shows, `POST /api/drafts` is refused 403 with the read-only message, "End impersonation" ends it, and `/super/audit` shows `impersonation.started` and `impersonation.ended` for that session | PASS | Claude |
| 4 | — | CI green on GitHub Actions | NOT RUN — nothing has been pushed | — |
| 5 | 2026-10-19 | `pnpm lint && pnpm typecheck && pnpm test && pnpm build` — Windows 11 (pnpm 9.15.9 via npx, Node 22.17.1), each gate run separately with its exit code asserted | PASS (lint 0 warnings; **4,748 tests passed, 0 failed**: shared 594, judge-worker 403, db 153, design 84, scheduler 136, web 2,753, repo 625; `next build`) | Claude (coordinator) |
| 5 | 2026-10-19 | Same four gates — Linux via `scripts/dev/linux-gate.sh` (WSL2 Ubuntu 24.04.4, PostgreSQL 17.11 on 5433, Redis 7.0.15, isolate 2.7), plus `migrate deploy` to `recx_test`, the `RECX_DB_TESTS=1 RECX_REDIS_TESTS=1` suites and the real-isolate suite | PASS 7/7 steps. With the services suites every test runs, none skipped: shared 594, judge-worker 403, db **431**, design 84, scheduler **172**, web **2,909**, repo 625; isolate-integration **260/260** | Claude |
| 5 | 2026-10-19 | The Linux gate caught 3 failures Windows structurally could not: `student-exposure.db.test.ts` (live content-leak canaries, `RECX_DB_TESTS=1` only) refused the new contest surface until it was registered. Fixed by adding a contest to that test's fixture which pins the SAME frozen `ProblemVersion` carrying canaries in every hidden test, checker and reference solution, with the student registered and on the board | PASS 13/13 — `listContests`, `getContest`, `getStandings` (as STUDENT **and** as ADMIN, since staff bypass the freeze and read different rows), `getRatingSummary`, all five contest pages plus the arena layout, and both contest actions called as a student, all proved to leak no canary | Claude |
| 5 | 2026-10-19 | Rating gate items (SPEC §5): a Codeforces-shaped fixture asserts Σdelta ≈ 0 and the top-set constraint, and rating computation is idempotent | PASS — `packages/shared/test/rating.test.ts` 35 tests on a realistic 40-participant field, which asserts FIRST that no delta is clamped so the zero-sum assertion is not vacuous; a separate reversed field proves the clamp binds at ±200 and that the total is then non-zero. Idempotence is structural and tested on a live database (`contest-invariants.db.test.ts`): `ratingComputedAt` and `ratedParticipants` are written once, together, and cannot be rewritten even by raw SQL, and a RATED contest never reopens | Claude |
| 5 | 2026-10-19 | `rebuild-standings` reproduces a standings table from `ContestProblemAttempt` byte-for-byte (SPEC §5) | PASS — `scripts/rebuild-standings.ts` (with a `--check` mode that diffs and exits non-zero), proved on a 150-participant board in the simulation below and on a live database in `contest-invariants.db.test.ts` | Claude |
| 5 | 2026-10-19 | Manual (spec): **a 150-participant simulated contest** — `apps/web/scripts/contest-sim.ts`, 3 problems pinned at frozen revisions, 364 authoritative attempt rows | PASS — rank pass **4 ms** against the 2-second budget; a second pass moves 0 rows (idempotent); the rebuild equals the stored board byte for byte; the freeze engages 10 minutes before the end, hides other rows, keeps the viewer's own, and never hides anything from staff; a mid-contest problem edit moves the live pointer and changes **neither the pin nor any verdict**; rating over 148 participants with Σdelta −18 and every delta inside the clamp. Cleans up after itself; the dev database was verified pristine afterwards | Claude |
| 5 | — | The "practice lane is never starved" half of that manual item | NOT RUN for Phase 5 — it is a judge-lane property, not a standings one, and was measured in Phase 2 with the burst harness (`scripts/load/`, `docs/CAPACITY.md` §6.2). Re-measure there if the lane weights change | — |
| 6a+6b | 2026-10-19 | `pnpm lint && pnpm typecheck && pnpm test && pnpm build` — Windows 11 (pnpm 9.15.9 via npx, Node 22.17.1), each gate run separately with its exit code asserted. Covers slices 6a (assessments, THE HARD RULE in the data) and 6b (the attempt engine: server-computed `expiresAt`, the attempt token, the heartbeat route, the status machine, auto-submit at the deadline, `ProctorEvent` partitioned monthly) | PASS (lint 0 warnings; **4,963 tests passed, 0 failed**, 607 DB/Redis tests skipped by default: shared 712, judge-worker 403, db 172, design 84, scheduler 136, web 2,829, repo 627; `next build`) | Claude |
| 6a+6b | 2026-10-19 | Same four gates — Linux via `scripts/dev/linux-gate.sh` (WSL2 Ubuntu 24.04.4, PostgreSQL 17.11 on 5433, Redis 7.0.15, isolate 2.7), plus `migrate deploy` to `recx_test`, the `RECX_DB_TESTS=1 RECX_REDIS_TESTS=1` suites and the real-isolate suite | PASS 7/7 steps (lint, typecheck, test, build, migrate-test-db, services-tests, isolate-integration). With the services suites every test runs, none skipped: shared 712, judge-worker 403, db **587**, design 84, scheduler 172, web **2,986**, repo 627; isolate-integration **260/260** | Claude |
| 6b | 2026-10-19 | The Linux gate again caught what Windows structurally cannot: `student-exposure.db.test.ts` (live content-leak canaries, `RECX_DB_TESTS=1` only) refused the new exam surface until the heartbeat route was registered in its `ROUTE_CALLS`. Fixed by adding an OPEN assessment to that fixture whose `AssessmentProblem` pins the SAME frozen `ProblemVersion` carrying canaries in every hidden test, checker and reference solution, plus a live `IN_PROGRESS` attempt for the student with a known token | PASS 14/14. Note the heartbeat answers **200 even when it refuses** (a candidate mid-exam needs a renderable body, not an error status), so `status: [200]` alone would not have proved the sweep got past the attempt guard — a separate assertion checks `revokeReason === null`, `status === "IN_PROGRESS"` and `msRemaining > 0`, so the canary sweep is known to exercise the authenticated path | Claude |
| 6b | 2026-10-19 | Auto-submit and the presence sweep, against a live database (`packages/db/test/attempt-sweep.db.test.ts`, 28 tests). The deadline is `expiresAt + pausedMs`, so a candidate on an invigilator-granted break is not force-submitted mid-break — the spec states the sweeper predicate as bare `expiresAt` two lines before defining `msRemaining = expiresAt + pausedMs − now()` and calling that "the bug that voids an exam"; the reconciliation is in `docs/OPEN-QUESTIONS.md`. **Mutation-checked**: replacing the deadline expression with bare `expiresAt` fails exactly the granted-break test and nothing else (1 failed / 27 passed), and restoring it returns 28/28 | PASS | Claude |
| 6b | 2026-10-19 | Proved by the same suite: auto-submit is idempotent, never re-submits a student's own submission, records `submittedAt` at the **deadline** rather than when the sweeper noticed, bumps `version`, cannot move `expiresAt` (the write-once trigger), and two concurrent sweeps finalise each attempt exactly once (`FOR UPDATE SKIP LOCKED`). And what it must never do: it cannot reach `VOIDED`, writes no `integrityScore`, and records no `ProctorEvent` — being finalised at a deadline is not evidence (SPEC §0) | PASS | Claude |
| 6b | — | The `db` suites are a **Linux-gate** item, not a Windows one | Recorded 2026-10-19 after running them from Windows against the WSL2 Postgres: several Phase 4/5 governance fixtures write an app-clock timestamp into a column a CHECK compares against a database-clock one (`PrivilegedOperation_decided_after_request_check`), and across hosts those are two clocks. WSL2's had drifted 210 ms ahead of the host over a suspend, which failed 13 tests **on an unmodified checkout**. Inside the mirror there is one clock and they pass. The underlying fragility is real in production too (app and database are separate hosts); the durable fix is for both columns to come from one `now()`, which is Phase 4/5 code and wants its own gated change — see `docs/OPEN-QUESTIONS.md` | — |
| 6b | — | Phase 6b's own live/e2e stage (an exam sat end to end) | NOT RUN for 6b — there is no exam surface to sit yet: 6b is the server-authoritative engine, and the client that beats at it is slice 6c. The heartbeat's own contract, the attempt guard and both sweeps are covered by unit and live-database suites above; the end-to-end sitting is a 6c gate item | — |
| 6c | 2026-10-19 | `pnpm lint && pnpm typecheck && pnpm test && pnpm build` — Windows 11 (pnpm 9.15.9 via npx, Node 22.17.1), each gate run separately with its exit code asserted. The exam surface: four pure modules (timer, palette, telemetry, snapshots), the three `/api/exam` ingestion routes, the `(exam)` route group, the shell components and the client that drives them | PASS (lint 0 warnings; **5,195 tests passed, 0 failed**: shared 880, judge-worker 403, db 175, design 84, scheduler 136, web 2,893, repo 648; `next build`) | Claude |
| 6c | 2026-10-19 | Same four gates — Linux via `scripts/dev/linux-gate.sh` (WSL2 Ubuntu 24.04.4, PostgreSQL 17.11 on 5433, Redis 7.0.15, isolate 2.7), plus `migrate deploy` to `recx_test`, the `RECX_DB_TESTS=1 RECX_REDIS_TESTS=1` suites and the real-isolate suite | PASS 7/7 steps. With the services suites every test runs, none skipped: shared 880, judge-worker 403, db **591**, design 84, scheduler **172**, web **3,050**, repo 648; isolate-integration **260/260** (5,828 in all) | Claude |
| 6c | 2026-10-19 | Gate item 6 (SPEC section 5): the timer announces at exactly the four moments and no others. A test walks **every second of a one-hour paper** and asserts exactly four announcements, at 10:00, 5:00, 1:00 and 0:10. Also covered: a tab the OS froze past several thresholds announces only the most urgent one (reading out a stale 10-minutes-remaining is worse than silence), and a granted extension re-arms the thresholds it moved back past | PASS — `packages/shared/test/exam-timer.test.ts` 29 tests | Claude |
| 6c | 2026-10-19 | Gate item 7: the palette's five states each carry shape, icon and label. Asserted as a FINGERPRINT — shape + glyph + badge — so the test fails if any two states become distinguishable only by colour, which is the way this requirement actually breaks | PASS — `exam-palette.test.ts` 32 tests, incl. Arrow navigation clamping rather than wrapping (one extra keypress from question 30 to question 1 is how someone loses their place in an exam) | Claude |
| 6c | 2026-10-19 | Gate item 5: a focus-loss event is persisted server-side **before** the overlay is dismissible. Structural rather than timed: the overlay's warning number and its wording are composed SERVER-side and returned by `/api/exam/[attemptId]/events` after the row is committed, so the client has nothing to compose and cannot show a dismissible overlay before the server answers | PASS — `exam-events.test.ts` 22 tests | Claude |
| 6c | 2026-10-19 | Gate item 9: a `SCREEN_READER` accommodation exempts the focus signals. Exempt from **counting**, not merely from acting — exempting the action while still counting would end the sitting at warning three regardless, which is the bug the exemption exists to prevent. The events are still recorded and the counters still move, so a reviewer sees the whole timeline beside the note that these signals are discounted | PASS | Claude |
| 6c | 2026-10-19 | The Linux gate again caught what Windows structurally cannot: `student-exposure.db.test.ts` refused the new exam surface until it was registered. Fixed by adding an OPEN assessment whose `AssessmentProblem` pins the SAME frozen `ProblemVersion` carrying canaries in every hidden test, checker and reference solution, plus three live attempts — and by rendering the **attempt page itself** in the canary sweep, which is the single most important leak surface in Phase 6. Note the heartbeat answers 200 even when it refuses, so a separate assertion checks that `revokeReason` is null to prove the sweep reaches the authenticated path | PASS 14/14 | Claude |
| 6c | 2026-10-19 | Found while building, and worth more than the feature: Tailwind v4 emits a colour utility only for a `--color-*` entry in the theme, so `text-fg`, `bg-surface-raised` and `text-on-accent` compile to **nothing** — no error, no warning. Five of them passed lint, typecheck and build and would have reached a student's screen looking nearly right (the real names are `text-text`, `bg-elevated`, `text-primary-fg`). `tests/repo/design-tokens.test.ts` now fails on any colour utility whose suffix names one of our token stems and does not resolve; **mutation-checked** by reintroducing two of the five. `docs/CONVENTIONS.md` | PASS | Claude |
| 6c | — | A mutating route outside `app/api/` is bound by no fence | Found 2026-10-19: the submit route was first written at `app/(exam)/assessments/[slug]/attempt/submit/route.ts`, where `capabilities.test.ts` requires neither a capability binding nor a guard call — its `required` list covers `app/api/**` (non-GET), `app/api/admin/**` and `app/super/**`. It passed every gate. Moved under `/api/exam/`, which is covered. Widening the fence's scope is recorded in `docs/OPEN-QUESTIONS.md` | — |
| 6c | — | Phase 6c's own live/e2e stage (an exam sat end to end with a screen reader, in each proctor mode) | NOT RUN yet — the exam surface exists and is unit- and fence-tested, but the manual items in `docs/handoff/phase6/DESIGN.md` section 4 (sit a full assessment with a screen reader; drop the network mid-attempt and confirm the work survives and the pill tells the truth) need the live WSL stack and a person. Carried to the Phase 6 closing stage | — |
| 6d | 2026-10-19 | `pnpm lint && pnpm typecheck && pnpm test && pnpm build` — Windows 11 (pnpm 9.15.9 via npx, Node 22.17.1), each gate run separately with its exit code asserted. Containment: the hall network allowlist, SEB config keys, WebAuthn device binding, the staff enrolment screen and the candidate's device check | PASS (lint 0 warnings; **5,604 tests passed, 0 failed** with the DB/Redis suites skipped by default; `next build`) | Claude (coordinator) |
| 6e | 2026-10-19 | The same four gates on Windows after 6e (triage banding, the review queue, the invigilator's hall, the student's own report, `/super/integrity`) | PASS — same run as the row above; 6d and 6e were gated together on Windows because 6e's review queue reads the attempts 6d contains | Claude |
| 6d+6e | 2026-10-19 | Same four gates — Linux via `scripts/dev/linux-gate.sh` (WSL2 Ubuntu 24.04.4, PostgreSQL 17.11 on 5433, Redis 7.0.15, isolate 2.7), plus `migrate deploy` to `recx_test`, the `RECX_DB_TESTS=1 RECX_REDIS_TESTS=1` suites and the real-isolate suite | PASS 7/7 steps (lint, typecheck, test, build, migrate-test-db, services-tests, isolate-integration). With the services suites every test runs, none skipped: shared 991, judge-worker 403, db **733**, design 84, scheduler 172, web **3,225**, repo 694 — **6,302**, plus isolate-integration **260/260** | Claude |
| 6d+6e | 2026-10-19 | `pnpm size` after the build | PASS — all budgets met; Monaco-free now covers **39 routes**, including every new admin and exam page. Nothing regressed | Claude |
| 6d | 2026-10-19 | Device and containment invariants against a live database — `packages/db/test/device-invariants.db.test.ts`, 31 tests: at most two active devices per student (the third is refused by a trigger, not by application code), a revoked device frees a slot, a loaner does not count toward the limit, a signature counter that goes backwards is refused while 0→0 is allowed (some authenticators do not count), a challenge is single-use, and an expired challenge cannot be consumed | PASS 31/31 | Claude |
| 6d | 2026-10-19 | The containment decision table as unit gates — `packages/shared/test/cidr.test.ts` and `seb.test.ts`. The three cases that matter are asserted as DISTINCT outcomes rather than booleans: an **empty** allowlist is no restriction (not a lockout — a hall whose allowlist nobody filled in must not refuse the whole cohort), an allowlist of only malformed entries is treated as empty and reported as invalid so an admin is told, and a configured allowlist against an address we cannot parse **refuses**. IPv6 is parsed properly — `::ffff:10.0.0.1` round-trips to the same bytes as `::ffff:a00:1` and `2001:db8:::1` is rejected — and a block **never matches across address families**, so an IPv4 allowlist entry cannot silently admit a dual-stack client | PASS | Claude |
| 6d | — | A Postgres CHECK can be created and still be an invalid regex | Found 2026-10-19: `col ~ '^[A-Za-z0-9_-]{16,1024}$'` exceeds Postgres's repetition limit of 255. The constraint was created happily — both catalog fences reported it present and correct — and then raised `invalid regular expression: invalid repetition count(s)` on **every insert**, because Postgres compiles the pattern lazily. A guard that exists is not a guard that works; only the invariant test proved it. Split into `~ '^[A-Za-z0-9_-]+$' AND length(col) BETWEEN 16 AND 1024`. `docs/CONVENTIONS.md` | — |
| 6d | — | Do not apply a migration to `recx_test` while a Linux gate is running | Recorded 2026-10-19: doing so left the mirror's guard catalog describing a database that had moved on, and produced two alarming fence failures that meant nothing. The gate owns `recx_test` for its duration | — |
| 6e | 2026-10-19 | Triage banding as unit gates — `packages/shared/test/triage.test.ts`. The three properties the phase stands on: a band is computed from `substantivePoints` ALONE, the context-only kinds (a devtools heuristic, a second monitor, an automation hint) total 18 points and **cannot raise a band** however many of them fire, and an exempt signal scores **zero** rather than a reduced amount. `BAND_REVIEWERS` requires two independent reviewers at HIGH and one at MEDIUM; LOW is sampled at 10% deterministically from the attempt id, so a student cannot tell from a review whether they were sampled | PASS | Claude |
| 6e | 2026-10-19 | Review, appeal and termination invariants against a live database — `packages/db/test/integrity-invariants.db.test.ts`, 37 tests: a verdict without a rationale is refused at three layers, a flag cannot skip from OPEN to CLEARED without a review, an appeal needs a decided flag, and **terminating a sitting takes a second member of staff** — `AttemptTermination_two_person_check` refuses the requester's own confirmation. Also what must never happen: no path writes a score, a band or an `integrityScore`, and nothing in the schema can hard-delete a flag | PASS 37/37 | Claude |
| 6e | 2026-10-19 | The SLA that protects students: `apps/scheduler/src/integrity-sla.ts` only ever CLEARS. A flag nobody reviewed within 72 hours publishes as CLEARED, and an appeal nobody decided within 7 days resolves in the student's favour. `apps/scheduler/test/integrity-sla.test.ts` (23 tests) captures **every write the job makes** and inspects it field by field against an allowlist of the four columns that LIFT a consequence (`status`, `outcome`, `resolvedAt`, `withheld`), asserts no status it writes is `UPHELD`/`VOIDED`/`TERMINATED`, that `withheld` is never set to true, and that no field name matches /score|band|points|rating|xp|verdict|penalt/. **Mutation-checked**: adding `withheld: true, integrityScore: 10` to the clear path fails 5 tests, three of them those fences. Written on 2026-10-19 while opening Phase 7 — the job shipped with 6e untested, which is why its 23 tests are counted in the Phase 7 gate below rather than in the 6d+6e rows above | PASS 23/23 | Claude |
| 6e | 2026-10-19 | `tests/repo/integrity-isolation.test.ts` — the fence SPEC §5 asks for by name: nothing under the integrity tree writes to a scoring model or sets a score column, nothing imports the judge, contests, ratings or XP, and the **student** tree never mentions `substantivePoints`, `contextPoints`, `queuePoints` or `integrityScore`. A band is for the person deciding, never for the student or a recruiter | PASS | Claude |
| 6e | — | A Postgres CHECK that evaluates to NULL is SATISFIED | Found 2026-10-19 and the most serious finding of the phase: `length(btrim("firstRationale")) BETWEEN 40 AND 4000` is NULL when the column is NULL, so `false OR NULL` is NULL and a verdict with **no rationale at all** was accepted by the constraint whose entire job is the mandatory rationale. Caught by the invariant test, not by either catalog fence. Fixed with an explicit `"firstRationale" IS NOT NULL AND`, and every hand-written CHECK in every migration was then audited for the same shape — only this one and the regex above were wrong | — |
| 6e | — | An API route must not use a PAGE guard | Found 2026-10-19 by the live canary sweep: the hall's SSE route used `requireAdminScopePage()`, which **redirects**, and an `EventSource` cannot follow a 307 into a login page. Changed to `requireActionRole` plus an `AppError` status. The symptom in the browser is a stream that silently never opens | — |
| 6d+6e | — | Phase 6's live/e2e stage (a full assessment sat with a screen reader, in each proctor mode; the network dropped mid-attempt) | NOT RUN — carried to the Phase 6 closing stage. Both items need the live WSL stack and a person; everything server-side is covered by the unit, fence and live-database suites above | — |
| 7a | 2026-10-19 | `pnpm lint && pnpm typecheck && pnpm test && pnpm build` — Windows 11 (pnpm 9.15.9 via npx, Node 22.17.1), each gate run separately with its exit code read. The question bank: three enums, three tables, 21 CHECKs, the published-question freeze, and the four pure modules in `@recx/shared` | PASS (lint 0 warnings; **5,775 tests** with the DB/Redis suites skipped by default; `next build`) | Claude (coordinator) |
| 7a | 2026-10-19 | `packages/db/test/aptitude-invariants.db.test.ts` — every CHECK and the trigger, attempted through Prisma, 53 tests. A catalog fence proves a guard EXISTS; only this proves it WORKS. It covers the one that could have failed silently: a CHECK may not contain a subquery, so "every correct index exists and no index twice" is an `IMMUTABLE` SQL function the CHECK calls, and the suite exercises it on a real insert | PASS 53/53 | Claude |
| 7a | 2026-10-19 | The arithmetic SPEC §5 gates the phase on: *negative marking and per-section cutoffs compute correctly across all seeded patterns*. `packages/shared/test/aptitude-grading.test.ts` grades all six — a perfect attempt, a blank one, one guessing every question, one exactly on each cutoff, and one mark below each — plus the four rules the spec leaves ambiguous, each recorded in `docs/OPEN-QUESTIONS.md` with the narrower reading | PASS — 76 tests, and the seeds live in `@recx/shared` precisely so this test can reach them | Claude |
| 7b | 2026-10-19 | The same four gates after 7b (patterns, sections, the totals trigger and the blueprint invariants) | PASS — **5,782 tests** on Windows | Claude |
| 7b | 2026-10-19 | Gate item: `patternTotals()` and `recx_sync_pattern_totals` agree on all six seeded patterns — one definition, two enforcements, so the denormalised totals a listing page renders cannot drift. `packages/db/test/mock-pattern-invariants.db.test.ts` also covers the case a single-row trigger usually gets wrong, a section MOVING between patterns, where the source would otherwise keep a total for a section it no longer has | PASS 37/37 | Claude |
| 7b | — | **A CHECK that evaluates to NULL is SATISFIED — again, in my own new code** | Found 2026-10-19, one phase after Phase 6e found the same shape. A blueprint entry with no `count` key makes `entry -> 'count'` SQL NULL, so `jsonb_typeof(...) <> 'number'` is NULL, so the EXISTS predicate is not TRUE, so it fell through to `SUM(NULL)` — and `NULL = "questionCount"` is NULL, which Postgres treats as satisfied. Every comparison in both blueprint helper functions is now COALESCEd and both results COALESCE to a failing value; the invariant suite walks ten malformed shapes and names the one that slips | — |
| 7c | 2026-10-19 | The same four gates after 7c (the sitting engine: four models, 18 CHECKs, four guard triggers, the three sitting modules, the finalise transaction, the server actions, the clock route and the `mockSweep` job) | PASS — **6,037 tests** on Windows | Claude |
| 7c | 2026-10-19 | SPEC §5's second gate for the phase: *a test asserts `allowBackNavigation: false` is enforced server-side, not just in the UI.* Three fences, three tests, none of which renders anything — `packages/shared/test/mock-navigation.test.ts` (the pure predicate, 31 tests), `apps/web/test/aptitude-navigation.test.ts` (the server action, called directly, with the database mocked so the assertion is about the ORDER of its checks: it consults `canAnswer()` BEFORE it writes), and `packages/db/test/mock-sitting-invariants.db.test.ts` (the same two writes by RAW SQL, past every action) | PASS — 12 + 40 tests | Claude |
| 7c | 2026-10-19 | The finalise transaction against a live database — `packages/db/test/mock-finalise.db.test.ts`, 20 tests. Three properties cannot be proved anywhere else: the ORDER (the trigger refuses the grading writes if the order is wrong, so a passing run IS the proof that grading happens before closing), idempotence (a re-finalise writes no second ledger row and does not double a score), and the negative-marking arithmetic end to end on rows Postgres accepted | PASS 20/20 | Claude |
| 7c | — | **Two CHECKs refused my own code, and both were right** | Found 2026-10-19 by the tests above. `MockAttemptAnswer_graded_check` refused the grading of an UNANSWERED question: `gradeAnswer()` returns `isCorrect: null` with `awarded: 0`, and writing that is a half-graded row. An unanswered question is not graded at all — both columns stay null and the section's `unansweredCount` carries the fact. And `AptitudeQuestionStat_counts_check` refused the roll-up's second run, because `timesAnswered` was incremented at finalise while `timesServed` moved nowhere. The increment now happens where the server SERVES the question, which also creates the answer row blank on first serve — giving `firstSeenAtMs` a real value and making "first serve" exactly once through `@@unique([attemptId, questionId])` | — |
| 7a–7c | 2026-10-19 | Same four gates — Linux via `scripts/dev/linux-gate.sh` (WSL2 Ubuntu 24.04.4, PostgreSQL 17.11 on 5433, Redis 7.0.15, isolate 2.7), plus `migrate deploy` to `recx_test`, the `RECX_DB_TESTS=1 RECX_REDIS_TESTS=1` suites and the real-isolate suite. Covers 7a, 7b, 7c and 7d's CSV pipeline | PASS 7/7 steps on the third attempt. With the services suites every test runs, none skipped: shared 1,303, judge-worker 403, db **991**, design 84, scheduler **212**, web **3,294**, repo 703 — **6,990**, plus isolate-integration **260/260** | Claude |
| 7c | — | **The Linux gate refused the phase twice, and was right twice** | Recorded 2026-10-19. Both failures were in a teardown or a clock rather than in anything a test asserted — all 3,293 tests passed each time — which is the lesson now in `docs/CONVENTIONS.md`: vitest prints `Tests 3293 passed` beside `Test Files 1 failed`, so a grep for assertions reports a clean run while the suite is red. **Read the Test Files line, or the exit code.** The first failure: `apps/web/test/student-exposure.db.test.ts` requires every self-service action to be registered with a FIXTURE INPUT so the canary sweep exercises it as the student, and seven new aptitude actions were unregistered — seven student-callable paths never swept for a leak. The second: `saveAnswer` clamped the answer time against the CLIENT's idea of when the question was seen rather than the server's stored `firstSeenAtMs`, and `MockAttemptAnswer_timing_check` refused the row | — |
| 7c | 2026-10-19 | The live half of the answer-key fence, which is the stronger half: the canary sweep's fixture now holds a PUBLISHED aptitude question whose worked explanation is a CANARY, a published pattern, and a sitting in progress — so the four mock actions run against a real paper instead of being refused before they read anything. The static fence (`tests/repo/aptitude-answer-exposure.test.ts`) proves no student-reachable module SELECTS the key; this proves nothing a student can actually call hands it back. The practice action is the one path that MAY return the working, and it is a POSITIVE control rather than an exemption — the sweep now also fails if the explanation stops being returned | PASS 14/14 | Claude |
| 7d | 2026-10-19 | The CSV pipeline SPEC §5 names: *reuse the LMS question-bank CSV import/export pipeline with per-row results.* The columns ARE the LMS question bank's, in its order, with pipe-separated options and a 1-based index or letter for the key, so a file exported from the LMS imports — including finding its topic in the `tags` column. The RFC 4180 reader moved from `roster-csv.ts` to `@recx/shared`, and the roster's nine tests are untouched as the proof the move changed no behaviour; the formula-injection-hardened WRITER moved out of `lib/privileged/csv.ts` (which re-exports it) rather than a second weaker one being written | PASS — 48 CSV tests, 24 import-planner tests | Claude |
| 7d | — | The byte cap is 4 MB, not the roster's 900 KB | Recorded 2026-10-19: a roster row is ~80 bytes while an aptitude row carries a 4 KB stem and an 8 KB worked explanation, so a realistic 300-question file runs to 1–2 MB and a 900 KB cap would refuse it WHOLE — the same failure "one bad row cannot discard a 300-question file" forbids, reached from the other direction. That is also why the upload is a route handler and not a server action: Next's default action body limit is 1 MB | — |
| 7d | 2026-10-19 | `tests/repo/aptitude-notice.test.ts` — any module whose CODE writes one of the five company names must render the notice SPEC §5 requires. Comments do not count and neither does the slug (`tcs-nqt` in a route is a key; "TCS NQT" on a page is a claim). It lands BEFORE 7e builds the card, the cover page and the result page, so those surfaces must satisfy it rather than being audited afterwards. **Mutation-checked**: a file exporting `const LABEL = "TCS NQT"` with no notice fails it by name and line | PASS — 17 repo fences, 710 tests | Claude |
| 7a–7d | — | The `pnpm size` and axe gates, and Phase 7's manual sitting | NOT RUN yet — there is no aptitude page to measure or to sit: 7a–7d are the schema, the arithmetic, the engine and the pipeline. The two new `size-budgets.json` routes, the axe rows and the manual item (sit a full seeded TCS-NQT-pattern mock and verify section timing, cutoffs and the explanation view) are 7e gate items | — |
| 5 | 2026-10-19 | `pnpm size` after the build. Two budgets added for the new surface | PASS — all budgets met: `/contests` **116.9 KB** (limit 130) and `/contests/[slug]/arena` **117.5 KB** (limit 135), both ~1 KB over the framework floor plus their shell because the arena links out to the existing workspace instead of embedding a second editor; the countdown is its only client component, costing 0.6 KB. Monaco-free now covers 34 routes incl. every contest page. Nothing else moved. Details: `docs/CAPACITY.md` §7.1 | Claude |
| 5 | 2026-10-19 | Playwright `contest` project against the live WSL stack | PASS 3/3 — a super-admin authors a contest, a DRAFT is invisible to students, publishing is refused with no problems, a problem is pinned at its current revision and the page states which, a letter cannot be reused, a student who never registered is turned away from the arena, registration lets them in, the arena is hard-blocked below 768 px with an explanation (the problem navigation is absent, not restyled), and a student cannot reach `/admin/contests` | Claude |
| 5 | 2026-10-19 | A bug the contest e2e caught on its first run: `<input type="datetime-local">` is timezone-naive, and the contest form sent the bare string, so the server parsed it in the SERVER zone — on a UTC host a contest set for 10:00 became 10:00 UTC, i.e. 15:30 IST. Fixed to the convention `announcement-form.tsx` already used (`istLocalInput()` in, explicit `+05:30` out) | PASS (after fix) — and recorded in `docs/OPEN-QUESTIONS.md`, because on a development box whose local zone IS Asia/Kolkata the bug is invisible: it appears only where the server zone and the author zone differ, which is production | Claude |
| 5 | — | CI green on GitHub Actions | NOT RUN — nothing has been pushed | — |
| 7e | 2026-10-19 | The four Windows gates over the student surface: the hub, topic practice, the pattern cover page, the sitting and the result. `pnpm lint && pnpm typecheck && pnpm test && pnpm build`, each run separately as `npx pnpm@9.15.9` with its exit code asserted | PASS 4/4 | Claude |
| 7e | 2026-10-19 | `pnpm size` with the three new sitting routes budgeted by their ENTRY paths. A mock sitting links out to nothing and embeds no editor, so the floor is the framework plus the palette and the clock | PASS — all budgets met and Monaco-free now covers **47 routes**, the three aptitude routes included. A timed paper that shipped a 2 MB editor it never uses would be a paper that loads slowest on the hardware least able to wait | Claude |
| 7e | — | Sit a full seeded TCS-NQT mock end to end and read the explanation view; and sit one with a screen reader in each proctor mode | NOT RUN — carried forward with Phase 6's deferred manual items. The palette's four states are shape + icon + `aria-label` and the clock's digits are `aria-hidden` with four spoken announcements, but neither is proof until somebody listens to it | — |
| 7 (all) | 2026-10-19 | The full Phase 7 gate on Linux — `scripts/dev/linux-gate.sh` in the WSL2 mirror (Ubuntu 24.04.4, PostgreSQL 17.11 on 5433, Redis 7.0.15, isolate 2.7): lint, typecheck, test, build, `migrate deploy` to `recx_test`, the `RECX_DB_TESTS=1 RECX_REDIS_TESTS=1` suites, and the real-isolate suite. Covers 7a through 7e | PASS **7/7 steps**, first attempt. With the services suites every test runs and **nothing is skipped: 7,222 tests**, plus isolate-integration **260/260**. (The bare `test` step reports 6,230 passed with 991 skipped — those are exactly the DB and Redis suites that the `services-tests` step then runs with their flags set, which is why the headline number is the services run. "Tests N passed" from the wrong step is how a gate fails green: `docs/CONVENTIONS.md`) | Claude |
| 8a | 2026-10-20 | `CalendarDay` and `LeaveException`: the four Windows gates plus the invariant suite. Both tables are append-mostly because a Phase 8c evidence row cites the days it excluded, so a calendar that could be rewritten afterwards turns old evidence into a lie | PASS — 50 invariant tests, all through Prisma and the immutability ones through raw SQL as well. Two real defects found BEFORE any surface existed: the decision-pair CHECK made an approved leave impossible to cancel (CANCELLED would have had to erase its decider, which the terms trigger refuses), and the rejection-note CHECK let through the single row it exists to refuse because `char_length(btrim(NULL)) >= 10` is NULL — the fourth time that trap has been sprung here. Both fixed by rolling the migration back in BOTH databases and re-applying | Claude |
| 8a | 2026-10-20 | A fence for the one guard no fence could see. `LeaveException_no_overlapping_approved` is `contype = 'x'`, so the CHECK catalogue, Prisma's drift check and `uncataloguedChecks` are all blind to it — a later migration could have dropped it with every fence still green | PASS — `EXCLUSION_CONSTRAINTS` added, policed statically against the migration SQL and live against `pg_get_constraintdef`, one catalogue entry serving both readings. The self-test mutates it six ways (dropped, re-added, wrong operator class, element removed, predicate removed, predicate widened to every status) and each is caught | Claude |
| 8a | 2026-10-20 | `calendar.manage` wired in the same slice its two models appear, which is what `capabilities.test.ts` demands. Four repo conventions this slice got wrong first and the fences caught: `runAction` takes the action name; a `"use server"` file may export only functions; a self-service capability binds actions, not pages; the `/super` page count is hard-coded so an undiscovered page fails rather than passing silently | PASS — the arriving-capability list is now EMPTY: all twelve of the spec's super-admin capabilities are wired to a real guard. `docs/SECURITY.md` regenerated | Claude |
| 8a | 2026-10-20 | The full Linux gate over 8a — `scripts/dev/linux-gate.sh` in the WSL2 mirror | FAIL then PASS. First run: **3,465 tests passed and the SUITE failed**, in `student-exposure.db.test.ts`'s teardown — exercising `account#requestLeaveException` as the fixture student left a `LeaveException` row, and the FK is RESTRICT because a student is never hard-deleted. Exactly the failure mode `docs/CONVENTIONS.md` warns about by name. Teardown fixed; the suite re-run in WSL passes 14/14 | Claude |
| 8b | 2026-10-20 | `InactivityPolicy`, versioned and immutable, plus `packages/shared/src/inactivity-policy.ts`. The thresholds are rows because SPEC §5 requires them to be tunable without a deploy — and therefore the rows can never be edited, since an 8c event cites the version it was decided under | PASS — 52 invariant tests and 41 pure tests. `InactivityPolicy_threshold_order_check` lists all six threshold pairs rather than adjacent ones, and COALESCEs every comparison: a null middle rung must not let the rungs either side cross, and a NULL comparison would have satisfied the whole CHECK. Nine of the invariant tests assert the zod schema and the CHECKs agree case for case, because where they disagree a super-admin either sees an unexplained database error or saves something the form should have refused | Claude |
| 8b | 2026-10-20 | A deliberate NON-constraint, tested: `disableAfterDays = 5` with auto-disable ON is **accepted** by the database | PASS — the test exists to stop the floor being re-added. A draft had `>= 14` in the CHECK, which contradicted the spec clause three sentences later; the college's own stated wish would have needed a migration. The fortnight argument ships as copy above the field with a typed confirmation and a SECURITY audit instead | Claude |
| 8b | 2026-10-20 | The expression index `InactivityPolicy_active_scope_key`, on `COALESCE` rather than on columns so that two GLOBAL policies collide — a plain unique index treats them as distinct because NULL <> NULL, and `resolveInactivityPolicy()` would stop being single-valued | PASS — `columnsPattern` added to the index catalogue for the case where there are no column names to quote, and each catalogued index now names its own migration so a detector handed one phase's migrations can tell "missing" from "not yours". Prisma renders a unique violation as P2002 and drops the constraint name, so the invariant test pins the COALESCE expressions (which no other index has) and `guard-state.db.test.ts` pins the name against `pg_get_indexdef`, where it survives | Claude |
| 8b | 2026-10-20 | `docs/RUNBOOK.md` §2's "a policy engine, not a kill switch" section, rendered verbatim on `/super/settings/inactivity` above the switch | PASS — the argument is product copy, not a comment, so the person who can turn on automatic disabling reads the case against it on the same screen, every time, and so does whoever inherits the job | Claude |
| 8a–8b | — | The manual dry-run gate (read a sweep report over seeded holidays, exam weeks, approved leave, partial activity, an open attempt, a pending appeal, an assessment 48 hours out and a student with no activity at all) | NOT RUN — there is no sweep yet. 8a is the calendar, 8b is the policy record; the dry-run job is slice 8c and the manual item is its gate | — |
| 8a–8b | 2026-10-20 | The full Linux gate over 8a and 8b together — `scripts/dev/linux-gate.sh` in the WSL2 mirror: lint, typecheck, test, build, `migrate deploy` to `recx_test`, the `RECX_DB_TESTS=1 RECX_REDIS_TESTS=1` suites, and the real-isolate suite | PASS **7/7 steps**. With the services suites every test runs and **nothing is skipped: 7,554 tests** (shared 1,420, judge-worker 403, db 1,183, design 84, scheduler 212, web 3,502, repo fences 750), plus isolate-integration **260/260** | Claude |
| 8c | 2026-10-20 | The counter and the DRY RUN. `AccountRestriction`, `AccountStatusEvent`, `packages/shared/src/inactivity.ts`, `packages/db/src/inactivity.ts` and `InactivitySweepJob` — which resolves policies, counts days, applies the holdbacks and reports, and writes NOTHING | PASS — 57 invariant tests, 17 candidate-query tests against real rows, 71 pure tests, 24 job tests. The dry run is a property rather than an intention: the job test's fake database records every method touched and asserts the set contains no `create`, `update`, `upsert`, `delete`, `$executeRaw` or `$transaction` — including when the scheduler was NOT started with `--dry-run`, because a flag nobody read the output of would not be the gate the spec asks for. Mutation-checked: a deliberate `user.update()` is caught by the recorder | Claude |
| 8c | 2026-10-20 | The three assertions that ARE the phase's safety argument, all through raw SQL with every trigger in force | PASS — a sweep row reaching DISABLED is refused while the policy it cites has `autoDisableEnabled` false (on the stage **or** the status); `NONE → DISABLED` is refused in one step; and a sweep transition cannot be stored without its evidence, with one test per required key. The eight-key list is **parsed out of the migration SQL** and compared against `inactivityEvidenceSchema`, so the CHECK and the zod schema are provably one list rather than two kept in step by hand | Claude |
| 8c | 2026-10-20 | Two bugs in my own triggers, both found by tests written before the migration was final | FIXED — `recx_refuse_stage_jump` refused a row where the stage did not move, which `AccountStatusEvent_change_check` explicitly permits (a status-only change is real: an admin taking an already-WARNED student off the board at their request). And the constraint-trigger guard was named `recx_require_restriction_event`, which the fence that lists every `recx_refuse_*` function cannot see — the exact hole I had just closed for EXCLUDE constraints. Both fixed by rolling the migration back in BOTH databases and re-applying | Claude |
| 8c | 2026-10-20 | A fence for CONSTRAINT triggers, which GUARD_TRIGGERS cannot describe | PASS — `AccountRestriction_requires_event` is `DEFERRABLE INITIALLY DEFERRED` with an `UPDATE OF` clause, and losing the DEFERRABLE would fail every sweep transaction on statement order alone. `DEFERRED_CONSTRAINT_TRIGGERS` pins its timing, its deferred-ness and the function it runs; the self-test mutates it four ways; and both "every trigger that runs a guard" completeness assertions now read it, so they cover every guard trigger rather than only the row ones | Claude |
| 8c | 2026-10-20 | Two test-harness faults worth recording, because both would recur | FIXED — an assessment scoped to a cohort holds back **every** student in it, so the suite needs two cohorts: a quiet one for the counting tests and one for the holdback fixtures. And every `CalendarDay` row this suite writes is in the past, where `CalendarDay_past_immutable` refuses DELETE — so a teardown that does not lift it leaves rows in `recx_test` for ever. The second time this phase that a Phase 6/7 guard caught a teardown: a published assessment refuses DELETE too ("archive it instead") | Claude |
| 8c | 2026-10-20 | The whole `@recx/db` suite inside WSL, with `RECX_DB_TESTS=1` | PASS — 23 files, **1,296 tests**, nothing skipped. Run inside WSL on purpose: twenty concurrent `prisma migrate deploy` processes saturate Windows→WSL localhost forwarding and leave it dead until a restart (`docs/CONVENTIONS.md`) | Claude |
| 8c | — | The manual dry-run gate: read a sweep report over seeded data covering holidays, exam weeks, approved leave, partial activity, an open attempt, a pending appeal, an assessment 48 hours out and a student with no activity at all | NOT RUN — the job exists and reports, and every one of those cases has an automated test, but the spec asks for a human to read the output before the job is allowed to write. It is the gate on slice 8d, not on 8c | — |
| 8c | 2026-10-20 | The full Linux gate over 8c — `scripts/dev/linux-gate.sh` in the WSL2 mirror | PASS **7/7 steps**, first attempt. With the services suites every test runs and **nothing is skipped: 7,762 tests** (shared 1,491, judge-worker 403, db 1,296, design 84, scheduler 236, web 3,502, repo fences 750), plus isolate-integration **260/260** | Claude |
| 8d | 2026-10-20 | The LIVE sweep: one transaction writing `AccountStatusEvent` + `AccountRestriction` + `User.status` + `Notification` + `AuditLog`, with the contest-lane cancellation and the mentor's `EmailOutbox` row; the restriction effects in the leaderboard query and `lib/progress/apply.ts`; `/admin/inactivity`; and the status event the existing manual super-admin path now writes | PASS — 8 live-transaction tests over real rows, plus the five Windows gates. The Redis removal is deliberately OUTSIDE the transaction: a Redis call does not roll back, and it does not need to — the row is already CANCELLED, so a job left in the queue is picked up, found cancelled and dropped | Claude |
| 8d | 2026-10-20 | A bug my own test found, and the FIFTH time this trap has been sprung here: `applyDecision` wrote `stageEnteredAt` from the application clock and let the event's `createdAt` take the DATABASE default — and `recx_refuse_restriction_without_event` compares the two. On any host whose clock runs ahead of the database, a perfectly correct write would have been refused | FIXED — both written from one clock. `docs/CONVENTIONS.md` already said this; it is worth re-reading before writing any pair of timestamps a constraint compares | Claude |
| 8d | 2026-10-20 | What the live transaction does NOT do, each with a test | PASS — only the CONTEST lane is cancelled (practice and assessment submissions run to completion, because a practice solve is the documented way OUT of the restriction and killing it would kill the exit); `User.status` is written only while `ownsAccountStatus`, so an account a human suspended for another reason is never quietly reopened or rewritten; a second instance holding a stale decision reports a race rather than writing a second rung; and a hold still refreshes the count and the review item, so the dormancy chip can warn a student BEFORE the rung they are heading for | Claude |
| 8d | 2026-10-20 | XP and rewards while paused | PASS — the `XpEvent` is still written, carrying `restricted: true`, and no `XpBucket` moves; `awardBadges` is passed no keys. Withheld, never destroyed: the ledger is append-only, so nothing has to be re-awarded when the restriction lifts and no compensating row is ever needed. Read at the START of the transaction on purpose, since 8e clears the restriction inside the same transaction and a later read would make the spec's `meta.restricted` unreachable | Claude |
| 8d | 2026-10-20 | Three repo conventions this slice got wrong first | FIXED — the capability fence requires the GUARD to be the first statement inside `runAction` (authenticate before parsing untrusted input, which is better practice as well as the rule); the AdminScope fence's R4 reads the literal identifier `scopedId` at the call site, so the checked id is visible in the query rather than three lines above it; and an `AdminScope` is REVOKED, never deleted — the fourth Phase 4/6/7 guard to catch a teardown in this phase | Claude |
| 8d | 2026-10-20 | The full Linux gate over 8d | **6/7 in one pass, then isolate-integration clean on a re-run.** lint, typecheck, test, build, migrate-test-db and services-tests all PASS first time; `isolate-integration` failed ONE test — `py312 MemoryError / OOM → MLE` returned TLE, i.e. the wall clock beat the memory wall on a loaded machine. The suite is in `apps/judge-worker`, untouched by Phase 8, and it passed 260/260 on an immediate clean re-run (and twice in the Phase 7 gates). Recorded as a load-induced flake rather than claimed as 7/7, because "it passed when I ran it again" is the honest sentence | Claude |
| 8e | 2026-10-20 | Restoration: auto-clear on solve inside the submission transaction, one-click self-service at `/account/reactivate`, and a retroactive approved leave reversing a restriction | PASS — the five Windows gates. Auto-clear is inside the solve's own transaction, so the solve and the restoration either both happen or neither does: a student told to solve a problem, who solved one, and who is still paused would be the worst possible outcome of a feature meant to reassure. Only on a FIRST solve — an accepted resubmission of a problem they had already solved is not new work | Claude |
| 8e | 2026-10-20 | The leave reversal RECOUNTS rather than assuming, and runs outside the decision transaction | PASS — a leave covering days that were not the days that counted reverses nothing and says so, so the approver learns the student is still over the threshold instead of believing they fixed it. Outside the transaction because the approval is the decision and must commit; a failed recount must not undo somebody's approval, and it is logged loudly rather than swallowed. It is also the one path besides a super-admin that may take an account out of DISABLED — deliberately: the student did not become inactive retroactively, the platform was wrong about them | Claude |
| 8e | 2026-10-20 | `tests/repo/inactivity-copy.test.ts` — two fences over the phase's most dangerous surfaces | PASS 14 tests. (1) `account#selfClearRestriction` must be guarded by `requireActionUser()` and nothing stronger: a later well-meant "hardening" pass adding a role check reads like an improvement and is in fact the removal of the only route out of a restriction, so the fence names all six stronger guards and fails on any of them. (2) No student-facing string says "disabled" — read as STRING LITERALS and JSX TEXT through `lexSource`, so a prop named `disabledReason` is code and a comment cannot smuggle copy past it. An all-caps bare token is exempt as an enum value, and a mutation check proves that exemption does not swallow `"Your account is disabled."`, `"DISABLED — contact us"` or `"account disabled"` | Claude |
| 8e | 2026-10-20 | The dormancy chip's accessibility, which is a requirement and not polish | PASS — icon plus words plus an `aria-label` carrying the whole sentence INCLUDING the way out; never colour alone; the number is text rather than only a ring's label; and it is NOT a `role="timer"` and not a per-tick live region, because a countdown that announced itself repeatedly would make a screen reader unusable (the same rule Phase 6 applies to the exam timer). It sits BEFORE the announcements and the cards in DOM order, so a screen-reader user meets the explanation first, and it is shown only once something is actually counting — a chip reading "0 of 10" on a student's first morning is a threat rather than information | Claude |
| 8e | — | The gating axe rows for `/account/leave` and `/account/reactivate`, and sitting a restriction end to end with a screen reader | NOT RUN — the Playwright rows are added and `pnpm size` covers both routes (Monaco-free over **50 routes**), but the axe run and the manual listen are carried forward with Phase 6's and 7's deferred manual items | — |
| 8 (all) | 2026-10-20 | **The full Linux gate closing Phase 8** — `scripts/dev/linux-gate.sh` in the WSL2 mirror over 8a through 8e: lint, typecheck, test, build, `migrate deploy` to `recx_test`, the `RECX_DB_TESTS=1 RECX_REDIS_TESTS=1` suites and the real-isolate suite | PASS **7/7 steps**. With the services suites every test runs and **nothing is skipped: 7,864 tests** (shared 1,527, judge-worker 403, db 1,304, design 84, scheduler 237, web 3,536, repo fences 773), plus isolate-integration **260/260**. Phase 8 is therefore green on Windows and Linux | Claude |
| 9a | 2026-10-20 | `packages/shared/src/readiness.ts`: the three tier formulas exactly as SPEC §5 gives them, `topicBreadth` as a MINIMUM, the points-carrying next action, and the framing copy as a constant | PASS — 36 tests. The spec's own example is a test by name: a profile with **200 array problems and zero graphs scores ZERO**, with GRAPHS named as the limiting topic. Each tier's weights are asserted to sum to exactly 1.00 — not tidiness, but because a tier summing to 0.95 would silently cap everybody in it at 95 and nobody could tell that from a cohort 5% short | Claude |
| 9a | 2026-10-20 | The honesty decisions, each with a test | PASS — weights are **not** renormalised over the present components (renormalising would make a student who has never done a mock interview look exactly as ready as one who has done five); `availableWeight` is reported beside every score, and the distribution buckets, the per-drive threshold and the at-risk cut all read the NORMALISED figure, because a raw 70 on a tier capped at 85 is not 70 out of 100; a MISSING component offers no points-available, since it is not a gap the student can close; SERVICE counts a hinted solve and the two higher tiers do not, which is what the spec's naming says | Claude |
| 9b | 2026-10-20 | `ReadinessRun`, `ReadinessSnapshot` and `MentorAssignment` with every CHECK and trigger, then the invariant suite over them | PASS — 37 tests against `recx_test`. The three honesty constraints each refuse the row they were written for: a TOP score of 95 against 85 measurable, a ZERO where nothing was measurable (and a NULL where something was), and a breadth value with no limiting topic beside it. A PLACEMENT_OFFICER is refused as mentor of record, because the at-risk list exists to route a student AWAY from the analytics surface. Two findings in the tests themselves: above 100 the range and score-le-available checks overlap unavoidably (the weight is itself capped at 100), so the assertion names both rather than pretending Postgres fixes the evaluation order; and both ends of a run's time window must come from ONE clock, since a `finishedAt` from the app clock lands before a `startedAt` taken from the database's default on the WSL mirror | Claude |
| 9b | 2026-10-20 | The input adapter and the 02:30 nightly job, including the dry run | PASS — 21 scheduler tests. The clock gate is asserted in both directions (it does NOT run at 02:00, which is when the Phase 8 sweep runs); every sample figure in the report carries its denominator; and a dry run is proved to write nothing by a recording proxy over the whole Prisma client, with a mutation check that the proxy would have caught a write. The adapter reads the college in one grouped pass per source rather than once per student | Claude |
| 9c | 2026-10-20 | `/placement`: the three tier cards, the measurable-weight denominator, the missing chips, the three largest gaps and one next action | PASS — 24 shared tests for the stored-snapshot round trip. The page recomputes nothing: it rebuilds the inputs from the stored breakdown and re-scores with the SAME `scoreTier` the nightly job used, and a test asserts the rebuild equals the stored scalar columns for three profiles (lopsided, middling, brand-new). A second implementation of the weights for the UI is how a card ends up disagreeing with the database, and the student is the one who notices | Claude |
| 9c | 2026-10-20 | `tests/repo/readiness-copy.test.ts` — the copy fence, and a proof that it bites | PASS (16 tests) — and it found a real defect in the card while being written. The count-based version of the denominator rule PASSED on a mutation that removed the visible denominator, because the file still named `availableWeight` in an aria-label; it was replaced with an adjacency rule (every rendered score must say "out of" within the next few tags). That version failed on the mutation and then failed on the UNMUTATED card too: the progress bar's accessible name said "62 of 90" where the visible text said "62 out of 90 measurable", so a screen-reader user heard a different sentence from the one on screen. Fixed in both labels | Claude |
| 9c | 2026-10-20 | Accessibility: axe over `/placement` at 1366x768 and 375x812, light and dark, as the seeded student against the live WSL stack | PASS 4/4, **zero violations**. Scanned against a page with DATA rather than an empty state: the seed now runs the real 02:30 pipeline (`pnpm seed` wrote 6 snapshots for 6 students on 2026-10-20), so the scan covers both the measured and the not-measured rendering paths. Every progress bar's accessible name carries its denominator ("Service companies: 0 out of 35 measurable points"). Playwright's chromium will not launch inside the WSL mirror (`libnspr4.so` missing), so the scan ran from Windows against the WSL server | Claude |
| 9c | 2026-10-20 | `pnpm --filter @recx/web size` for the new route | PASS — `/placement` 117.1 KB against a 135 KB budget, and it is in the `serverRendered` list: the page adds **0.2 KB** of its own (Next's page stub only), so no client JavaScript ships for it at all. A client component added here fails two checks rather than quietly costing every student a download | Claude |
| 9b-9c | 2026-10-20 | The four Windows gates over 9b and 9c | PASS 4/4 — lint (0 warnings), typecheck, test and build. **6,730 tests** pass (shared 1,569, judge-worker 403, db 282, design 84, scheduler 222, web 3,380, repo fences 790); the skipped files are the opt-in DB, Redis and isolate suites, which were run separately against `recx_test` | Claude |
| 9d | 2026-10-20 | The two role boundaries, as EXACT sets | PASS — `capabilityMatrix().PLACEMENT_OFFICER` and `.TA_MENTOR` are asserted by equality, not by spot check, so a capability granted to either by accident fails rather than ships. The officer holds the placement keys and the self-service ones and NOTHING from the twelve or from STAFF — which is where authoring, moderation, accommodations and the judge console live. Neither role holds the other's: an officer reading the at-risk list must not also be the named human it routes a student to, and the database refuses an officer as mentor as well | Claude |
| 9d | 2026-10-20 | `tests/repo/placement-fence.test.ts` — default-deny over the schema | PASS (46 tests). The rule is an ALLOWLIST of 19 models, not a classification of all 98: a model that is not on it may not be touched from a placement or mentor file, so a future `DiscussionPost` or `AssistantMessage` is forbidden the day it is created with no list to remember to update. That is how the unsatisfiable half of the spec's "cannot reach chat content by any route" gets discharged honestly. Proved it bites by adding `db.note.findMany` to a mentor query: 1 failed, naming the file, the line and why a note is the student's | Claude |
| 9d | 2026-10-20 | A runtime bug four suites missed, and the fence that came out of it | **FOUND AND FIXED.** `MentorScope` branded itself by writing `[MENTOR_SCOPE]: true` into the object literal. `declare const …: unique symbol` emits NOTHING, so that typechecks and then throws `ReferenceError: MENTOR_SCOPE is not defined` on the first render — which is exactly what `/mentor` did, HTTP 500, against the live stack. Lint, typecheck, 6,815 unit tests and the 1,465-test capability matrix all passed over it: the matrix hangs its database stub, so the literal was never constructed. Fixed by branding the type and casting in one constructor, the idiom `buildStudentScope` already used, and rule R5 of the placement fence now refuses a declared brand symbol used as a runtime key anywhere under `lib/auth`. Re-introduced the bug to confirm R5 fails on it | Claude |
| 9d | 2026-10-20 | Manual: all four new surfaces rendered against the live WSL stack with seeded data | PASS. `/placement-cell` as SUPER_ADMIN: the newest run, 6 snapshots, and the measurable weight per tier (SERVICE 35, PRODUCT 55, TOP 50) with the sentence that a cohort under 30 is not ranked at all. `/mentor` with no assignment: "Nobody is assigned to you" — it fails closed and says so. With one assignment inserted into the DEV database only: the mentee row, the reason, and `0 out of 35 measurable`. `/mentor/[menteeId]`: the three tiers and the gaps. `/placement` as that student: the mentor card, the badge, and the two lists of what a mentor can and cannot see. The verification row was then deleted — which needed `MentorAssignment_immutable` disabled, so the append-only guard was seen working too, and re-enabled with no trigger left disabled | Claude |
| 9d | 2026-10-20 | The four Windows gates over 9d, plus `docs/SECURITY.md` regenerated | PASS 4/4 — lint (0 warnings), typecheck, test and build. **6,815 tests** pass (shared 1,573, judge-worker 403, db 282, design 84, scheduler 223, web 3,409, repo fences 841). The capability matrix in `docs/SECURITY.md` was regenerated with `RECX_UPDATE_DOCS=1` and now carries five tiers. The student exposure sweep passes 14/14 against `recx_test`: the staff trees are excluded from it by name and covered by the capability matrix instead, and the student's own `/placement` stays in it | Claude |
| 9e | 2026-10-20 | The cohort arithmetic: `readiness-distribution.ts` and `placement-export.ts` | PASS — 44 tests. The distribution module is written so a ranking of students is not EXPRESSIBLE: no export returns a per-student row, and a test asserts that over the module's actual export list rather than trusting the author. Every bucket is over `score / availableWeight`, so two students on a raw 40 measured out of 85 and out of 50 land in different bands (47 % and 80 %) instead of the same one. The export allowlist is asserted in BOTH directions — assessment SCORES present, no source, draft, note, accommodation, percentile or integrity signal — because narrowing a permitted field is as much a departure as widening a forbidden one | Claude |
| 9e | 2026-10-20 | Two things found while writing that slice | **BOTH FIXED.** The repo already had a `csvCell` that prefixes a cell a spreadsheet would read as a formula with an apostrophe; I had written a second, weaker quoter, which is exactly how an export surface loses that protection — deleted, and the module reuses the strong one, which matters most here because a placement CSV is built from NAMES and opened in Excel. And an earlier draft of the readiness coverage targets shipped 80 / 60 / 50, making the hardest tier the easiest to max out; corrected to the design's 120 / 80 / 120, pinned by a test and recorded in `docs/OPEN-QUESTIONS.md` with the reason a change is a rules-version bump | Claude |
| 9e | 2026-10-20 | `PlacementExport`, and the invariant suite over it | PASS — 12 tests, and the suite found a real defect before any surface used the table. `array_length('{}', 1)` is NULL, not 0, and a CHECK that evaluates to NULL is SATISFIED — so `array_length("columns", 1) >= 1` accepted the exact row it exists to refuse. **The fifth time that trap has been sprung in this schema, and the fifth time an invariant test found it rather than a review.** Fixed with COALESCE, rolled back in BOTH databases and re-applied; `migrate diff` reports no drift. The record is append-only by trigger: one that could be edited would be a record of nothing, and one that could be deleted would let the person who exported a cohort remove the evidence | Claude |
| 9e | 2026-10-20 | The cohort dashboard: distributions, the 14 × section heatmap, the at-risk worklist, aptitude by section | PASS — rendered against the live WSL stack as the SUPER_ADMIN over six seeded students. Every chart ships the same bucket counts as an accessible `<table>` with a caption rather than an `aria-label` summary, because a summary is a sentence somebody wrote once and a table is the data. The heatmap prints `6/6` in every cell with shading as a redundant encoding. The at-risk list is ordered by DAYS QUIET and shows both figures (`0 out of 35 measurable (0%)`), and a student with no activity ever recorded is treated as the quietest rather than the freshest — which is the bug a naive `ORDER BY lastActiveOn` would have | Claude |
| 9e | 2026-10-20 | The filter's own counts, found by rendering rather than by a test | **FIXED.** Each page passed whatever total it happened to have — a section count on the heatmap, a run total on the overview — so the filter read "All (1)" on a page showing six students. There is now one `cohortSize()` derived from the filter's own options, which every page uses. Nothing failed; it simply read wrongly, which is the class of defect only looking at the page finds | Claude |
| 9e | 2026-10-20 | Routing to a named mentor, and what it deliberately does not do | PASS — a form submit with a visible focus ring, never a `mailto:` (SPEC §6), because a `mailto:` leaves no record of who was asked and the record is the only thing the control exists to create. It sends the STUDENT nothing: a student who receives "you have been flagged as at risk" learns only that a number somewhere is low, which is the discouragement the whole phase is arranged to avoid. There is no action on these surfaces that restricts an account, withholds XP or writes to a student's record — the maximum consequence of being on the list is that somebody is asked to talk to you | Claude |
| 9e | 2026-10-20 | The four Windows gates over 9e's analytics, plus the live suites | PASS 4/4 — lint (0 warnings), typecheck, test and build. **6,937 tests** (shared 1,620, judge-worker 403, db 287, design 84, scheduler 223, web 3,450, repo fences 870). Against `recx_test`: the 360-assertion live guard-state suite passes with the new table and trigger catalogued, the `PlacementExport` invariants 12/12, and the student exposure sweep 14/14 — the new placement action refuses a student with exactly Forbidden, by the sweep rather than by inspection | Claude |
| 9e | 2026-10-20 | The audited drill-down | PASS — rendered live, and exactly ONE `placement.student.view` row written, `SENSITIVE`, with the student as `targetUserId`. The `audit()` call comes BEFORE any read of the student, which is what makes the claim true: a log written afterwards is a log missing exactly the reads that failed. The page also says on its face that opening it was recorded, because a record nobody knows about is a trap rather than a deterrent. It renders every component with what it contributed and what it could — so an officer and the student are reading the same breakdown | Claude |
| 9e | 2026-10-20 | `/placement-cell/students/[id]` is deliberately NOT in the axe scan | **Decision, recorded.** An automated scan on every run would write an audit row for a student nobody looked at, and the value of that log is that every row in it is real. It is covered by the capability matrix (rendered as every role with the real guard) and by the manual pass below | Claude |
| 9e (export) | 2026-10-20 | The CSV, end to end against the live stack | PASS — `POST /api/placement/export` returned 200, `text/csv`, `cache-control: no-store`, `attachment; filename="recx-placement-pex_….csv"`, 8 lines for 6 students. The provenance line names the requester, the run and the export id; every readiness score is followed by its measurable weight (`"0","35"`); a student with no rated contests has an EMPTY rating cell rather than a 0, because a 0 rating in a spreadsheet reads as "terrible" and an empty cell reads as "none". One `PlacementExport` row with 23 columns and the file's digest, and one `placement.export` audit row at `SENSITIVE` | Claude |
| 9e (export) | 2026-10-20 | The export page states the cost before the download | PASS — rows, columns, and separately how many columns NAME A PERSON, which is the number that decides how the file should be handled. A plain form POSTing to the route: no JavaScript, and a POST because the route writes a record — a GET that recorded an export every time a tab was refreshed would make the record useless | Claude |
| 9e (export) | 2026-10-20 | Two registry gaps the capability matrix found, not a review | **BOTH FIXED.** The export route had no request recipe, so it was bound but never called as any role — the matrix refuses that by name. And the drill-down failed its "past the guard" check for every admitted role because `unstable_noStore` was missing from the test's `next/cache` mock: the import was undefined, the page threw a TypeError, and that reads identically to a page that never got past its guard. Worth recording because the failure pointed at the guard and the cause was the mock | Claude |
| 9e | 2026-10-20 | The four Windows gates closing 9e | PASS 4/4 — lint (0 warnings), typecheck, test and build. **6,973 tests** (shared 1,620, judge-worker 403, db 287, design 84, scheduler 223, web 3,474, repo fences 882). `docs/SECURITY.md` regenerated: `placement.analytics`, `placement.drilldown`, `placement.export` and `placement.mentor.route` are four separate capabilities rather than one, because reading a cohort, opening one student, taking a file off the platform and asking a human to intervene are four different powers | Claude |
| 9f | 2026-10-20 | `PlacementDrive`, `DriveEligibilityDecision`, `ProfileExport` and their invariants | PASS — 21 tests against `recx_test`. The assertion the tables exist for: **a decision inserted without its audit row does not COMMIT.** The deferred constraint trigger `DriveEligibilityDecision_requires_audit` fires at commit, not at insert — deliberately, because the audit chain takes a per-day advisory lock and appends with its own hash link, so the two writes cannot be ordered without one waiting on the other. Also asserted: an audit row for a DIFFERENT decision does not satisfy it, the whole transaction rolls back, and a decision is refused an edit and a delete | Claude |
| 9f | 2026-10-20 | The honest sentence about what the database can enforce | **Recorded, because a draft of the design overclaimed it.** A NOT NULL actor with a foreign key does NOT make an automatic eligibility decision impossible — any job holding a staff user id satisfies both. What is enforced is that a decision is attributable, carries a reason of at least ten characters, never changes, and cannot exist without an `AuditLog` row in the same transaction. The migration and the Prisma model both say so in their own comments, rather than implying more | Claude |
| 9f | 2026-10-20 | The signed export, end to end against the live stack | PASS. A link issued through the REAL signing module verifies: `Verified`, with the denominator and the framing on the page, and no email, roll number or department anywhere in the HTML. A **forged row** — the same facts with one number raised and the signature of the original facts, which is what somebody with database access but not the key could produce — renders `Does not verify`. That is the whole reason for signing: verification RE-DERIVES the signature from the stored payload, so a stored-signature comparison would have passed | Claude |
| 9f | 2026-10-20 | The frozen payload and the withdrawal, live | PASS — `UPDATE "ProfileExport" SET payload = …` is refused by `ProfileExport_payload_frozen` ("a signature over a mutable payload verifies nothing"); a withdrawn link renders `Withdrawn by the student` rather than a 404, so the student's withdrawal is not lost to a recruiter who reads "not found" as a mistake; and un-revoking is refused ("a withdrawn link stays withdrawn"). The verification rows were then deleted with the guard disabled and re-enabled, leaving no trigger disabled | Claude |
| 9f | 2026-10-20 | Codes cannot be probed | PASS — a well-formed code that does not exist and a MALFORMED one render the identical `Not found` page, and the malformed one runs no query at all. 24 url-safe characters from a CSPRNG, asserted over 50 generated codes against the same pattern the database CHECK enforces, with 200 distinct in a row | Claude |
| 9f | 2026-10-20 | The payload is a closed shape, asserted in both directions | PASS — 23 shared tests. `.strict()` all the way down, so an undeclared field cannot be signed; a sweep over the BUILT object finds a forbidden key at any depth (the schema and the builder can disagree, which is why both are checked); and the schema declares no `departmentCode`, `section`, `collegeId` or `email` while keeping `batchYear`, which answers "which cohort" without identifying anybody. Every attested tier carries `availableWeight` as a REQUIRED field — a public page is the last place a score can appear without its denominator | Claude |
| 9f | 2026-10-20 | The canonical form, which is what makes a signature survive a refactor | PASS — keys sorted at every depth, array order preserved because an array's order is data, `undefined` dropped from an object but kept as `null` in an array (its length is part of what was signed), and total: it throws on nothing a stored row could hold, because a verifier handed an unreadable row must say "does not verify" on a public page rather than 500. A test re-verifies a payload rebuilt with every key in the opposite order, at the root AND inside a nested object | Claude |
| 9f | 2026-10-20 | The per-drive count reads the NORMALISED figure | PASS — 15 shared tests, including the one that shows the arithmetic rather than asserting it in prose: on raw scores one of two students clears a bar of 70, and on the normalised figure both do, because `mockInterviewScore` leaves no TOP score above 85. A student with nothing measurable is counted in NEITHER direction — they are not below the bar, they were never assessed, and folding them in would let an officer read "40 fall short" when forty had no figure | Claude |
| 9f | 2026-10-20 | `EXPORT_SIGNING_SECRET` is its own secret, and refused at the default in production | PASS — 32 characters minimum, with a `superRefine` that refuses a production boot still holding the `dev-only-` default, the same shape the unhardened-judge override uses. The reasoning, recorded: a verify key is the one secret exercised by strangers on a public route, so it is the one most likely to be found wrong — and a key that could also mint a session or read the IP pepper would turn that into an account compromise | Claude |
| 9f | 2026-10-20 | The public page's weight, measured and recorded rather than claimed | PASS with a caveat written down. `/verify/[code]` is in `serverRendered`, so the PAGE adds 0.2 KB and renders fully without JavaScript, as SPEC §5 requires. Its first load is nevertheless 117 KB, which is Next's framework bundle plus the `(public)` layout chain — sent to every App Router route whether it needs them or not. Budget set to the measured figure with the comment saying what it is made of, and recorded in `docs/OPEN-QUESTIONS.md` as the strongest candidate in the product for the zero-JS Pages Router treatment `/login` already uses | Claude |
| 9f | 2026-10-20 | A false positive in the placement fence, found and fixed | **FIXED.** R3 ("no cohort surface ranks students by readiness") matched a 160-character window after `orderBy`, so `orderBy: { computedOn: "desc" }` followed by a `select` naming `serviceScore` was reported as a ranking. A fence that cries wolf gets widened until it says nothing, so it now reads the orderBy's own brace-balanced value — a nested `{ sort, nulls }` is included and the `select` after it is not. The self-test gained the exact shape that misfired | Claude |
| 9f | 2026-10-20 | The four Windows gates closing 9f | PASS 4/4 — lint (0 warnings), typecheck, test and build. **7,122 tests** (shared 1,658, judge-worker 403, db 297, design 84, scheduler 223, web 3,549, repo fences 908). Against `recx_test`: guard-state 373/373 with three new tables, two new row guards and the second deferred constraint trigger in the schema catalogued; drive and export invariants 21/21. `docs/SECURITY.md` regenerated — `placement.drives`, `placement.eligibility.decide` and the self-service `profile.export` are separate capabilities, because keeping a list of drives, recording a judgement about a student's opportunities, and a student signing their own record are three different powers | Claude |
| 9f | 2026-10-20 | Four registry gaps the LINUX gate found, which Windows cannot | **ALL FIXED.** The opt-in DB suites are skipped on Windows, so `pnpm test` there passed over every one of these: the officer CSV route had no `ROUTE_CALLS` entry (bound but never called as a student), `readiness#myExportLinks` was unregistered, `(public)/verify/[code]/page.tsx` was unswept, and the two self-service export actions had no fixtures. This is precisely what the `services-tests` step exists for — four tests failed and named each one | Claude |
| 9f | 2026-10-20 | The exposure sweep was passing on this action without exercising it | **FIXED, and worth recording.** `createProfileExport` threw on `IP_HASH_PEPPER: Required` before it built a payload: `env()` parses as a whole, so a module reading one variable fails on a missing unrelated one. The sweep still passed — an action that errors leaks no canary — while checking nothing. With `IP_HASH_PEPPER` and `EXPORT_SIGNING_SECRET` set in the suite's hoisted block the happy path runs, and the payload it signs is built from the fixture's own canary-bearing rows. Which then surfaced a teardown failure on `ProfileExport_userId_fkey` (RESTRICT) and `ProfileExport_payload_frozen` (no DELETE) — the same shape as the Phase 8a `LeaveException` teardown, and the same lesson: every test in the file passes and the SUITE fails | Claude |
| 9 (all) | 2026-10-20 | **The full Linux gate closing Phase 9** — `scripts/dev/linux-gate.sh` in the WSL2 mirror over 9a through 9f: lint, typecheck, test, build, `migrate deploy` to `recx_test`, the `RECX_DB_TESTS=1 RECX_REDIS_TESTS=1` suites and the real-isolate suite | PASS **7/7 steps**. With the services suites every test runs and **nothing is skipped: 8,466 tests** (shared 1,658, judge-worker 403, db 1,445, design 84, scheduler 259, web 3,709, repo fences 908), plus isolate-integration **260/260**. Phase 9 is therefore green on Windows and Linux | Claude |
| 10a | 2026-10-20 | The web process's metrics, read off a live `/metrics` rather than asserted in a test | PASS — `sse_connections_active` up and back down across a real verdict stream, `proctor_event_total{type}` moving as signals arrived, `submission_e2e_latency_seconds` observing a real submit-to-verdict. The exposition carries no label matching `user|student|college|handle|email|attempt|submission|ip|name|section`, and no `process_*` or `nodejs_*` (no `collectDefaultMetrics`: the host's own numbers come from the node exporter, which is the thing that still works when this process is the problem) | Claude |
| 10a | 2026-10-20 | `/api/health` always answers 200, and its Redis field was wrong until it was read live | **FIXED.** The endpoint reports `ok: false` in the body rather than a 5xx, because a health check that cannot be reached cannot say what is wrong. Reading the live response showed `redis: "down"` on a healthy Redis: the client runs with `enableOfflineQueue: false`, so a ping issued mid-connect rejects immediately. `pingRedis()` now waits for `ready` inside the same timeout. No test would have caught this — the stub was connected | Claude |
| 10a | 2026-10-20 | `/metrics` on web is 404, not 401, without the right token | PASS — no token, a wrong token of the same length, and the right one: 404, 404, 200. A 401 would confirm the endpoint exists to a scan; the route is also absent from the capability matrix's "required GETs" for the same reason, with the reasoning written at the list | Claude |
| 10a | 2026-10-20 | The judge worker's and the scheduler's `/metrics` listeners, live in the WSL mirror | PASS — scheduler on 9101 and worker on 9103: `GET /metrics` 200, `GET /` 404, and both refuse connections after SIGTERM. The scheduler publishes all five lanes as `judge_queue_depth{queue=…} 0` and the dev node's `judge_worker_heartbeat_age_seconds{worker=…} 2945.135` — a node that stopped checking in 49 minutes ago, rising rather than going missing, which is the whole reason that gauge is derived by the scheduler. Labels present: `queue`, `worker`, `le`, and nothing else | Claude |
| 10a | 2026-10-20 | A scrape one tick too early, which read as a broken pipeline | Worth recording: the first run showed the three gauge families with **no series at all**. The listener answers a few hundred milliseconds before the first reconciler tick, and the gauges are published BY the tick — so the scrape was 200 ms early. The check now waits for the tick before scraping. A metric with `# HELP` and no samples looks identical to one nothing publishes | Claude |
| 10a | 2026-10-20 | The four Windows gates closing 10a | PASS 4/4 — lint (0 warnings), typecheck, test and build. The suite caught the half-finished move of `judge_verdict_total` from the scheduler to web: `metricsFor("web")` was still a three-item literal in `apps/web/test/metrics-contract.test.ts`. Plus the opt-in Redis suite 7/7, including the new depth test | Claude |
| 10a | 2026-10-20 | `queues.depth()` against a real BullMQ, and the bug it exists to refuse | **FIXED before it shipped.** Every judge job this platform enqueues carries a lane priority, and a prioritized job never appears in BullMQ's `waiting` list at all — so counting only `waiting`, or reading the oldest age from its head, reports an empty queue during exactly the backlog the alert exists to catch. `depth()` counts `waiting + delayed + prioritized` and reads the oldest from the head of each of the three. Proved against a real Redis with a backdated job (ASSESSMENT lane, untouched by the other tests), and proved non-vacuous by reverting to the naive count: `expected +0 to be 1` | Claude |
| 10b | 2026-10-20 | **Every alert rule fired**, against the live stack where the condition can be produced | PASS 8/8 — `scripts/ops/fire-alerts.ts`. Live: `JudgeQueueBacklog` 250 real jobs on the PRACTICE lane (depth 250 > 200), `JudgeOldestJobStale` one job left to wait **61.6 real seconds** (> 60), `JudgeWorkerHeartbeatStale` a `JudgeNode` row 120 s stale (its own series read 120 s; the rule's `max by (worker)` read 4,771 s, the dev node that stopped checking in earlier), `FailedLoginBurst` **120 refusals in 2.6 s = 2,790/min** against the running web app, read back through the token-guarded `/metrics`. Synthetic, with the reason in the output: the two exporter rules (node_exporter and postgres_exporter need root to install here), `JudgeInternalErrorRate` (a real IE needs a checker that exits 3 — the 10f judge drill) and `SubmissionLatencyP95High` (a real 31 s verdict means making the judge slow, which is a load test). The two of our own are asserted through `buildMetrics` against the contract's real definitions, bucket ladder included | Claude |
| 10b | 2026-10-20 | Each rule fires just above its threshold and stays quiet just below it | PASS — 32 shared tests over the rule list, including a two-sided fixture per rule (200 vs 201 jobs, 90 s vs 91 s, 2 of 102 verdicts vs 3 of 103, 0.8 vs 0.81 of a disk, 100 vs 101 refusals a minute, a p95 of 20 s vs 37.5 s). A one-sided assertion passes on a rule that fires constantly, which is worse than no rule: it is a rule somebody silences, and then the real one is silent too. Also asserted: every rule's threshold appears in its own expression, every metric an expression reads exists (ours or a declared exporter's), and an absent metric reduces to `null` rather than 0 — "below the threshold" and "nothing is publishing" are different incidents | Claude |
| 10b | 2026-10-20 | `promtool check config` and `promtool check rules` | **NOT RUN HERE.** Prometheus cannot be installed on this machine without root (`apt` needs a password; no container runtime is running), so nothing here can parse PromQL or load a rule file. Both commands run in CI instead — `.github/workflows/ci.yml`, the `monitoring` job, pinned to the distribution's Prometheus — and `packages/shared/test/monitoring-files.test.ts` fails if that job is removed. What would have to be true to run it here: a Prometheus binary, which means root or a download; the gap it leaves is recorded in `docs/OPEN-QUESTIONS.md` along with the one-off `promtool test rules` that would close it properly | Claude |
| 10b | 2026-10-20 | The rule file is generated, and the dashboards plot only metrics that exist | PASS — `infra/monitoring/alerts.yml` is rendered from `packages/shared/src/alerts.ts` and the fence rewrites it under `RECX_UPDATE_DOCS=1`; a hand edit is a failing test. 13 further assertions over the committed files: `prometheus.yml` loads the rule file next to it, scrapes all three of our processes and both exporters, reads the web token from a file and carries no inline secret, and evaluates no faster than it scrapes (a `for:` shorter than one scrape interval fires on a single sample). Both Grafana dashboards parse, take the datasource as a variable, plot 12 expressions between them — every metric known — and group by no label that could identify a person, checked by reading the label names out of the expressions rather than by a substring search, because `submission_e2e_latency_seconds` contains the word `submission` | Claude |
| 10b | 2026-10-20 | Every alert says what to do, in the runbook, before it can fire | PASS — §2.12 above: one `#### <AlertName>` section per rule, each with the threshold, the first thing to check, and what NOT to do (do not flush the queue; do not free disk space by deleting a backup set; do not raise `max_connections`; do not raise the sign-in rate limits — they are what is working). The fence refuses a rule whose `runbook_url` anchor has no heading, and refuses a heading that is a heading and little else | Claude |
| 10c | 2026-10-20 | A problem statement renders from the cached read, live | PASS — signed in as a seeded student through the real form POST: `/problems/two-sum` returns 200 with the statement, its examples, the constraints, both samples, the language tabs and the starter code, all from the immutable `problem:{id}:v{n}` entry. Warm renders in dev mode: 886 ms, then 273, 245, 333, 251 — the markdown render and the two queries behind a statement now happen once per version rather than once per request | Claude |
| 10c | 2026-10-20 | The rank count the leaderboard ZSET would have replaced, measured before deciding | PASS (measured, then NOT built) — PostgreSQL 17.11, a table with the board's index shape and **50,000 rows, sixteen times a 3,000-student campus**: a student at the very bottom (every row ahead) counts in **5.2 ms**, one in the middle in **4.4 ms**. A Redis round trip is 0.2–0.5 ms of that, so the ZSET would save a few milliseconds and cost a second source of truth for the number students care about most — stale between rebuilds while the count is live, unable to express the opt-out subtraction or the `lastXpAt` tiebreak in one score, and doubled by the fallback path. Recorded in `docs/OPEN-QUESTIONS.md` with the thresholds that would change the decision (a board over ~200,000 rows, or that count over 50 ms). Also recorded there: the planner picks a seq scan, because `xp > me.xp OR (xp = me.xp AND lastXpAt < …)` is not a range on the index — the cheaper plan at these sizes | Claude |
| 10c | 2026-10-20 | A leftover mock-driver worker was judging everything AC, and the authoring journey caught it | Worth recording, because nothing else would have. The first `authoring` e2e run failed with "Echo unchanged (py312, expected WA): produced AC". The database showed all three reference solutions AC on four tests whose expected output is the input upper-cased: the deliberately wrong cpp20 model MATCHED, which is impossible. `ps` found TWO judge workers — one of them the `RECX_DRIVER=mock` process started 70 minutes earlier for the 10a metrics check, which had survived its `kill -TERM` and was still claiming jobs from the real queues and returning AC for every one. A mock driver on a shared Redis is indistinguishable from a broken judge, and the lesson for the runbook is in §1.5: a mock worker must never share the dev queues with a real one | Claude |
| 10c | 2026-10-20 | The publish-revalidates-the-pointer path, live | **NOT RUN today, and the reason is the platform working.** The `authoring` e2e journey is what exercises it end to end (publish r2, then the student sees r2), and it could not complete on this machine: under the load of a dev server, a judge worker on real isolate and a Playwright run, the node's 6-hourly self-check returned `memory-4gb: expected MLE, got TLE` — the 4 GB allocation hit the wall clock before the cgroup killed it — so the node **quarantined itself** and stopped claiming. That is the Phase 2 design: a node that cannot prove its sandbox judges nothing, and a QUARANTINED node needs an admin to clear it rather than clearing itself. A restarted worker on a quieter machine passed all 12 fixtures. What is verified instead: the cached statement read, live (the row above); the revalidation call sites, by `tests/repo/cache-keys.test.ts`, which fails if any `tags: [X]` has no `revalidateTag(X)`; and the 60-second pointer TTL as the backstop if a call is ever missed. The journey is carried to the Phase 10 gate run, where the suite runs on a quiet stack | Claude |
| 10d | 2026-10-20 | `POST /api/vitals`, live: what it accepts, what it drops, and what lands in Redis | PASS — against the running dev stack, unauthenticated, exactly as a browser's beacon posts. Four accepted reports became three histograms in the right buckets (LCP 1,900 → `2000`, LCP 4,200 → `6000`, CLS 0.03 → `0.05`, INP 180 → `200`), each key `vitals:2026-10-20:{METRIC}:{route}` with a TTL of 3,024,000 s (35 days) set on the write. Four refused reports wrote nothing and answered 204 like the rest: an unknown metric (`FID`), an unknown route (`/admin`), a real slug instead of its pattern (`/problems/two-sum`) and a valid report carrying a fourth field (`userId`). A scan of every `vitals:*` key matched nothing resembling `user`, `session`, `student`, `email`, `college` or `ip` | Claude |
| 10d | 2026-10-20 | The reporter is in the student bundle and not in the exam one, read off the production build | PASS — `web-vitals` is its own 6.6 KB lazy chunk, so the three page loads in four that are not sampled never fetch it; the reporter itself sits in the `(student)` layout chunk (4.0 KB). **Zero chunks under `app/(exam)` contain the beacon endpoint**, which is the property that matters: a locked-down page should make exactly the requests its own protocol describes. `tests/repo/exam-isolation.test.ts` keeps it that way by forbidding the import. Every size budget still met (`/dashboard` 121.5 of 160 KB, `/problems` 123.9 of 170 KB, `/problems/[slug] shell` 173.3 of 220 KB) | Claude |
| 10d | 2026-10-20 | **Lighthouse CI, run here** against a production build with the reference device's throttling | PASS — `@lhci/cli@0.14.0 autorun`, 3 runs per page, 4× CPU / 3 Mbps / 150 ms / 375×812. `/login` LCP **1,212 ms**, FCP 912, CLS 0, TBT 43, performance 98; `/judge` LCP **2,376 ms**, FCP 1,532, CLS 0, TBT 277, performance 91. Budgets are per page: `/judge` gets the statement page's 2.5 s because it is the platform's longest server-rendered document, raised after the measurement and written into `docs/CAPACITY.md` §8 with the reason — a budget loosened without one is a budget nobody chose. Recorded in full in `docs/CAPACITY.md` §8.4 | Claude |
| 10d | 2026-10-20 | Three things the first Lighthouse run found, none of them in the product | **ALL FIXED**, and each would otherwise have surfaced on a CI runner nobody was watching. (1) `/problems` was in the audit list and silently **redirected to `/login`** — Lighthouse holds no session, so all six runs measured the sign-in page and the only sign was "Checking assertions against 1 URL(s)"; the fence now refuses a session-guarded page in that list. (2) **The platform had no favicon at all** — `errors-in-console` failed with a 404 for `/favicon.ico`: no `app/icon.*`, no `public/favicon.ico`, no `<link rel="icon">` anywhere, so every page load in every browser logged an error and no tab ever showed a mark. Fixed with `app/icon.svg` and the explicit link the Pages Router sign-in page has to carry itself. (3) **Two assertions could never pass**: a `//` comment key inside `assertions` is read as an audit name, and `no-unload-listeners` and `render-blocking-resources` produce no value under these settings. The config also needed `npx next start` rather than `node_modules/.bin/next` (not a command on Windows) and not `pnpm exec` (the global pnpm on this machine refuses to switch versions) | Claude |
| 10e | 2026-10-20 | **The restore drill, run here**, into a scratch database | PASS in **67 s** — `scripts/ops/restore-drill.sh` against the dev database in the WSL2 mirror (PostgreSQL 17.11 on 5433). A 56 MB set taken and verified (`pg_restore` reads 1,055 entries; zstd verifies the test data), restored into `recx_drill`, and then the three questions that decide whether a restore is usable: **no drift** (`prisma migrate diff --exit-code` = 0 against the schema in this checkout), every counted table present and equal to the source (User 9, Problem 17, ProblemVersion 18, TestCase 207, TestBlob 334, Submission 1, AuditLog 391), and the unpacked store (145 files) agreeing with the restored rows about the 85 blobs that live in the store rather than inline. Migration head `20261020270200_phase9f_drives_exports`. The scratch database is created and dropped by the drill | Claude |
| 10e | 2026-10-20 | `verify-backup.sh` refuses a tampered set — four mutations, one control | PASS 4/4 refused, control verified. A changed byte in `database.dump` (digest mismatch, reported with both prefixes); a changed byte in `testdata.tar.zst`; a **manifest** whose digest disagrees with its own file (one digit changed); and **half a set** — `testdata.tar.zst` removed with the manifest untouched, refused with "a half set must never restore". That last one is the failure the one-set rule exists to prevent: a dump restored beside a test-data snapshot from another hour leaves submissions judged against test cases that no longer exist | Claude |
| 10e | 2026-10-20 | Every refusal in the ops scripts, exercised rather than reviewed | PASS 5/5. `restore.sh` refuses the live database by name and content ("it holds 116 tables… and its name is not one of the scratch shapes") and refuses an unverifiable set **before writing anything**. `deploy.sh` refuses an unset image, refuses one pinned by TAG (`registry.example/recx-web:1.4.2` → "must be pinned by digest"), and refuses to deploy blind when `/api/health` is unreachable ("deploy blind is not a deploy") | Claude |
| 10e | 2026-10-20 | The deploy gate that matters: a live contest | PASS — exercised against the REAL `/api/health` body with `activeContest` flipped to true, served from a throwaway listener (no contest invented in the database: the script's input is a health body, so that is what was varied). Without an override: **REFUSED** — "a contest or an assessment is LIVE. Students are mid-attempt; a rolling restart drops their SSE streams and their next save races the restart." With `FORCE_DEPLOY=1`: it proceeds and writes "deploying DURING a live contest or assessment, deliberately" to the deploy log, so the override is auditable rather than invisible. It then stops at `docker`, which this machine does not run — the honest boundary of what can be tested here | Claude |
| 10e | 2026-10-20 | `deploy/compose.{app,db,judge}.yml`, `deploy/Caddyfile`, `deploy/pgbackrest.conf` | **NOT RUN HERE.** One Windows laptop with a WSL2 mirror: no second host, no registry, no public hostname, no certificate, no object store and nowhere offsite. Each file says so at the top, and §2.13 lists what each would need. What is asserted instead, by `tests/repo/deploy-topology.test.ts` (15 tests): every image comes from a `${VAR:?…sha256:…}` so compose REFUSES to start rather than pulling a tag that has moved; the database host publishes **no** port; every judge-host port is bound to that host's monitoring address rather than to every interface (Phase 2: a judge host has no public listener); the app host publishes exactly 80, 443 and 443/udp; no credential appears as a value anywhere in `deploy/` (only `*_FILE` indirection or `${VAR}`); and the backup repository is encrypted with `aes-256-cbc` **before** it leaves the host, with the passphrase in the environment and not in the file | Claude |
| 10e | 2026-10-20 | The judge host is barely containerised, and the file says why | Recorded because it reads as a mistake: `compose.judge.yml` runs the worker `privileged` with the host's cgroup filesystem. That is what `isolate` needs, and the isolation that matters is between a student's code and everything else — which isolate provides on a host prepared by `infra/judge/install-isolate.sh` and verified at boot by the worker's own hardening check. A rootless container around it would add a second, weaker boundary and break the first. The honest alternative is no container at all: the systemd unit in `infra/judge/systemd/`, which is probably what a college with two judge hosts should use | Claude |
| 10f | 2026-10-20 | **The plug-pull drill**: `kill -9` the judge worker with 30 jobs in flight (SPEC §10's manual item) | PASS, and it found a bug (next row). 30 practice submissions enqueued at once; at the kill, 30 in flight and **12 holding leases**. The chain the platform then ran, in order: the worker died with its isolate boxes still allocated → the restarted worker's `isolate --init` failed on them ("This box is currently in use by another process") → each failure released the lease instead of posting a verdict → after **4 consecutive releases** the app **auto-drained the node** (audited `judge.node.auto_drain`, which is what that mechanism exists for) → the reconciler kept re-enqueueing the waiting jobs (`jobs.replaced` 18–22 every tick) while the node took nothing → `isolate --cleanup` on the job boxes, **Return to ONLINE** through `/admin/judge` with a reason (audited `judge.node.returned`) → every remaining submission judged. **Nothing was lost**: all 36 rows reached a terminal state (AC 27, CE 6, IE 3) with attempt counts 1×20, 2×7, 3×9. The three IEs are the honest cost of a hard crash — they exhausted their three attempts against a broken sandbox before the auto-drain stopped the node, which is the mechanism bounding the damage to three rather than twenty-two | Claude |
| 10f | 2026-10-20 | **A bug the drill found: six students' correct programs were recorded as CE** | **FIXED.** The six CEs in the row above all read `FileNotFoundError: [Errno 2] No such file or directory: 'main.py'`. A stale box is not a usable box, so the compile step ran against an empty one, the interpreter could not find the source, and the worker classified a non-zero compile exit as a **student's compile error**. A wrong verdict shown to a student is the one failure this platform must not have. `compileProgram` now checks, on a compile failure, whether the source file is actually in the box: if it is not, the box is broken and it is an `InfraError` — the lease is released, the job is retried on a healthy node, and three consecutive releases drain this one. `listFiles` failing counts as "present", so a transient listing error can never swallow a student's real compile error. Two tests in `apps/judge-worker/test/run-job.test.ts`: no source → InfraError, source present → still CE | Claude |
| 10f | 2026-10-20 | **The Redis drill**: `FLUSHALL` with jobs in flight (SPEC §10's second manual item) | PASS — harsher than the restart the spec asks for, and it needs no root: every BullMQ key deleted (170 → 0) while submissions were QUEUED, leaving Postgres as the only record of them. The reconciler put them back on its next ticks (`jobs.replaced`, because the job ids still existed in the lanes it rebuilt) and every submission reached a verdict. This is RUNBOOK §2.1's rule demonstrated rather than asserted: Postgres is truth, Redis is transport. What is NOT covered: a real `systemd restart` of Redis, which needs root on this machine — the difference is the AOF replay, and AOF is configured in `deploy/compose.app.yml` precisely so a production restart loses less than this drill did | Claude |
| 10f | 2026-10-20 | Returning a node to service through the admin page, driven | PASS — `apps/web/e2e/judge-resilience.spec.ts` (`--project=resilience`, not in any gate: it needs a live stack and a human to kill the worker). It found the node not ONLINE, clicked **Return to ONLINE**, typed a reason into the dialog and confirmed; the page then showed ONLINE and the audit log carries `judge.node.returned` with that reason. Done twice during the drills — once out of QUARANTINED (after the 4 GB self-check fixture failed under load, §10c) and once out of DRAINING (after the auto-drain above). The page also refuses the transition while a node's last self-check is failing, which is why the click is itself evidence that the restarted worker passed all 12 fixtures | Claude |
| 10f | 2026-10-20 | The judge worker's dependency surface, asserted for the first time | PASS — `tests/repo/judge-dependencies.test.ts`: **six** direct dependencies against SPEC §10's limit of twenty, and the list is closed, not just counted (`@prometheus-io/client`, `@recx/shared`, `bullmq`, `ioredis`, `pino`, `zod`). It also refuses a database client, an HTTP server or anything else that could turn networking on, and refuses the test toolchain in the runtime list. True since Phase 2 and never asserted, which is how a number that is true by accident becomes false. Recorded in `docs/SECURITY.md` §10b with the reason it matters on this process: every direct dependency is a package that runs *before* the sandbox does | Claude |
| 10f | 2026-10-20 | The schema drift check, in CI and verified locally | PASS — `prisma migrate diff --from-schema-datasource --to-schema-datamodel --exit-code` against the dev database: **"No difference detected."** Added to the `verify` job after the migrations are applied, where it catches the mistake that is invisible locally: a change to `schema.prisma` committed without its migration passes every test on the developer's own machine (because `migrate dev` kept their database correct) and produces a schema the code cannot use the first time somebody runs `migrate deploy`. `tests/repo/deploy-topology.test.ts` fails if the step is removed or moved before the migrations | Claude |
| 10f | 2026-10-20 | `.github/dependabot.yml`, closing a Phase 1 item | Written, and **NOT RUN** (nothing in this project has ever been pushed, so no Dependabot run exists). Weekly, grouped so a reviewer reads one PR per decision rather than fifteen; the development toolchain is one PR because it cannot reach a student. Four things are deliberately excluded and the file says why: Prisma (a client/engine bump is a migration problem), Monaco (self-hosted, with a copy step and a size budget) and the judge worker's runtime dependencies (a package that runs before the sandbox does is not a thing to merge on a Monday morning). `docs/SECURITY.md` §11 says the same rather than claiming the item is working | Claude |
| 10f | 2026-10-20 | The four Windows gates closing 10f | PASS 4/4 — lint (0 warnings), typecheck, test and build, plus `pnpm size` with every budget met. **7,307 tests** (shared 1,713, judge-worker 414, db 297, design 84, scheduler 246, web 3,599, repo fences 954), with 1,348 database- and Redis-backed tests skipped as they always are on Windows — the Linux row below is where those run. New in this phase and included in that total: the metric contract against three live registries, the alert rules fired two-sided, the cache fence, the vitals endpoint, the deploy-topology fence, the judge dependency fence and the perf-budget fence | Claude |
| 10f | 2026-10-20 | `activeContest` against a real contest, not a mocked count | PASS — `apps/web/test/health-contest.db.test.ts` against `recx_test`: a window that closed and one that has not opened count for nothing; a window open right now makes `activeContest` true and raises the count by one; and the contest ends **by the clock** two and a half seconds later with no write at all. The endpoint's body stays a closed set of nine fields with the live contest's slug and title nowhere in it. The deploy gate refuses a release on the strength of this boolean, so it deserved a test that trusts a database rather than a mock | Claude |
| 10f | 2026-10-20 | Two things the Linux gate caught that Windows cannot | **BOTH FIXED.** (1) `catalog.db.test.ts` failed with "Invariant: incrementalCache missing in unstable_cache": Phase 10c put the company filter's options under `unstable_cache`, and Next's real one throws outside a request — the function is only ever called from a request in production, so nothing on Windows noticed. The file now mocks `next/cache` to the identity, as the exposure sweep does, and keeps testing the SQL. (2) The new contest test was refused twice by the database, correctly both times: `Contest_freeze_check` (SPEC §5 allows a freeze only on a contest at least 90 minutes long) and then "its window, kind and rated flag are fixed" when it tried to end a PUBLISHED contest by moving its end date — a Phase 5 invariant so that a contest cannot be rescheduled out from under the students sitting it. The test now uses a two-and-a-half-second window and waits | Claude |
| 10 (all) | 2026-10-20 | **The full Linux gate closing Phase 10** — `scripts/dev/linux-gate.sh` in the WSL2 mirror over 10a through 10f: lint, typecheck, test, build, `migrate deploy` to `recx_test`, the `RECX_DB_TESTS=1 RECX_REDIS_TESTS=1` suites and the real-isolate suite | PASS **7/7 steps**. With the services suites every test runs and **nothing is skipped: 8,655 tests** (shared 1,713, judge-worker 414, db 1,445, design 84, scheduler 283, web 3,762, repo fences 954), plus isolate-integration **260/260**. Phase 10 is therefore green on Windows and Linux, and the ten phases of `docs/handoff/SPEC.md` are complete | Claude |
| 10 (CI) | 2026-10-20 | **The first CI run this repository has ever had** (PR #2, 66 commits, Phases 5–10) | **3 of 6 jobs failed, all three environmental, all three fixed.** Green first time: `Verify (windows-latest)`, `Judge integration (isolate)` — 260 real-isolate tests on a runner — and **`Lighthouse (reference device budgets)`**, which matters because its budgets were set from measurements on a loaded laptop and a runner is a different machine; they held. Failed: `Verify (ubuntu-24.04)`, `E2E (axe + keyboard)` and `Monitoring rules (promtool)`. Each is below, with what it showed and what it says about the gate | Claude |
| 10 (CI) | 2026-10-20 | A database test that quietly depended on seed data | **FIXED.** `packages/db/test/inactivity-apply.db.test.ts` built its submission fixture with `db.problem.findFirstOrThrow()` — which passes on any database that has been seeded or that another suite has written to, and fails with `P2025 No record was found` on a fresh one. CI's gate job applies the migrations and does **not** seed, so this was the first time it ever met a clean database (the file is from Phase 8, and the remote was at the Phase 1–4 commit until today). The fixture now creates its own problem, version and language config, and the teardown removes them. Proved against CI's condition rather than against the mirror: a scratch database created with migrations only (0 problems, 0 language configs) runs **the whole db project 1,445/1,445** and **the whole web project 3,762/3,762**, both green | Claude |
| 10 (CI) | 2026-10-20 | Two e2e tests lost to `next dev` compile time on a two-core runner | **FIXED.** `page.goto: Timeout 90000ms exceeded` on the RBAC test that walks all twelve `/super` pages in one test, and on one axe scan of `/bookmarks`; 199 of 201 passed. `next dev` compiles a route on its first request, and the suite visits about sixty — the same cost §1.5 documents locally, several times larger on a runner. Three changes, none of which weakens what the suite asserts: the CI dev server now runs with `--disable-source-maps` (§1.5: most of the heap fix), a new committed `scripts/dev/warm-routes.sh` pre-compiles the routes the suite visits **before** Playwright starts, so a slow compile is a slow build step rather than a test failure, and the CI-only navigation budget is 180 s. How fast a page arrives is asserted against a PRODUCTION build by Lighthouse and the `perf` project; this suite checks axe violations, RBAC and the keyboard journey | Claude |
| 10 (CI) | 2026-10-20 | `promtool check config` refused the config for being right | **FIXED.** "error checking authorization credentials or bearer token file `/run/secrets/recx_metrics_token`: no such file or directory" — `check config` validates that every file the config REFERENCES exists, and `prometheus.yml` points at the metrics bearer token as a Docker secret on the monitoring host. The token must never be inline (`tests/repo/deploy-topology.test.ts` refuses that), so the fix is on CI's side: the job now creates an empty file where the host has a secret, and the **full** check runs rather than a syntax-only one — which also proves `alerts.yml` is reachable from `prometheus.yml`, since `check config` resolves `rule_files` relative to it. This is the first time any Prometheus has read these rules | Claude |
| dev | 2026-10-21 | A sign-in that refused every attempt on the development machine — and what it was not | **FIXED, and nothing was wrong with the product.** `RECADMIN01` was answered with "Something went wrong. Please try again — if it keeps happening, quote reference …" on every attempt. That page is `POST /api/auth/login`'s answer to ANY unexpected exception (`?error=unavailable`, §1.8): the code is deliberately the same for a database outage as for a bug, and the reference is printed beside the exception in the web log, which is where this one was — Prisma `P1001 Can't reach database server at localhost:5433`. Two independent causes, both on the Windows↔WSL2 boundary. **One:** Windows resolves `localhost` to `::1` first and WSL2 serves only the IPv4 loopback, so the connection waited out a timeout on `::1` while `127.0.0.1:5433` connected on the first try — measured 20/20 against `127.0.0.1`, `ETIMEDOUT` against `[::1]`, with Redis unaffected because `REDIS_URL` already said `127.0.0.1`. **Two:** WSL stops the distribution within seconds of its last session exiting (16 s, measured), taking PostgreSQL, Redis and isolate with it — and `wsl -d Ubuntu -- pg_isready`, the obvious way to check, *starts* the distribution in order to run and so always answers happily. Fixes: `127.0.0.1` in both `.env.example` files, the RUNBOOK's own snippets and the 37 files holding a `RECX_TEST_DATABASE_URL` fallback; mirrored networking actually set in `%UserProfile%\.wslconfig`; a new `scripts/dev/stack-up.ps1` that holds the distribution open, starts the three services and proves from **Windows** that 5433 and 6379 answer; and `tests/repo/dev-stack.test.ts` so the examples cannot drift back. Verified: `/api/health` `{"ok":true,"db":"up","redis":"up","migrations":"current"}`, six consecutive admin sign-ins landing on `/admin`, a student sign-in landing on `/dashboard`, and the holder released and re-taken with the stack coming back both times | Claude |
| 10 (CI) | 2026-10-21 | The e2e job again: warming the pages was not enough, because the first thing the suite does is a POST | **FIXED (second attempt).** Run `39472472463` still failed `E2E (axe + keyboard)`, now in the storage-state setup: `Sign-in failed for 2116231001004`, with no alert text — and the empty alert was the clue, because a refused sign-in always renders one. The page had not navigated at all: `next dev` compiles `/api/auth/login` on its first request, and the warm pass added for the previous run only walked GET routes, so the compile landed inside `waitForURL`'s 120 s. Warming now POSTs the sign-in route with an empty form (refused as `identifier-missing` before the database or the limiter is touched, so nothing signs in), the helper's budget matches `navigationTimeout` on CI instead of expiring first, and its failure message now distinguishes "the server refused, and said why" from "the POST never answered". The warm step's own output is the check: 62 requests, `POST /api/auth/login -> 303`, 0 unanswered | Claude |
| 10 (CI) | 2026-10-21 | The e2e job, third attempt: `next dev` restarting itself mid-navigation | **FIXED.** Run `39480760114` left only this job failing, and the web log named the cause in Next's own words: "⚠ Server is approaching the used memory threshold, restarting..." — a minute after the warm pass, so the global setup's first `page.goto("/login")` got `net::ERR_EMPTY_RESPONSE` and the job ended before one assertion ran. The CI step's own comment had predicted exactly this. Two changes. **The suite now tolerates it:** every navigation in `apps/web/e2e` goes through `openPage()` (`e2e/support/page.ts`), which retries only connection-level failures (empty response, refused, reset) while a budget lasts and rethrows everything else — a navigation TIMEOUT is still a failure, because a page that takes too long is a finding and this must never turn one into a pass. 53 call sites across ten files. **And it should not have to:** Next sizes that threshold from the V8 heap limit, so the CI dev server now runs with an explicit `--max-old-space-size=4096` instead of whatever the runner's memory implies. Proved locally against a live stack, including the helper's two halves: `--project=judge` **2/2** (its global setup signs all eight accounts in through the real form, so every converted navigation in `session.ts` ran), and with the dev server deliberately down, `openPage` retried `ERR_CONNECTION_REFUSED` for its whole budget and then **failed** rather than hanging or passing. The fence was proved non-vacuous by adding one `page.goto` to a spec and watching it fail. `--project=rbac` was run twice and is **not** evidence either way: 4 passed and the two failures were this laptop, not the suite — a 500 whose cause the dev log gives as `P1001 … can't reach 127.0.0.1:5433` (§1.8: a long local run can still knock the WSL2 loopback out), and on the rerun `Compiled /problems in 84.9s / GET /problems 200 in 124294ms`, a compile four seconds over the budget on a loaded machine — which is the cost CI's warm step exists to pay outside the assertions | Claude |
| deploy | 2026-10-27 | Asking what a real deployment needs, and finding three defects in the Phase 10e artefacts | **Three defects fixed, each of which would have stopped the server from starting.** (1) **No process read a `*_FILE` secret.** `deploy/compose.app.yml` passes every credential as a Docker secret — it must, because `tests/repo/deploy-topology.test.ts` refuses a credential written as a value — and nothing in the application looked for `EXPORT_SIGNING_SECRET_FILE`, `DATABASE_URL_FILE` or `RECX_NODE_TOKEN_FILE`. The web app would have found the development signing secret and refused to start in production; the judge worker would have had no token. Fixed with `packages/shared/src/env-file.ts` (`KEY` wins, else `KEY_FILE` is read and trimmed; an unreadable or empty file throws rather than silently defaulting), wired into all three processes, and additionally into `apps/web/src/lib/db-client.ts` because Prisma resolves `DATABASE_URL` from the environment when its client is CONSTRUCTED, which can happen before anything calls `env()` — that is the one line in the application that builds a client, so the ordering guarantee belongs there. A Next start-up hook was written first and discarded: `src/middleware.ts` exists, so `instrumentation.ts` is compiled for the edge runtime as well, where `node:fs` cannot be bundled at all, and a dynamic import inside a `NEXT_RUNTIME` guard did not keep it out of that graph (`UnhandledSchemeError`, caught by `pnpm build`). (2) **Names that matched nothing:** `TESTDATA_S3_ENDPOINT`/`_BUCKET`/`_ACCESS_KEY_FILE`/`_SECRET_KEY_FILE` against an app that reads `S3_*`, an `AUTH_SECRET_FILE` for a variable this application has never had, and the scheduler handed the direct database URL under `DATABASE_URL` when its config refuses a missing `DATABASE_URL_DIRECT` outside development. (3) **`TRUST_PROXY` was never set on the app host**, so behind Caddy — which sets `X-Real-IP` for exactly this — the app would have read no client address at all: every per-address rate limit inert, every audit row without an `ipHash`, and nothing visibly wrong. New fences: the compose files may now hand a process only variables that process reads (proved non-vacuous by restoring `TESTDATA_S3_BUCKET` and watching it fail), `TRUST_PROXY` must be on, and the scheduler must get its direct URL. `APP_URL` and `REDIS_URL` are now refused in production when unset rather than defaulted to `localhost`, because a rate limiter pointed at a Redis that is not there fails open exactly as designed and says nothing | Claude |
| 11a | 2026-10-28 | A one-time link, so a roster account can have a password at all | **DONE.** A roster import creates every student with `passwordHash` NULL — the LMS is the identity source and no password crosses that boundary — and nothing in the product could set one afterwards, so the only accounts that could sign in were the seed's. Every student this platform is for was locked out of it. `/forgot-password` → mail → `/reset-password` closes that: sha256 of the token only, 256 bits, one hour, one use (a conditional UPDATE whose row count settles the race, a trigger that refuses un-spending it or moving it to another account), one answer whether or not the account exists (including when the rate limit refuses), one message for expired/spent/superseded/invented, every session of the account ended after the new hash commits, and a security mail to every super-admin when a super-admin's password is set this way. 10 database tests against the real trigger; demonstrated end to end on this machine — refused at sign-in before, the mail read out of the outbox, weak and mismatched passwords refused with the link surviving, the link spent once and refused the second time, and the new password signing in to `/dashboard` | Claude |
| 11a | 2026-10-28 | One student, typed in | **DONE.** `/admin/students/new`: the late admission and the transfer, which until now needed a CSV of one row. It is deliberately not a second way to create a student — the field validation is `rosterRowSchema`, the conflict and scope decisions are `planRosterImport`, the write is `applyRosterPlan`, and the same advisory lock an import takes — so anything that is not a clean creation inside the admin's scope comes back as the planner's own refusal. No `RosterImport` row: a manual add has no file name and no file hash, and inventing them would put a lie in a provenance field, so the audit entry (`student.added`, with the actor and the scope) is the provenance. 5 database tests, including that the account arrives with no password, exactly like an imported one | Claude |
| 11b | 2026-10-28 | **The proctoring audit, and what it found** | **FIXED.** `docs/PROCTORING.md` is the most load-bearing prose in the repository and was prose alone; turning it into `tests/repo/proctoring-posture.test.ts` found that prose and code had drifted badly. **(1) The integrity engine was inert.** `flagAttemptIfNeeded` — written in Phase 6, complete, idempotent, audited — was called by NOTHING. No attempt was ever flagged, no result was ever withheld, the 72-hour SLA had nothing to act on, and the review queue, the reviews and the appeals were a surface over an empty table. Every test passed, because every test called the engine directly. It is now called at submit, after the derivation below, and a fence asserts both. **(2) Seven of twenty-five declared signals were produced by nothing**, with nothing to say so — and a signal a reviewer believes exists and does not is worse than one never offered, because its absence reads as evidence. The worst was `SNAPSHOT_JUMP`, the heaviest substantive contribution in the triage engine (30 points), which SPEC §5 calls "the most probative artefact" and "the one piece of evidence that survives client tampering": its derivation was written and tested in Phase 6 and never called, so no exam has ever been reviewed with it. Now derived at submit, when the final solution the rule is a share of first exists, with a grace window so an ordinary paste explains its own interval, exemptions from the attempt's frozen accommodation flags, and a refusal to run twice. `FIRST_KEYSTROKE`, `IDLE_GAP`, `NETWORK_DROP` and `CLIENT_SCRIPT_ERROR` are now emitted by the exam client; `INVIGILATOR_NOTE` gained a producer (`invigilate#recordObservation`), so the control §4 rates highest — a physical invigilator — can finally put what they saw in front of the reviewer, as context that cannot raise a band. `DEVTOOLS_HEURISTIC` and `SUBMISSION_RATE_ANOMALY` are reserved with their reasons in code (one is unreliable in both directions; the other has no referent, because a sitting submits once). The three lists partition the vocabulary and a test holds them to it, so a kind added now fails until somebody answers "who emits this?". **(3) Contests:** no proctor mode, no telemetry, no flags — a decision, not an omission, now written in §6 with its three reasons and fenced, so nobody half-builds collection a student was never told about. 10 new database tests (snapshot jumps derived, not derived when a paste explains them, not derived from steady work, never doubled; banding that leaves a clean sitting alone, refuses to flag on context alone, withholds with a 72-hour deadline, is idempotent, and touches no score, status or account) | Claude |
| 11b | 2026-10-28 | Changing a password you already know | **DONE.** `/profile/settings` → "Password", for every signed-in role. Until now nobody could change their own password at all — a super-admin who suspected theirs was known had to ask for a reset link to replace it. The current password is required and verified with Argon2id (a change that needed only a live session would turn an unlocked laptop in a lab into a permanent takeover), which makes the form a guessing oracle, so it is rate-limited per account and a wrong current password is audited as `auth.password_change_failed`. Every session ends including the one making the change, because the friendlier alternative leaves whoever prompted the change still signed in. An account with no password is sent to the sign-in page's link instead of being asked for one it does not have. 4 database tests | Claude |
| 11c | 2026-10-28 | "Can proctor mode require an incognito window, so no extensions load?" | **ANSWERED, AND THE REAL CONTROL SHIPPED.** No, three times over, and the reasons are in `docs/PROCTORING.md` §8 with the §2 limitation beside the extension one: a page cannot detect private mode (no API; Chrome treats detectability as a leak and has closed each one found — the FileSystem probe in Chrome 76, the storage-quota probe after it — and the heuristics that survive misreport Guest mode and some ordinary profiles), a private window is not extension-free anyway (*Allow in incognito* is a per-extension toggle; unpacked developer-mode extensions ignore the question), and a page cannot enumerate extensions in any window. The general form, which is the part worth keeping: **what the candidate's browser reports about the candidate's browser is not a control**, and a gate built on a self-reported value is strictly worse than a signal — when it is wrong it stops an honest student from sitting the paper instead of adding a line a reviewer can discount, and it chooses who on exam morning at random. So nothing was added to the exam client. What shipped instead is the control §4 lists first, which until now was a sentence: `deploy/lab-policy/` — `chrome-policy.json` (Linux/ChromeOS), `recx-exam-policy.reg` (Windows) and a README explaining every key — plus `docs/RUNBOOK.md` §2.14 with the install, the root-ownership check and a five-step per-hall verification at `chrome://policy`. `ExtensionInstallBlocklist: ["*"]` is the real "no extensions", and it holds because the college owns the policy file. Two findings worth the row: **Chrome Sync is the hole that would have undone it** — without `BrowserSignin: 0` and `SyncDisabled: true`, one Google sign-in reinstalls the candidate's own extension set on arrival and the blocklist is theatre; and the policy **disables** private mode rather than forcing it, because what the idea actually wants is a clean browser for the next candidate, which `ClearBrowsingDataOnExitList` does without private mode's own hazard (a window closed by accident takes the session with it, mid-sitting, against a running clock — the hazard the `/assessments/[slug]/readiness` page now warns the candidate about in one line). Fenced: 6 tests in `tests/repo/proctoring-posture.test.ts` (§8 — no storage-quota probe, FileSystem probe, detection library, `chrome-extension://` probe or `chrome.management` anywhere in `apps/web/src`, beside the §5 `getUserMedia` fence) and 9 in `tests/repo/deploy-topology.test.ts` (the two policy files must agree key-for-key across two syntaxes, every key must be explained in the README — which caught `HomepageIsNewTabPage` undocumented — the placeholder host must be `.invalid` so a forgotten one fails loudly, and the one-host allowlist must stay sound, read from the CSP in `apps/web/src/middleware.ts` rather than assumed). NOT RUN: the policy itself. There is one laptop and no lab, so no machine has had it installed; §2.14 is written to be verified in front of a candidate, and that is where it must first be run | PASS (gate; policy NOT RUN) | Claude |
| 11c | 2026-10-28 | `pnpm lint && pnpm typecheck && pnpm test && pnpm build` + `pnpm size` — Windows 11 (pnpm 9.15.9 via npx, Node 22.17.1), each gate run separately with its exit code asserted | PASS (lint 0 warnings; **7,462 tests passed, 0 failed**, 1,376 DB/Redis tests skipped by default: shared 1,730, judge-worker 414, db 301, design 84, scheduler 246, web 3,651, repo 1,036 — +15 over Phase 11b, all of them the new fences; `next build` exit 0; all size budgets met, `/assessments/[slug]/readiness` 118.7 KB of 130 after the private-window line, zero-JS `/login` confirmed from the served build) | Claude (coordinator) |
| 11f | 2026-10-29 | An initial password an admin can set, and the one sign-in it is good for | **DONE.** Both ways of adding a student — `/admin/students/new` and the roster CSV import — now take an optional initial password, and both create accounts that must replace it. Blank keeps the older behaviour (no password; the holder uses the one-time link), which is still the better path wherever mail works. The danger is that a default password is in practice ONE password for a whole batch, so `User.mustChangePassword` makes it good for exactly one sign-in: while it is set, `requireUser` redirects every page to `/account/new-password` and `requireActionUser` throws on every action, the replacement is refused if it is the password they were given, and a CHECK refuses the flag on an account with no password at all. Sign-out still works (it reads the session directly). Verified against recx_test: 6 tests in `initial-password.db.test.ts` — including the database refusing the flag without a hash, the refusal of the given password, and every session being dropped when it is replaced — plus 2 in `add-student.db.test.ts`. Windows gate: lint 0 warnings, typecheck clean, **7,528 tests passed, 0 failed**, build exit 0, all size budgets met. **A batch was then run end to end** on the local stack against the production build (2026-10-29): three accounts imported with one shared initial password, all three created flagged; a wrong password refused; the given password signed in and landed on `/account/new-password`; `/dashboard`, `/problems` and `/profile/settings` each bounced back to it with a 307; the page refused the password the batch was given (“Choose a password different from the one you were given.”); a new one was accepted and landed on `/dashboard` signed in; the given password then answered `credentials` and the chosen one went straight to `/dashboard`; the other two accounts stayed flagged. The drill accounts were removed afterwards. STILL NOT RUN: a real intake, with students who were told the password by somebody other than the person who set it | PASS (gate and the batch drill); a real intake NOT RUN | Claude |
| 12a | 2026-10-30 | Assessments: a way to create one, and always proctored | **DONE.** The sitting engine has existed since Phase 6 and nothing in the product could create the thing it runs — every assessment that ever ran was a test fixture. `/admin/assessments` now creates a draft, pins questions at their frozen revisions, schedules halls with their CIDR allowlists, and walks DRAFT → PUBLISHED → OPEN → CLOSED. `NONE` is gone as a proctor mode for an assessment, in the shared schema, at the server boundary and as `Assessment_proctored_check`: the Phase 11b audit found the engine never read the mode, so a `NONE` assessment watched its candidates exactly as closely as any other while telling them nobody was. Refused, each with a sentence and each also true of the data: an unproctored assessment, placement eligibility on anything but a lab sitting, publishing an empty paper, publishing a lab assessment with no hall, a lab hall with an empty or malformed allowlist, and any change to a published assessment's questions or terms. The migration refuses rather than rewrites a pre-existing `NONE` row — its first draft disabled `Assessment_published_immutable` to move them and `frozen-coverage.test.ts` failed the build, which is the fence working. Verified against recx_test: 5 tests in `admin-assessments.db.test.ts`, both doors on the unproctored refusal, the publish blockers and the full status walk. Windows gate: lint 0 warnings, typecheck clean, **7,622 tests passed, 0 failed**, build exit 0, all size budgets met. **A paper was then sat end to end** against the production build (2026-10-30): created through the admin actions with every refusal firing (unproctored, empty paper, a question added after publication), listed to a candidate, readiness 200, Start → 303 to the arena with the attempt cookie issued, the arena rendering the pinned question, and a second start resuming the same sitting. That run found the defect below and it is fixed in the same breath: **the arena could never start a sitting at all**, because the page called `startOrResumeAttempt` while rendering and Next refuses a cookie write there — true since Phase 6, invisible to 7,600 tests that call the function directly, and caught by the first real sitting. Starting is now `POST /api/exam/start/[slug]`. STILL NOT RUN: a cohort sitting one, and the lab and remote modes, which need a WebAuthn authenticator this machine has none of | PASS (gate and the sitting drill); a cohort sitting NOT RUN | Claude |
| 12b | 2026-10-30 | The AI helper: practice only, off by default, and a super-admin owns it | **DONE.** A student stuck on a **practice** problem can ask the assistant what they have got wrong, or how to approach it, and gets an explanation rather than a solution. Three decisions carry the feature. **It goes through the existing help chokepoint rather than beside it:** `lib/help/access.ts` says of itself that every hint and editorial read — "anything later phases add" — asks `getHelpState()` and obeys it, with no per-feature branches, so `aiAllowed()` takes the same `HelpState` the hints do, with the same server-decided context, and the assistant cannot be reachable on a surface where a hint is not; CONTEST and ASSESSMENT get nothing, and in a sitting there is no tab at all rather than a disabled one. **Asking makes a later first solve ASSISTED** (`makesSolveAssisted({ ai: true })`, read by the finaliser exactly as it reads `HintReveal`) — readiness is built on unassisted coverage, and an assistant that did not mark the solve would have inflated every readiness number in the college silently. **The key is environment-only and the model is a setting:** `/super/settings/ai` chooses whether it answers, which of four models answers, the per-student daily allowance and the answer length, read per request so the kill switch lands on the next one; `AI_API_KEY` is never written to `PlatformSetting`, because a key in a settings row is a key in every backup and on every admin's screen. The model catalogue is closed (an id reaches an external API), with one escape hatch for a college-hosted OpenAI-compatible endpoint. Data: `AiAssist`, append-only with four CHECKs — practice-only in the data and not only at the boundary, an answer exactly when the ask did not fail, a bounded non-empty answer, non-negative usage — plus the no-TRUNCATE guard; the answer is stored (a student may reread it) and the draft that prompted it is not. The unlock is hint 2's threshold, deliberately: one judged submission or ten active minutes. Fenced by `tests/repo/ai-helper-posture.test.ts` (15): nothing in the exam, contest or judge trees imports the assistant; `lib/ai/provider.ts` is the only module that posts to an AI endpoint and has exactly one caller; `AI_API_KEY` is read only where it is declared and where it is sent, with `lib/ai/settings.ts` allowed a presence check and nothing more. Not built, deliberately: no conversation (a thread is where a student argues the model into writing the answer), no per-cohort switch, nothing for staff | PASS | Claude |
| 12b | 2026-10-30 | `pnpm lint && pnpm typecheck && pnpm test && pnpm build` + `pnpm size` — Windows 11 (pnpm 9.15.9 via npx, Node 22.17.1), each gate run separately with its exit code asserted | PASS (lint 0 warnings; typecheck clean; **7,724 tests passed, 0 failed** — shared 1,761, judge-worker 414, db 312, design 87, scheduler 247, web 3,821, repo 1,082; build exit 0; every size budget met, `/problems/[slug] shell` 175.2 KB of 220 KB with the Assistant tab added) | Claude |
| 12b | 2026-10-30 | `RECX_DB_TESTS=1` against recx_test: the `AiAssist` invariants, the guard catalogue and the student-exposure sweep | PASS (`ai-assist-invariants.db.test.ts` 10/10 — the practice-only CHECK refuses CONTEST and ASSESSMENT, the answer/failed pairing refuses both halves, an edit, a delete and a TRUNCATE are all refused through Prisma and through raw SQL; `guard-state.db.test.ts` 384 and `frozen-coverage.test.ts` 256 with the new function, trigger and four CHECKs catalogued; `student-exposure.db.test.ts` 14/14) | Claude |
| 12b | 2026-10-30 | Two pre-existing Phase 12a gaps the exposure sweep found, both invisible to the Windows gate | **FIXED.** `student-exposure.db.test.ts` is `RECX_DB_TESTS=1` and skipped on Windows, so neither had been run since Phase 12a: `POST /api/exam/start/[slug]` was never added to `ROUTE_CALLS` (the sweep's own completeness assertion), and the fixture's live `AssessmentAttempt` carried `layout: { order: [1] }` — a placeholder from before the format existed, which nothing read until the arena page started parsing the layout to render, so rendering the arena as a student threw `stored attempt layout is not a v1 layout` instead of being swept for canaries. The attempt now carries a real v1 layout pinning the canary-bearing frozen version, and the start route has a recipe (a slug that does not exist, so the fixture's live token is not rotated out from under the heartbeat and snapshot recipes) | Claude |
| 12b | 2026-10-30 | Manual, against the production build on this laptop with a **stand-in** OpenAI-compatible endpoint (`scratchpad/fake-model.mjs`, asserting the request shape and printing every prompt): the whole path end to end | PASS. Super-admin `RECADMIN01` → `/super/settings/ai` 200, model catalogue listed, no key anywhere in the HTML; `updateAiHelper` through the real action → `PlatformSetting "ai-helper"` written and one `settings.ai_helper_changed` SECURITY audit row per change. Student 2116231001001 → `/problems/two-sum` 200 with the Assistant tab present and both questions offered; `askAiHelper` answered twice, the allowance counting 3 → 2 → 1 → **0** and the fourth ask refused by the cap **without reaching the model** (3 requests at the endpoint, not 4); the answer rendered as sanitised HTML with the model's `[docs](https://example.invalid/x)` **link stripped**; `AiAssist` rows carry PRACTICE, the model id, both token counts and a latency. What actually crossed the wire, read in the endpoint's log: the public statement, the student's own `cpp20` draft, `Their last judged submission: AC`, and nothing else — a grep for the student's college id, an `@rajalakshmi` address, "Hidden test" and "expected output" matched only the system prompt's own line telling the model it is not given the hidden tests. Kill switch: `updateAiHelper` off → the tab gone from the workspace on the very next request and both asks refused. Provider down (endpoint killed): the ask refused with "could not answer just now" and an `AiAssist` row written `failed=true, answer IS NULL`, no tokens, latency recorded — and `/super/settings/ai` then read **Answered 5, Failed 2, Students who asked 1** | PASS | Claude |
| 12b | — | A real model has never answered | **NOT RUN.** There is no `AI_API_KEY` on this machine and no account to get one from, so the HTTP call was exercised against a stand-in that implements the OpenAI-compatible shape, and the Anthropic shape only against a fake `fetch` in `apps/web/test/ai-helper.test.ts`. Two things stay unproven: that a live Anthropic response parses as this code expects (ten minutes with a key), and that a real model obeys "never a complete solution" under pressure from a half-written program — which is a judgement to be made by reading real answers over a week, not a test. `docs/OPEN-QUESTIONS.md` carries both | NOT RUN | — |
| 12b | — | The assisted-solve warning was not seen in a browser | **NOT RUN.** `marksAssisted` is `!solved`, and `two-sum` is the only published problem in the development database — every seeded student has already solved it, so every real ask in the run above correctly returned `marksAssisted: false` and the confirm dialog never appeared. The flag itself is asserted both ways in `packages/shared/test/ai-helper.test.ts` and `apps/web/test/ai-helper.test.ts`; what has not been looked at is the dialog on screen. It will be the first thing a student with an unsolved problem sees | NOT RUN | — |
| 12c | 2026-10-30 | Spaced revision: the problems you solved, coming back | **DONE.** SPEC §11 calls this the highest-value thing on the post-launch list, "because the documented failure mode of sheet prep is solving 300 problems once and retaining none." A `RevisionCard` per student per problem, written by the progress engine on a first solve and moved by it afterwards: five rungs at 1, 3, 7, 21 and 60 days; a due re-solve climbs one and pays 25 % of the first solve (`XpEventKind.REVISION`, which existed in the enum since Phase 3 and had never been issued), a due attempt that fails drops one and stays due today, and clearing the top rung retires the card. Three decisions carry it. **The ladder moves only when the ledger did** — `applyRevision` advances the card after `insertXpEvent` reports an insert, so a retried finalise can neither pay twice nor climb twice. **Three a day is a property of the queue, not of the data**: `REVISION_DAILY_CAP` is applied in `dueQueue()`, and both `/revision` and the dashboard card print how many more are past their date, because a page that quietly drops work is a page nobody trusts twice. **The migration backfills**, three per student per day, oldest solve first, at rung 0 — without it the feature is empty for exactly the students it exists for, and with a naive backfill those same students open it to a two-hundred-card wall. Surfaces: `/revision` (225 B of its own JS; the whole page is server-rendered), a dashboard card, and Revision second in the PRACTICE nav. Four CHECKs guard the card, because its columns are the only explanation a student ever gets for why a problem is in front of them today | PASS | Claude |
| 12c | 2026-10-30 | A bug the arithmetic hid, found by walking a real card up the ladder | **FIXED BEFORE SHIPPING.** The ledger row was first keyed on the rung the card came due on, which reads as the tightest possible key and is wrong: a card that lapses from rung 2 back to rung 1 must climb rung 1 again, and that rung's key was spent on the first climb. Because the ladder only advances when the row was actually inserted, the second climb would have paid nothing AND never moved — a student who forgot one problem once would have been stuck on it forever, shown the same card every day with no way to clear it. Nothing on paper showed this; it appeared the moment a DB test walked a card up, down one rung and up again. The key is now the campus day, which the schedule already makes unique (a review pushes the card at least a day out; a lapse pays nothing), and `XP_KEYS.revision` carries the reasoning, because the rung version will look like an improvement to the next reader | Claude |
| 12c | 2026-10-30 | `pnpm lint && pnpm typecheck && pnpm test && pnpm build` + `pnpm size` — Windows 11 (pnpm 9.15.9 via npx, Node 22.17.1), each gate run separately with its exit code asserted | PASS (lint 0 warnings; typecheck clean; **7,752 tests passed, 0 failed** — shared 1,784, judge-worker 414, db 315, design 87, scheduler 247, web 3,822, repo 1,083; build exit 0; every size budget met, `/revision` adds 225 B of its own) | Claude |
| 12c | 2026-10-30 | `RECX_DB_TESTS=1` against recx_test: the ladder walked end to end, and the card's own invariants | PASS (`progress-apply.db.test.ts` 18/18, seven of them new: a first solve writes a card due tomorrow and a same-day re-solve does not move it; a due re-solve climbs a rung, pays 13 XP on an EASY problem and comes back in three days; the same finalise applied twice pays once and climbs once; a due failure drops one rung, stays due today and pays nothing; the walk to the top learns the card and a later solve of a learned problem is just a solve; a rejudge is never a review; a capped revision writes a zero-amount event and still advances exactly once. `revision-invariants.db.test.ts` 8/8 over the four CHECKs and the primary key. `guard-state.db.test.ts` and `frozen-coverage.test.ts` green with the new CHECKs catalogued) | Claude |
| 12c | 2026-10-30 | Manual, against the production build: the backfill and both surfaces, signed in as a student | PASS. The migration wrote one card per existing solve — six students, each due today, the unpublished e2e problem correctly skipped. `/revision` 200: the ladder explained in a sentence, REC-0001 Two Sum listed with "Due today, on the 1-day step", and "Due today 1 · Waiting 0 · Done with 0". `/dashboard` 200: the revision card reads "Revision · 1 due today" with the problem and an "All revision" link. Revision appears in the PRACTICE nav on both | PASS | Claude |
| 12c | — | No card has ever been moved by the real judge | **NOT RUN.** Every submission in the ladder walk is a row the test wrote rather than a program a student wrote and a worker judged. What that leaves unproven is only the seam into `finalize.ts`, which this phase did not change — it added to the call that was already there — but it is the same kind of gap that hid the arena's cookie write until somebody sat a paper. The first student to re-solve a due problem on a running stack closes it | NOT RUN | — |
| 12d | 2026-10-30 | Discussion and shared solutions, with the moderation role in the same change | **DONE.** SPEC §11: "discussion and solution sharing gated behind an unassisted solve (with the TA_MENTOR moderation role shipping simultaneously, not after)." Both halves ship here, because a board nobody can moderate is not a feature at launch. **Two lists with different rules.** Solutions and tips need a solve to read and an UNASSISTED solve to post; questions need neither, because being stuck is the reason to ask. Only the ASKER and a mentor may reply to a question — the hole an anti-spoiler gate on solutions alone would leave open, since a question thread anybody could answer is the solution list again, reachable by exactly the people the gate keeps out. **One decider:** `discussionAccess()` in @recx/shared, reached only through `discussionAllowed()` on the help chokepoint (which now carries `assisted` beside `solved`), re-asked inside every action body. **Hidden, never deleted:** a moderator hides with a reason the author is shown word for word, un-hides, and marks the post worth reading first; nothing deletes, and the body of a hidden post is never fetched rather than fetched and filtered. Moderation is college-wide rather than per mentee — `mentor-scope` answers "whose student is this" for private data, and a queue narrowed to a mentor's own mentees would leave most of the board unmoderated while looking staffed. `/mentor/moderation` lists the open reports and, underneath, every post hidden in the last 30 days with who hid it, so a decision can be looked at by somebody who did not make it; `/mentor/doubts` lists every unanswered question, oldest first, and a thread leaves it when the ASKER marks an answer rather than when somebody replies. The three mentor capabilities that have carried `arrives: { phase: 11, models: [DiscussionPost, DoubtThread] }` since Phase 4 are now wired to real guards | PASS | Claude |
| 12d | 2026-10-30 | Where this reads the spec more finely than it is written | **RECORDED.** The spec names one gate; the implementation splits it — reading needs a solve of any kind, posting needs an unassisted one. The single sentence is doing two jobs: the spoiler problem is solved by any accepted submission, and the quality problem is the one the word "unassisted" is about. Splitting them means a student who needed a hint can still read and still ask, while the people posting are the people who got there alone, and the refusal says in as many words that it applies to this problem only and that using help was fine. If that reading is wrong the fix is one line in `discussionAccess()`; `docs/OPEN-QUESTIONS.md` carries the argument | Claude |
| 12d | 2026-10-30 | `pnpm lint && pnpm typecheck && pnpm test && pnpm build` + `pnpm size` — Windows 11 (pnpm 9.15.9 via npx, Node 22.17.1), each gate run separately with its exit code asserted | PASS (lint 0 warnings; typecheck clean; **7,924 tests passed, 0 failed** — shared 1,798, judge-worker 414, db 318, design 87, scheduler 247, web 3,953, repo 1,107; build exit 0; every size budget met, the workspace shell 179.7 KB of 220 KB with the Discussion tab added) | Claude |
| 12d | 2026-10-30 | `RECX_DB_TESTS=1` against recx_test: the twelve CHECKs and the exposure sweep | PASS (`discussion-invariants.db.test.ts` 14/14 — a hidden post without a reason, a visible one carrying one, a report naming both targets or neither, a resolved report with nobody attached, a post that is its own parent, a language with no submission, and the body and title bounds are each refused by the database; `guard-state.db.test.ts` and `frozen-coverage.test.ts` green with the twelve catalogued; `student-exposure.db.test.ts` 14/14 with the three discussion queries and the seven student actions registered) | Claude |
| 12d | 2026-10-30 | Manual, against the production build: the whole loop, with the role boundaries | PASS. As a student who solved `two-sum` unaided: the Discussion tab renders, a question is asked, a solution is posted, a two-word post is refused, and an attached submission id that is not theirs is refused — the one check that would otherwise be a way to render another student's accepted code. As a TA/mentor: the question is in `/mentor/doubts`, the answer is written with `byMentor` frozen true, and `/mentor/moderation` reads "Nothing is waiting". Then the loop: a second student reports the post, a repeat report from the same student is refused, the queue renders both the complaint and the post, a STUDENT calling the hide action is refused, a mentor hides it with a reason, the author then sees the notice and not the body, un-hiding restores the body and clears the notice, the report is dismissed with a person and a sentence attached, and the post is marked worth reading first. Three SECURITY audit rows written (`discussion.post_hidden`, `post_unhidden`, `report_resolved`). From a third student's browser: the badge, the mentor's answer with its TA badge, the shared solution, and "only … can reply here" on somebody else's question | PASS | Claude |
| 12d | — | Nobody has moderated anything they did not create | **NOT RUN.** The whole loop ran against the production build, but with six seeded accounts and one problem. What a real board does to a report queue, and whether one TA keeps up with a cohort, is a question only a term answers. `docs/OPEN-QUESTIONS.md` carries it, with the four things deliberately not built: votes, moderator editing, reply notifications and per-cohort queues | NOT RUN | — |
| 12e | 2026-10-30 | The interview archive: what companies actually asked, in fields | **DONE.** SPEC §11 calls it "the only legal and genuinely REC-specific source of company tags and 'asked at' frequency, and therefore load-bearing rather than a nicety". `InterviewExperience` and its join to the problem catalogue, with `/interviews` for students, `/mentor/experiences` for the people who read them, and the provenance label the spec asks for on the catalogue. **There is no prose.** One free-text column — a company name, so a student can report a company nobody has entered — and closed lists for everything else; where a tips box would be there is a "what helped" list. An account written in a hurry names interviewers, repeats questions under an NDA and says things about a company the college would have to answer for, and prose cannot be counted, which is what the archive is for. `tests/repo/interview-archive-posture.test.ts` asserts the model's field list exactly, so a `notes` column is a failing build. **Attributed in the database, anonymous on the page:** the student-facing query never selects a name, and the anonymous line drops the section because batch + department + section is three or four people. **"Asked at" frequency is maintained, not computed** (SPEC §4(d)): approving increments `ProblemCompanyTag.frequency` and flips the source to EXPERIENCE, reversing decrements, a tag that reaches zero is deleted, all inside the decision's transaction. The catalogue then says which it is looking at — "curated … best guess" or "from N interviews students reported here" — which is §11's own requirement that curation be labelled | PASS | Claude |
| 12e | 2026-10-30 | Three bugs, all found by running it rather than reading it | **FIXED.** (1) The CHECK refusing an experience that names no round kind accepted every one: `array_length(x, 1)` is NULL for an empty array, a comparison with NULL is NULL, and a CHECK that evaluates to NULL passes. It reads correctly and does nothing; the database test caught it on its first run and the constraint now coalesces. (2) `withdrawInterviewExperience` had no zod boundary — a malformed call reached Prisma and came back as a masked "something went wrong" rather than a refusal; the student-exposure sweep surfaced it. (3) A company created from a reported interview is `curated: false`, honestly, and the catalogue's filter selected `curated: true` only — so the archive produced real tags for a company nobody could filter for. Found by loading `/problems?company=…` after the first real approval | Claude |
| 12e | 2026-10-30 | `pnpm lint && pnpm typecheck && pnpm test && pnpm build` + `pnpm size` — Windows 11 (pnpm 9.15.9 via npx, Node 22.17.1), each gate run separately with its exit code asserted | PASS (lint 0 warnings; typecheck clean; **7,988 tests passed, 0 failed** — shared 1,813, judge-worker 414, db 321, design 87, scheduler 247, web 3,987, repo 1,119; build exit 0; every size budget met) | Claude |
| 12e | 2026-10-30 | `RECX_DB_TESTS=1` against recx_test: the CHECKs and the tag arithmetic | PASS (`interview-archive-invariants.db.test.ts` 13/13 over the ten CHECKs — a decision with nobody attached, a STUDENT row with no author, month 0 and month 13, zero rounds, an empty round-kind list, a negative tag frequency; `interview-archive.db.test.ts` 9/9 for the arithmetic — a submission tags nothing until read, approving tags each named problem once, a second approval adds rather than replaces, reversing takes it back, a tag at zero is deleted, deciding twice the same way is refused, the student view carries no name while the queue does, withdrawal is the author's only and only while pending, and both provenance labels read correctly) | Claude |
| 12e | 2026-10-30 | Manual, against the production build: the whole chain | PASS. `/interviews` 200 explaining why there is no writing box and that a TA reads it first. A student submits one naming REC-0001; a year that has not started is refused; the student's own list shows "Waiting for a TA" and the account is not published. `/mentor/experiences` 200 shows it, offers to add the typed company to the catalogue, names the problem, and shows the moderator what students will see instead of the author. Publishing with a new company wrote `Company{slug: northwind-systems, curated: false}`, one `ProblemCompanyTag{two-sum, frequency: 1, source: EXPERIENCE}` and one `interview.experience_decided` SECURITY audit row carrying `problemsTagged: 1`. A third student then sees the account anonymously ("… student, batch of 20xx", no names), with the problem it named and a working company filter; and `/problems?company=northwind-systems` offers the company and says the tag came from a reported interview rather than from curation | PASS | Claude |
| 12e | — | The pre-launch collection, and the curated label on screen | **NOT RUN.** Nobody has collected anything from the two most recent graduated batches — the bootstrap §11 asks for, which the schema supports (an author-less BOOTSTRAP row, with a CHECK that a row without an author can only be one) but which is an operational task rather than a code one. And the "curated by the placement cell … best guess" label is asserted in two suites and has never been seen in a browser: the development database's only company was created by the archive itself, which is the other label | NOT RUN | — |
| 12f | 2026-10-30 | The recommender: one next action, and why | **DONE.** SPEC §11: "rule-based, explainable (no ML — it has neither the data nor an evaluation harness to beat a good rule, and it cannot explain itself; always render the reason inline, and rotate topics after 3 consecutive picks from the same one)". `recommend()` in @recx/shared is a pure function over seven rungs that returns the REASON with the pick, and the Continue card renders that string — the four-rung `selectContinue` it replaces had its copy in the component, which is a second place an explanation can drift from the decision. The rungs: finish what you started; then a problem a company whose drive is inside 21 days has been reported asking (Phase 12e's tags); then a due revision (12c); then the topic with the fewest UNASSISTED solves against the PRODUCT per-topic target; then the plan, the daily challenge, anything. Two placements are arguments rather than conventions, and both are in the module header: FINISH is top because a problem already in the student's head is the cheapest thing they can finish tonight, and DRIVE is above REVISE because a drive has a date while a revision has a schedule built to tolerate a day. Rotation reads the topics of their last three judged PROBLEMS — one topic per problem, so five submissions on one array problem is one array problem — rather than our own past suggestions: same signal where it matters, and better where it differs, since a student who ignored three array suggestions has not done three array problems. Fenced by `tests/repo/recommender-posture.test.ts`: no ML package in any workspace manifest, the engine touches no database, clock or network, `recommend()` is called from exactly one place, and every rule the engine can return has an eyebrow and a call to action so none can render blank | PASS | Claude |
| 12f | 2026-10-30 | A gap that made the best rule unreachable | **FIXED.** `createDrive` has always taken a free-text `companyName` and never set `companyId`, so no drive in the system had a catalogue company — and the DRIVE rung, which needs one to look up "asked at" tags against, could never fire for anybody. Found by creating a real drive for the company the interview archive had just tagged and watching the dashboard not change. It matches on the slug now, the same way the archive matches a typed company name; a drive for a company nobody has entered keeps a null link, which is right, because there are no tags for it either. The audit row records the link | Claude |
| 12f | 2026-10-30 | A rung order the browser run settled | **CHANGED BEFORE SHIPPING.** The first draft had REVISE above DRIVE. Reading three seeded students' dashboards made the question concrete: every one of them got "due for revision today" while a drive six days away sat underneath it. A revision missed today costs a day on a ladder built to tolerate that; the one problem a company has been reported asking, missed, costs the interview. DRIVE moved above REVISE, and the reasoning is in the module header rather than in a commit nobody will read again | Claude |
| 12f | 2026-10-30 | `pnpm lint && pnpm typecheck && pnpm test && pnpm build` + `pnpm size` — Windows 11 (pnpm 9.15.9 via npx, Node 22.17.1), each gate run separately with its exit code asserted | PASS (lint 0 warnings; typecheck clean; **8,004 tests passed, 0 failed** — shared 1,829, judge-worker 414, db 321, design 87, scheduler 247, web 3,982, repo 1,124; build exit 0; every size budget met, `/dashboard` 121.8 KB of 160 KB) | Claude |
| 12f | 2026-10-30 | `RECX_DB_TESTS=1` against recx_test: the half that reads | PASS (`recommend.db.test.ts` 9/9 — the rule engine is pure and unit-tested, so what this covers is every `where` clause a unit test cannot: a due card found and an undue one ignored, a learned card ignored however overdue, the most-asked UNSOLVED problem chosen while a solved one with a higher count and a DRAFT one with a higher count still are both skipped, a drive outside the 21-day horizon and an archived one and one for another batch and one for another department all refused, the weakest topic counting unassisted solves only, and the rotation window counting one topic per problem rather than per submission) | Claude |
| 12f | 2026-10-30 | Manual, against the production build | PASS. Three seeded students' dashboards each render one next action with its reason inline — "Due for revision today, on the 1-day step." — and the card links the problem. A placement officer created a drive for the company the archive had tagged; the drive row carries the catalogue company id after the fix above | PASS | Claude |
| 12f | — | The DRIVE rung has never been seen in a browser | **NOT RUN.** It is proved end to end against recx_test, but the development database has one published problem and every seeded student has solved it, so there is no unsolved tagged problem for the rung to pick. The first cohort with two published problems closes it | NOT RUN | — |
| 12g | 2026-10-30 | Core-CS MCQ as a fourth `AptitudeArea` | **ATTEMPTED AND REVERTED WHOLE.** SPEC §11 lists OS/DBMS/CN/OOP MCQs, and the aptitude sitting, scoring and readiness input already exist, so the feature is a taxonomy entry plus content. It cannot be built that way: `AptitudePassage_area_topic_check` and `AptitudeQuestion_area_topic_check` enumerate every (area, topic) pair in the CHECK body, so a fourth area means dropping two catalogued CHECKs — and `packages/db/test/frozen-coverage.test.ts` fails the build for any migration that drops, alters, disables or bypasses one, with no allowlist, which is the whole value of it. Reverted: the taxonomy, the readiness change, the schema, the migration directory, both CHECKs restored in `recx` and `recx_test` and the `_prisma_migrations` row removed; 784 db tests green afterwards. The shape that would unblock it — the area→topic rule in an `IMMUTABLE` function the CHECK calls — itself needs one guarded drop, so it is a human's decision and is written up in `docs/OPEN-QUESTIONS.md` rather than taken here | REVERTED | Claude |
| 12h | 2026-10-30 | Mock interviews: a mentor's hour, and a read-only mirror | **DONE.** SPEC §11: a mentor offers a slot, a student books it, both open the same room and the interviewer watches the candidate's editor in "read-only spectate mode". The policy is pure (`packages/shared/src/mock-interview.ts`): five statuses with three terminal, `canTransitionInterview()` as the single gate every write goes through, and a clock with three rules that each cost somebody something — give a slot back until 60 minutes before, join from 10 minutes before, no-show only after 10 minutes have passed. `IN_PROGRESS → NO_SHOW` is refused outright. The mirror is a candidate-pushed snapshot every 4 s and an SSE read every 2 s whose permission is re-asked on every tick, so the stream dies with the interview; the interviewer's half renders it as a `<pre>` rather than a disabled editor, because a disabled editor is a control somebody eventually enables. Booking is a conditional `updateMany`, so two students pressing Book is a race Postgres settles. 10 CHECKs, all catalogued | Claude |
| 12h | 2026-10-30 | `pnpm lint && pnpm typecheck && pnpm test && pnpm build` + `pnpm size` — Windows 11 (pnpm 9.15.9 via npx, Node 22.17.1), each gate run separately with its exit code asserted | PASS (lint 0 warnings; typecheck clean; **8,114 tests passed, 0 failed** — shared 1,845, judge-worker 414, db 324, design 87, scheduler 247, web 4,064, repo 1,133; build exit 0; every size budget met, `/dashboard` 121.9 KB of 160 KB) | Claude |
| 12h | 2026-10-30 | `RECX_DB_TESTS=1` against recx_test: the lifecycle, the race and the mirror | PASS (`mock-interviews.db.test.ts` 13/13 — a slot offered, taken, started, mirrored and written up; two students pressing Book together and exactly one getting it; the booking cap refusing a third and a mentor refusing their own slot; the give-back cutoff; `mirrorFor` refusing another mentor, another student and the candidate themselves, and refusing everybody once the interview is not running; the snapshot write refused before the start and after the end; a cancel carrying its reason to the other side). The fixtures now mint a fresh student per booking test — the race's winner is deliberately non-deterministic, which made a shared fixture order-dependent and failed the cap test on one run in three | Claude |
| 12h | 2026-10-30 | The ten new CHECKs against the frozen-guard fence | PASS (`frozen-coverage.test.ts` 268/268 against `recx_test`: every catalogued CHECK created exactly once, valid, on its table, and no uncatalogued CHECK up to this migration — including `MockInterview_candidate_pair_check`, `_timing_check`, `_cancel_pair_check`, `_cancel_reason_size_check`, `_duration_check`, `_feedback_pair_check`, `_rating_range_check`, `_feedback_size_check`, `_not_self_check` and `MockInterviewSnapshot_source_size_check`) | Claude |
| 12h | 2026-10-30 | The student-exposure sweep, with both new routes and both new pages registered | PASS (`student-exposure.db.test.ts` 14/14 against recx_test, its own completeness assertion included — the sweep refuses to pass if a route, page, query or action is missing from its registry) | Claude |
| 12h | 2026-10-30 | Manual, against the production build (four signed-in sessions: the slot's mentor, another mentor, the candidate and another student) | PASS. The mentor offered a 45-minute slot; it appeared on every student's list; the candidate booked it, the second student was told **"Somebody has already taken that slot."** and the mentor was told **"You cannot book your own slot."**. Before the start, the snapshot POST answered 422 and the SSE route 409, both "That interview is not running.". The mentor started it, the candidate's editor POSTed 204, and the mentor's `EventSource` delivered the frame — `int main() { /* half an answer */ return 0; }`, named with the candidate. The same stream answered **403 to the other mentor**, **403 to the candidate themselves** and 403 to another student's push; a student who is neither gets 404 on the room, not 403. The mentor finished with three ratings and a note; the candidate's list renders the write-up, and the page carries no band, no score and no integrity language. After the end the snapshot POST is 422 and the stream 409 again | PASS | Claude |
| 12h | — | Two people in two places watching the same mirror | **NOT RUN.** Both halves are proved — the candidate pushing and the mentor's SSE stream reading, against the production build, plus every refusal — but the run was two sessions from one machine. Whether four seconds reads as live or laggy to somebody watching over the campus network is a question only two real browsers in two places answer | NOT RUN | — |
| 12i | 2026-10-30 | Written and system-design questions, marked against a rubric | **DONE.** SPEC 11's last Phase 11+ item: "written/system-design with rubric grading". Nothing here runs code. A TA writes a question AND the rubric it is marked against, published together - the word doing the work is *rubric*: a mark says how it went, a rubric says what is being looked for, and a student who can see what is being looked for can practise against it. Four tables, sixteen CHECKs, two of which carry rules the application also enforces: a mark is whole or it does not exist (grader, moment, note and weighted total together, and never the author), and a published rubric is fixed. Marking is one transaction and the weighted total is STORED, so retiring the question afterwards cannot move somebody's score. A grader may hand an answer back into the student's drafts with a sentence instead of marking it 4 of 16 - the better outcome, and a grader's doing rather than a student's. The score feeds nothing: no XP, no leaderboard, no readiness, no band, fenced on the import graph of every scoring module | Claude |
| 12i | 2026-10-30 | `pnpm lint && pnpm typecheck && pnpm test && pnpm build` + `pnpm size` - Windows 11 (pnpm 9.15.9 via npx, Node 22.17.1), each gate run separately with its exit code asserted | PASS (lint 0 warnings; typecheck clean; **8,231 tests passed, 0 failed** - shared 1,867, judge-worker 414, db 327, design 87, scheduler 247, web 4,138, repo 1,151; build exit 0; every size budget met, `/dashboard` 121.9 KB of 160 KB - the two new pages ship no editor and no new dependency) | Claude |
| 12i | 2026-10-30 | `RECX_DB_TESTS=1` against recx_test: the marking | PASS (`written.db.test.ts` 15/15, green on the first run - the draft nobody published that nobody can answer or read; two criteria with the same name and a rubric of one, both refused; publish then retire, and no reopening; one answer per student per question with the draft saving over itself; the floor on handing in; the mark as one transaction, 5x4 + 3x2 out of 32, with the per-criterion notes; a rubric with a gap, a criterion marked twice and a criterion from ANOTHER question, all three refused with nothing written; a TA refused their own answer; the hand-back that keeps the student's words and lets them hand in again; a student's own answer visible and another's not; a retired question readable by whoever answered it and nobody else; the shared queue minus the grader's own; grading refused on a draft; publish and retire refused to a stranger and allowed to staff; and the CHECKs refusing a half-written mark three ways through raw Prisma) | Claude |
| 12i | 2026-10-30 | The sixteen new CHECKs against the frozen-guard fence | PASS (`frozen-coverage.test.ts` 271/271 against recx_test: every catalogued CHECK created exactly once, valid, on its table, and no uncatalogued CHECK up to this migration) | Claude |
| 12i | 2026-10-30 | The student-exposure sweep, with five queries, two pages and two actions registered | PASS (`student-exposure.db.test.ts` 14/14 against recx_test, including its own completeness assertion. `loadForGrading` and `loadGradingQueue` are the two that matter: both render or name somebody else's work, and both are swept as a STUDENT) | Claude |
| 12i | 2026-10-30 | Manual, against the production build (four signed-in sessions: the question's TA, a second TA, the student and another student) | PASS. The TA wrote a three-criterion rubric (weights 5/3/2) and published it; before publishing, the draft was absent from the student's list and answering it was refused with "That question is not open for answers.". The student's page showed each criterion with its weight, "40 weighted marks in all", the rubric notice, the time-box sentence and the warning that the grader sees their name - all **before** the answer box. A short answer was refused; the real one was handed in; editing after handing in was refused. The answer reached the shared queue with the student's name, and both `/mentor/written` and the grading page answered a student with a 307. Marking two of three criteria was refused ("a rubric with a gap in it is not a rubric"); marking all three stored 33 of 40, and marking again was refused as final. The student's page then showed "33 of 40 weighted marks (83%)", each criterion's mark against the same rubric, the TA's note, who marked it and when, and the sentence saying it counts for nothing - with no band, no grade letter and no integrity language anywhere. Another student opened the question and saw no part of the answer | PASS | Claude |
| 12i | - | Nobody has marked a real cohort's answers | **NOT RUN.** The lifecycle is proved against recx_test and by hand against the production build, but a TA marking thirty answers in an evening is the only way to find out whether three criteria or six is the right number, and whether the 0-4 ladder means the same to two different TAs | NOT RUN | - |
| 12j | 2026-10-30 | Editor settings that reach the editor, and the vim and emacs keymaps | **DONE.** SPEC 11: "vim/emacs keymaps". No migration: the preference lives in the `User.editorPrefs` JSON whose own comment had predicted this key. The phase also fixed something older — `fontSize` and `tabSize` were saved by the profile form and read by NOTHING (both editors hard-coded 14 px and 4 spaces), so two settings had been a control that lied since Phase 3. Both editors now take the viewer's font size, tab size and keymap, and a change reaches a live editor through `setPrefs()`. Monaco's keymaps are the `monaco-vim` / `monaco-emacs` UMD builds, self-hosted under `/monaco/keymaps` and loaded through Monaco's own AMD loader; CodeMirror's are dynamic imports. Nothing is fetched for the standard keys, so no size budget moved | Claude |
| 12j | 2026-10-30 | `pnpm lint && pnpm typecheck && pnpm test && pnpm build` + `pnpm size` - Windows 11 (pnpm 9.15.9 via npx, Node 22.17.1), each gate run separately with its exit code asserted | PASS (lint 0 warnings; typecheck clean; **8,253 tests passed, 0 failed** - shared 1,879, judge-worker 414, db 327, design 87, scheduler 247, web 4,138, repo 1,161; build exit 0; every size budget met. The workspace shell grew 2.0 KB to 182.1 KB of 220 KB - the preferences plumbing, not the keymaps, which are not in any bundle) | Claude |
| 12j | 2026-10-30 | Manual, in a real browser (Playwright-driven Chromium against the production build, wide and narrow) | PASS. Wide: the profile form offers Standard / Vim / Emacs; saving Vim and 18 px made Monaco report font 18, line height 27 and, with the radio set, tab size 2; the page fetched `/monaco/keymaps/monaco-vim.js` and nothing else. Modal editing works - `jj` typed nothing and moved the caret two lines, `dd` deleted a line, `i` inserted, the status line read `--INSERT--`, and `:` opened a command line. **Esc then Tab still left the editor in vim mode.** Emacs: the module was fetched and `C-k` killed a line. Back on the standard keys, `jj` typed two characters and no keymap file was requested. Narrow (390 px, CodeMirror): the editor opened in `--NORMAL--`, `dd` took the document from 3 lines to 2, `o` entered insert mode and typed, `u` undid it, Esc then Tab left the editor, and nothing from `/monaco` was fetched at all. No page errors in any run | PASS | Claude |
| 12j | 2026-10-30 | The keymap fences | PASS (`tests/repo/editor-keymap-posture.test.ts` 10/10: the copy script self-hosts both Monaco builds, the loader asks for them under `/monaco/keymaps`, no file names a CDN host, no module imports any of the four keymap packages at the top level, the CodeMirror ones are dynamic imports, the escape hatch is a capture-phase listener with the Monaco-only gate gone, and the arena hands the editor `DEFAULT` and says so) | Claude |
| 12j | - | A vim user has never sat a real contest with it on | **NOT RUN.** Both keymaps are proved in a real browser, in both editors, including the escape hatch - but a two-hour contest is where a keymap either disappears into the work or gets in the way, and that needs a student rather than a script | NOT RUN | - |
| 12k.1 | 2026-10-30 | Slice 1: the protocol goes to 4, and the SQL comparison is a pure module | **DONE.** `packages/shared/src/sql-problem.ts`: the dialect (PostgreSQL 17, stated rather than inferred), the limits the spec names (statement_timeout 5 s, one statement, 2,000 rows), the canonicalisation and the comparison. Two rules are arguments rather than conventions, and both are in the module header: a cell that LOOKS like a number is compared as a number (so `numeric`'s "1.50" and `float8`'s "1.5" are one answer, and a student is not failed for `sum(x)::int`), and column NAMES do not decide the verdict while the column COUNT does (so `count(*)` and `count(*) AS n` are one answer). NULL stays distinct from the empty string, because SQL's three-valued logic is the thing students get wrong. An ordered comparison that fails on rows that are nonetheless right reports ROW_ORDER — "the rows are right and the order is not" is one ORDER BY away, and is the most useful sentence available. Protocol 4 adds the engine discriminator, the SQL spec, and SQL's own five queues: `claimJob()` leases by id with no engine condition, so an isolate node would otherwise claim a SQL submission and refuse it, and three refusals fail a job | Claude |
| 12k.1 | 2026-10-30 | `pnpm lint && pnpm typecheck && pnpm test && pnpm build` + `pnpm size` - Windows 11 | PASS (lint 0 warnings; typecheck clean; **8,284 tests passed, 0 failed** - shared 1,910, judge-worker 414, db 327, design 87, scheduler 247, web 4,138, repo 1,161; build exit 0; all size budgets met). The protocol bump broke nothing because nothing hard-codes the number: every reference is the constant, which is what `tests/repo/single-source.test.ts` exists to keep true | Claude |
| 12k.1 | 2026-10-30 | The comparison, as unit tests | PASS (`sql-problem.test.ts` 31/31: numeric and boolean canonicalisation, NULL against the empty string, a row key no cell's text can forge, column names ignored and the count enforced, row counts, the ROW_ORDER case, duplicates counted in both modes, a truncated result refused rather than compared on its prefix, a hidden case's message carrying the row and nothing in it, the multiple-statement HINT not fooled by a semicolon in a string, a comment or a dollar-quoted body, and the two engines' specs refusing to parse as each other) | Claude |
| 12k.2 | 2026-10-30 | Slice 2: `apps/sql-judge`, the sandbox service | **DONE.** A judge node with a PostgreSQL sandbox instead of an isolate box: it consumes the SQL queues, claims through the same five endpoints, and posts the same result shape, so XP, the leaderboard, contests, assessments and the lease rules all keep meaning what they meant. Per case: the owner creates a schema, runs the author's setup and grants SELECT on what it made; the student's statement runs on its OWN connection as a role that owns nothing, inherits nothing and can create nothing, in a READ ONLY transaction with search_path pinned to that schema, statement_timeout at 5 s and a row cap; the schema is dropped in a `finally`, and a boot sweep drops anything a crash left behind. Two connections rather than `SET ROLE`, because one statement can call `set_config('role', …)` and a privileged session_user has something to go back to. One statement, because the EXTENDED protocol refuses a second command — the server's rule, not a semicolon count | Claude |
| 12k.2 | 2026-10-30 | A hang the first database run found, which no unit test could | **FIXED.** Every case whose statement ERRORED hung forever: the suite timed out on six of them at once. The cause is in node-postgres rather than in the SQL — a query executed with a row limit is a portal, and when such a query errors the client's queue can be left waiting, so the `ROLLBACK` in the cleanup never settles. An `await` on a promise that never settles is invisible to `catch`, which is why it read as a hang rather than a failure. The fix is that nothing is sent on that connection afterwards: a READ ONLY transaction has nothing to roll back, and closing the socket is what ends it. Closing now has a three-second deadline and destroys the socket if even that does not return, the schema drop has its own `lock_timeout`, and the boot sweep exists because this run had left six schemas behind — each one a dataset the student role still had SELECT on | Claude |
| 12k.2 | 2026-10-30 | `RECX_SQL_TESTS=1` against the real cluster: is the sandbox a sandbox? | PASS (`sandbox.db.test.ts` 17/17 against PostgreSQL 17 on 127.0.0.1:5433 — a query reading its own case's data as text with NULL distinct from the empty string; two cases not seeing each other's rows; every way of writing refused (DELETE, UPDATE, INSERT, DROP, TRUNCATE, ALTER); CREATE TABLE, CREATE TEMP TABLE, CREATE SCHEMA and CREATE VIEW refused; a second statement refused by the protocol; `pg_read_file`, `pg_ls_dir`, `COPY … FROM PROGRAM` and `COPY … TO PROGRAM` refused; `pg_authid` refused; `set_config('role', …)` refused; no other job's schema visible; a spin stopped by the database at 5.7 s; a flood truncated at the cap; the schema dropped after an ok, an error AND a refusal; a broken setup script released permanently; the eleven-case adversarial self-check green; and the five cluster checks green including "this is not the application's database") | Claude |
| 12k.2 | 2026-10-30 | `pnpm lint && pnpm typecheck && pnpm test && pnpm build` + `pnpm size` - Windows 11 | PASS (lint 0 warnings; typecheck clean across seven projects; **8,330 tests passed, 0 failed** - shared 1,910, judge-worker 414, **sql-judge 32** (17 database cases skipped without the opt-in), db 327, design 87, scheduler 247, web 4,138, repo 1,175; build exit 0 including the new app's 171 KB bundle; every size budget met). Two fences needed a line each: the AI-key fence now lists the SQL judge's config as a file that NAMES the key in order to refuse it (with its own test that it never reads it), and the new `sql-judge-posture.test.ts` fences the whole posture | Claude |
| 12k.2 | 2026-10-30 | The service against the real app and the real cluster | PASS. Started with the development judge node's credentials against the production build: it refused nothing at boot, reported "holds no application tables", "superuser=false", "member of no other role" and "CREATE=false", swept stale schemas, passed its self-check, was accepted by `/api/judge/heartbeat` as `driver: postgres` with an empty language list, claimed a job queued by hand on `judge-sql-practice` with an id the app has never seen, treated the refusal as "job done" (which is the contract), reported ready and logged no error. The web side does not enqueue SQL jobs yet (slice 4), so the claim round trip is what this proves | PASS | Claude |
| 12k.2 | - | The clean-stop path, and two fleets at once | **NOT RUN.** `SIGTERM` is not delivered to a Node process on Windows, so the drain-and-close path (`close()` on each queue worker, then the Redis connection) is unproved here; the Linux gate is where it will be. And the development seed registers one judge node, so an isolate worker and a SQL judge have not yet heartbeaten side by side — the `JudgeNode` row's `driver` column currently shows whichever beat last | NOT RUN | - |
| 12k.3a | 2026-10-30 | Slice 3, the model: SQL problems in the database, and the routing | **DONE.** `ioMode = SQL` with `compareMode = ROWS`, two SQL-only columns (`sqlDialect`, `sqlOrdered`) and four CHECKs — and no new table, because a `TestCase`'s input and output blobs are a SQL case's dataset and its expected result set. That is what let SQL join the pipeline with no change to `Submission`, and so none to XP, the leaderboard, contests, assessments or rejudges. SQL is a `LanguageConfig` row (`sql17`) whose runtime is a `SqlRuntime` rather than a `LanguageRuntime`: `LANGUAGE_KEYS` describes toolchains, and a statement handed to a database has no argv, no environment and no `/opt/toolchains` directory. Routing is two shared functions (`engineForIoMode`, `queueNameFor`) and the enqueuer reads the engine from the row rather than taking it as a parameter — five call sites, none with the version in hand, and a SQL job on an isolate queue is one an isolate node claims and cannot run | Claude |
| 12k.3a | 2026-10-30 | A CHECK that was too weak, found by the test that asked for the bad row | **FIXED BEFORE COMMIT.** `(ioMode = 'SQL') = (sqlDialect IS NOT NULL AND sqlOrdered IS NOT NULL)` is satisfied by a STDIN version carrying a dialect and no ordering rule: both sides are false. It is two CHECKs in one expression, and now it is written that way — each column tested against the io mode on its own. The migration was amended rather than followed by a drop (it had not been committed, let alone deployed), the constraint was rolled back by hand on both local databases and re-applied, which is the same procedure the Phase 12g revert used | Claude |
| 12k.3a | 2026-10-30 | Two enum values, in their own migration | **PostgreSQL refuses to USE a new enum value in the transaction that added it** (`unsafe use of new value "SQL" of enum type "IoMode"`), and Prisma runs one transaction per migration — so `20261101120000_phase12k_sql_problems` adds the values and the columns, and `20261101120500_phase12k_sql_checks` constrains them. Two files is the honest way to say "the value exists, then it is constrained"; the alternative, comparing `"ioMode"::text`, would put a cast of questionable immutability inside a constraint to save a file | Claude |
| 12k.3a | 2026-10-30 | `RECX_DB_TESTS=1` against recx_test: the model and the claim | PASS (`sql-problems.db.test.ts` 10/10 — all four CHECKs refusing a half-SQL version (no ROWS, ROWS without SQL, a missing dialect, a missing ordering rule, SQL columns on a STDIN version, a signature, a checker); the engine and queue mapping; a SQL submission claimed as a `postgres` spec with its dialect, its two cases' dataset and expected blobs, the version's ordering rule on every case, and the statement timeout and row cap the SERVER chose; a Run given only the sample case, because a SQL problem's input is its dataset; and an isolate submission still claimed as an isolate spec) | Claude |
| 12k.3a | 2026-10-30 | `pnpm lint && pnpm typecheck && pnpm test && pnpm build` + `pnpm size` - Windows 11 | PASS (lint 0 warnings; typecheck clean across seven projects; **8,336 tests passed, 0 failed** - shared 1,910, judge-worker 414, sql-judge 32, db 333, design 87, scheduler 247, web 4,138, repo 1,175; build exit 0; every size budget met). The third `IoMode` value and the sixth `CompareMode` value found every place that had copied those enums by hand: two view types in the web app and a compare-mode copy map, each now using the shared type, which is what the single-source rule is for | Claude |
| 12k.3b | 2026-10-31 | Slice 3, the authoring: a TA writes a SQL problem, and the capture produces its answer | **DONE.** The create form offers SQL, the judging section asks the one question a human must answer (is the order part of the answer?), a case's dataset is the test's input, and the model solution is a reference QUERY in `sql17`. Nobody types expected rows: a validation run on a SQL version is a CAPTURE run, and `lib/judge/sql-capture.ts` stores what it reported as the version's expected results. The path is narrow on purpose — a validation job only, a SQL version only, an unfrozen version only, existing cases only, and only when EVERY case reported, because a half-capture would publish one case's rows left over from a previous dataset. `versionContentIssues` gained the SQL rules so an author reads a sentence rather than meeting a constraint violation, and `summarizeValidation` now knows that a SQL problem's model solution is its query rather than a C++ program | Claude |
| 12k.3b | 2026-10-31 | The whole path, against the production build and the real sandbox | PASS, and this is the run slice 3 existed for. A TA (RECADMIN01) created a SQL problem through the real `createProblem`, added two cases with their datasets, added the reference query, and started validation; the SQL judge claimed it as a capture run (`capture: true`, every `expected` null), ran the query against each dataset in the real PostgreSQL sandbox and reported the rows; the expected results arrived in the database as `{"columns":["id","name"],"rows":[["1","Asha"],["2","Bala"]]}` for a dataset that INSERTS Bala first — so the reference query's ORDER BY really ran. A second admin approved it, it published, and a student then answered it through the real submit action: the right query **AC 2/2**; the same rows in the wrong order **WA**; one column short **WA**; a column that does not exist **CE** with the database's own message; `DELETE FROM students` **RE**; two statements **CE**. No error in the judge's log | PASS | Claude |
| 12k.3b | 2026-10-31 | Three gates that did not know about a second engine, each found by that run | **ALL THREE FIXED.** (1) The approve and publish gates demanded a C++ model solution, so a SQL problem could never be published — `summarizeValidation` now takes the io mode and asks for the reference query instead, at all four call sites. (2) The submit boundary refused `sql17` as "not a supported language", so no student could answer one; the language schema accepts it and `loadTarget` now refuses SQL for a non-SQL problem AND a programming language for a SQL problem, which is the pairing neither side could state before. (3) `enabledConfigs` validated every LanguageConfig runtime against the TOOLCHAIN schema, so the SQL row was skipped with an error and its reference query was never "runnable" — which silently meant a SQL problem could not be validated, captured or published at all | Claude |
| 12k.3b | 2026-10-31 | A teardown defect in the exposure sweep, found by running the database set together | **FIXED (pre-existing).** `student-exposure.db.test.ts` passed all 14 tests and failed as a SUITE in teardown on `DoubtThread_problemId_fkey`: Phases 12d, 12e and 12h gave the fixture problem doubts, discussion posts, an interview experience and a mock interview, and the cleanup predates all of them. Confirmed pre-existing by stashing this slice's changes and watching it fail the same way. The teardown now removes them in dependency order, with the comment the file already carries twice for the same failure mode (leave exceptions, profile exports) | Claude |
| 12k.3b | 2026-10-31 | `pnpm lint && pnpm typecheck && pnpm test && pnpm build` + `pnpm size` - Windows 11 | PASS (lint 0 warnings; typecheck clean across seven projects; **8,352 tests passed, 0 failed** - shared 1,922, judge-worker 414, sql-judge 36, db 333, design 87, scheduler 247, web 4,138, repo 1,175; build exit 0; every size budget met). The six database suites also pass TOGETHER against recx_test (70 tests), which is how the teardown defect above surfaced | Claude |
| 12k.3b | - | A SQL problem still looks like a program to a student | **NOT RUN / NOT BUILT.** The workspace renders a SQL problem with the ordinary code editor and no dialect notice, the result console shows a WA without the row that differs (the judge sends the sentence; the submission's result compaction drops it), and nothing tells a student the query is read-only or that one statement is the limit. That is slice 4, the student surface; what slice 3 proves is that the data path underneath it is right | NOT RUN | - |
| 12k.4 | 2026-10-31 | Slice 4, the student surface: a SQL question stops looking like a program | **DONE.** The workspace offers a SQL problem `sql17` and nothing else (and no other problem SQL), on the dialect's grammar in both editors; four chips over the editor and the rules in full in the Description tab, every sentence from `SQL_NOTICES`; the sample is a dataset and a table of rows; a case's result is the dataset, the expected rows and the student's own rows as tables with NULL written as a word, under the judge's own sentence about the case; no Custom input tab, because a SQL question's input is its dataset | Claude |
| 12k.4 | 2026-10-31 | The channel the judge's sentence travels in | **REUSED, not invented.** The student's result set goes in the protocol's `stdout` (a SQL submission's output IS a result set), so the hidden-case rule that already drops stdout needed no new code. The sentence goes in `TestResult.message`, which the protocol has carried since Phase 1 and the web boundary dropped: `compactTestResults` now keeps it for the indexes the VERSION marks as samples — read from the database, never from the body a worker sent, so a worker cannot make a hidden case visible. Both sides are clipped to `SQL_DISPLAY_ROWS` before storage, because a visible field is capped in BYTES and JSON cut mid-string is not a result set | Claude |
| 12k.4 | 2026-10-31 | The whole student path, against the production build and the real sandbox | PASS. A TA authored and published a SQL problem with one sample and one hidden dataset (capture: `[["1","Asha"],["2","Bala"]]` and `[["3","Dev"],["7","Chitra"]]`, both from datasets that insert in the other order). A STUDENT then opened `/problems/<slug>`: PostgreSQL 17 offered and no programming language; the chips; the rules in full; the order rule; a query's limit instead of a C++ time limit; the sample as a dataset and a table; no Custom input tab; the hidden dataset nowhere on the page. The same rows in the wrong order submitted through the real action -> **WA**, and the submission page showed Dataset / Expected rows / Your rows as two tables, "The rows are right and the order is not - row 1 differs", and no hidden dataset. Two statements, a query past 20,000 characters and a C++ submission were each refused with their own sentence before anything was queued. A Run against the sample dataset carried the student's rows, the sentence and the expected rows; a custom input was refused. The reference query, as a student: **AC 2/2**. No error in the judge's log | PASS | Claude |
| 12k.4 | 2026-10-31 | `pnpm lint && pnpm typecheck && pnpm test && pnpm build` + `pnpm size` - Windows 11 | PASS (lint 0 warnings; typecheck clean across seven projects; **8,404 tests passed, 0 failed** - shared 1,935, judge-worker 414, sql-judge 41, db 333, design 87, scheduler 247, web 4,164, repo 1,183; build exit 0; every size budget met, with Monaco's `sql.js` now the largest grammar at 4.2 KB and `@codemirror/lang-sql` a lazy chunk of its own) | Claude |
| 12k.4 | 2026-10-31 | The narrow-screen grammar | **BUILT, NOT DRIVEN.** `@codemirror/lang-sql` (PostgreSQL dialect, keywords left as typed) is in the production build as its own lazy chunk, and Monaco's `sql` tokenizer is served from `/monaco/vs/basic-languages/sql`. The end-to-end run drove the wide layout; the under-768 px editor was not opened in a browser | NOT RUN | - |
| 12k.4 | - | A SQL question in a contest or an exam | **NOT BUILT.** The arena and the attempt surface build their own language list and do not know about `sql17`, so a SQL problem placed in a contest or an assessment offers a programming language, and the submit action then refuses it with "That problem is answered with a SQL query" - safe, and unusable. Practice is the surface slice 4 covers | NOT RUN | - |
| 12k.5 | 2026-10-31 | Slice 5, the ops: the fleet, the topology and the alerts know there are two engines | **DONE.** `/admin/judge` gained an **Engines** table (nodes online, slots busy, waiting and active per engine) and the node card now reads per engine — the engine and its version, the judge's own version beside PostgreSQL's rather than isolate's, and "Not measured for the SQL engine" where a calibration score would be. The lane figures are the SUM of both queues, which they silently were not before: `loadQueueDepths` read only the isolate queue name, so every SQL job waiting was invisible on the page that exists to show waiting work | Claude |
| 12k.5 | 2026-10-31 | A judge node's ENGINE version, and why it is not `isolateVersion` | Migration `20261101130000_phase12k_node_engine_version`: one column, one default, additive. The heartbeat has carried `engineVersion` since slice 2 and nothing stored it. A column named after one engine holding another engine's version is the kind of small lie that costs an hour during an incident, so the SQL node's PostgreSQL version gets its own. `migrate diff` reports no drift; applied to `recx` and `recx_test` | Claude |
| 12k.5 | 2026-10-31 | Lane eligibility that says something true about a SQL node | **CHANGED, consequence unchanged.** A postgres node was told its calibration was "missing", as though somebody forgot to send it; it now reads "the SQL engine has no calibration benchmark yet: a query's limit is the database's own statement_timeout, so this node does not serve ASSESSMENT or CONTEST". It is still refused the sensitive lanes, and that is the honest state rather than an oversight — a slow cluster really can turn a passing query into a timeout, so the engine needs a benchmark before an exam may be judged on one (`docs/OPEN-QUESTIONS.md`). The fleet calibration median is now taken over nodes of the SAME engine, in the heartbeat and on the fleet page: a CPU score from a database host measures nothing a C++ time limit is derived from | Claude |
| 12k.5 | 2026-10-31 | `judge_engine_queue_depth{queue,engine}`, and the ninth alert rule | **ADDED, contract unchanged.** `judge_queue_depth` keeps its one label: the rules are written against it, and adding `engine` would turn `max by (queue)` into a per-engine maximum — 150 waiting on each of two engines would stop firing a rule that fires at 200. The split is its own gauge, published from the same read, zeroed per engine for every lane that reported nothing. `JudgeEngineBacklog` (warning, >100 for 5m) is the rule that catches one engine stopped while the lane total still looks survivable; `fire-alerts.ts` produces it for real, 120 jobs onto the SQL practice queue, chosen to be over its own threshold and under the lane rule's | Claude |
| 12k.5 | 2026-10-31 | The fourth host role: `deploy/compose.sql-judge.yml` and `scripts/ops/sql-sandbox-provision.sh` | **WRITTEN, NOT RUN.** The sandbox cluster and the judge on one host, on an `internal:` network nothing else can reach; no published port but the node exporter's, every image pinned by a required digest variable, and all three credentials (the node token and both connection URLs) passed as `*_FILE` Docker secrets the config actually reads. The provisioner makes the student role — the one object the image cannot create for itself, because its whole definition is what it may NOT do: NOINHERIT, member of nothing, no CREATE, no TEMPORARY, nothing on schema public, and the default PUBLIC grants revoked | NOT RUN | - |
| 12k.5 | 2026-10-31 | `docs/CAPACITY.md` §4b: the engine that counts in connections | **DONE.** A SQL slot's real cost is two connections (owner and student) held for the length of a job, so `RECX_SLOTS` is a connection budget and `max_connections >= 2 x slots + 16`. What runs out is not CPU: connections first, then schemas left behind by a job that died between CREATE and DROP, then `temp_file_limit` on somebody's accidental cross join. One host is enough because SQL problems are not allowed in a contest or an assessment at all, which is stated rather than assumed | Claude |
| 12k.5 | 2026-10-31 | The fleet page and the alert, against the production build and a real SQL judge | PASS. `/admin/judge` as an admin, before and after a real `apps/sql-judge` heartbeat: the **Engines** table lists both engines and says a lane is the sum of its two queues; once the judge was up the node card read Engine `postgres` with **PostgreSQL 17.11** beside it (the packaging build trimmed - `server_version` reports "17.11 (Ubuntu 17.11-1.pgdg24.04+2)" and the fleet wants the number), **Judge / engine** rather than Worker / isolate, "Not measured for the SQL engine" where calibration goes, `sql17` in its languages, and the Engines row counting it 1 / 1 online. The stored restriction is the engine's own sentence, and the sensitive lanes are withheld. `fire-alerts.ts --only JudgeEngineBacklog`: **FIRES, 120 vs 100**, produced for real on `judge-sql-practice`. No error in the judge's log | PASS | Claude |
| 12k.5 | 2026-10-31 | `pnpm lint && pnpm typecheck && pnpm test && pnpm build` + `pnpm size` - Windows 11 | PASS (lint 0 warnings; typecheck clean across seven projects; **8,425 tests passed, 0 failed** - shared 1,936, judge-worker 414, sql-judge 43, db 336, design 87, scheduler 250, web 4,174, repo 1,185; build exit 0; every size budget met) | Claude |
| 12k.5 | - | The SQL judge publishes no `/metrics` of its own | **NOT BUILT, deliberately.** Everything about it is already published by a process there is exactly one of: the per-engine queue depth and its heartbeat age by the scheduler, its verdicts by web. A second listener republishing the same numbers from a second place is how two figures that should agree stop agreeing. What is genuinely missing is the engine's own internals - time in the author's setup script versus the student's statement, sweeper counts - and that is an open question rather than an omission | NOT RUN | - |
| 12l.0 | 2026-10-31 | The design: interactive problems, written before any of it | **DONE** — `docs/handoff/phase12/DESIGN-interactive.md`. The decisions it settles, each with the reason: the interactor IS the judge (no second checker pass, because two programs that can each fail is already the most fragile thing in the engine); two boxes that share nothing but the conversation (the worker relays, rather than FIFOs in a directory both boxes could write to); the interactor's CPU excluded by construction; mutual idle as the student's TLE; no expected output; no custom input; no interactive problem in an assessment until SPEC's two clean practice contests have happened | Claude |
| 12l.1 | 2026-10-31 | The engine: protocol 5, two boxes talking, and the verdict precedence | **DONE.** `Sandbox.execPair` runs both isolate processes with their stdio piped through the worker — no `--stdin`, no `--stdout`, and the banned flag that keeps every descriptor open is still never emitted (`test/argv.test.ts`). The interactor is compiled, cached and interpreted by the CHECKER's own code with its own exit codes; `prepareChecker` gained one argument so the author of a broken interactor reads "interactor does not compile" rather than being sent to look for a checker. The precedence is the design: infrastructure, the student's own limits, the deadlock, the interactor's failure, the student's crash **unless it was SIGPIPE**, then the interactor's verdict | Claude |
| 12l.1 | 2026-10-31 | The interactive suite on REAL isolate (WSL2, isolate 2.7, gcc 13.2.0, testlib 0.9.41) | PASS **9/9**, and two of them are findings. A binary search on a guess-the-number problem → **AC** with the conversation recorded by the relay (`> 500000000` / `< lower` …); a linear search out of queries → **WA** in the interactor's own words; a missing flush → **TLE in 2.1 s** with the sentence about flushing; a program that only prints → **OLE**; a crash mid-conversation → **RE**; the solution's reported CPU under 500 ms with the interactor's excluded; a hidden case carrying no transcript, no stderr and no report; an interactor reporting FAIL releasing the job permanently and posting no verdict; two cases in a row with a fresh interactor box each | PASS | Claude |
| 12l.1 | 2026-10-31 | Two verdicts the integration run got wrong before it got them right | **BOTH FIXED, and both would have been wrong verdicts.** (1) A segfault mid-conversation was reported **WA**, because the interactor then read EOF and said "wrong answer": the precedence now puts the solution's crash ABOVE the interactor's decision, except for SIGPIPE, which means the interactor had already decided and exited. (2) The deadlock case did not deadlock: a C++ program that forgets to flush still works, because `std::cin` is tied to `std::cout` and a read flushes the pending write — so the test now uses `printf`/`scanf`, which is the deadlock a student actually hits, and it fired the 2-second deadline exactly as designed | Claude |
| 12l.1 | 2026-10-31 | `pnpm lint && pnpm typecheck && pnpm test && pnpm build` + `pnpm size` - Windows 11 | PASS (lint 0 warnings; typecheck clean across seven projects; **8,445 tests passed, 0 failed** - shared 1,936, judge-worker 434, sql-judge 43, db 336, design 87, scheduler 250, web 4,174, repo 1,185; build exit 0; every size budget met) | Claude |
| 12l.1 | - | An interactive problem a student could reach | **NOT BUILT YET.** The engine judges one; nothing can author one. `ProblemVersion` has no interactor, the authoring surface still refuses INTERACTIVE in three places, and no web code puts an interactor in a job spec — so the only interactive problems that exist are the integration suite's. Slices 2 and 3 | NOT RUN | - |
| 12l.2 | 2026-10-31 | Slice 2, the data model and authoring: a TA can make one | **DONE.** One column (`ProblemVersion.interactorSha256`) and four CHECKs that say what an interactive version is; the interactor is its own authoring edit, stored as a content-addressed blob and moving `judgeSeq` like the checker's; a case's expected-output field is absent rather than ignored, and the version's cases carry the empty blob (making `TestCase.outputSha256` nullable would weaken a constraint every other kind of problem keeps). `interactor.cpp` joined the import package under the same rules. The claim resolves the blob for the node, the job spec carries it, and `/api/judge/blob` lets the holding node fetch it — the checker's own path, one branch wider | Claude |
| 12l.2 | 2026-10-31 | SPEC's assessment rule, with a date on it | **ENFORCED IN THREE PLACES.** SPEC §11: keep interactive problems out of high-stakes assessments "until they have run cleanly through two practice contests". A trigger on `AssessmentProblem` refuses the pin (the fact lives on another table, like the frozen-version rule beside it), the admin action says so in a sentence first, and both the trigger and its function are in the guard catalogue — so when somebody lifts the rule the build fails until they also record it. A CONTEST may hold one, which is why there is no trigger on `ContestProblem` | Claude |
| 12l.2 | 2026-10-31 | The whole authoring path, on the real judge (WSL2, isolate 2.7, testlib 0.9.41) | PASS. An interactive problem imported from a package (`interactor.cpp`, three cases, empty `.out` files, two reference solutions), validated on a real judge node — **model AC, deliberately-wrong WA, both MATCHED** — submitted for review, approved and **published at revision 1**; the frozen version carries its interactor and no checker. A seeded student's submission of the model solution was then judged **AC 3/3** by the same node, and the submission page showed the conversation the worker relayed (`> 500000000` / `< lower` …) with the interactor's own "found it after 29 queries" and nothing of the hidden cases. An assessment refused the problem | PASS | Claude |
| 12l.2 | 2026-10-31 | A limit for a language nobody can choose, found by that run | **FIXED.** The publish printed `sql17  2000 ms` beside `cpp20` for an interactive problem: `deriveLanguageLimits` derived a row for every enabled LanguageConfig, and since Phase 12k that list includes SQL. A stored limit for a language a student cannot choose is a row that reads as meaningful — and the other direction was worse, because a SQL problem was getting C++ limits. The derivation now takes the io mode and keeps only the languages the problem can be ANSWERED in, which is the rule the workspace and the submit boundary already follow | Claude |
| 12l.2 | 2026-10-31 | A clock-skew flake in the governance invariants, found on the way | **FIXED (pre-existing).** `packages/db/test/governance-invariants.test.ts` failed 4 to 15 of its 98 tests, differently on each run, with the right constraint firing for the wrong reason: its steps set timestamps two ways — a Prisma write from Node, an UPDATE with `now()` from PostgreSQL — and on this machine the database runs in WSL2, whose clock drifts a second or more from the Windows host's. Rows then had an "end" a hair before their "start". Confirmed pre-existing by stashing this slice and watching it fail the same way. The suite now measures the offset once and takes every Node-side timestamp from the database's clock: **98/98**, and the whole `@recx/db` suite with `RECX_DB_TESTS=1` is **1,609 passed** | Claude |
| 12l.2 | 2026-10-31 | `pnpm lint && pnpm typecheck && pnpm test && pnpm build` + `pnpm size` - Windows 11 | PASS (lint 0 warnings; typecheck clean across seven projects; **8,487 tests passed, 0 failed** - shared 1,946, judge-worker 434, sql-judge 43, db 343, design 87, scheduler 250, web 4,188, repo 1,196; build exit 0; every size budget met) | Claude |
| 12l.2 | 2026-10-31 | Why the live stage ran against the DEV server rather than the production build | **A property of this machine, and the production rail working.** A real isolate node cannot pass the kernel hardening check on a WSL2 kernel, and the web app refuses `JUDGE_ALLOW_UNHARDENED_NODES` when `NODE_ENV=production` — so the production build QUARANTINED the node, exactly as Phase 2 recorded. The authoring, validation, publish and student-submission steps above therefore ran against `pnpm dev` with a freshly registered node; the rendering they assert is the same React code the production build serves, and the SQL phases' own production-build runs cover that path | Claude |
| 12l.2 | - | The student surface of an interactive problem | **NOT FINISHED.** The live run found it: the console still offers a **Custom input** tab on an interactive problem, where typing input would be silently ignored, and the transcript is labelled "Your output" rather than as a conversation. The statement says nothing about flushing or about how the dialogue is judged. That is slice 3 | NOT RUN | - |
| 12l.3 | 2026-10-31 | Slice 3, the student surface: a case with no expected output shows none | **DONE.** An interactive case gets two blocks rather than three — the examiner's data and **Your conversation**, the transcript the relay recorded, marked `>` and `<` — and the empty "Expected output" block the slice-2 live stage found is gone from both the console and the statement. Four chips over the editor (a conversation, flush every line, 2 s of silence is a deadlock) and the same rules in sentences in the Description tab, every one of them from `INTERACTIVE_NOTICES` in `@recx/shared` with a repository test refusing a second copy. No custom input in either half: the console offers no tab, and `runCode` refuses one with a sentence | Claude |
| 12l.3 | 2026-10-31 | The surface, read from the running app as the student | PASS. `/problems/<slug>`: no **Custom input** tab, no expected output, the chips naming the conversation and the flush, "2 s of silence is a deadlock", **How your conversation is judged** in full, and the sample shown as **The examiner's data** with no Output block beside it. The submission page of the AC run reads *"ok found it after 29 queries — The examiner's data 42 40 — Your conversation > 500000000 < lower > 250000000 …"*, with no "Expected output" and no "Your output" anywhere, and nothing of the hidden cases | PASS | Claude |
| 12l.3 | 2026-10-31 | `pnpm lint && pnpm typecheck && pnpm test && pnpm build` + `pnpm size` - Windows 11 | PASS (lint 0 warnings; typecheck clean across seven projects; **8,509 tests passed, 0 failed** - shared 1,946, judge-worker 434, sql-judge 43, db 343, design 87, scheduler 250, web 4,204, repo 1,202; build exit 0; every size budget met, the workspace shell at 185.5 KB of 220) | Claude |
| 12l.3 | - | An interactive problem in a CONTEST | **NOT RUN.** SPEC allows it and nothing refuses it, but the contest arena builds its own language list and its own result console, neither of which has been read with a conversation in mind. The two practice contests SPEC asks for before an assessment may hold one have not happened either - so an interactive problem is a practice problem today, and the first contest that uses one should be watched rather than assumed | NOT RUN | - |
| 12m.1 | 2026-10-31 | Slice 1, the rule: an edit budget, and the three places it is read | **DONE.** `ProblemVersion.maxEditedLines` (migration `20261101150000_phase12m_debug_budget`, two CHECKs: 1..50, and never on a SQL or interactive version) makes a problem a DEBUGGING problem; the broken program is the `StarterCode` the version already had. `countEditedLines` in `@recx/shared` — `max(added, removed)` over a line-level LCS, trimmed, blank lines dropped — is the one count, read by the submit and run refusals (before the row, so a refused submission costs nothing), by the publish gate and by the editor. The gate adds four rules, two of which no CHECK could hold: a budget needs a starter, and the author's own model solution must itself fit the budget. The import format carries `maxEditedLines` and refuses one with no `starters/`. The judge is told nothing: no protocol field, no worker mention, both fenced | Claude |
| 12m.1 | 2026-10-31 | A Phase 12k defect, found while adding the field beside it | **FIXED.** `updateDraftJudging` (the action) never forwarded `sqlOrdered` to the edit: the form asked whether the row order is part of the answer, the schema validated the answer, and the action dropped it — so `sqlOrdered` fell back to `true` for every SQL problem ever saved, including one whose author answered no. SPEC asks for that question to be asked rather than guessed, and it was being guessed. One line, asserted in `admin-problems-actions.test.ts` | Claude |
| 12m.1 | 2026-10-31 | The migration ritual | `prisma migrate diff --from-migrations … --shadow-database-url` against a temporary `recx_shadow` (created OWNER recx, dropped afterwards): **No difference detected**, exit 0. `migrate deploy` applied `20261101150000_phase12m_debug_budget` to **recx** and **recx_test** (44 migrations each, exit 0), then `prisma generate` | Claude |
| 12m.1 | 2026-10-31 | The two CHECKs and the edit, against a real PostgreSQL (`RECX_DB_TESTS=1`) | PASS 8/8 — a budget of 1 and of 50 accepted; 0, 51 and -2 refused by `debug_budget_range` on INSERT **and** on UPDATE; a budget on a SQL or an interactive version refused by `debug_budget_kind`; the edit stores it and moves `judgeSeq`; switching the version to SQL or INTERACTIVE clears it (and keeps the author's `sqlOrdered` answer, the defect above); and the publish gate reads the starter and the model source only for a debugging version | PASS | Claude |
| 12m.2 | 2026-10-31 | Slice 2, the assessment rule: refuse the pin, not the candidate | **DONE.** Migration `20261101151000_phase12m_assessment_rule`: `recx_refuse_debug_assessment_problem` and trigger `AssessmentProblem_no_debug_budget`, with the sentence an admin reads first in `admin-assessments.ts` and both names in the guard catalogue. The reason is the one asymmetry of this phase: the budget is refused before the row in the submit and run actions, and `submitAttempt` writes every answered question at the end of a sitting, where a refusal would destroy work the candidate can no longer redo. A CONTEST needs no rule — its arena links to the ordinary workspace rather than building an editor of its own, so the budget is shown and enforced already, which is why the trigger is not on `ContestProblem` | Claude |
| 12m.2 | 2026-10-31 | The migration ritual, again | `migrate diff` against a fresh temporary `recx_shadow`: **No difference detected**, exit 0 (a trigger is invisible to Prisma's model, so the drift check is unchanged by design). `migrate deploy` applied `20261101151000_phase12m_assessment_rule` to **recx** and **recx_test** (45 migrations each, exit 0); shadow dropped | Claude |
| 12m.2 | 2026-10-31 | The trigger, and the guard catalogue over it (`RECX_DB_TESTS=1`) | PASS — the pin of a frozen debugging version into a DRAFT assessment is refused with *"not sat in an assessment yet"* (9/9 in `debug-problems.db.test.ts`), and `frozen-coverage` + `governance-invariants` pass 392/392 with the new function and trigger catalogued | PASS | Claude |
| 12m.3 | 2026-10-31 | Slice 3, the student surface: the budget and the count, side by side | **DONE.** `DebugNote` over the editor carries `debugChipLabel` and `debugCountLabel` — the budget and the lines changed so far, red when over — computed by the same `countEditedLines` the submit action refuses on, against the ACTIVE language's starter (a repository fence asserts that one line). The Description tab states the rule with the number in it plus what does not count, why the budget exists, why the picker is short, and what Reset does; Reset itself is relabelled "Reset to the broken program". Every sentence comes from `DEBUG_NOTICES` / the builders, with a fence refusing a second copy | Claude |
| 12m.3 | 2026-10-31 | The whole phase, driven through the running app end to end | PASS. A TA creates the problem, sets the budget (a budget of 0 is refused with *"The edit budget is at least 1 line."*), adds two cases and the model fix. **The gate, before the broken program exists:** "needs the broken program as starter code" — and satisfied once the starter is there. **The gate on an unsolvable question:** the model replaced by a rewrite is refused with both numbers, and accepted again when the real one-line fix is restored. Validation on the real isolate worker: AC. Approved by a second admin and published. **The assessment refuses the pin** with the slice-2 sentence and nothing is pinned. **The student:** the chip names the budget, the counter reads "0 of 1 line changed", the broken program is in the editor, only C++ is offered (the one language its program is written in), and the rules are stated in full. A correct program written from scratch is refused — *"This changes 6 lines and the question allows 1"* — with **no submission row written**; the same fix re-indented and spaced out is **AC 2/2**; the one-line fix is **AC 2/2**; and the program as given is **WA 0/2**, wrong rather than refused | PASS | Claude |
| 12m.3 | 2026-10-31 | `pnpm lint && pnpm typecheck && pnpm test && pnpm build` + `pnpm size` - Windows 11 | PASS (lint 0 warnings; typecheck clean across seven projects; **8,584 tests passed, 0 failed** - shared 1,979, judge-worker 434, sql-judge 43, db 350, design 87, scheduler 250, web 4,220, repo 1,221; build exit 0; every size budget met) | Claude |
| 12m.3 | - | The live counter, watched in a browser as somebody types | **NOT RUN.** The two halves are covered apart: a component test renders the counter at, below and over the budget (including the red class and the `aria-live` region), and a repository fence asserts that the bar and the action call the same `countEditedLines` against the same starter. What has not been watched is the number changing between keystrokes in a real editor. The same gap as the narrow-screen SQL grammar of 12k | NOT RUN | - |
| 12m.3 | 2026-10-31 | Dev-environment note, in passing | Two leftover in-flight submissions of earlier live stages (a `sql17` job with no postgres node online, and a `cpp20` job dispatched to a node that had gone) were holding the seeded student's two-in-flight cap, which refused the first submission of the live run with the right sentence. The cap behaved correctly; the two rows were CANCELLED by id in the dev database. Worth knowing before the next live stage: a stopped worker leaves submissions that count against a cap | Claude |
| 12n.1 | 2026-10-31 | `pnpm lint && pnpm typecheck && pnpm test && pnpm build` + `pnpm size` - Windows 11 | PASS (lint 0 warnings; typecheck clean across seven projects; **8,636 tests passed, 0 failed** - shared 1,980, judge-worker 446, sql-judge 43, db 356, design 87, scheduler 250, web 4,240, repo 1,234; build exit 0; every size budget met). The first test run caught Phase 12m's own fence pinning `enum IoMode` to three values; it now asserts what it meant - that no io mode is about debugging - rather than that the list never grows | Claude |
| 12n.1 | 2026-10-31 | Slice 1, the model and the engine: a submission that is the answer | **DONE.** `IoMode.OUTPUT_ONLY` (migrations `20261101160000` for the enum value alone — PostgreSQL refuses to use a new value in the transaction that adds it — and `20261101160500` for the CHECK that says what an output-only version is NOT: no signature, no dialect, no interactor, no edit budget, no ROWS or INTERACTIVE comparison). `answer1` is the second language a submission may carry that is not a toolchain (`answer-problem.ts`, a `LanguageConfig` row, `SUBMIT_LANGUAGE_KEYS` moved to `submit-language.ts` now that the list is no longer about SQL). **Protocol 6**: `JudgeJobSpec.language` is nullable, null exactly for an output-only job, both halves refined by the schema itself. The worker's `judge/answer.ts` compares the submitted text — or hands it to the author's checker in its box — and creates no run box at all; `requireRuntime()` is the one place that turns a nullable runtime into a program's | Claude |
| 12n.1 | 2026-10-31 | The real-isolate suite found a wrong verdict in the design | **FIXED.** The first spec builder forced `scoringMode: "ICPC"` on the grounds that one case is one case. ICPC has no partial credit (`aggregate.ts`: a PARTIAL test becomes WA), so the checker that had just awarded 30 of 100 for a best-effort answer produced **WA** — the exact verdict an output-only problem with a scoring checker exists to avoid. The author's scoring mode is now carried through, PER_TEST keeps the part marks, and SUBTASK is refused because one case is not a table of subtasks. Asserted in both suites | Claude |
| 12n.1 | 2026-10-31 | Output-only on REAL isolate (`RECX_ISOLATE_INTEGRATION=1`, boxes 70/170/270) | PASS 6/6 — the best answer judged **AC** by the author's testlib checker (compiled and run in the checker box, 3.8 s with a cold compile), a 3-of-10 answer **PARTIAL score=30/100**, a wrong sum **WA** in the checker's own words, an empty answer **WA** rather than an internal error, and a plain TOKEN comparison **AC in 1 ms with no box created at all** (and WA for the wrong text, AC for the same text re-spaced). Every case reports ms=0, kb=0 and no compile, because nothing of the student's ran | PASS | Claude |
| 12n.1 | 2026-10-31 | The migration ritual | `prisma migrate diff --from-migrations … --shadow-database-url` against a temporary `recx_shadow`: **No difference detected**, exit 0. Both migrations applied to **recx** and **recx_test** (47 each, exit 0), then `prisma generate`. The database test of the new CHECK passes 9/9 with `RECX_DB_TESTS=1` | Claude |
| 12n.2 | 2026-10-31 | Slice 2, authoring and the gate: one visible case, and the model answer | **DONE.** `answerIssues()` in the shared gate: exactly one case (one instance, one answer), the case is a SAMPLE (its data is the question), an expected answer is stored, the model ANSWER exists as an `answer1` reference expected AC, and no artefact of another kind (signature, dialect, interactor, edit budget, ROWS or INTERACTIVE comparison). Two rules are lifted for this kind — the hidden test and the C++ model solution. The io mode is offered on both authoring forms, `updateDraftJudging` clears an edit budget when a version becomes output-only, the import package describes the kind (one sample, no starter, a model answer) and `enabledConfigs` can see the answer language, without which nothing of this kind could be validated or published | Claude |
| 12n.2 | 2026-10-31 | Two Phase 12k gaps closed in passing | **FIXED.** The import package's `solutions[].language` was `z.enum(LANGUAGE_KEYS)` and the admin form's `LANGUAGE_OPTIONS` was the same list, so a SQL problem's reference QUERY could be named by neither — a SQL problem has been publishable only through a server action since Phase 12k. Both now carry `sql17` and `answer1`, each labelled for the kind of problem it belongs to | Claude |
| 12n.2 | 2026-10-31 | The gate and the authoring edit, against a real PostgreSQL (`RECX_DB_TESTS=1`) | PASS 11/11 — the CHECK's refusals from slice 1, plus: switching a version to OUTPUT_ONLY clears the edit budget (and the dialect and interactor with it), an empty version is told it needs one case AND the model answer, a complete one has no errors at all, and marking the case hidden is refused with the sentence about data nobody can read | PASS | Claude |
| 12n.2 | 2026-10-31 | `pnpm lint && pnpm typecheck && pnpm test && pnpm build` + `pnpm size` - Windows 11 | PASS (lint 0 warnings; typecheck clean; **8,653 tests passed, 0 failed** - shared 1,995, judge-worker 446, sql-judge 43, db 356, design 87, scheduler 250, web 4,240, repo 1,236; build exit 0; every size budget met) | Claude |
