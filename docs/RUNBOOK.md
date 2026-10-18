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

Windows reaches the WSL2 services as `localhost` (WSL forwards them). Docker
Desktop does not start on the main development machine, so these services
run natively in WSL2 (`docs/OPEN-QUESTIONS.md` item 9); `compose.yaml` is the
container alternative on machines where Docker works (§1.7).

Windows and Linux `node_modules` cannot be shared (Prisma engines, argon2,
esbuild and rollup are native), so Linux work happens in a **native mirror**
of the checkout at `~/recx` inside WSL2, refreshed by
`scripts/dev/linux-sync.sh`.

### 1.1 One-time setup — WSL2 side

1. Install Ubuntu 24.04 under WSL2 (the distribution is named `Ubuntu`
   below). Recommended: **mirrored networking**, so `localhost` works in both
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
$env:DATABASE_URL = "postgresql://recx:recx-dev-only@localhost:5433/recx_test"
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

The sync never copies `.env` / `.env.local` files and never deletes them
from the mirror, so the judge worker's environment is set up once inside
WSL2:

```bash
cp /mnt/c/Users/<you>/OneDrive/Documents/GitHub/REC-CODE/apps/judge-worker/.env.local ~/recx/apps/judge-worker/.env.local
# then, in that copy:
#   RECX_CACHE_DIR=/var/tmp/recjudge-blobs   (the default needs root)
#   RECX_APP_URL=http://<windows-host>:3000  (only without mirrored networking)
```

### 1.5 Starting everything

| Process | Command | Notes |
|---|---|---|
| WSL2 services | `wsl -d Ubuntu -- systemctl is-active postgresql redis-server isolate` | all three start with WSL2 (systemd); this also wakes the distribution |
| Web | `npx pnpm@9.15.9 dev` | Windows; <http://localhost:3000> |
| Scheduler | `npx pnpm@9.15.9 scheduler:dev` | Windows; reconciler every 10 s |
| Judge worker | the §1.4 form with `<command>` = `pnpm --filter @recx/judge-worker dev` | WSL2, `RECX_DRIVER=isolate`. The mirror is a copy: after editing worker code on Windows, stop and re-run the command so it re-syncs |

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

### 2.9 Judge protocol upgrades (protocol 3, Phase 4)

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
