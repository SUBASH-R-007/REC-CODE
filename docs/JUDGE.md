# REC Code — The judge

How student code is compiled, run and judged, what is guaranteed, and what is
not. This describes the judge as built through Phase 2 (judge hardening,
verdict completeness, capacity). The authoritative values live in code: the
limits table in `packages/shared/src/limits.ts`, the language catalog in
`packages/shared/src/languages.ts`, the wire protocol in
`packages/shared/src/protocol.ts` (`JUDGE_PROTOCOL_VERSION = 2`), the worker in
`apps/judge-worker`, and the web side of the protocol in
`apps/web/src/lib/judge`. Where this document and the code disagree, the code
is right and this document is a bug.

---

## 1. The guarantee, stated plainly

**No sandbox can be proven impossible to escape: kernel CVEs touching
namespaces, cgroups, eBPF and io_uring appear several times a year. The
documented guarantee is blast-radius containment on a disposable,
credential-free judge host, continuously re-verified by the self-check
suite.**

Everything below is a layer of that containment. None of them is claimed to
be perfect on its own:

| Layer | What it does | Where |
|---|---|---|
| isolate box | separate mount, PID, IPC and network namespaces; own cgroup; rlimits; a filesystem view of only `/box`, read-only system dirs and the job's toolchains; uid 60000+box | `apps/judge-worker/src/sandbox/isolate.ts` |
| Syscall restrictions | isolate `syscall_flags = 31`: keyrings, `AF_VSOCK`, file locks on shared inodes (`flock`, `fcntl` locks/leases), io_uring and 32-bit syscalls blocked in every box | `infra/judge/install-isolate.sh` |
| Egress firewall | outbound policy drop; only the app host (HTTPS, NTP) and Redis are reachable, plus DHCP lease renewal; no DNS (the app's name is pinned in `/etc/hosts`); sandbox uids 60000–60999 dropped explicitly; cloud metadata blackholed | `infra/judge/nftables.conf` |
| Kernel hardening | unprivileged user namespaces, bpf, io_uring, perf, ptrace, userfaultfd off; core dumps off; rare protocols/filesystems refused; module loading disabled after boot | `infra/judge/sysctl/`, `infra/judge/modprobe/` |
| Credential-free host | no database URL, no auth secret, no storage master key, no student PII — nothing worth stealing beyond one narrowly scoped node token | `apps/judge-worker/src/config.ts` |
| Disposability | the host is cattle, rebuilt from `infra/judge/cloud-init.yaml` in under 10 minutes, never repaired in place | `docs/RUNBOOK.md` |
| Re-verification | before every start `verify-host.sh` (systemd, as root); in the worker at boot the host hardening check, the 12-fixture adversarial self-check and calibration, re-run every 6 h; the results ride every heartbeat, and a failure quarantines the node (§10) | `apps/judge-worker/src/{hardening,selfcheck,calibration}.ts` |
| Toolchain verification | every toolchain compiles and runs a hello-world inside isolate with the catalog's exact argv before a host joins the fleet | `infra/judge/toolchains/verify-toolchains.sh` |

---

## 2. Topology

```
 apps/web (only process with DATABASE_URL)          judge host (credential-free)
 ┌──────────────────────────────────────┐   HTTPS   ┌────────────────────────────────────┐
 │ /api/judge/heartbeat  claim  blob    │ ◀──────── │ apps/judge-worker                  │
 │            result  release           │  node     │   lane allocator → BullMQ (Redis)  │
 │ lanes.ts decides the node's lanes    │  token    │   slot N: boxes N, 100+N, 200+N    │
 │ finalise txn → Postgres              │           │   isolate 2.7, cgroup v2, RAM root │
 │ publishes {type:"final"}             │           │   maintenance boxes 900–909        │
 └──────────────────────────────────────┘           └────────────────────────────────────┘
            ▲  SSE to the browser                         │ publishes {type:"state"|"test"|"subtask"}
            └──────────── Redis pub/sub recx:<kind>:<id> ◀┘
```

* **Judge hosts are credential-free.** The worker's whole configuration is
  its node id, its node token, the app URL, the Redis URL and sandbox
  tuning (`apps/judge-worker/src/config.ts`). A config test fails if a key
  resembling a database URL is ever added, and `tests/repo/judge-isolation.test.ts`
  fails if the worker ever depends on `@recx/db` or `@prisma/client`.
* **Node token scope.** The token is presented as
  `authorization: Bearer <token>` with `x-recx-judge-node: <nodeId>` and
  `x-recx-judge-protocol: <JUDGE_PROTOCOL_VERSION>` on every request. Only
  its sha256 is stored (`JudgeNode.tokenHash`), compared in constant time.
  It can do exactly five things:

  | Endpoint | What it allows |
  |---|---|
  | `POST /api/judge/heartbeat` | report health, slots, languages, calibration, self-check, host hardening, startup credit; receive the node's status and the lanes it may serve |
  | `POST /api/judge/claim` | take the lease on one queued job (`submission`, `run` or `validation`); receive its `JudgeJobSpec` or a `claimRefusal` |
  | `GET /api/judge/blob/[sha256]?kind=&id=&claimToken=` | fetch a test input, expected output or checker source **of the job this node holds**, only while its lease is live, only from that job's pinned problem version (samples only for a Run) |
  | `POST /api/judge/result` | post that job's result, guarded by its `claimToken` |
  | `POST /api/judge/release` | give the job back after an infrastructure failure, or (`permanent: true`) declare that no node can ever judge it (§9) |

  A protocol version mismatch is HTTP 426, so a half-upgraded fleet cannot
  write a result the server would misread. A stale or duplicate result is
  HTTP 409 `{stale: true}` and changes nothing. All bodies are validated with
  the zod schemas in `packages/shared/src/protocol.ts`.
* **What a fully compromised judge host could do.** It could read the source
  and test data of jobs it claims, forge verdicts for jobs it claims, and,
  through its Redis credentials, disturb queues or publish misleading
  progress events. It could not read the database, sessions, other jobs'
  blobs, reference solutions or any PII. Progress events are advisory; the
  stored verdict comes only from the guarded finalise transaction. Queue
  damage costs time, not submissions (Postgres is truth; the reconciler
  re-enqueues). A node that is QUARANTINED has the results it still posts
  discarded and the jobs re-queued (audited `judge.result.discarded_quarantined`).
  Redis ACLs that limit a node to the queue keys and progress channels are
  planned for Phase 10.

### Job lifecycle

1. The web app commits the `Submission` / `RunRequest` / `ValidationRun` row
   as `QUEUED`, then enqueues `{kind, id}` on one of five BullMQ queues
   (`judge-assessment`, `judge-contest`, `judge-run`, `judge-practice`,
   `judge-rejudge`; `docs/OPEN-QUESTIONS.md` item 2) with
   `judgeJobOptions(lane, id)` (`jobId` = the row id). A node serves the
   queues listed in `RECX_QUEUES`, intersected with the lanes its heartbeat
   allows (§3).
2. The worker's allocator fetches a job only when it has a free slot for that
   lane, and claims it. The lease is 120 s (`JUDGE_LEASE_SECONDS`); each
   claim writes a fresh `claimToken` and increments `attemptCount`. A node
   whose sensitive lanes are withheld cannot claim an ASSESSMENT or CONTEST
   row even if it fetches one.
3. Blobs come from `/api/judge/blob/…` into a content-addressed cache
   (`RECX_CACHE_DIR`), each verified against its size and sha256 before use
   and evicted LRU within `RECX_CACHE_MAX_BYTES`.
4. Compile in the compile box (or take the compiled artefacts from the
   compile cache, §6), then run each test in a fresh run box, and for
   `CHECKER` problems judge each output in a fresh checker box (§7).
   Progress goes to Redis pub/sub (`recx:<kind>:<id>`), never a database row
   per test.
5. The worker posts the result. The finalise transaction is guarded by
   `claimToken` and `judgeState IN ('DISPATCHED','RUNNING')`; it also
   charges the user's daily usage (`UserJudgeUsage`: submissions, runs,
   `cpuMs`). Only after it commits does the web app publish `{type:"final"}`,
   and the browser reads the stored result.

---

## 3. Lanes and the slot allocator

Five lanes, one BullMQ queue each. **BullMQ priority alone provably starves
the lowest lane** (a saturated higher-priority queue is always served
first), so the worker allocates its own slots (`apps/judge-worker/src/allocator.ts`,
a pure policy, unit-tested including starvation). It fetches a job with
`getNextJob` only when a slot is free *and* the policy picks that lane, and
never holds a job it has no slot for.

| Lane | Rule (`LANE_ALLOCATION`) | Sensitive? |
|---|---|---|
| ASSESSMENT | at most 60 % of the node's slots | yes |
| CONTEST | at most 50 % | yes |
| RUN | **2 hard-reserved slots** (1 on a node with < 3 slots, and never a node's last slot while it serves other lanes) that no other lane may use — the editor's Run button stays responsive during a contest | no |
| PRACTICE | a **25 % floor** (rounded up): a soft reservation held while practice has waiting jobs or was active in the last 2 s, so practice is never starved to zero | no |
| REJUDGE | at most 20 % (0 on nodes with < 5 slots), and **0 while the assessment backlog exceeds 50 jobs**; validation jobs ride this lane | no |

Caps are `floor(share × slots)`; a lane that is the node's only allowed lane
is uncapped, so a single-purpose node never wastes capacity. Soft
reservations (everything except RUN's) release after 2 s idle
(`softReservationIdleMs`). BullMQ priorities (`LANE_PRIORITY`) are kept only
as a tiebreak inside one queue.

**Sensitive lanes.** ASSESSMENT and CONTEST (`SENSITIVE_LANES`) are served
only by a node that is calibrated, self-checked and hardened right now. The
web app decides this on every heartbeat (`apps/web/src/lib/judge/lanes.ts`)
and withholds both lanes when any of these hold:

* its calibration score deviates **more than 10 %** from the median score of
  every ONLINE node (a lone node is its own median), or it has none, or it is
  older than 6.5 h;
* its self-check failed, was never reported, or is older than 6.5 h
  (`LIMITS.selfCheck.staleAfterMs`);
* its host hardening check failed or was not reported (§10).

The heartbeat response carries `lanes` (what the node may serve) and
`laneRestrictions` (one human-readable reason each, logged by the worker and
shown on `/admin/judge`). The claim route re-checks `sensitiveLanesOk`, so a
stale allocator cannot take sensitive work.

---

## 4. isolate 2.7 configuration

isolate is built from upstream tag `v2.7` at a pinned commit
(`infra/judge/install-isolate.sh` refuses any other checkout) and installed
setuid root. `/usr/local/etc/isolate`:

| Key | Value | Why |
|---|---|---|
| `box_root` | `/var/local/lib/isolate` | a tmpfs (below) |
| `lock_root` | `/run/isolate/locks` | |
| `cg_root` | `auto:/run/isolate/cgroup` | the cgroup v2 subtree held by `isolate.service` (`isolate-cg-keeper`, `isolate.slice`, cpuset + memory delegated) |
| `first_uid` / `first_gid` | `60000` | box N runs as uid/gid 60000+N |
| `num_boxes` | `1000` | uids 60000–60999, the range the firewall drops |
| `syscall_flags` | `31` | keyrings (1) + vsock (2) + file locks on inodes shared between boxes (4) + io_uring (8) + legacy architectures (16) |
| `box<N>.cpus` | one CPU per slot (production) | CPU pinning, below |

Flag 4 blocks `flock()` and `fcntl()` locks and leases outright. Most
programs never notice; the Go command does (its build cache needs a lock),
which is why Go builds without it (§7).

### Box ids

Each slot needs three boxes with distinct uids, so a compiler can never
write into the directory a program later runs from, and a checker never
shares a uid with the program it judges (`docs/OPEN-QUESTIONS.md` item 5):

| Box | Id | Used for |
|---|---|---|
| run | `BASE + N` | one fresh box per test |
| compile | `BASE + 100 + N` | compiling the submission, and compiling a checker |
| checker | `BASE + 200 + N` | one fresh box per checker invocation |
| maintenance | `RECX_SELFCHECK_BOX_BASE` … +9 (default 900–909) | self-check fixtures, calibration, startup credit |
| toolchain verification | 800–899 (`RECX_VERIFY_BOX_BASE`) | `verify-toolchains.sh`, never while it could collide with the above |

`BASE` is `RECX_BOX_BASE` (default 0) and `BASE + RECX_SLOTS ≤ 100`, so slot
boxes stay below 300 and every uid stays inside 60000–60999.

### CPU pinning (production judge hosts)

Timing is per CPU second, so a slot should own one physical core.
`RECX_SLOT_CPUS="2,3,4,5,6,7"` means slot 0 → CPU 2, slot 1 → CPU 3, and so
on. `install-isolate.sh` (with `RECX_SLOT_CPUS` set; cloud-init passes it)
then:

* writes `box<N>.cpus = <cpu>` for slot N's run, compile and checker boxes
  (`BASE+N`, `BASE+100+N`, `BASE+200+N`) — isolate writes it to the box
  cgroup's `cpuset.cpus` (and `box<N>.mems` on multi-NUMA hosts);
* refuses a CPU that is offline, listed twice, or the **SMT sibling** of
  another slot's CPU: siblings of slot CPUs are left idle;
* pins the maintenance boxes (900–909: self-check fixtures, calibration,
  startup credit — re-run every 6 h while slots are judging) to the
  housekeeping CPUs, so a fork loop or a 4 GiB allocation never shares a
  slot's core;
* confines `system.slice` and `user.slice` (the OS, sshd, the worker process
  itself) to the remaining **housekeeping** CPUs with `AllowedCPUs=`
  drop-ins; `isolate.slice` is untouched, so only the boxes run on slot
  cores.

`RECX_SLOT_CPUS="2,4,6" install-isolate.sh --print-config` prints the
configuration without root and without changing anything. The worker gets
the same value in `worker.env` and checks at boot that the isolate config
matches (`cpuPinningMismatches`), warning loudly if slots are not actually
pinned. On the development box `RECX_SLOT_CPUS` is never set and the
configuration is byte-identical to the unpinned one.

Production hosts also run at a fixed CPU frequency (cloud-init, never on a
development machine): `intel_idle.max_cstate=1 processor.max_cstate=1` on the
kernel command line, the `performance` governor on every CPU (the effect of
`cpupower frequency-set -g performance`, written to sysfs by
`recjudge-cpu-tuning.service`), and turbo / boost off. Cloud VMs that expose
no cpufreq interface are logged and left alone — calibration (§10) is what
finally keeps a noisy node off the sensitive lanes.

### Box root on RAM, and why not a tmpfs per slot

The whole `box_root` is one tmpfs (`var-local-lib-isolate.mount`, sized
slots × 3 boxes × 256 MB, `nosuid,nodev`). Teardown is `rm -rf` on RAM and
nothing a submission writes ever reaches disk.

A separate tmpfs per slot box, mounted with that box's uid, is **not
possible** with isolate 2.7: isolate itself `rmtree()`s and recreates
`box_root/<id>` on every `--init` and `--cleanup`, so a mount at that path
makes isolate fail with "Device or resource busy" (verified;
`docs/OPEN-QUESTIONS.md` item 4). The size of one box is bounded instead by
`--fsize` per file, the box's memory cgroup (tmpfs pages a box writes are
charged to it), the size of the shared tmpfs, and — on kernels built with
`CONFIG_TMPFS_QUOTA` (≥ 6.6) — tmpfs user quotas (`isolate --quota`). The
WSL2 development kernel lacks quota support and the worker does not pass
`--quota` yet; enabling it waits on confirming the production judge kernel.

### What a box sees

Every `isolate` command line is assembled by one pure function,
`buildIsolateArgv()`, whose unit tests assert it never emits `--share-net`,
`--full-env`, `--mem`, `--inherit-fds`, `--special-files` or `--tty-hack`.
A run uses `-D` (no default directories) and binds exactly:

| Path in the box | Source | Mode |
|---|---|---|
| `/box` | the box's own directory | read-write, owned by the box uid only during the run |
| `/usr`, `/lib`, `/lib64` (if present), `/bin` | host | read-only |
| `/etc` | `/var/lib/recjudge/etc` — a three-line `passwd` and nothing else | read-only |
| `/proc` | a fresh procfs, remounted `hidepid=2` by isolate | |
| `/dev` | host `/dev`, not recursive | |
| `/opt/toolchains/<id>` | only this job's toolchain(s) (Kotlin: also the JDK; a checker compile: also testlib) | read-only |

There is no `/tmp` and no `/sys` in a box. A runtime that needs a scratch
directory must be pointed at `/box` (Go: §7); a runtime that sizes itself
from `/sys/fs/cgroup` (the JVM, V8) cannot see the box's memory limit and
sizes its heap from host RAM, so a garbage-heavy program meets `--cg-mem`
(MLE) before its own collector would have run — see §7.

* **Network:** each box gets a fresh network namespace whose only interface
  is a loopback that is down; `connect()` fails with `ENETUNREACH` (a
  self-check fixture proves it on every node).
* **Environment:** only the language's fixed variables (from its
  `LanguageConfig`), plus `HOME=/box` and `LANG=C.UTF-8`. `LD_*` variables
  are refused. isolate itself is started with a minimal environment, so the
  node token never reaches it.
* **One fresh run box per test.** isolate keeps one cgroup per box and its
  memory peak and OOM counters are cumulative across runs, so the worker
  re-initialises the run box for every test; MLE and reported memory are
  therefore per test. The compiled artefacts are copied in each time.
* **Input:** only the current test's input is staged (`/box/input.txt`,
  mode 0444). **Expected output never enters the run box**: comparison
  happens in the worker, or in the separate checker box (§7).

---

## 5. Limits

From `LIMITS` in `packages/shared/src/limits.ts`. Kilobytes are KiB
(isolate's unit).

| Resource | Value | Mechanism | Breach |
|---|---|---|---|
| CPU time | per problem and language (below), clamped to 200 ms – 15,000 ms | `--time` (CPU time is authoritative) | TLE |
| Extra time | 0.5 s | `--extra-time`, so an overrun is measured, not just killed | TLE |
| Wall time | `ceil(2.5 × CPU limit) + 2 s`, at most 30 s | `--wall-time` (a safety net, e.g. 1 s → 5 s, 2 s → 7 s) | TLE (admin-visible `idle` flag when the CPU was idle) |
| Memory | default 262,144 KB (256 MiB), ceiling 1,048,576 KB (1 GiB); per language when measured | `--cg-mem` — never `--mem` / `RLIMIT_AS`, which breaks the JVM, Go and Node before `main()` | MLE |
| Stack | equal to the memory limit (≤ 1 GiB) | `--stack`, so deep recursive DP does not spuriously crash | RE (SIGSEGV) or MLE |
| Processes | native 1, managed runtimes 64, ceiling 128 | `--processes` (RLIMIT_NPROC + pids.max) | RE |
| Open files | native 64, managed 256, ceiling 1,024 | `--open-files` | RE (EMFILE) |
| Output file size | default 65,536 KB (64 MiB), ceiling 262,144 KB | `--fsize` → SIGXFSZ | OLE |
| Early output trip | `min(64 MiB, 2 × expected output + 1 MiB)`, polled every 200 ms | the supervisor kills the cgroup | OLE |
| Captured stderr | 8 KB default, 64 KB ceiling | supervisor | truncated |
| Scratch disk | 256 MB and 512 files of compiled artefacts | artefacts beyond that are refused (CE); run-time writes are bounded by `--fsize` per file and the box's memory cgroup | CE at compile time; at run time the failed write (usually RE) or MLE |
| Core dumps | 0 | `--core=0`; host `kernel.core_pattern` pipes to `/bin/false` | — |
| Source | 256 KB default, 512 KB ceiling | zod at submit + DB `CHECK` | rejected before judging |
| Compile | CPU 10 s (25 s for slow toolchains: Kotlin, checkers), wall 20 s (40 s), memory 1 GiB, 64 processes, files 128 MiB, output 8 KB | compile box | CE |
| Checker | CPU 10 s, wall 20 s, memory 512 MiB, 1 process, report 4 KB captured (500 B stored) | checker box | checker FAIL (§7) |
| Custom run (Run button) | CPU ≤ 5 s, stdin ≤ 64 KB, stdout ≤ 64 KB, stderr ≤ 8 KB, kept 24 h | | |
| Visible-case detail | ≤ 4 KB per test, ≤ 32 KB per submission, purged after 30 days; hidden tests never get detail | | |
| Sample diff | 256 bytes; hidden tests get no diff at all | | |
| Inline blob | test data ≤ 64 KB is stored in the database row; larger in object storage | | |

### Per-language time limits (measured)

Every problem version is validated before publish (job kind `validation`,
REJUDGE lane, never scored; `apps/web/src/lib/judge/validation.ts`):

1. Every model solution (expected AC) runs at the 15 s ceiling, so it is
   *measured*, not cut off; all must be AC, and a C++ model is mandatory.
2. A `ProblemLanguageLimit` row is frozen with the version for every enabled
   language (`deriveTimeLimitMs`, `packages/shared/src/limits.ts`):
   * with a measured model solution in that language:
     **TL = clamp(ceil₁₀₀ ms(max(2.5 × slowest model test, base C++ TL)), 200 ms, 15 s)**;
   * without one, the catalog's fallback:
     **TL = clamp(ceil₁₀₀ ms(base × multiplier + extra), 200 ms, 15 s)**
     (CPython ×5 + 1 s, PyPy ×2 + 300 ms, Java ×2 + 300 ms, Kotlin ×2 + 500 ms,
     Node.js ×2.5 + 150 ms, Go ×1.5, C/C++ ×1).
3. Every deliberately-wrong solution then runs at those limits and must
   produce its expected verdict (a brute force must TLE, a wrong answer must
   WA). Publishing is blocked unless everything matched.

At claim time the claiming node's **startup credit** for the language is
added: the median CPU ms of a hello-world run 20 times
(`LIMITS.startupCredit.runs`) in its sandbox at worker boot, reported in
every heartbeat (`startupMs`). A managed runtime's fixed start-up (JVM, PyPy,
Node) is therefore never charged against a student's solve time, and it is
the node's own measurement, not a guess. Runs are additionally capped at
5 s.

### Per-user judge caps

`LIMITS.userCaps`, enforced in the submit / run actions under a per-user
advisory lock (`apps/web/src/lib/judge/caps.ts`):

| Cap | Default | Overridable |
|---|---|---|
| in-flight submissions | 2 | no |
| in-flight runs | 1 | no |
| practice submissions per day (Asia/Kolkata) | 300 | yes |
| runs per hour (trailing) | 60 | yes |
| judge CPU per day | 20 CPU-minutes (sum of per-test CPU, charged at finalise) | yes |

A super-admin may grant a per-user `JudgeQuotaOverride` (audited
`judge.quota.override`, with a reason and an optional expiry).

---

## 6. Compilation

* **Its own box, offline.** Compilation runs in the slot's compile box
  (separate uid), with the same no-network namespace as a run.
* **Fixed flags.** Compiler and run command lines are fixed server-side in
  the `LanguageConfig` row (seeded from the catalog). Students can never
  add flags, environment variables or extra files. The worker refuses any
  program path outside the job's own `/opt/toolchains/<id>` directories.
  Interpreted languages get a syntax check that maps to CE exactly like a
  C++ typo (Python `compile()`, Node `--check`); PyPy has no compile step.
* **Sanitised output.** Diagnostics pass through `sanitizeToolOutput()`
  before they leave the judge host: `/opt/toolchains/<id>` becomes
  `<toolchain>`, `/box/` is stripped, every other absolute host path becomes
  `<system>/<basename>`, version banners are collapsed, and the text is cut
  to 8 KB on a UTF-8 boundary. For FUNCTION-mode problems, compile errors and
  runtime traces are first remapped to the student's own code
  (`remapDiagnostics()`, §7 "FUNCTION problems"), then sanitised, then the
  plain-language hints are appended.
* **Resource exhaustion is a CE, not an IE.** A compile killed for time,
  memory or a signal (a template-instantiation bomb, a huge constant table)
  is a statement about the source: CE with "compilation exceeded resource
  limits" and `resourceExceeded: true`. Only `status:XX` from the compile box
  is infrastructure.
* **Compile cache** (`apps/judge-worker/src/compile-cache.ts`). Worker-local,
  shared by Run, Submit and validation jobs on the node, so a Submit after a
  Run of the same code skips the compiler. The key is the sha256 of
  everything that decides the output — language, toolchain ids and version,
  the fixed compile argv and environment, the source file name and the exact
  (harness-wrapped) source; checkers have their own key (source sha256 +
  toolchains + flags). Entries are written atomically, re-verified against
  their sha256 on every read (a damaged entry is deleted and missed), live
  1 h from creation, and are evicted least-recently-used within 5 GB
  (`LIMITS.compileCache`). Only successful compiles are cached: a CE
  is always recompiled. Toolchain directories are immutable, so an entry is
  never stale for correctness.

---

## 7. Toolchains, comparison and scoring

### Pinning

Toolchains live at `/opt/toolchains/<id>/`, root-owned and read-only, bound
read-only into the boxes that need them. Each is either built from a
GPG-verified upstream tarball, or installed from the vendor's release
artefact whose sha256 is pinned in the script **and** cross-checked against
the checksum the vendor publishes next to it
(`infra/judge/toolchains/`, `docs/OPEN-QUESTIONS.md` item 10). Every script
is idempotent (a verified, installed toolchain is skipped). The vendor
`install-*.sh` scripts also stage next to the final path and rename into
place — a worker offers a language as soon as its directory exists, so a
half-installed directory must never appear — and record their source in
`<id>/.recx-provenance`.

**An upgrade is a new directory plus a new `LanguageConfig` row** (the new
row becomes `isCurrent`; the old one is kept). It is never an in-place change,
so a 2026 submission rejudges byte-identically in 2029 on the toolchain it was
judged with.

| Language | Toolchain (`/opt/toolchains/…`) | Source and verification | Catalog |
|---|---|---|---|
| C17, C++17, C++20 | `gcc-13.2.0` (`-O2 -static`, static glibc from the host) + precompiled `<bits/stdc++.h>` for `-std=c++17`/`-std=c++20 -O2` | GNU tarball, GPG (`build-gcc.sh`, `build-gcc-pch.sh`) | C++20 enabled; C17, C++17 off |
| Python 3.12 | `cpython-3.12.6` + numpy 1.26.4 | python.org tarball, GPG (`build-cpython.sh`) | enabled |
| Java 21 | `temurin-21.0.4+7` + AppCDS archive `lib/recx-appcds.jsa` | Adoptium tarball + its `.sha256.txt` (`install-temurin.sh`) | off |
| Kotlin 2.0 | `kotlin-2.0.21` (runs on the Temurin JDK) | JetBrains GitHub release zip + its `.sha256` (`install-kotlin.sh`) | off |
| PyPy 3.10 | `pypy-7.3.17` (stdlib byte-compiled at install) | downloads.python.org + pypy.org/checksums.html (`install-pypy.sh`) | off |
| JavaScript | `node-22.11.0` (npm/npx/corepack removed) | nodejs.org tarball + `SHASUMS256.txt` (`install-node.sh`) | off |
| Go 1.23 | `go-1.23.2` + prebuilt standard library + `bin/recx-go-build` | go.dev tarball + go.dev's published sha256 (`install-go.sh`) | off |
| Rust 1.80 | `rust-1.80.0` (rustc + std only: no cargo, rustup, clippy or rustfmt); links through `gcc-13.2.0` | static.rust-lang.org tarball + its published `.sha256` (`install-rust.sh`) | off |
| C# 8 | `dotnet-10.0.403` (.NET 10 LTS runtime, C# LANGUAGE version pinned to 8.0; `bin/recx-cs-build` calls `csc.dll` directly, no MSBuild or NuGet) | builds.dotnet.microsoft.com tarball + the sha512 Microsoft's release metadata publishes, re-checked at install time (`install-dotnet.sh`) | off |
| (checkers) | `testlib-0.9.41/testlib.h` | github.com/MikeMirzayanov/testlib tag 0.9.41 = commit `68f9f300b6ab…`, file sha256 pinned (`install-testlib.sh`) | testlibId `testlib-0.9.41` |

Since Phase 4 the FUNCTION-mode harness covers C++ (cpp17, cpp20), Python
(py312, pypy310) and Java (java21) — §7 "FUNCTION problems". Java ships its
harness but stays off by default (enabling it also needs Java model solutions
for the STDIN seeds). C, JavaScript, Go, Kotlin, Rust and C# have no FUNCTION
harness; they stay off by default even though their toolchains ship, and a
FUNCTION problem never offers them.

**Rust (Phase 12o) is `rustc` and nothing else.** One file in, one STATIC
binary out: `--edition 2021 -O -C target-feature=+crt-static -C
linker=…/gcc-13.2.0/bin/gcc -C codegen-units=1`. Static because a box mounts
the toolchain read-only and nothing else, so a dynamically linked program
could not find libc; through gcc because rustc does its final link with a C
compiler and the box has no system one, which is why `gcc-13.2.0` is an extra
toolchain for `rust180` exactly as Temurin is for `kotlin20`. Cargo is not
installed: it would want a writable `CARGO_HOME` and a network, and a judge
submission is a single file. `install-rust.sh` runs the catalog's own compile
argv at install time and refuses to finish unless the result is static and
prints the expected line.

**C# (Phase 12o): the key is the LANGUAGE, the directory is the RUNTIME.**
SPEC §11 asks for `cs8`, so the compiler is pinned to `-langversion:8.0` and a
submission means in 2029 what it meant in 2026. The runtime underneath is .NET
10, the current LTS, because .NET 8 leaves support on 2026-11-10 and a judge
host should not ship a runtime that stops getting security fixes; C# 12 would
be a NEW key and a NEW directory, never an in-place change to this one. The
compile step is `bin/recx-cs-build`, written by the installer, for the same
reason Go has `recx-go-build`: it runs `dotnet exec …/Roslyn/bincore/csc.dll`
with a response file that already names every framework reference assembly
(resolved once, on the host) and then writes `main.runtimeconfig.json`, which
is what makes the produced `main.dll` runnable. MSBuild and NuGet are never
invoked — both want a writable home, a lock file and a network, and a
submission is one file. The environment finishes the story: `DOTNET_CLI_HOME`
and `TMPDIR` are `/box` because that is the only writable place,
`DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=1` because the box has no ICU data,
`DOTNET_EnableWriteXorExecute=0` because W^X JIT pages need a double mapping
the sandbox does not grant, `DOTNET_EnableDiagnostics=0` because there is
nothing in a box to attach a debugger with and the diagnostic server would
open a socket under `TMPDIR`, and telemetry is off because there is no
network to send it to.

`infra/judge/toolchains/verify-toolchains.sh` compiles and runs a hello-world
for every catalog language **inside isolate**, with the catalog's exact argv
and environment and the worker's own `buildIsolateArgv` / `compileLimits` /
`runLimits` (boxes 800–899), checks every toolchain directory is root-owned
with nothing writable, that the Java AppCDS archive maps inside a box
(`-Xshare:on`), that the Go binary is static, and that a testlib checker
built with the worker's checker argv returns the expected exit codes.
cloud-init runs it before a new host's closing reboot, and CI runs it in the
judge-integration job. Findings of the first run (2026-10-10):

* **Python + numpy needs `OPENBLAS_NUM_THREADS=1`.** numpy's OpenBLAS starts
  one thread per host CPU at import; under the native process limit of 1
  every `pthread_create` fails and the interpreter dies with SIGSEGV, so any
  submission that imports numpy is judged RE. With the variable set the same
  program passes (112 ms CPU, 34 MB including the numpy import). The fix is
  one entry in the `py312` catalog environment.
* **Go cannot use `go build` in a box.** The Go command takes a `flock()` on
  its build cache, which `syscall_flags` bit 4 blocks (`go: failed to trim
  cache: … function not implemented`), it needs a temporary directory (there
  is no `/tmp`; `GOTMPDIR=/box` fixes that part), and a fresh box has a cold
  cache, so even with locks allowed each compile rebuilds the standard
  library: 7.2 s CPU and 280 MB measured, against a 10 s compile cap.
  `install-go.sh` therefore prebuilds the standard library into the
  toolchain and installs `bin/recx-go-build` (`go tool compile` + `go tool
  link` against it, no cache, no lock): 0.11–0.15 s CPU, static binary, passes in
  a box. The catalog's `go123` compile argv must call it before Go is
  enabled.
* **Java:** the AppCDS archive maps inside a box; hello-world CPU 73–90 ms
  with it, 92–130 ms with `-Xshare:off`.
* **Kotlin compiles slowly:** 10–11 s CPU (4.3–4.8 s wall) for hello-world on the
  development machine, inside the 25 s slow-compile cap but with little
  margin on a slower production core.
* **testlib exit codes** under the worker's checker flags: ok → 0, wa → 1,
  `_pc(37)` → 53, fail → 3.

### Managed runtimes and memory

The JVM and V8 size their heaps from what they believe the machine has. A box
has no `/sys`, so they cannot see the box's cgroup limit and assume host RAM;
a program that allocates garbage quickly reaches `--cg-mem` (MLE) before the
collector runs hard.

**JVM (java21, kotlin20), since Phase 4:** the worker inserts
`jvmRunFlags(memoryLimitKb)` (`@recx/shared`) right after the `java` program
of every run (`runArgv()`, `apps/judge-worker/src/judge/limits.ts`):

| Flag | Value (MB = the job's memory limit in MiB) | Why |
|---|---|---|
| `-Xmx` | max(32, ⌊0.7 × MB⌋) MiB — 179m at the 256 MiB default | the heap fills, and the JVM throws `OutOfMemoryError` (→ MLE, §5) before the cgroup kills it; the rest is left for metaspace, code cache and thread stacks |
| `-Xss` | min(MB, 256) MiB — 256m at the default | the main thread's stack, so deep recursion behaves like the native languages' stack = memory rule |

The flags are fixed server-side, never influenced by the student, and
published on `/judge`. Node (`--max-old-space-size`) has no such ceiling
yet: allocation-heavy JavaScript can still see MLE where a native judge
would not (an open item before enabling Node).

### Compare modes

Comparison of a test's output runs in the worker on raw bytes
(`apps/judge-worker/src/judge/compare.ts`), or in the checker box:

| Mode | Rule |
|---|---|
| `TOKEN` (default) | the whitespace-separated token sequences are equal; any run of spaces, tabs and newlines is one separator; leading and trailing whitespace is ignored |
| `EXACT` | byte-for-byte equality |
| `FLOAT` | token by token; a numeric expected token matches a numeric actual token within the absolute **or** relative epsilon (`floatEpsilon`, default 1e-6); non-numeric tokens must match exactly |
| `CHECKER` | a testlib-compatible checker (below) |
| `INTERACTIVE` | not available: a job that asks for it is released **permanently** (§9) |

There is no PE verdict: presentation differences fold into WA, and the
problem page explains the whitespace policy instead.

### FUNCTION problems: harness and comparators

A FUNCTION problem gives the student a method to write
(`class Solution { … methodName(params) … }`) instead of a program. Its
signature uses a closed type grammar (`int long double bool char string
list<T> matrix<T> pair<A,B> TreeNode ListNode void`), validated by
`functionSignatureSchema` (`packages/shared/src/harness/signature.ts`).
Values travel LeetCode-style: one JSON value per input line, trees in level
order with nulls. The harness templates live in the repository
(`packages/shared/src/harness/`), never in the database — a harness bug is
fixed by a deploy and a rejudge.

**The harness.** The worker wraps the student's code, verbatim, between a
short prelude and a generated driver, and compiles the result like any
program:

| Family | Languages | Program | Student code starts at |
|---|---|---|---|
| C++ | cpp17, cpp20 | `main.cpp`: `<bits/stdc++.h>`, `using namespace std;`, the node structs; driver = a JSON reader/writer (`recx_harness`) and `main()` | line 3 (+ node structs) |
| Python | py312, pypy310 | `main.py`: `typing`, common imports, the node classes; driver = typed converters and `_recx_main()` | line 4 (+ node classes) |
| Java | java21 | `Main.java`: five import lines only (so the student's own `import` lines stay legal); driver = `ListNode`/`TreeNode`/`record Pair` when used, `RecxIn`/`RecxOut` (a dependency-free JSON reader/writer) and `public class Main` | line 6 |

Java types: `int[]`, `long[]`, `String[]`, `TreeNode[]`… for a list of
scalars or nodes, `S[][]` for such a matrix, `List<…>` / `List<List<…>>` for
any other list or matrix, `Pair<A, B>` (boxed) for a pair. Java calls the
method through a typed local, so a wrong return type is a compile error; C++
calls it through `auto`. The driver reads every parameter before calling
the method, then prints exactly one line: the return value — or, for
IN_PLACE_MUTATION, the named parameter after the call. A null `TreeNode` /
`ListNode` prints `[]`.

**Structured comparison (protocol 3).** For EVERY FUNCTION problem the
worker decodes the expected answer and the program's stdout strictly against
the compared type (`packages/shared/src/harness/compare.ts`) — never token
by token: ints and longs exactly (BigInt), doubles as numbers, strings after
JSON unescaping (so `"a b"` never equals `"a  b"`), trees rebuilt in level
order, `null` = `[]` for nodes. Then the comparator decides:

| Comparator | Rule | Compared type must be |
|---|---|---|
| `EXACT` | structural equality | free of doubles |
| `FLOAT_TOLERANCE` | structure exact; each double within the absolute **or** relative `floatEpsilon` (default 1e-6) | containing a double |
| `SET_EQUAL` | multiset equality, order ignored at every list/matrix level; pairs ordered; strings, trees, linked lists exact | a list or matrix, no doubles |
| `ROWS_ANY_ORDER` | top-level rows in any order; each row exact | a matrix, or a list of lists or pairs, no doubles |
| `IN_PLACE_MUTATION` | EXACT on the named parameter after a `void` call | a list, matrix, TreeNode or ListNode parameter; the method returns `void` |
| `CUSTOM_CHECKER` | the output is decoded strictly, re-serialised canonically and handed to the version's testlib checker as `output.txt` (`input.txt` = the parameters, `answer.txt` = the jury answer, both verbatim) | anything but `void` |

Output that does not decode — nothing printed, extra printed lines (debug
prints on stdout), `NaN`, a long out of range, the wrong shape — is WA; under
CUSTOM_CHECKER the checker never runs for it. Visible tests and validation
jobs carry the reason in the test's message; hidden tests carry nothing
(§8). An expected answer that does not decode is the problem's bug: the job
is released permanently (§9). The version's `compareMode` must mirror the
comparator — CHECKER exactly for CUSTOM_CHECKER, TOKEN otherwise — or the
job is refused permanently; a frozen version cannot break this rule or lack
a comparator (CHECK constraints, migration
`20261010100100_function_comparator_checks`). `checkerTemplate(sig)` emits a
complete testlib checker that reads values with the harness's own C++
reader, for authors to fill in.

**Custom input.** The Run button's custom input for a FUNCTION problem is
validated before anything is queued: one line per parameter, each a valid
value of its type (JSON whitespace allowed), or the action names the line
and the parameter that is wrong.

**Compile errors and traces point at the student's code.** Because the
student's code sits verbatim inside the program, `remapDiagnostics()`
(`packages/shared/src/harness/remap.ts`) maps every location in it to
`solution.cpp:N` / `solution.py", line N` / `Solution.java:N`, and labels a
location in the generated code `[generated driver code]`. It drops
generated-code notes, "required from" lines, instantiation banners, include
chains, excerpts and caret lines of generated code, harness stack frames
(Python, JVM), and the line numbers of library files; no output line ever
shows a line number outside the student's own range (a property test).
gcc's `In function 'int main()'` becomes "In the judge's code that calls
your function:", javac's `location: class Main` likewise. Hints are appended
once each: the signature hint whenever the judge's code is named, plus hints
for a student-written `main()`, a `public class Solution`, a redefined
`ListNode` / `TreeNode` / `Pair`, reading standard input, and an unclosed
bracket.

**The golden gate.** `apps/judge-worker/test/integration/golden.isolate.test.ts`
judges every seeded problem's reference solutions on real isolate in every
enabled-by-default language plus `RECX_GOLDEN_EXTRA_LANGUAGES` (`java21` in
`scripts/dev/linux-gate.sh`): model solutions AC on every test,
deliberately-wrong ones their expected verdict; a missing toolchain fails
the gate.

### Checkers (testlib)

A `CHECKER` problem version carries the checker's source sha256 and a pinned
`testlibId` (`testlib-0.9.41`). The worker (`apps/judge-worker/src/judge/checker.ts`):

* **Compiles** it in the slot's compile box with the pinned GCC as C++20:
  `g++ -std=c++20 -O2 -pipe -static -s -DPC_BASE_EXIT_CODE=16 -I
  /opt/toolchains/testlib-0.9.41 -o checker checker.cpp` (slow-compile
  limits). The binary goes into the compile cache, so a checker compiles once
  per node per hour, not once per submission.
* **Runs** it per test in the slot's **checker box** (`BASE+200+N`, its own
  uid, a fresh box and cgroup per invocation) as
  `./checker input.txt output.txt answer.txt`, all three staged read-only.
  The contestant's program never sees `answer.txt`: run box and checker box
  are different boxes with different uids.
* **Maps the exit code:**

  | Exit | testlib | Verdict |
  |---|---|---|
  | 0 | `_ok` | AC |
  | 1 | `_wa` | WA |
  | 2 | `_pe` | WA (there is no PE verdict) |
  | 3 | `_fail` — the checker found a bug in the test or the answer file | **never WA**: a checker FAIL is the problem's bug, released permanently with the checker's first line, and an admin is alerted |
  | 16 … 116 | `_pc(n)`, n = 0…100 (testlib's partial-credit base is pinned to 16 at compile time) | n/100 of the test's points: PARTIAL; n = 100 → AC; n = 0 → WA |
  | 7 (`_points`), anything else, a crash, or the checker's own limits | | checker FAIL (permanent release) |

* The checker's report (sanitised; 4 KB captured, 500 bytes stored — the protocol's
  message field allows 512) becomes the test's message only
  for visible tests and validation jobs; a hidden test carries nothing about
  its output beyond verdict, time and memory.

### Scoring

* **ICPC** (default): tests run in index order. With `stopOnFirstFailure`
  (the default) the first failing test ends the run, the rest are `SKIPPED`,
  and the verdict is that test's verdict ("Wrong Answer on test 7"). Score is
  1 or 0; checker partial credit counts as WA here.
* **PER_TEST**: score = Σ points × fraction (fraction 1 for AC, n/100 for
  checker partial credit, else 0); a test without points weighs 1.
* **SUBTASK**: subtasks run in dependency order (ties by index):
  * a subtask whose `dependsOn` subtasks were not all fully passed is
    `SKIPPED` — none of its tests run and it earns 0;
  * `MIN`: the subtask earns points × the smallest test fraction (with
    `stopOnFirstFailure`, a test earning nothing ends that subtask);
  * `SUM_FRACTION`: points × (sum of test fractions) / number of tests;
    every test runs;
  * a `{type:"subtask"}` progress event follows each subtask, and the result
    carries one `{index, earned, max, verdict}` per subtask.
* PER_TEST and SUBTASK verdict: AC when score = maxScore, PARTIAL when
  0 < score < maxScore, otherwise the worst failing verdict. The result
  carries `score`, `maxScore` and `cpuMs` (the sum of per-test CPU, charged
  to the user's daily budget; compile and checker time are the platform's).
* The **Run** button is feedback, not scoring: it runs every visible case,
  never stops early, and has no score.

---

## 8. What a student learns about a test

* **Hidden tests:** index, verdict, CPU ms and memory KB. Nothing else — no
  stdout, stderr, diff, input, expected output or checker message. The web
  app drops any other field for a hidden test even if a worker sends one
  (`apps/web/src/lib/judge/truncate.ts`).
* **Samples and custom runs:** truncated output and a short diff (§5).

**Expected-output secrecy is a hard guarantee.** Expected output never
enters the box the student's program runs in, is compared outside it (or by
the checker in a separate box and uid), and is never returned for a hidden
test.

**Input secrecy is best-effort.** A program is handed its input and can
print it. Hidden stdout is never shown, but a program can still leak a few
bits per submission through its verdict, time or memory (exit with an error
when the first number is odd; sleep when it is large). Where input secrecy
matters — an assessment whose test data must stay unknown — generate
per-attempt test data rather than relying on hidden inputs staying hidden.

---

## 9. Retries and failure

* **Deterministic verdicts are never retried.** AC, WA, TLE, MLE, RE, CE,
  OLE, PARTIAL and SKIPPED are statements about the code.
* **Infrastructure failures only** (isolate `XX`, a blob that fails its
  hash, a missing toolchain on this node, a crashed or unreachable worker):
  the worker calls `release`, or its lease simply expires and the reconciler
  reclaims it. At most **3 attempts** (`JUDGE_RETRY`, exponential backoff
  from 2 s). After the third, the row becomes `INTERNAL_ERROR` with verdict
  IE, is excluded from scoring, and the event is audited.
* **Permanent release.** When no node could ever judge the job — an
  unsupported compare mode (`INTERACTIVE`), a malformed spec or subtask
  table, a checker that does not compile, a checker FAIL — the worker
  releases it with `permanent: true` and a reason, and the web app finalises
  INTERNAL_ERROR at once (audited `judge.<kind>.permanent_failure`) instead
  of spending three attempts on it. The reason is admin-visible; the student
  sees an internal error, never a wrong answer.
* **Node health:** heartbeat every 5 s; a node silent for 20 s goes OFFLINE
  and its leases are reclaimed in the same reconciler tick (every 10 s). A
  node whose releases reach 3 in a row is drained automatically
  (`DRAINING`, audited); a failed self-check or hardening check quarantines
  it (§10). See `docs/RUNBOOK.md` → "Judge node lifecycle".

---

## 10. Node health: hardening, self-check, calibration

The worker's boot order (`apps/judge-worker/src/main.ts`):
**config → mock/production guards → host hardening → driver → self-check →
calibration → startup credit → heartbeat → lane allocator.** The allocator
starts only after an ONLINE heartbeat with a non-empty lane list, and only if
the node is cleared for intake.

### Host hardening

At boot the worker reads `/proc/sys` for the exact values in
`infra/judge/sysctl/99-recjudge.conf` plus `kernel.modules_disabled = 1`, and
`/proc/modules` for the blacklisted modules in
`infra/judge/modprobe/recjudge-blacklist.conf`
(`apps/judge-worker/src/hardening.ts`). A setting that is missing or
unreadable is a failure: unverifiable is not hardened. The result rides every
heartbeat (`hostHardening`). In production a node that fails takes no jobs
and the web app quarantines it.

**The development-only override.** A WSL2 development kernel cannot be
hardened (it lacks `kernel.unprivileged_userns_clone`, uses its own
`core_pattern`, and module loading stays on). Two switches, both refused with
`NODE_ENV=production`, let a development box judge anyway:

* worker: `RECX_DEV_ALLOW_UNHARDENED_HOST=1` — take jobs despite the failed
  check, with a loud warning;
* web app: `JUDGE_ALLOW_UNHARDENED_NODES=true` — do not withhold the
  sensitive lanes from an unhardened node (needed to exercise ASSESSMENT and
  CONTEST locally, e.g. with the capacity burst).

`infra/judge/verify-host.sh` (the same settings, run by systemd as root
before every start) remains the first gate on a real judge host.

### Self-check

Twelve adversarial C fixtures (`apps/judge-worker/src/selfcheck/fixtures.ts`)
run through the real sandbox at boot and every 6 h, in the maintenance boxes.
Each either prints SAFE (the attack failed) or must trip the expected
resource verdict; anything else means the containment this node promises is
not in force:

| Fixture | Expected |
|---|---|
| `fork()` loop under the process limit | RE, and the host is clean afterwards (no stray box-uid process, cgroup gone) |
| `while(1) putchar` | OLE (early trip) |
| 4 GiB allocation, pages touched | MLE |
| `fallocate` 10 GiB | SAFE |
| `socket()` + `connect()` out and to loopback | SAFE |
| `open("/etc/shadow")` | SAFE |
| `ptrace(PTRACE_ATTACH)` | SAFE |
| read `/proc/1/environ` | SAFE |
| `setuid(0)` | SAFE |
| 3-hour sleep | TLE with the idle flag (wall-time net) |
| `io_uring_setup` | SAFE |
| read another box / escape via `..` | SAFE |

A failed self-check stops intake at once (the node keeps heartbeating its
failures) and the web app quarantines the node (audited
`judge.node.quarantined`, SECURITY). A self-check older than 6.5 h withholds
the sensitive lanes.

### Calibration

A fixed 10⁹-iteration integer benchmark (~1 s on a modern core,
`apps/judge-worker/src/calibration.ts`) runs through the sandbox three times
at boot and every 6 h; the score is the median of work units per CPU second
(higher is faster). The node reports `calibrationScore` and `calibratedAt`;
the **web app** compares it with the median of every ONLINE node and
withholds ASSESSMENT and CONTEST from a node more than 10 % off
(`LIMITS.calibration.maxDeviation`) — a slow or noisy host can still serve
practice and runs, never a graded sitting. Each stored result records the
node and its calibration score at the time (`Submission.judgeNodeId`,
`calibrationScore`).

---

## 11. Determinism caveats

* **There is no promise of deterministic timing.** CPU time varies with the
  host, CPU frequency scaling, cache and memory-bandwidth contention, SMT
  siblings and kernel version. Two runs of the same program can differ by
  several percent; a submission within a few percent of the limit can pass
  on one run and fail on the next.
* **Mitigations:** CPU time (not wall time) is authoritative; time limits are
  **≥ 2.5×** the slowest measured model solution in that language (§5), so
  ordinary jitter never decides a verdict; each slot owns a physical core
  with its SMT sibling idle, at a fixed frequency (§4); calibration keeps
  outlier nodes off graded lanes (§10); runtimes are pinned single-threaded
  where they allow it (`GOMAXPROCS=1`, `-XX:ActiveProcessorCount=1`,
  `-XX:+UseSerialGC`) and hashing is fixed (`PYTHONHASHSEED=0`); the startup
  credit is measured per node.
* **Every result is attributable.** Each stored result records the node
  that produced it and that node's calibration score at the time, so a timing
  dispute can be checked against the node and resolved by a rejudge on
  another node.

---

## 12. Host verification

`infra/judge/verify-host.sh` prints every required kernel setting with its
expected and actual value and exits non-zero if any is wrong, missing or
unreadable; `recjudge-worker.service` runs it as root before every start.
It checks the 13 keys in `infra/judge/sysctl/99-recjudge.conf` and
`kernel.modules_disabled = 1`, which `recjudge-modules-lock.service` sets
last in boot (after nftables, chrony, isolate and the box-root mount have
loaded their modules; before the worker). It is expected to fail on the
WSL2 development kernel: the development box is not a judge host.

The worker unit runs as the dedicated `recjudge` user without
`NoNewPrivileges=`, because `isolate` is setuid root and the kernel ignores
the setuid bit under no-new-privileges (verified: isolate then refuses with
"Must be started as root"). The unit file documents every systemd setting
left out for the same reason and the kernel-level control that covers it.

---

## 13. The public /judge page

`/judge` (`apps/web/src/app/(public)/judge/page.tsx`, Phase 4) publishes
how a submission is compiled, run and judged, to anyone: it is reachable
signed out (signed-in viewers get the normal app chrome through
`components/shell/public-shell.tsx`, shared with `/u/[handle]`). It calls no
guard because it reads nothing private: only the enabled, current
`LanguageConfig` rows (five fields: key, label, version, toolchainId,
runtime) and constants from `@recx/shared`. No user, node, problem or test
data.

**Every value is derived, never copied.** The view model is
`apps/web/src/lib/judge/transparency.ts` (pure):

| Section | Source |
|---|---|
| Languages (`#lang-<key>`) | each row's `runtime` JSON, the same JSON the worker receives at claim time: version, toolchain directories, source file, compile argv (shell-quoted) with the compile caps chosen by `compile.slow`, run argv, the environment (the language's variables, then `SANDBOX_FORCED_ENV` = HOME and LANG, in the order `buildIsolateArgv` applies them), processes, open files. JVM languages also show the memory-derived flags from `jvmRunFlags()` that the worker inserts after the `java` program, for the default and the ceiling memory limit |
| Time limits | the measured rule and the fallback rule from `LIMITS.timeLimit` / `cpuTime`; each row's `fallbackMultiplier` and `fallbackExtraMs`, with a worked example from `deriveTimeLimitMs`; the start-up credit (`startupCredit.runs`, capped at `startupCredit.maxMs`) |
| How TLE is measured | `LIMITS.extraTimeSec`, `wallTime` with `wallTimeSecFor()` examples, `calibration.maxDeviation` as the flip margin (§11) |
| Memory, output | `LIMITS.memory`, `outputFile`, `earlyOle`, `stderrCapture`, `detail`, `customRun`; the garbage-collector caveat is shown only for an enabled managed runtime with no memory-derived heap ceiling (Node.js, Go) |
| Verdicts | `RUN_OUTCOME_RULES` (`packages/shared/src/verdict.ts`): the per-test classification order, which `classifyRun()` follows (bound by `apps/judge-worker/test/verdict-rules.test.ts`, over every combination of an isolate-meta grid); `VERDICT_PRECEDENCE` |
| Every limit | one row per enforced `LIMITS` field: value, mechanism, what happens when it is reached |

**Only enforced limits are published.** A `LIMITS` field that nothing
enforces is left off the page: `scratchDisk.inodes` (there is no per-slot
tmpfs, §4). `startupCredit.maxMs` is published because
`startupCreditFor()` in `apps/web/src/lib/judge/claim.ts` now caps a node's
reported credit with it (Phase 4; before that the cap was declared but not
applied).

**Prose that is not derived** must be changed by hand when the behaviour it
describes changes: the ICPC / per-test / subtask aggregation summary
(`apps/judge-worker/src/judge/aggregate.ts`), the sandbox paragraph (§4),
"memory is the problem's limit for every language", and the run-outcome
rule texts (`RUN_OUTCOME_TEXT`, exhaustive by type: a new rule does not
typecheck until it has its prose).

**Freshness.** `getPublicLanguageRows()`
(`apps/web/src/server/queries/judge-languages.ts`) is an `unstable_cache`
tagged `language-config` with a 60-second backstop. `setLanguageEnabled`
calls `revalidateLanguageConfigs()` after its audit row; every future
`LanguageConfig` writer must do the same. The page is `force-dynamic` (the
build never prerenders it or touches the database); a database failure
still renders every constant section with a notice that the language list
is unavailable. `/help` reads the same rows through the same view model and
links here.

**Workspace footer.** The editor footer shows the active language's label
plus `LanguageConfig.version` when the label does not already carry it,
linked to `/judge#lang-<key>` in a new tab so the editor is never left. The
contest arena and assessment attempt surfaces pass `judgeLink={false}`.

**No client JavaScript of its own.** The page and everything it imports
are server components (`apps/web/test/judge-page-imports.test.ts`), and
`scripts/size-budget.mjs` checks the production build: under
`serverRendered`, the page's chunks beyond the framework and its layout
chain may hold only Next's page stub. `/judge` also has a first-load budget
and is on the Monaco-free list.

**Tests.** `judge-transparency.test.ts` (quoting, units, ordering, the
environment rule, enforced-only limits), `judge-page.test.ts` (the exact
query, every rendered value, rule and precedence order, database failure),
`judge-page.canary.test.ts` (sentinel `LIMITS`, a reversed precedence and a
canary row must all show, so nothing is hard-coded),
`judge-languages.test.ts` (cache key, tag, revalidation after the audit),
`language-version.test.ts`, `public-shell.test.ts`, and
`e2e/judge-page.spec.ts` (signed out 200, the footer link reaches its
anchor).
