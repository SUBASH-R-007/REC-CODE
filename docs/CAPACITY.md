# REC Code — Capacity planning

How many judge slots, and how many judge hosts, a given load needs. The
planning model in §2–§4 is an engineering estimate; §6 is where measured
numbers go, each with its date and method. Until §6 is filled from a real
burst run, treat every figure on this page as a plan, not a promise.

---

## 1. The unit: a judge slot

A **slot** is one concurrent judging lane on a judge host: one run box, one
compile box and one checker box (`docs/JUDGE.md` §4), working on one job at
a time, pinned to one physical core on a production host. Judging capacity is
the number of slots, so every question below reduces to "how many slots".

## 2. The planning model

| Quantity | Planning figure | Basis |
|---|---|---|
| Cost of an average submission | **5 slot-seconds** | compile (C++ `-O2 -static` with the precompiled header ≈ 0.3–0.7 s CPU; a compile-cache hit costs nothing; Python's syntax check ~10 ms), a fresh box per test, ~15–20 small tests, the occasional TLE that runs to its limit, a checker per test on `CHECKER` problems |
| Throughput of one slot | 3,600 / 5 = **~720 submissions per hour** | |
| Headroom | **+30 %** | bursts at contest start and just before the end; a node being rebuilt; retries; calibration keeping an outlier off the graded lanes |
| Slots per 8-core host | **~5** | one physical core per slot with its SMT sibling idle, plus housekeeping cores for the OS, the worker, blob fetches and compiles overlapping runs (`docs/JUDGE.md` §4, CPU pinning) |

**Slots needed = peak judged jobs per hour ÷ 720 × 1.3** (rounded up).
"Judged jobs" counts submissions **and** Run-button executions — Runs are
judged on the same slots.

## 3. Worked figures

**One 8-core host ≈ 700–1,000 students in an active contest.** Five slots
give 5 × 720 = 3,600 jobs per hour, or ~2,770 with 30 % headroom. Active
contestants generate roughly 3–4 judged jobs per hour each (submissions
plus Runs), which is ~700–900 students per host; the upper end of the range
assumes lighter Run use.

**A 5,000-student simultaneous mock assessment needs ~21 slots, about four
8-core hosts.** Assessments generate fewer jobs per student-hour than
contests (fewer, longer problems; Runs capped by the in-flight limit) —
planned at ~2.3. Then 5,000 × 2.3 = 11,500 jobs per hour; 11,500 ÷ 720 ×
1.3 ≈ 21 slots.

**Staggered sittings of 1,000–1,200 students are the honest operational
recommendation.** Each sitting needs 1,200 × 2.3 ÷ 720 × 1.3 ≈ 5 slots —
one 8-core host — and leaves the rest of the fleet for practice traffic and
reruns. Staggering also matches the real constraint for results that count:
only `LAB_SUPERVISED` attempts may feed shortlisting or placement
(`docs/PROCTORING.md`), and lab seats, not judge slots, bound how many
students can sit one at a time.

## 4. How lanes shape the arithmetic

The worker's slot allocator (`docs/JUDGE.md` §3) caps each lane **per node**,
so slots on a node that serves every queue are not all available to one
lane:

| Lane | Share of a 5-slot node that serves all five queues |
|---|---|
| ASSESSMENT | at most 3 slots (60 %) |
| CONTEST | at most 2 slots (50 %) |
| RUN | 2 slots hard-reserved, always |
| PRACTICE | at least 2 slots while it has work (25 % floor, rounded up) |
| REJUDGE / validation | at most 1 slot (20 %), none while the assessment backlog exceeds 50 |

A lane that is a node's **only** allowed lane is uncapped. Two consequences
for planning:

* **During a graded sitting, dedicate hosts to it.** A host started with
  `RECX_QUEUES=judge-assessment` gives all 5 slots to the assessment; the
  same host serving everything gives it 3. The ~21-slot figure in §3 assumes
  dedicated hosts; on mixed hosts the same sitting needs ~35 slots. Keep one
  mixed host so Runs and practice stay responsive.
* **Only nodes that pass the sensitive-lane gates count** for ASSESSMENT and
  CONTEST: calibrated within 10 % of the fleet median, self-check fresh,
  hardening verified (`docs/JUDGE.md` §10). Plan one spare host per sitting
  so a node that drifts out of the band does not shrink the graded fleet
  below what the sitting needs.

## 5. Beyond the judge

Also estimates, still to be measured:

* **Web app.** Two Next.js instances behind Caddy; each SSE connection is
  one open stream per student watching a verdict, closed when the result
  arrives. A contest's peak is a few thousand concurrent streams.
* **Postgres.** The web app connects through PgBouncer in transaction mode
  (`connection_limit=10` per instance); the scheduler holds one direct
  connection. Submissions are narrow rows with per-test results in one
  `jsonb` column, never a row per test (~7 million rows per year planned).
* **Redis.** BullMQ queues and progress pub/sub only; job payloads are
  `{kind, id}`. Memory is dominated by completed-job retention (one hour).

---

## 6. Measured

Every number here was measured, with its date, machine and method. A
measurement replaces the planning figure it measures; until then the plan
above stands.

### 6.1 Toolchain start-up cost — measured 2026-10-10 (development box)

From `infra/judge/toolchains/verify-toolchains.sh`: one hello-world per
language that reads a line from stdin, compiled and run inside isolate with
the catalog's argv (compile limits; run at the language's fallback limit for
a 1 s problem). Machine: Intel Core i7-13650HX (WSL2, kernel 6.6, 20 logical
CPUs, **no CPU pinning, no frequency control** — a development box, not a
judge host) and **shared with other concurrent build and test work**: three
runs, reported as min–max; the spread is mostly that load, not the
toolchains.

| Language | Compile CPU / wall | Run CPU | Run memory (cgroup peak) |
|---|---|---|---|
| C17 | 55–327 ms / 128–546 ms | 0–7 ms | ~0.5 MB |
| C++17 (precompiled header) | 295–1,475 ms / 626–2,134 ms | 0–3 ms | ~0.5 MB |
| C++20 (precompiled header) | 642–1,047 ms / 616–1,616 ms | 1 ms | ~0.5 MB |
| Java 21 (AppCDS, `-Xshare:auto`) | 884–1,150 ms / 592–732 ms | 77–90 ms (`-Xshare:on` 73–77 ms, `-Xshare:off` 92–130 ms) | 18–27 MB |
| Python 3.12 (syntax check; numpy imported) | 10–15 ms / 10–30 ms | 112 ms with `OPENBLAS_NUM_THREADS=1` (crashes without it, `docs/JUDGE.md` §7) | 34 MB |
| PyPy 3.10 | — | 50–74 ms | 19–68 MB |
| Node.js 22 (`--check`) | 35–46 ms / 139–168 ms | 21–31 ms | 8–10 MB |
| Go 1.23 (`bin/recx-go-build`, proposed) | 108–150 ms / 103–248 ms | 1 ms | 1.4 MB |
| Go 1.23 (`go build`, cold cache, locks allowed — one run) | 7,238 ms / 7,198 ms | — | 280 MB |
| Kotlin 2.0 | 9,779–11,225 ms / 4,318–4,751 ms | 62–77 ms | 22 MB |
| testlib checker (C++20, compiled once per node per hour) | 4,095–4,773 ms / 3,890–4,618 ms | — | — |

What it means for the model: compile time dominates the per-submission cost
for C++ (0.3–1.5 s CPU) and Kotlin (~10 s), and a compile-cache hit (Run then
Submit of the same code) removes it. Per-test cost for these hello-worlds is
negligible next to the 5 slot-second budget; real tests and TLEs are what
the burst measures.

### 6.2 Capacity burst — measured 2026-10-10 (development box)

* **Machine and fleet**: Intel Core i7-13650HX (10 cores / 20 threads),
  WSL2 kernel 6.6, **no CPU pinning, no frequency control**; one judge node
  `dev-judge-1` with `RECX_SLOTS=8` (RUN hard-reserves 2), isolate 2.7,
  worker 0.1.0, calibration score 629,326,621, self-check 12/12 passed,
  serving all five lanes (development override for the unhardened WSL2
  kernel — never in production). Web app in `next dev`, scheduler running.
* **Workload**: the default mix (15 % ASSESSMENT, 15 % CONTEST, 25 % RUN,
  45 % PRACTICE) over the three published problems (two-sum, bracket-cleanup
  with a testlib checker, study-pairs with subtasks), C++20 and Python 3.12
  model solutions, so every verdict is AC. Clock offsets: Postgres 0 ms,
  Redis 0 ms. Raw reports: `docs/capacity/2026-10-10-burst-*.json`.

**A. 200 submissions arriving uniformly over 60 s** (≈ 3.3 per second —
a realistic arrival profile; this is the gate run).
`npx tsx ../../scripts/load/burst.ts --count 200 --spread 60 --json … --markdown`

| Lane | Jobs | Done | Wait p50 | Wait p95 | Wait max | Service p50 | Service mean | End-to-end p95 | IE | Verdicts |
|---|---|---|---|---|---|---|---|---|---|---|
| ASSESSMENT | 30 | 30 | 143 ms | 292 ms | 380 ms | 767 ms | 832 ms | 1.52 s | 0 | AC 30 |
| CONTEST | 30 | 30 | 183 ms | 353 ms | 381 ms | 857 ms | 834 ms | 1.45 s | 0 | AC 30 |
| RUN | 50 | 50 | 186 ms | 274 ms | 342 ms | 647 ms | 509 ms | 1.13 s | 0 | AC 50 |
| PRACTICE | 90 | 90 | 145 ms | 282 ms | 462 ms | 735 ms | 776 ms | 1.36 s | 0 | AC 90 |

Makespan 60.8 s, 197 jobs/min; mean slot time per job 727 ms. PRACTICE
starvation: **none** — the longest PRACTICE wait while a usable slot was free
was 467 ms. Gate targets: assessment p95 < 2 s (**292 ms**), practice p95
< 5 s (**282 ms**), practice floor never starved (**held**).

**B. The same 200 submissions all at once** (a saturation test, not a
realistic arrival).
`npx tsx ../../scripts/load/burst.ts --count 200 --instant --json … --markdown`

| Lane | Jobs | Done | Wait p50 | Wait p95 | Wait max | Service p50 | Service mean | End-to-end p95 | IE | Verdicts |
|---|---|---|---|---|---|---|---|---|---|---|
| ASSESSMENT | 30 | 30 | 4.43 s | 9.78 s | 9.91 s | 1.33 s | 1.40 s | 10.9 s | 0 | AC 30 |
| CONTEST | 30 | 30 | 17.5 s | 21.9 s | 22.1 s | 1.22 s | 1.40 s | 24.7 s | 0 | AC 30 |
| RUN | 50 | 50 | 8.91 s | 13.1 s | 13.4 s | 1.00 s | 786 ms | 14.1 s | 0 | AC 50 |
| PRACTICE | 90 | 90 | 25.4 s | 33.4 s | 34.2 s | 1.14 s | 1.19 s | 34.6 s | 0 | AC 90 |

Makespan 35.4 s, 339 jobs/min; mean slot time per job 1.15 s (slower than A:
eight boxes compete for one shared, unpinned host). PRACTICE starvation:
**none** — the longest PRACTICE wait while a slot it may use was free was
394 ms (it waited up to 20.1 s while only RUN's hard-reserved slots were
idle, which is the reservation working as designed). Waits here are bounded
by arithmetic, not policy: 200 jobs × 1.15 s ÷ 8 slots ≥ 29 s of work, so no
allocator can keep every lane under 5 s. What the allocator controls is the
order — ASSESSMENT first (capped at 60 % of slots), then RUN, CONTEST, and a
PRACTICE floor that never drops to zero — and that held.

**What it means for the model (§2):** the measured slot time per job is
0.7–1.2 s for these problems, far below the planning figure of 5
slot-seconds, because the problems are small and compiles hit the
precompiled header and the compile cache. Keep the 5 slot-second planning
figure until production traffic (larger tests, TLEs, Kotlin/Java compiles)
is measured (§6.3); on this evidence it is conservative by roughly 4–7×.
The honest operational recommendation in §3 (stagger a 5,000-student mock in
slots of 1,000–1,200, or provision ~21 slots) stands until then.

### 6.3 Still to measure

* Slot-seconds per submission by language and problem size (median, p95),
  from production traffic.
* The share of judged jobs that are Runs, in practice and in contests.
* Jobs per student-hour in a real practice week and a mock contest.
* Slots an 8-core production host sustains, pinned, before calibration drifts.
* Queue wait at the p95 under a synthetic 5,000-student burst on a
  production-shaped fleet.
* The web app's concurrent SSE ceiling per instance.

---

## 7. Front-end budgets

### 7.1 Bundle sizes — measured 2026-10-19 (production build, Windows)

`pnpm --filter @recx/web build && pnpm --filter @recx/web size`
(`apps/web/scripts/size-budget.mjs` against `apps/web/size-budgets.json`;
also a CI step after the build). Sizes are gzip level 9, 1 KB = 1,024 bytes.
App Router routes count Next's runtime + every client chunk of the layout
chain + the page. `/login` is measured from what the browser really loads:
the script serves the production build in-process, fetches `/login` signed
out and reads the HTML (`apps/web/scripts/served-html.mjs`); it also serves
`/offline`, which must show its scripts, so the detector cannot go blind.

| Budget | Measured | Limit | Breakdown |
|---|---|---|---|
| `/login` | **0.0 KB** | 90 KB | Pages Router, `unstable_runtimeJS: false`: 0 `<script src>`, 0 script preloads, no `__NEXT_DATA__`; 1 inline script (the theme script, CSP hash). Not JS: one 12.4 KB stylesheet (gzip), two font preloads, 2.6 KB of HTML (gzip) |
| `/dashboard` | 120.1 KB | 160 KB | framework 100.3 + app 19.7 |
| `/problems` | 122.5 KB | 170 KB | framework 100.3 + app 22.2 |
| `/leaderboard` | 139.3 KB | 150 KB | framework 100.3 + app 39.0 |
| `/problems/[slug]` shell | 171.6 KB | 220 KB | framework 100.3 + app 71.2 |
| `/contests` | **116.9 KB** | 130 KB | framework 100.3 + app 16.6. Server-rendered; the list adds no client component of its own |
| `/contests/[slug]/arena` | **117.5 KB** | 135 KB | framework 100.3 + app 17.2 — the countdown clock is the only client component the arena adds, and it costs 0.6 KB over the list |
| `/judge` | **116.9 KB** | 125 KB | framework 100.3 + app 16.5. Public, server-rendered: its own chunks add 0.2 KB, Next's page stub only (`serverRendered` in `size-budgets.json`). `shared: false`, so it does not enter the shared measure |
| Shared first-party | 12.4 KB | 120 KB | of 131.4 KB in chunks two or more budgeted routes load |
| Monaco chunk (lazy, `/monaco/vs`) | 942.1 KB | 1,050 KB | `loader.js` 9.0 + `editor/editor.main.js` 930.4 + largest grammar (`javascript.js`) 2.7 |
| Monaco editor worker (lazy) | 112.0 KB | 120 KB | `base/worker/workerMain.js` |
| `editor.main.css`, `codicon.ttf` | 20.0 KB, 43.4 KB | reported | not JS |
| CodeMirror lazy set (< 768 px) | 148.7 KB | 190 KB | core 97.2 + largest grammar (`@codemirror/lang-javascript`) 51.5 |

**Monaco-free: ok** — 34 routes checked (first-load and lazy chunk graphs):
`/problems`, `/dashboard`, `/leaderboard`, `/judge`, the contest pages and
every `/admin` page carry no Monaco module or loader marker; the workspace shell loads Monaco
only lazily, and the detector sees it there (self-check).

**Zero-JS: ok** — `/login` served from this build has no `<script src>`, no
script preload and no `__NEXT_DATA__`; the detector sees 10 `<script src>`
on `/offline` (self-check), so it has not gone blind.

Phase 4 deltas against 2026-10-10 (same machine, same build command). The
gate item was `/judge` (new) and `/dashboard` staying under 160 KB:
`/dashboard` 117.0 → **120.1 KB** (app 16.6 → 19.7), the announcement
banner's dismiss button — the one client component Phase 4 adds to the
student shell. `/problems/[slug]` shell 169.2 → 171.6 KB (app 68.8 → 71.2)
and `/leaderboard` (app 38.9 → 39.0 KB) come from the same shell chain.
Shared first-party 12.5 → 12.4 KB and CodeMirror 148.8 → 148.7 KB are
rounding; the framework chunk measured 100.4 → 100.3 KB. Monaco is
unchanged. Every budget is met with ≥ 8.0 KB of headroom; the tightest three
are the Monaco editor worker (8.0 KB), `/judge` (8.2 KB) and `/leaderboard`
(10.7 KB).

Phase 5 added two budgets. `/contests` (116.9 KB of 130) and
`/contests/[slug]/arena` (117.5 KB of 135) are both within ~1 KB of the
framework floor plus their own shell: the arena deliberately links out to the
existing workspace rather than embedding a second editor, so the only client
component it adds is the countdown. The limits are set ~13 KB above the
measurement so they are a real budget, not a rubber stamp. Nothing else
moved: `/dashboard` 120.1, `/judge` 116.9, Monaco unchanged.

History, 2026-10-10: `/login` as an App Router page measured 113.6 KB (over
by 23.6 KB) — hence the zero-JavaScript Pages Router page
(`docs/ARCHITECTURE.md`). The Monaco set first counted the editor worker
inside the chunk (1,054.0 KB); the worker is a separate worker script and
now has its own line (`docs/OPEN-QUESTIONS.md`, Phase 3, "Front-end
budgets").

### 7.2 Throttled workspace — measured 2026-10-10 (production build, Windows)

`apps/web/e2e/perf-workspace.spec.ts` (Playwright project `perf`) against
`next start -p 3200`: Chrome at 1366 × 768, CPU throttled 4× and network
3 Mbps down / 1 Mbps up / 150 ms RTT (CDP), student `2116231001003`,
`/problems/two-sum`. Cold = HTTP cache disabled; warm = static assets in the
HTTP cache; the service worker is blocked in both. Machine: the same
development laptop as §6 — **not** the reference device — with the WSL
stack running and OneDrive syncing the repository (measured at one full
core throughout the last runs); the spread below is mostly that load.
Times in ms from navigation start.

Final build (all of this section's code), nine runs:

| Run | FCP | LCP | Textarea typable | Monaco interactive | CLS | Warm: typable | Warm: Monaco | Warm CLS | Caret under console |
|---|---|---|---|---|---|---|---|---|---|
| 8 | 1,368 | 1,592 | 2,655 | 7,568 | 0.0010 | 2,132 | 4,953 | 0.0001 | no |
| 9 | 1,076 | 1,828 | 3,494 | 9,212 | 0.0001 | 3,780 | 8,918 | 0.0042 | no |
| 10 | 1,132 | 1,564 | 2,788 | 9,147 | 0.0065 | 2,022 | 5,195 | 0.0006 | no |
| 11 | 1,044 | 1,372 | 2,441 | 7,373 | 0.0105 | 1,831 | 3,754 | 0.0759 | no |
| 12 | 768 | 1,232 | 2,200 | 7,024 | 0.0001 | 2,359 | 6,746 | 0.0001 | no |
| 13 | 776 | 944 | 1,735 | 6,220 | 0.0001 | 1,447 | 3,551 | 0.0019 | no |
| 14 | 832 | 832 | 1,786 | 7,462 | 0.0001 | 1,469 | 3,427 | 0.0010 | no |
| 15 | 904 | 904 | 1,657 | 6,326 | 0.0001 | 2,102 | 4,643 | 0.0052 | no |
| 16 | 868 | 868 | 1,646 | 6,473 | 0.0001 | 2,132 | 4,644 | 0.0000 | no |

| Metric (target, p75) | min | p50 | p75 | max |
|---|---|---|---|---|
| Textarea typable, cold (≤ 2.5 s) | 1,646 | 2,200 | 2,655 | 3,494 |
| Monaco interactive, cold (≤ 7 s) | 6,220 | 7,373 | 7,568 | 9,212 |
| Monaco interactive, warm (≤ 4 s) | 3,427 | 4,644 | 5,195 | 8,918 |
| Textarea typable, warm | 1,447 | 2,102 | 2,132 | 3,780 |

Earlier builds the same day (identical Monaco loading path; runs 1–7):
cold typable p50 1,814 / p75 1,842
ms, cold Monaco p50 6,768 / p75 7,193 ms, warm Monaco p50 3,766 / p75 3,987
ms. Per cold load the browser moves 181.8 KB of Next JS (17 files) and
1,011.9 KB from `/monaco/vs` (`editor.main.js` 934.8 KB finishes at ~4.6 s;
the rest of the Monaco time is executing it at 4× throttle); a warm load
moves ~40 KB.

What held in every run:

* **The textarea is typable before Monaco arrives** — cold and warm, all
  sixteen runs (the spec asserts `textareaTypable < monaco`).
* **The console never hides the caret.** Caret on line 28 at the bottom of
  the editor (line box 667–688 px, editor 162–700 px): opening the console
  (drawer top 404 px) scrolls the editor 74 → 370 px and the caret line
  sits at 371–392 px; eight more lines typed with the console open stay at
  371–392 px. A caret already clear of the drawer (line 1) does not move and
  the editor does not scroll. The editor's height is unchanged (538 px): an
  overlay, never a squeeze. Plain-textarea fallback (Monaco blocked): caret
  681–702 px → 371–392 px with the console open, and typing with it open
  stays clear.
* CLS stayed ≤ 0.05 except one warm run (run 11, 0.0759). Two causes of a
  0.07 shift were found: the statement pane painting full-width before the
  streamed HTML reached the editor pane (fixed — the pane keeps its 38 %
  while alone, `:not(:has(~ *))`; 20 instrumented warm loads after the fix,
  largest shift 0.0011), and a residual case in which a partially streamed
  statement paragraph reflows the text under it (one run in nine; the perf
  spec now records each shifted node's x and width to pin it down).

Not met on this machine: the cold Monaco (≤ 7 s), warm Monaco (≤ 4 s) and
cold textarea (≤ 2.5 s) p75 targets in the final-build runs above (they
were met at p75 for typable and warm Monaco, and missed by 0.2 s for cold
Monaco, in runs 1–7). They are targets for the reference device and real
lab machines (field vitals), not for a loaded development laptop; re-measure
on the reference device before Phase 3 sign-off.

### 7.3 Throttled solve with a live judge — 2026-10-10 (`next dev`, WSL)

The same spec with `E2E_JUDGE=1` against the WSL development stack (the
only one with a judge worker attached): throttled from the first byte of
`/problems/two-sum` to the last verdict — the student types into the plain
textarea before Monaco arrives (nothing typed is lost when Monaco takes
over), switches to Python 3.12, writes 31 lines (the caret ends at the
bottom of the editor), **Run → Accepted, Submit → Accepted**, with the
caret checked against the console every 0.5 s while judging and after each
verdict: never under it (final caret line 362–383 px, drawer top 404 px).
Five runs: the first failed because the caret line ended 6 px below the
editor after the status row under it wrapped (Monaco now keeps an in-view
caret in view when its box shrinks), the second on the test's own race with
Monaco's takeover (fixed in the test); the last three passed — the last on
the final code: typed into the textarea before Monaco, caret checked 10
times, 7 with the console open, 0 under it. `next dev` timings (typable ~10–13 s, Monaco ~14–19 s, unminified and
compiled on request) say nothing about production and are not budgets.

## 8. The reference device, and what "done" means on it (Phase 10d)

Every number in §7 was measured on a development laptop with OneDrive
syncing a repository and a WSL stack running. That is a useful signal and it
is not the definition of done. **The definition of done is the reference
device**, because that is what a student at this college actually holds.

### 8.1 The device and the network

| | |
|---|---|
| **Device** | a 2021-era mid-range Android phone — 8 cores, ~4 GB RAM, Chrome; roughly a 4× CPU slowdown against the development laptop |
| **Network** | campus wifi at its worst: **3 Mbps down, 1 Mbps up, 150 ms RTT** |
| **Viewport** | 375 × 812 (the phone) and 1366 × 768 (a lab desktop) |
| **State** | cold = empty HTTP cache, no service worker; warm = static assets cached |

The throttling figures are the ones `apps/web/e2e/perf-workspace.spec.ts`
already applies through CDP, so a run on the laptop with that profile is an
honest *proxy* for the device — slower CPU, same network. It is not a
substitute: the last column of §7.2 is "not met on this loaded laptop", and
the point of this section is that the targets belong to the device, not to
whatever machine ran the test.

### 8.2 The targets

| Metric | Target | Where it is checked |
|---|---|---|
| **Textarea typable** | **≤ 2.5 s, cold and warm** | `perf` e2e project, p75 of ≥ 8 runs |
| **Monaco interactive** | **≤ 7 s cold, ≤ 4 s warm** | `perf` e2e project, p75 |
| **LCP** | **≤ 2.0 s** | Lighthouse CI, and field vitals (p75 per route) |
| **LCP, `/problems/[slug]`** | **≤ 2.5 s** | field vitals (the page needs a session) |
| **LCP, `/judge`** | **≤ 2.5 s** | Lighthouse CI |
| **CLS** | **≤ 0.1** | Lighthouse CI, and field vitals |
| **INP** | **≤ 200 ms** | field vitals (p75 per route) |
| **First-load JS per route** | `apps/web/size-budgets.json` | `pnpm size`, in CI |

`/judge` has the statement page's budget rather than the dashboard's, and the
reason is the same: it is a long server-rendered document — the whole
language catalogue, the limits and the verdict table — and what matters for
it is whether the text arrives, not whether it beats a dashboard. It was
measured at **2,376 ms** (§8.4), which is over 2.0 s and under 2.5 s; the
budget is written per page in `apps/web/lighthouserc.json` so neither page
excuses the other.

Two of these need the footnote the spec itself asks for, and both are about
Monaco rather than about this code:

- **The editor's budget is warm-and-cold, not a single number.** Monaco is
  about 1 MB gzipped after the TypeScript service is stripped out, which on
  3 Mbps is three seconds of transfer before a line of it runs. A cold
  four-second budget would be a budget nobody could meet without replacing
  the editor; the honest version is "typable in 2.5 s always, and the real
  editor in 7 s cold / 4 s warm". The textarea is what makes that
  acceptable: a student can start typing into a plain `<textarea>` while
  Monaco loads, and what they type is carried over.
- **LCP is 2.0 s except on the statement page, where it is 2.5 s.** The
  statement page renders the problem, the samples and the editor shell in
  one document. Averaging the two into one budget would either excuse the
  dashboard or condemn the workspace; stating both is what makes each
  actionable.

### 8.3 Field vitals: what is collected, and what is deliberately not

`POST /api/vitals` takes **a metric, a value and a route pattern** — and
nothing else. There is no user id, no session, no address: the endpoint
stores a bucketed histogram per metric per route per day
(`packages/shared/src/vitals.ts`), in Redis, with a 35-day expiry set on
every write.

So the question this data answers is "is the p75 LCP on `/problems/[slug]`
within its 2.5 s budget this week", and the question it cannot answer is
"which students see a slow editor". That trade is the point, not a
limitation to be fixed later: a `WebVital` row per page view per student is
a browsing history with a performance column, kept in the datastore with the
least access control over it.

Three further decisions, recorded because each shows up as a gap otherwise:

- **One page load in four reports** (`VITALS_SAMPLE_RATE`). A p75 per route
  per day needs tens of samples, not thousands, and the busiest hour on this
  platform is a contest — the last moment to add a write per page view.
- **A dynamic path collapses to its pattern** before it leaves the browser:
  `/problems/two-sum` is reported as `/problems/[slug]`. Which page is slow
  is a performance question; which problem a particular student opened at
  11:02 is not.
- **Nothing reports from inside an exam.** The reporter is mounted in the
  student shell, and `app/(exam)` is its own route group — a locked-down
  page should make exactly the requests its own protocol describes, and
  `tests/repo/exam-isolation.test.ts` keeps it that way.

`/login` is not sampled at all: it is a zero-JavaScript page by requirement
(SPEC §5), so nothing there can measure anything. The slowest first paint on
the platform is therefore invisible to field vitals, and Lighthouse CI is
what covers it.

### 8.4 Lighthouse, measured — 2026-10-20 (production build, Windows)

`npx @lhci/cli@0.14.0 autorun` from `apps/web`, against `next start -p 3210`
with the reference device's throttling (4× CPU, 3 Mbps down / 1 Mbps up,
150 ms RTT, 375 × 812 mobile emulation), three runs per page. Same laptop as
§7.2, same caveats: the WSL stack was running and OneDrive was syncing.

| Page | LCP | FCP | CLS | TBT | Speed index | Performance |
|---|---|---|---|---|---|---|
| `/login` | **1,212 ms** | 912 ms | 0 | 43 ms | 3,494 ms | 98 |
| `/judge` | **2,376 ms** | 1,532 ms | 0 | 277 ms | 2,715 ms | 91 |

Medians of three. Both pages meet their budgets; `/judge`'s is 2.5 s for the
reason above, and that is the one number in this document raised after a
measurement rather than before one.

Three things the first run found, all of them in the configuration rather
than in the product, and all of them things that would otherwise have been
discovered on a CI runner nobody was watching:

- **`/problems` was being audited and silently redirecting to `/login`.**
  Lighthouse holds no session. All six runs measured the sign-in page, and
  the only sign was the line "Checking assertions against 1 URL(s)".
  `tests/repo/perf-budgets.test.ts` now refuses a session-guarded page in
  the audit list.
- **The platform had no favicon at all.** `errors-in-console` failed on
  `/login` with a 404 for `/favicon.ico`: there was no `app/icon.*`, no
  `public/favicon.ico` and no `<link rel="icon">` anywhere, so every page
  load in every browser logged an error and no tab ever showed a mark.
  Fixed with `app/icon.svg` plus the explicit link the Pages Router page
  needs.
- **Two assertions could never pass.** A `//` comment key inside
  `assertions` is read as an audit name, and `no-unload-listeners` and
  `render-blocking-resources` produce no value under these settings — each
  failed on the assertion rather than on the page.

Speed index is a warning rather than an error: across six runs of the same
page it ranged from 1,973 ms to 9,141 ms, which measures the laptop and not
the build.
