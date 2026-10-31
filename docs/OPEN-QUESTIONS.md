# Open questions and recorded decisions

Where the specification was ambiguous or could not be implemented literally,
the narrower reading was implemented and recorded here for review. Each entry
names what was decided and what should be revisited.

## Content is the binding constraint

**Content, not code, is the binding constraint on launch.** The launch target
is 450 originally-authored problems (180 Easy / 200 Medium / 70 Hard) and
~2,000 aptitude questions, with named owners. Owners: _to be named by the
placement cell and department heads_. Nothing may be scraped or pasted from
LeetCode, GeeksforGeeks, InterviewBit or anywhere else.

## Phase 1 decisions

1. **The 14 topics.** The prompt fixes the count but not the members. Chosen
   (packages/shared/src/topics.ts): Arrays & Hashing, Two Pointers, Sliding
   Window, Stacks & Queues, Binary Search, Linked Lists, Trees, Heaps,
   Recursion & Backtracking, Graphs, Dynamic Programming, Greedy, Math & Bit
   Manipulation, Strings. *Revisit with the placement cell.*
2. **BullMQ queue names.** BullMQ 5 rejects `:` in queue names (verified:
   "Queue name cannot contain :"). The five queues are `judge-assessment`,
   `judge-run`, `judge-contest`, `judge-practice`, `judge-rejudge` — same
   semantics as the prompt's `judge:*` names.
3. **Prisma enum mirrors.** `Verdict` (and the lane / compare / scoring / IO
   enums) must exist as Postgres enums for the columns. The Prisma enum is a
   storage mirror; `packages/db/test/enum-parity.test.ts` holds it identical
   to `@recx/shared`, and the single-source test exempts only `schema.prisma`.
4. **Per-slot tmpfs.** The prompt specifies `mount -t tmpfs … uid=6000N` per
   slot box root. isolate 2.7 itself `rmtree()`s and recreates
   `box_root/<id>` on every `--init`/`--cleanup`, so a mount at that path makes
   isolate fail ("Device or resource busy"; verified). Implemented instead: the
   whole isolate `box_root` is one tmpfs (`var-local-lib-isolate.mount`, sized
   slots × 3 boxes × 256 MB, `nosuid,nodev`), so teardown is still `rm -rf`
   on RAM and nothing reaches disk. Per-box size is bounded by `--fsize`, the
   worker's 256 MB disk-usage trip, and tmpfs user quotas via
   `isolate --quota` on kernels with `CONFIG_TMPFS_QUOTA` (not available on
   the WSL2 dev kernel; verify on the production kernel). *Revisit: kernel
   floor for production judges should be ≥ 6.6 (bookworm-backports) for tmpfs
   quotas.*
5. **Box ids per slot.** Each slot needs three boxes (run, compile, checker)
   with distinct uids. Slot N uses box ids N (run), 100+N (compile) and
   200+N (checker); all uids stay inside 60000–60999 for the egress drop rule.
6. **Seed of `#6d28d9` "within ΔE 2".** The derivation clamps chroma to 0.21,
   but `#6d28d9` has OKLCH chroma ≈ 0.27, so the generic algorithm cannot
   reproduce it within ΔE 2 by construction. The rec-purple preset therefore
   short-circuits (as the prompt specifies) and is selected whenever the
   submitted seeds equal the canonical REC seeds; the ΔE test asserts that
   path, and the design test suite also reports the generic algorithm's
   per-token ΔE for information. *Revisit if the clamp should be relaxed for
   the canonical hue.*
7. **Run button in Phase 1.** `RunRequest` (listed under "other required
   tables") is introduced in Phase 1 because the workspace needs Run. Runs
   use the `judge-run` queue from day one.
8. **pnpm version.** The repo pins `pnpm@9.15.9`. On the Windows dev machine
   the globally installed pnpm 10 fails to self-switch (a pnpm-on-Windows
   issue with its `.tools` junctions), so commands run as
   `npx pnpm@9.15.9 …`. Linux uses corepack.
9. **Local services.** Docker Desktop on the development machine fails to
   start (its own inference-manager service errors). Postgres 17 and Redis 7
   run natively in WSL2 instead (`scripts/dev/wsl-services.sh`), Postgres on
   port **5433** because a Windows-native Postgres owns 5432. `compose.yaml`
   remains the documented container path.
10. **Toolchain sources.** GCC 13.2.0 and CPython 3.12.6 are built from
    GPG-verified upstream tarballs (`infra/judge/toolchains/`), not from
    distro packages (Ubuntu 24.04 ships GCC 13.3.0). The binutils and glibc
    used for static linking come from the judge host's `/usr` (read-only).
11. **Two-sum `target` type.** Declared `long` in the FUNCTION signature
    because `nums[i] + nums[j]` can reach ±2·10⁹, outside 32-bit range.
12. **Fallback per-language time limits in Phase 1.** Until Phase 2 measures
    model solutions per language, a job's CPU limit is the problem's base
    (C++) limit scaled by the language's published fallback multiplier
    (`fallbackTimeLimitMs`: CPython 5× + 1 s, PyPy 2× + 300 ms, …), clamped to
    [200 ms, 15 s]. Custom runs are additionally capped at 5 s.
13. **Precompiled `<bits/stdc++.h>`.** Every FUNCTION-mode C++ program
    includes it; parsing it took 2–7 s CPU (once 10.1 s — a false "compilation
    exceeded resource limits" CE for a correct program) against the 10 s
    compile cap. The toolchain image now carries PCH files for the exact
    catalog flag sets (`infra/judge/toolchains/build-gcc-pch.sh`); a compile
    takes ~0.5 s CPU. GCC ignores a PCH whose flags do not match, so this can
    only ever speed a compile up.
14. **Session time zone.** Prisma stores `DateTime` as UTC in `timestamp(3)`
    columns and the lease / blob / reconciler SQL compares them with
    `now()`. Migration `20261010000000_session_timezone_utc` pins the
    database's session time zone to UTC.
15. **Client IP.** Forwarding headers are read only when `TRUST_PROXY=true`
    (Caddy overwrites `X-Real-IP`); otherwise no IP is derived, so per-IP
    sign-in limiting applies only behind the proxy.

## Phase 1 — decisions recorded during the build

### Judge worker
- **A fresh run box (and cgroup) per test.** isolate 2.7 creates the box
  cgroup at `--init` and reuses it for every `--run`; `memory.peak` and the
  OOM counter accumulate (verified: after one OOM run every later run in the
  same box reported `cg-oom-killed`). Re-initialising per test keeps MLE and
  per-test memory correct and stops files persisting between tests.
- **Box disk usage is bounded by the memory cgroup.** tmpfs pages written by
  a box are charged to its memory cgroup (verified: writing output under a
  64 MB `--cg-mem` OOM-kills), plus `--fsize` per file. The worker cannot
  walk the box during a run (mode 0700, box uid), so there is no separate
  disk-usage trip (this supersedes the trip mentioned in item 4).
- Capture files are pre-created and read through descriptors opened before
  the run, with `O_NOFOLLOW`; isolate is spawned with a minimal environment so
  the node token never reaches it.
- Verdict precedence: XX → IE (released, never posted); early output trip →
  OLE; TO → TLE (idle flag when CPU < TL); OOM / cg-mem ≥ limit → MLE; SG →
  OLE for SIGXFSZ, else RE with the signal name; RE → exit code, with the JVM
  (`OutOfMemoryError` → MLE, `StackOverflowError` → labelled RE) and Python
  (`MemoryError` → MLE) refinements.
- Phase 1 judges compare modes TOKEN / EXACT / FLOAT and FUNCTION comparators
  EXACT / IN_PLACE_MUTATION / FLOAT_TOLERANCE. Other modes are refused as
  infrastructure failures (→ INTERNAL_ERROR after 3 attempts); authoring must
  block them until Phase 2. *Phase 2: add a non-retryable release.*
- Scoring: ICPC full; PER_TEST = passed points / all points; SUBTASK = a
  subtask earns its weight only if all its tests pass (Phase 2 adds MIN /
  SUM_FRACTION and dependencies). stopOnFirstFailure applies only to ICPC.
- A custom run with no expected output that exits cleanly is reported as
  `AC` with the message "there is no expected output to compare against"; the
  UI shows it as "Finished", never as "Accepted".
- Intake follows the heartbeat: BullMQ workers start after the first ONLINE
  heartbeat and pause on DRAINING / QUARANTINED / OFFLINE; 426 → drain and
  exit. Weighted lane allocation, self-check, calibration and the compile
  cache are Phase 2. DockerDriver is not available in Phase 1 (Docker cannot
  be verified on the development machine); selecting it fails at startup.

### Judge protocol (web side)
- Every token-guarded write also requires `claimedByNodeId` = the
  authenticated node; the stored `judgeNodeId` is always the authenticated
  node.
- A release on the final attempt finalises INTERNAL_ERROR immediately; a
  spec that cannot be built (corrupt runtime, invalid signature) is
  INTERNAL_ERROR at once — no retry can fix bad data.
- Blob access is 403 unless the blob belongs to the job this node holds; a
  custom-stdin run may fetch no blob (its input arrives inline).
- A TestBlob is inline only when ≤ 64 KB *and* valid UTF-8 without NUL.
- Bundles are deterministic (tar mtime/uid/gid 0), so rewriting an identical
  revision is a no-op rather than an immutability error.
- *Resolved in Phase 2:* a result posted by a node that is now QUARANTINED is
  discarded (409), the job is re-queued with its attempt refunded, and the
  discard is audited.

### Scheduler
- Tick order: node sweep → queued dispatch → expired leases → RunRequest TTL.
  A QUEUED row whose `attemptCount` ≥ 3 is finalised INTERNAL_ERROR instead of
  being re-enqueued. One instance acts per tick (`pg_try_advisory_lock`, pool
  pinned to one connection); decisions use the database clock. The scheduler
  publishes `final` after it commits an IE and `state: QUEUED` after a
  requeue.

### Web app
- Sign-in `login(prev, formData)` works with and without JavaScript. Only
  failed attempts count toward the limits (5 per account and 20 per IP hash
  per 15 minutes; fail-open if Redis is down). *Open:* 20 per IP may be
  reached by a whole lab behind one NAT address — revisit or allow-list campus
  egress before exams. Any per-account limit lets someone lock a student out
  for 15 minutes by guessing; accepted for now.
- Submission/run read APIs return 404 (not 403) to non-owners, so ids cannot
  be enumerated. In-flight caps are enforced under a per-user advisory lock.
- Statement markdown: raw HTML is rendered as inert text; h1/h2 are demoted;
  no images in Phase 1.
- `revalidateTag('platform-theme')` clears only the replica that handled the
  save. With two web replicas this needs a shared cache handler or a
  broadcast — *Phase 10*.

### Design system
- **The required contrast pairs cannot all be met with the spec's literal
  derivation constants** (every derived preset would fail). Derivation keeps
  the specified starting values and adds documented step-until-pass repairs
  (like the specified `muted` clamp). Consequences on *derived* themes: light
  primaries are deeper than their seeds (OKLCH l ≈ 0.38–0.42); dark primaries
  are pastel (l ≈ 0.78) with **dark** text, because no colour reaches 4.5:1
  against both white and the dark surface; `border-strong` is darker (3:1);
  the focus ring sits between primary and surface (ring/surface ≥ 3 and
  ring/primary ≥ 3 can only both hold that way). rec-purple is untouched.
- **The canonical rec-purple palette itself fails 7 required pairs** (light
  border-strong/surface 1.53, light ring/primary 1.68, dark primary-fg/primary
  4.23, dark primary/primary-subtle 3.76, dark primary/primary-soft 3.13, dark
  border-strong/surface 1.53, dark ring/primary 1.56). It is the verbatim LMS
  palette and ships as-is; the branding report lists these honestly.
  *Revisit with the LMS owners — `border-strong` at 1.53:1 is below the WCAG
  non-text contrast guideline for input borders.*
- `--shadow-color` uses the seed's HSL hue (the token is consumed as
  `hsl(var(--shadow-color) / a)`); 262 for rec-purple.
- The palette JSON is validated strictly before `buildBrandCss`, so a
  tampered row cannot inject CSS.

### Infrastructure
- MinIO for local containers is pinned by digest to the community image
  `pgsty/minio` (the upstream image is no longer pulled anonymously). The
  production object store is an open decision.
- The judge firewall additionally allows DHCP, NTP to the app host and SSH
  from an admin CIDR; there is no DNS egress (hosts file). Production judges
  should run an Ubuntu kernel ≥ 6.6 (`unprivileged_userns_clone` exists only
  on Debian/Ubuntu kernels; tmpfs quotas need 6.6).
- `recjudge-worker.service` cannot set `NoNewPrivileges` (isolate is setuid).

## Phase 2 — decisions recorded during the build

### Time limits and validation
- **Measured limits.** With a measured model solution in a language:
  `clamp(ceil_100ms(max(2.5 × measured, baseTL)), 200 ms, 15 s)`; without one,
  the fallback multiplier applies to the author's base (C++) limit. The
  prompt's single formula mixes both terms; this split is the narrower
  reading. The claiming node's startup credit (median hello-world CPU ms,
  capped at 1 s) is added at claim time.
- **Validation is two-stage.** Stage 1 runs every expected-AC model solution
  at the 15 s ceiling to measure; limits are then derived; stage 2 judges the
  deliberately-wrong solutions with the derived limits. Publish is blocked
  unless a C++ model exists and matched, every model matched, and every
  deliberately-wrong solution failed as expected. For a SUBTASK problem a
  deliberately-TLE brute force earns partial credit, so a PARTIAL verdict
  whose worst failing test equals the expectation counts as a match.
- Reference solutions in languages that are not enabled are skipped with a
  note (except the mandatory C++ model).

### Scoring and checkers
- SUBTASK: tests run subtask by subtask in dependency order; MIN earns the
  points only if every test passes (early stop only inside MIN subtasks, only
  with stopOnFirstFailure, only on a zero-credit test); SUM_FRACTION earns the
  passed share; a subtask whose dependency was not fully passed is SKIPPED
  without running. Overall: AC at full score, PARTIAL with some points, else
  the worst verdict by precedence. A malformed subtask table is a permanent
  failure.
- CHECKER: testlib 0.9.41 (`TESTLIB_ID`), compiled with
  `-DPC_BASE_EXIT_CODE=16` (testlib's default base is 0, which would make
  `_pc(n)` collide with WA/PE/FAIL). Exit 0 → AC, 1/2 → WA, 3 → checker FAIL,
  16+n → n % partial credit (`_pc(0)` → WA: zero credit is not partial),
  anything else (incl. exit 7 / `quitp`) → checker FAIL. **A checker FAIL is
  never a WA**: the job is released permanently (INTERNAL_ERROR) with the
  checker's first line, visible to admins.
- Under ICPC a test with partial checker credit fails the job (WA, score 0).
- Compile errors are never cached; compiled artifacts are cached 1 h by a
  key over language, toolchains, argv, env and the harness-wrapped source.
- Checker report text is capped at 500 bytes (the protocol's message field
  allows 512). *Next protocol bump: an admin-only checker report field and a
  per-test credit fraction.*

### Lanes, allocator and node health
- The worker allocates slots itself (BullMQ manual fetch): RUN keeps 2 hard
  slots (1 on nodes with < 3 slots, never the last slot of a node that also
  serves another lane); PRACTICE has a 25 % floor; ASSESSMENT ≤ 60 %, CONTEST
  ≤ 50 %, REJUDGE ≤ 20 % (0 on nodes with < 5 slots and while the assessment
  backlog exceeds 50). A node never holds a job it has no slot for.
- Sensitive lanes (ASSESSMENT, CONTEST) are withheld when calibration
  deviates > 10 % from the ONLINE fleet median or is stale (> 6.5 h), the
  self-check failed or is stale, or host hardening failed or was not
  reported. The claim lease refuses such jobs atomically without spending an
  attempt.
- **Host hardening on development machines.** The WSL2 development kernel
  cannot pass the sysctl check and its settings are not changed (they are the
  machine owner's). Development uses two explicit, production-refused
  overrides: `RECX_DEV_ALLOW_UNHARDENED_HOST=1` (worker: take jobs anyway)
  and `JUDGE_ALLOW_UNHARDENED_NODES=true` (web: do not quarantine, allow every
  lane). Both are refused at startup when `NODE_ENV=production`.
- Self-check fixtures run in maintenance boxes 900–909 (clear of job boxes);
  with CPU pinning they sit on the housekeeping CPUs, so calibration measures
  a housekeeping core. *Revisit: calibrate per slot core before intake if the
  fleet comparison should reflect slot cores.*
- A node advertises a language only if its hello-world compiled and ran in
  the sandbox at boot (directory existence alone proves nothing).
- A permanent release (a job no node can judge) does not count toward a
  node's auto-drain.

### Caps and usage
- `UserJudgeUsage.submissions` counts PRACTICE-origin submissions only (it
  backs the 300/day practice cap); CPU is charged for every origin except
  admin rejudges (lane REJUDGE), which never charge the student again.
  Internal errors and discarded results are never charged.
- Per-user cap overrides are SUPER_ADMIN only and audited; in-flight caps
  cannot be overridden; a cap of 0 is not allowed (account status exists for
  blocking).

### Toolchains
- **Go** cannot use `go build` inside a box (no /tmp, file locks blocked by
  the syscall filter, a cold cache rebuilds the standard library at ~7 s
  CPU). The toolchain ships a prebuilt standard library and
  `bin/recx-go-build` (`go tool compile` + `link`): ~0.1 s CPU.
- **py312 + numpy**: OpenBLAS starts one thread per host CPU and crashed with
  `--processes=1`; the runtime now pins `OPENBLAS_NUM_THREADS=1` /
  `OMP_NUM_THREADS=1`.
- **JVM / V8 heap sizing** (Phase 4, before enabling Java/Kotlin/Node): boxes
  have no /sys, so the runtimes size their heaps from host RAM and an
  allocation-heavy program hits `--cg-mem` (MLE) before collecting. The run
  argv needs a heap cap derived from the memory limit (`-Xmx`,
  `--max-old-space-size`).
- Kotlin compiles take 10–11 s CPU against the 25 s slow cap — tight on
  slower cloud cores.

### Scheduler and retention
- The scheduler reconciles ValidationRun like submissions and runs; an
  exhausted validation run is INTERNAL_ERROR with outcome FAILED.
- Retention (Phase 2 scope): SubmissionTestDetail after 30 days, one batch of
  10,000 per tick. A `PlatformSetting` key `retention` with
  `{legalHold: true}` suspends every purge including the RunRequest TTL; a
  malformed setting fails closed (no deletes).
- The scheduler cannot write the audit log (audit lives in the web app); its
  IE finalisations and lane withdrawals are log alerts. *Revisit: move audit
  into a shared server-only package.*
- The rate limiter's decision now runs atomically in a Redis Lua script on
  Redis's clock: the previous client-clock version admitted 4 of a 10-request
  concurrent burst against a limit of 3.

## Phase 3 — decisions recorded during the build

### Progress, XP and streaks
- **Activity moment = submission time** (Submission.createdAt), not the
  moment the judge finished: it decides the campus day (Asia/Kolkata) for
  ActivityDay, the streak, the daily caps, the daily challenge, the WEEK /
  MONTH bucket keys and XpEvent.occurredAt.
- IE is never an attempt; every other verdict (CE and PARTIAL included) is an
  attempt and counts as streak activity (a judged submission — signing in
  never does). Only AC is accepted.
- XP is awarded once per first solve: the XpEvent idempotency key is unique
  and buckets / ActivityDay / UserStats move only by what was actually
  inserted. A fully capped award is still written once (amount 0,
  `meta.capped`).
- **Streak milestone XP** (7 / 30 / 100 days: 30 / 100 / 300 XP, the LMS
  values) pays once ever, is not subject to the Easy cap but is subject to
  the 2,000/day total cap, and is bucketed for leaderboards.
- **Assisted** = a tier-3 hint revealed or the editorial first viewed strictly
  before the submission was created. A revealed tier counts across problem
  versions.
- Admin rejudges credit only a missed first solve; they never touch attempt
  or submission counters or the streak, and **a rejudge never takes a solve
  away** (no automatic penalty). A rejudge that turns WA into AC does not
  increment ProblemStat.accepted (the previous verdict is gone) — the
  acceptance rate can be off by one per such rejudge.
- Progress runs behind a savepoint inside the finalise transaction: if it
  fails it is rolled back and logged and the verdict still commits. *Open:*
  there is no automatic recompute job yet; submissions judged in Phases 1–2
  are not reflected in progress (dev data only).
- XP difficulty comes from the pinned problem version.
- **XP rules are super-admin adjustable**: PlatformSetting `xp` holds a
  validated override (base XP per difficulty, multipliers, daily caps) with
  its own rules version recorded on every later XpEvent; written only by
  `updateXpRules` (SUPER_ADMIN, audited). An invalid stored override is
  ignored and logged. The settings page arrives with `/super` in Phase 4.
- `ProblemStat.acceptanceRate` is a 0–1 fraction (accepted / submissions),
  maintained in the finalise transaction.

### Leaderboards
- Hidden from peers = `leaderboardOptOut` OR role ≠ STUDENT. Ranks count
  visible rows only; ties are competition-style ("1, 2, 2, 4") on exact
  (xp, lastXpAt). *Open:* graduated or disabled students' buckets still count
  on all-time boards — decide with Phase 8.
- Snapshots freeze closed WEEK and MONTH periods 30 minutes after they close
  (top 200 per COLLEGE / DEPARTMENT / BATCH / SECTION), looking back 8 weeks /
  ~100 days. Only "Last week" reads a snapshot.
- The full board is virtualised; rows are shipped as compact tuples (capped
  at 10,000 rows).

### Daily challenge
- Picked deterministically per campus day (rendezvous hash) among published
  problems, preferring Easy/Medium, avoiding reuse within 30 days; tomorrow's
  row is prepared in the last 10 minutes before campus midnight. An
  admin-set row is never replaced.

### Hints, editorial and active time
- One chokepoint (`getHelpState` → `helpAccess`); the context is decided on
  the server, never taken from the client. Reveals and editorial views are
  not audited (the student's own study activity; the row is the record).
- Active time: one accepted ping per 20 s per problem (enforced in Postgres,
  so it cannot fail open), credit capped by wall-clock time since the last
  ping, the first ping only starts the clock, ActivityDay.activeSeconds
  capped at 86,400/day. A ping inside the window is answered 202 "deferred"
  (not an error) and the tracker keeps its seconds.

### Workspace
- Full-bleed workspace via `<WorkspaceFrame>` (the shell reacts with CSS
  `:has()`); one React tree at every width — below 1024 px a three-tab single
  column (Problem / Code / Result), below 768 px CodeMirror 6, chosen once per
  mount so undo history is never lost when the window is resized.
- Drafts: IndexedDB (400 ms) and server CodeDraft (3 s, blur, pagehide
  beacon); newest wins by device edit time, clamped server-side to now + 2
  min; the other copy is offered by a "Restore" bar. A draft above ~60 KB
  cannot be beaconed during unload (browser keepalive quota) — the IndexedDB
  copy covers it and syncs on the next visit.
- **Solutions and Discussion tabs are deferred to Phase 11** (solution
  sharing gated behind an unassisted solve ships with the TA_MENTOR
  moderation role). They are not rendered rather than shown dead.
- **The console drawer never hides the caret.** It overlays the bottom of
  the editor (55 % of it, never a squeeze: the editor keeps its size and
  layout). The workspace measures how much of the editor it covers and the
  editor treats that strip as off screen: Monaco gets that much extra bottom
  padding and scrolls just enough to keep the caret line and the next above
  the drawer — on opening it and on every caret move while it is open; the
  plain-textarea fallback and CodeMirror do the same (padding + scroll,
  CodeMirror through its scroll margins). An editor whose caret is already
  clear does not scroll. When the editor's own box shrinks (the status row
  under it wraps onto a second line), Monaco keeps a caret that was in view
  in view. Measured: `docs/CAPACITY.md` §7.
- While the workspace HTML is still streaming in, the statement pane keeps
  its 38 % share (`:not(:has(~ *))`; Chrome does not match `:only-child`
  until the parent has finished parsing) instead of painting full-width and
  snapping back — a 0.07 layout shift on warm loads. *Open:* one residual
  0.0759 warm-load shift in nine throttled runs (a partially streamed
  statement paragraph); the perf spec records the shifted nodes' x and width
  to pin it down. *Open:* the status row under the editor wraps onto a
  second line for long language labels (Python), so the editor is 18 px
  shorter than for C++ — reserve the row's height or keep it on one line.

### Catalogue, plans, notes
- Topic filter is single-select (difficulty multi-select); filters apply on
  submit (no auto-submit, WCAG 3.2.2) and work without JavaScript.
- Company tags are intentionally empty: no claim that a company asked a
  problem is invented. The curated-company filter stays hidden until the
  placement cell curates tags (and Phase 11's interview-experience archive).
- Notes: 64 KB, 1,000 per student, a write/preview budget; deleting a note
  is audited, edits are not. Enrol / leave / bookmark are not audited
  (personal, reversible).
- `/accessibility` currently requires sign-in. *Revisit:* a public copy
  linked from /login. The accessibility contact is still to be named.

### Design: dark-theme contrast
- The canonical dark `--primary` (#8b5cf6) measures 4.23:1 under white text
  and 4.1–4.5:1 as text on the dark surfaces — below WCAG AA for normal text,
  which axe reports as serious. `tokens.css` stays verbatim; a dark-only rule
  in `packages/design/utilities.css` paints filled primary surfaces with
  `--primary-active` (#7c3aed, 5.7:1) and primary text with
  `--primary-hover` (#9d74f8, 5.3:1). Consequence: in dark mode, REC Code's
  primary buttons are one step deeper than the LMS's. *Recommend the LMS
  adopts the same fix in its tokens.*

### Sign-in page: zero JavaScript
- **`/login` is the one Pages Router page, and it ships no JavaScript**
  (`unstable_runtimeJS: false`). As an App Router page it measured 113.6 KB
  of first-load JS against the 90 KB budget, almost all of it the React
  runtime and Next client that every App Router page carries — and a sign-in
  form needs none of it. The form posts to `POST /api/auth/login`, which
  answers with a 303 to the role's home or to `/login?error=<code>`; the
  messages, `aria-invalid`, `aria-describedby` and the focus target are
  server-rendered. Rate limits, the Argon2id decoy, the audit trail and
  session rotation are unchanged (`docs/SECURITY.md` §2, "The sign-in
  flow"). Consequences: no client-side validation or "show password" toggle
  (native `required` / `maxlength` only); with a `pages/` directory present,
  Next types `usePathname()` as nullable in the App Router too. *Open:*
  `unstable_runtimeJS` is an experimental Next flag — re-check it on every
  Next upgrade (`pnpm --filter @recx/web size` fails if a script reappears).
  `next dev` ignores the flag and always adds its client and HMR scripts
  (and hides `<body>` until they run), so `_document` stamps the request's
  CSP nonce on Next's scripts — otherwise the dev page stays blank.
- The typed roll number / email survives a failed attempt in a 60-second,
  `/login`-only, httpOnly cookie (cleared when read), never in the URL.

### Front-end budgets
- **The "Monaco chunk ≤ 1,050 KB lazy" is the main-thread Monaco code a
  cold workspace load fetches**: `loader.js` + `editor/editor.main.js` + the
  largest tokenizer grammar offered (942.1 KB gzip on 2026-10-10). The editor
  web worker (`base/worker/workerMain.js`, 112.0 KB) is a separate worker
  script, not part of that chunk; it has its own budget line (120 KB) so it
  stays measured. Counting it in the chunk read 1,054 KB. `editor.main.css`
  and the codicon font are reported, not budgeted (not JS).
- `/login` is measured from the served HTML of the production build (the
  size script serves it in-process), not from manifests: 0 KB, no
  `<script src>`, no script preload, no `__NEXT_DATA__`.
- Numbers and method: `docs/CAPACITY.md` §7.

## Phase 4 decisions

Each Phase 4 stream appends its own sub-heading below.

### Phase 4 — foundation
- **Active-grant uniqueness is a partial unique index, not a lock-only
  rule.** `AdminScope_active_grant_key` (`adminId, departmentCode,
  batchYear` `NULLS NOT DISTINCT WHERE "revokedAt" IS NULL`),
  `Accommodation_one_approved_per_user` and
  `Accommodation_one_open_request_per_user` live in migration
  `20261010100000_phase4_admin_authoring` only. Prisma 6.16.2 does not diff
  partial indexes: `prisma migrate diff --from-migrations … --exit-code`
  stays clean (exit 0), while a control with one extra non-partial index
  reports drift (exit 2). A duplicate surfaces as `unique_violation`
  (Prisma P2002); actions may still take
  `pg_advisory_xact_lock(hashtext('admin-scope:'||adminId))` and pre-check
  for a friendlier message. The indexes are not deferrable, so approving a
  superseding accommodation must move the old row out of APPROVED first,
  in the same transaction.
- **The seeded scope of `RECADMIN02`** (CSE, every batch, granted by
  `RECADMIN01`) is created only while that admin has no `AdminScope` row at
  all, so re-seeding neither duplicates it nor undoes a revoke or re-scope
  made in the app.
- **Re-seeding never changes an existing account's role, status or
  password.** The seed writes role, status and the password hash only when
  it creates an account; on an existing one (matched by `collegeId`) it
  refreshes only the profile fields it owns (names, email, handle, batch,
  department, section). A role that differs from the seed's is kept and
  logged.
- **`runAction` recognises `FrozenVersionError` by its name and its
  `code`**, not by `instanceof`, so `lib/errors.ts` (reachable from client
  components through `import type`) never loads the Prisma client. Only
  code `"frozen"` (a write reached a published revision) shows the conflict
  message. Code `"born_frozen"` (creating an already-frozen revision) can
  only come from a bug in the calling code, so it is logged with a
  reference id and the user sees the generic message. A write that only the
  database trigger refuses (a nested write the repository guard cannot see)
  also shows the generic message with a reference id.
- **nodemailer 10 ships its own type declarations**, so `@types/nodemailer`
  (8.x, written for nodemailer 8) was removed from `apps/scheduler` in the
  foundation fix-up. A scheduler file using `nodemailer` and
  `nodemailer/lib/smtp-transport` type-checks against the package's own
  declarations. nodemailer is pinned to 10.0.10, the newest release at
  least two weeks old on 2026-10-10.
- **Governance rows are guarded by the database** (migration
  `20261010100050_phase4_foundation_fixes`; the schema `///` comments list
  each rule). Readings chosen where the designs were silent:
  - a `PrivilegedOperation` is INSERTed only as an undecided PENDING
    request (no decision or execution fields);
  - its `artifactAvailableUntil` is written by the EXECUTING → EXECUTED
    update itself, not by a separate update while EXECUTING; `result` and
    `error` likewise only by EXECUTING → EXECUTED | FAILED;
  - nothing moves an APPROVED operation to EXPIRED (only PENDING expires);
  - an `Accommodation`'s decision fields are set once, so a revoke reason
    goes to the audit row (or to `decisionNote` only while it is still
    null);
  - an `Announcement`'s publish UPDATE sets `publishedAt`,
    `publishedById` and `recipientCount` together; after that the text,
    audience and count are fixed;
  - `AdminScope.revokedAt` and `revokedById` are written together, and
    `ImpersonationSession.endedAt` and `endReason` likewise.
  TRUNCATE is refused on these four tables and on ProblemVersion, its frozen
  child tables and TestBlob (nothing in the repository truncates them).
  DB tests that delete such rows disable the row triggers inside one
  transaction and re-enable them before it commits.
- **Second database fix-up** (migration
  `20261010100080_phase4_foundation_fixes_2`). Readings chosen:
  - an `Accommodation` is INSERTed only as REQUESTED. "Approve now" by a
    SUPER_ADMIN is an INSERT as REQUESTED and then the approving UPDATE in
    the same transaction. Because of `Accommodation_one_open_request_per_user`,
    approve-now is refused while the student already has an open request
    (decide or withdraw that one first);
  - the decision (`decidedById`, `decidedAt`, `decisionNote`,
    `approvedBySuperAdminId`, `grantedAt`) is written only by the single
    UPDATE that leaves REQUESTED. This replaces the earlier note above: a
    revoke reason always goes to the audit row, never to `decisionNote`;
  - **WITHDRAWN carries `decidedById` and `decidedAt`** (who withdrew and
    when), like REJECTED. The design lets either the requester or a
    SUPER_ADMIN withdraw, so the row must name the person. A PrivilegedOperation
    CANCELLED stays without a decider, because only the requester can cancel
    and `requestedById` already names them;
  - APPROVED → SUPERSEDED needs a REQUESTED successor (same student,
    `supersedesId` = the old row) at that moment. Beyond what was asked, once
    the old row is SUPERSEDED that successor can only be approved: it cannot
    be withdrawn, rejected, unlinked or deleted. So a superseded grant always
    has its replacement;
  - time windows at INSERT allow 5 minutes either side of the database clock
    (`PrivilegedOperation.requestedAt`, `ImpersonationSession.startedAt`),
    because Prisma fills `@default(now())` from the application clock;
  - a PrivilegedOperation is approved or rejected only before `expiresAt`, and
    expired only after it, both on the database clock. APPROVED → EXECUTING is
    not time-limited: `expiresAt` bounds the wait for a decision, and nothing
    can move an APPROVED row out except execution;
  - CANCELLED and EXPIRED operations carry no decider, no `decidedAt` and no
    break-glass flag;
  - an Announcement is created as an unpublished draft. Once published it is
    never deleted (archive it instead), and TRUNCATE is refused on it;
  - TRUNCATE is also refused on `XpEvent` and `AuditLog`. AuditLog row DELETE
    stays allowed for the 3-year retention purge (legal hold excepted);
  - left to the application, as before: the 3-download cap and the download
    window of a PII export, and the value of `AdminScope.revokedAt` (any
    timestamp is accepted).
  The static fence (`packages/db/test/frozen-coverage.test.ts`, catalogue in
  `packages/db/test/support/guard-catalog.ts`) lists every hand-written CHECK
  up to this migration. A later migration that adds CHECKs (e.g. the planned
  function-comparator CHECKs) should add them to `HAND_WRITTEN_CHECKS` and move
  `CHECK_CATALOG_THROUGH` forward; until they are listed, the fence does not
  protect them.

### Phase 4 — D2 seed content
- **The three CUSTOM_CHECKER seeds (session-order, exact-change-pair,
  no-neighbour-seating) use hand-written testlib checkers**, not text
  generated by `checkerTemplate` when the module loads. Each checker is one
  self-contained source: a small JSON-line reader shared through
  `apps/web/scripts/content/checker-json.ts` is pasted into it, then the
  problem's own rule. A malformed or invalid value in `output.txt` is `_wa`;
  in `input.txt` or `answer.txt` it is `_fail`, so a broken test reaches an
  admin instead of a student. Generating at load time would change a frozen
  checker's text, and its sha256, whenever the template changes.
- **No java21 starter rows for the six seeds.** java21 is not enabled by
  default, and the workspace already falls back to `starterStub(language,
  signature)` for any language without a stored starter. The existing
  FUNCTION seeds store only cpp20 and py312 starters too. Every seed does
  have a java21 model solution.
- **exact-change-pair allows up to 2·10⁵ prices** (the design table set no
  limit). With 10⁵ prices, the deliberately-slow O(n²) reference ran in only
  about 1.5 s against the 1 s limit, too close for a golden gate on faster
  hardware. At 2·10⁵ it runs about 7 s of CPU time, roughly 300 times the
  model.
- **no-neighbour-seating's deliberately-wrong reference (odd roll numbers
  first, then even) fails on exactly one allowed size, n = 4.** The tests
  include n = 4 as a hidden test on purpose, and the samples (n = 5, n = 1)
  do not catch it.
- **playlist-fold cannot tell relinking from rewriting `val`s.** The
  statement asks for relinking and the editorial teaches it, but a solution
  that copies the values into an array and writes them back in the folded
  order is also accepted. The judge prints the list from the head node only.

### Phase 4 — E /judge transparency
- **`/judge` is reachable signed out but stays `noindex`.** It inherits the
  root layout's `robots: { index: false, follow: false }`. Should the
  public judge specification be indexable by search engines?
- **Only enabled, current toolchains are listed.** Retired toolchains
  (still used when an old submission is rejudged) and catalog languages
  that are not enabled are not shown. Should either be?
- **Live fleet facts are not published.** Each judge's measured start-up
  credit and its isolate version (`JudgeNode`) stay admin-only; `/judge`
  states the method and the cap, not per-node values.
- **The workspace footer shows the version and a link, not the time
  limit.** The per-problem, per-language limit (`ProblemLanguageLimit`, or
  the fallback `jobTimeLimitMs` derives) could also be shown there; deferred.
- **The start-up credit cap is now applied.** `LIMITS.startupCredit.maxMs`
  was declared ("it is capped") but nothing read it; `startupCreditFor()`
  in `apps/web/src/lib/judge/claim.ts` now applies `Math.min(…, maxMs)`, and
  `/judge` publishes the cap. If the cap is rejected, the page must drop
  that row.
- **The per-box inode limit is not published**, because nothing enforces
  `LIMITS.scratchDisk.inodes` (no per-slot tmpfs). Only enforced limits
  appear on `/judge`.
- **JVM heap flags replace the heap caveat for Java and Kotlin.** The
  harness stream's `jvmRunFlags()` (`@recx/shared`) existed when the page
  was built, so each JVM language shows the flags the worker inserts after
  the `java` program, computed for the default and the ceiling memory
  limit. The garbage-collector caveat remains only for an enabled managed
  runtime without a memory-derived heap ceiling (Node.js, Go; both off by
  default).
- **The footer link opens a new tab** so the editor is never left. The
  contest arena and assessment attempt surfaces (Phases 5-7) must pass
  `judgeLink={false}` to the workspace.
- **Revalidating the language list is best effort.** `setLanguageEnabled`
  has committed and audited the toggle before it calls
  `revalidateLanguageConfigs()`; a failure to revalidate is logged, never
  reported as a failed toggle, and the cache's 60-second backstop still
  applies.
- **`/judge` is in the student sidebar's footer links** ("Judge
  specifications", after "How judging works"), so `shell-nav.test.ts`
  now expects three secondary links.
- **`/help` reads the runtime JSON, not the catalog.** Its fallback
  multiplier table used `LANGUAGE_CATALOG`, which can drift from the
  `LanguageConfig.runtime` the worker receives; it now uses the same rows
  and view model as `/judge` and links there.
- **The "scaled for other languages" link in the problem statement was not
  added.** `components/workspace/problem-description.tsx` belongs to the
  harness stream in Phase 4; linking it to `/judge#time-limits` is left for
  integration.

### Phase 4 — D1 harness
- **FUNCTION harness languages: C++ (cpp17, cpp20), Python (py312,
  pypy310) and Java (java21).** C has no classes or generics and would need
  a different calling convention (sizes, malloc'd results). JavaScript cannot
  hold a `long` above 2^53 without BigInt. Go needs a different generator and
  error format. Kotlin compiles at 10–11 s of CPU, paid on every submit of a
  wrapped source. Every harness language also needs a reference solution for
  every FUNCTION problem, forever. A FUNCTION problem simply does not offer
  the others: the workspace names them in a note, Submit and Run refuse them,
  validation marks such references not runnable, and the worker refuses them
  permanently.
- **java21 ships its harness but stays `enabledByDefault: false`.** Enabling
  Java is a flag flip in a later change, which must also add Java model
  solutions for the three STDIN seeds (bracket-cleanup, study-pairs,
  second-swipe). Every FUNCTION seed already has one; the golden suite judges
  them with `RECX_GOLDEN_EXTRA_LANGUAGES=java21` (linux-gate.sh).
- **Comparator semantics.** SET_EQUAL ignores order at EVERY list and matrix
  level (a multiset at each level; pairs keep their order; strings, trees and
  linked lists compare exactly). ROWS_ANY_ORDER ignores only the top-level
  order; each row is exact. Both are now judged (protocol 3).
- **Doubles are allowed in the compared type only under FLOAT_TOLERANCE or
  CUSTOM_CHECKER**, because C++, Python and Java print the same double
  differently (`1` / `1.0` / `1.0E-9`). A FLOAT_TOLERANCE compared type must
  contain a double. Parameters may hold doubles under any comparator.
- **IN_PLACE_MUTATION needs a void method and a list, matrix, TreeNode or
  ListNode parameter.** Strings, numbers and pairs cannot be changed in place
  in Python and Java. A parameter reassigned inside the method is invisible
  to the caller in all three languages, so "reverse a linked list in place"
  is not judgeable this way (playlist-fold keeps the head node fixed).
- **The CHECKER mirror.** A FUNCTION version has compareMode CHECKER exactly
  when its comparator is CUSTOM_CHECKER; otherwise TOKEN by convention, and
  the judge ignores it. Enforced by `comparatorIssues()` (the publish gate),
  by `buildJudgeJobSpec` and the worker (permanent refusal), and by CHECK
  `ProblemVersion_function_checker_mirror` on the freeze. "Cannot publish
  without a declared comparator" is CHECK
  `ProblemVersion_function_comparator_declared`; a frozen CHECKER version
  names its checker and testlib (`ProblemVersion_checker_present_when_frozen`).
  All three are in migration `20261010100100_function_comparator_checks` and
  are NOT yet listed in the static fence's `HAND_WRITTEN_CHECKS`
  (`packages/db/test/support/guard-catalog.ts`, foundation-owned).
- **Structured comparison applies to already-published FUNCTION versions.**
  Every FUNCTION problem's output is now decoded strictly and compared by its
  comparator instead of token by token (which accepted `"a  b"` for `"a b"`,
  lost precision above 2^53, and rejected Python's `null` for an empty tree).
  This is a judge fix, not a content change: the frozen versions are
  untouched; an optional rejudge applies it to old submissions.
- **Any extra standard output is Wrong Answer** (with the reason "Standard
  output must contain only your function's result…" on visible tests).
  Open question: frame the result line (a sentinel the harness prints before
  the result) so debug prints are shown but ignored?
- **`char` is one ASCII character** (a C++ `char` is a byte). A string's
  length in non-ASCII text differs by language (C++ counts UTF-8 bytes,
  Java UTF-16 units, Python code points); statements should say "ASCII" when
  length matters.
- **JVM run flags:** `-Xmx` = max(32, ⌊0.7 × MB⌋) MB and `-Xss` = min(MB,
  256) MB, MB = the job's memory limit; inserted by the worker right after
  the `java` program for java21 and kotlin20 (`jvmRunFlags()` in
  `@recx/shared`, published on /judge). This settles the Phase 2 "JVM / V8
  heap sizing" item for the JVM; V8 (node22) remains open.
- **The CUSTOM_CHECKER file contract.** `input.txt` = the test's input (one
  JSON line per parameter), `answer.txt` = the jury's answer (one valid
  result), `output.txt` = the student's result already decoded and
  re-serialised canonically by the judge. Output that does not decode is WA
  before the checker runs, so a checker never sees malformed student output.
  `checkerTemplate(sig)` emits a complete, self-contained testlib checker
  with the harness's own reader and a TODO; a value that does not parse is a
  checker FAIL (through testlib's `quitf(_fail, …)`).
- **Custom Run input for a FUNCTION problem is validated before anything is
  queued** (`validateFunctionInput`): one line per parameter, each a valid
  value of its type. JSON whitespace and non-canonical spellings (`[1, 2]`,
  `null` for an empty tree, `1.0` for a double) are accepted because every
  harness reads them identically; extra non-blank lines are refused.
  Authored tests must be exactly canonical (`validateFunctionTest`).
- **Reserved names.** Parameter and method names may not be a keyword of
  C++, Python or Java, `self`, `main`, `Main`, `Solution`, the judge's own
  class names, a C library macro (`NULL`, `EOF`, `errno`), a C++ reserved
  spelling (`__x`, `_X`) or start with `recx`; the method may not be a
  `java.lang.Object` method name (`equals`, `wait`, …).
- **The per-test reason reaches the worker result but not yet the student's
  screen.** The worker puts the comparator's reason ("not a valid
  list<int>…", "extra output…") in `TestResult.message` for visible tests and
  validation jobs only. Validation runs store it (admins see it); the student
  view of a submission or run does not show test messages yet — the
  comparator-aware note under a Wrong Answer is shown instead. Should sample
  tests show the reason?
- **The golden suite imports seed content from apps/web** by relative path
  (`apps/web/scripts/content/index.ts`); the content modules may import only
  `@recx/shared*` (tests/repo/content-purity.test.ts), so the judge worker
  never reaches the database or the web app. It judges with the
  student-facing fallback time limits (`deriveTimeLimitMs`, no measurement)
  and boxes 70/170/270; the new harness and compile-error suites use bases 80
  and 90 — all clear of a live worker's 0–7 / 100–107 / 200–207 and
  maintenance 900+.
- **`validationOutcome` / `effectiveVerdict` are single-sourced in
  `@recx/shared/harness` (`outcome.ts`)** for the golden suite;
  `apps/web/src/lib/judge/validation.ts` (authoring-owned) still has its own
  copy and should re-export these.
- **C++ calls the method through `auto`, Java through a typed local.** A C++
  method returning a different but printable type compiles and is judged on
  its output; in Java the mismatch is a compile error labelled as the
  judge's code with the signature hint.
- **The Description tab's "scaled for other languages" now links to
  `/judge#time-limits`** (the item stream E left for integration), since the
  harness stream owns `components/workspace/problem-description.tsx`.

### Phase 4 — C authoring

- **The launch content target stands, with owners still unnamed.** 450
  originally authored problems (180 Easy / 200 Medium / 70 Hard). Owners per
  difficulty and topic: *TBD by the placement cell*. Content, not code, is the
  binding constraint on launch (docs/AUTHORING.md). Who owns which slice?
- **APPROVED is `status = IN_REVIEW` with `approvedAt` set.** `ProblemStatus`
  is unchanged; RETIRED exists only on `Problem.status` (a frozen version
  cannot be written); SUPERSEDED is derived. `reviewStageOf()` in
  `@recx/shared/authoring` is the one mapping.
- **The approver must differ from the revision's creator, last editor and
  submitter.** The one exception is the operator CLI
  (`validate-and-publish.ts --approve`), recorded with `approvedById` null and
  via `cli:<operator>`; the operator also submits on the author's behalf and
  that submission carries the originality attestation.
- **Only ADMIN and SUPER_ADMIN author and review.** TA_MENTOR and senior-student
  contributions arrive through an admin-run import, with `origin` and the
  submitter's originality attestation recorded.
- **"Pass in every enabled language"** means every reference solution in an
  enabled language (and, for FUNCTION problems, one with a harness) gets its
  expected verdict, with a C++ model mandatory. It is not read as "every
  enabled language must have a model" for database-held problems; seeded
  content does have a model per enabled-by-default language (golden test).
- **Retire, delete and un-retire.** Retire and delete belong to the
  governance stream (`super-problems.ts`); the authoring pages only render
  them for SUPER_ADMIN. There is no un-retire, and publishing a RETIRED
  problem is refused by the publish gate.
- **Slug and display code never change after creation.** The display code
  is `REC-` plus four digits.
- **Import limits and rules.** The UI takes a zip only; directories go
  through the CLI. There is no dry run, and validation is not started
  automatically (300 imports land on the REJUDGE lane at ≤ 20 % of slots; the
  import page has "Validate imported drafts"). A single file is capped at
  64 MiB (larger needs a streaming `TestDataStore.put`). An import never
  overwrites an open draft, and topics are applied only on CREATED (a
  difference is a warning).
- **One running upload per admin is checked, not locked.** Two uploads posted
  at the same instant by the same admin could both start; each still imports
  correctly (per-slug locks), only the 409 is skipped.
- **An interrupted import is shown as interrupted when read** (PROCESSING for
  over 30 minutes) and marked FAILED for good by the next upload's sweep;
  pages never write.
- **The test-upload action takes typed text only:** at most 100 tests and
  900 KB per call, no NUL bytes. Binary or larger test sets go through import.
- **Statement-only edits do not invalidate validation** (`editSeq` vs
  `judgeSeq`). Hints, editorial and starter code are statement-like; tests,
  subtasks, references, limits, modes, signature and checker are judging.
- **Validation may run on a revision in review or approved** (it does not
  change content); `check-approved.ts` relies on that. A failing re-run does
  not revoke an approval by itself — `check-approved.ts --revoke` does, and
  publishing re-checks validation anyway.
- **Bundles are written once, after the freeze.** The publish transaction
  pins `bundleKey` / `manifestSha256` and the bytes are put after the commit;
  a failed put is audited (`problem.bundle.write_failed`) and repaired with
  `check-approved.ts --repair-bundles`. A dev database may hold pre-Phase-4
  draft bundles under the same key with other bytes (keys are immutable): such
  a revision is published without a bundle (`bundleKey` null, audited with
  reason `key_holds_other_bytes`). The judge never reads bundles, so judging is
  unaffected. Garbage collection of orphan blobs is deferred.
- **`publishVersion({ requireApproval: false })` stays for the pre-review
  library tests only;** every action and CLI path requires an approval.
- **The trigger tying `Problem.liveVersionId` to a frozen version of the same
  problem is deferred** (Phase 3 fixtures point it at drafts); the publish
  path is the fence.
- **`check-approved.ts` is an operator or cron command,** not a CI job,
  because APPROVED rows live in the production database. Run it after any
  toolchain or language change (RUNBOOK §2.10).
- **Retiring does not recount study-plan totals** until the sheets stream
  exposes a hook (governance's `retireProblem` revalidates pages only).
- **The submission page shows the problem as judged.** Besides "Judged
  against revision N" it renders the pinned revision's statement in a
  collapsed "Problem as judged" section — a full as-judged statement, not
  only the revision number.
- **A FUNCTION draft's compare mode follows its comparator** (CHECKER for
  CUSTOM_CHECKER, otherwise TOKEN) on create, edit and import; the
  "Comparator" select applies to STDIN problems.
- **Hints are replaced as a list:** tiers 1–3 in order, and the first empty
  tier ends it.
- **Accessible names for the authoring journey beyond the agreed contract:**
  "Submit for review" (with the originality checkbox), "Approve", "Return to
  author", "Withdraw to draft", "Revoke approval"; editing an existing
  reference solution starts with "Edit <label> (<language>)"; the retire
  dialog's confirm button is "Confirm retirement" (field "Reason", at least
  10 characters). Publishing needs a second admin's approval, so the e2e
  journey approves as RECADMIN02.

### Phase 4 — A governance

Each is the narrower reading, implemented as described.

- **Later-phase capabilities.** Ratings (Phase 5), integrity overturn
  (Phase 6) and calendar / MEDICAL leave (Phase 8) are declared in
  `lib/auth/capabilities.ts` with `arrives` and no actions;
  `test/capabilities.test.ts` fails as soon as their models (Contest,
  RatingChange, IntegrityFlag, CalendarDay, LeaveException) appear in
  `schema.prisma` unwired. `RATING_RECOMPUTE` joins `PrivilegedOperationKind`
  in Phase 5.
- **Email is an outbox drained by the scheduler.** `MAIL_TRANSPORT` is
  `smtp`, `log` (development only; the scheduler refuses it in production) or
  `disabled` (the default outside development). With no transport, rows stay
  PENDING and `/super` shows a danger alert; the in-app notifications of a
  break-glass always go out. `nodemailer` was installed by the foundation.
  *Which SMTP relay does the college provide for production?*
- **Impersonation targets.** Never a SUPER_ADMIN, never yourself, only ACTIVE
  or SOFT_RESTRICTED accounts. The target is not notified. Read-only also
  blocks harmless student writes (draft saves, hint reveals, activity
  pings). The banner sits above the page, so the full-height workspace is
  pushed down by its height while it shows. Signing in again on the same
  browser ends a live impersonation (SIGNED_OUT).
- **Deleting problems.** Only a never-published, unreferenced problem
  (no frozen revision, no student-linked rows) or a draft revision that is
  not the only one can be deleted, by two-person approval. Frozen revisions
  are retired instead (the database refuses even a DELETE). Test blobs and
  bundles of a deleted draft are left as orphans (content-addressed and
  possibly shared); a later cleanup job may collect them.
- **Retire is immediate and single-person.** `retireProblem` needs only
  SUPER_ADMIN (it is reversible in principle and not on the spec's
  two-person list). There is no un-retire yet. Retiring does not recount
  study plans (the admin stream's `recountPlansForProblem`, if it lands, can
  be called at integration).
- **Submission purge** covers one student's PRACTICE sources (and their
  visible-test output) created before a campus date. Verdict rows are kept;
  contest and assessment sources are never purged; accepted sources only
  when the request ticks "include accepted"; refused under legal hold, at
  request and again at execution.
- **PII export** is generated at download time and never stored: requester
  only, 24 hours after approval, at most 3 downloads, the minimised column
  set (no password hashes, sessions or IP hashes).
- **Retention durations are read-only.** Only the legal hold is editable
  (`/super/settings/policy`); its reason, time and author are kept in the
  setting and the audit row.
- **Status changes are super-only in Phase 4**, including GRADUATED and
  SOFT_RESTRICTED. Up to 25 accounts change directly and all-or-nothing;
  26–5,000 need two-person approval; more is refused (narrow the filter).
  `AccountStatusEvent` is deferred to Phase 8; audit rows are the history
  until then.
- **Role changes** (including to and from SUPER_ADMIN) are one super-admin
  plus a SECURITY audit row; they are not on the spec's two-person list. At
  least one ACTIVE SUPER_ADMIN always remains; staff roles go to ACTIVE
  accounts only; leaving ADMIN revokes that admin's scopes.
- **AdminScope grants** go to ADMIN accounts that are ACTIVE, and are
  SECURITY-audited (PLAN decision 1). An identical active grant is refused by
  the partial unique index (P2002 → "already has exactly that scope").
  Overlapping grants (CSE/all batches next to CSE/2027) are allowed.
- **Both the requester and the approver must be SUPER_ADMIN**, and the
  approver approves the payload digest shown to them.
- **Global rejudge** is one problem at a time (optionally one revision, some
  languages, some verdicts), capped at 25,000 rows, and only re-queues rows
  (the reconciler dispatches them on lane REJUDGE). A language-wide rejudge
  across problems would need a new Submission index and is deferred.
- **The flags registry is closed** and holds only the two governance kill
  switches (`impersonation`, `breakGlassSelfApproval`), both on by default.
- **Integrations is a status page plus a test email.** Credentials are never
  shown; the transport shown is the one the scheduler last reported.
- **Audit append moved to `@recx/db`** (resolves the Phase 2 "move audit into
  a shared server-only package" item), so the scheduler audits the
  governance sweep and failed security email. `@/lib/audit` keeps its API.
- **Voiding XP** writes a REVERSAL and lowers the three buckets of the
  original moment and `UserStats.xpTotal`. It does not change
  `ActivityDay.xp` (so the day's caps are not reopened), solved counters,
  problem status or frozen leaderboard snapshots.
- **No `ThemePreset` table**: presets stay in `@recx/design`.
- **A privileged operation that fails is not retried.** FAILED is final;
  request it again. An execution stuck over 15 minutes is failed by the
  governance sweep.

### Phase 4 — B admin surface and AdminScope
- **Imported accounts cannot sign in yet.** `/admin/students/import` copies
  identities that already exist in REC Learning (every row needs its
  `lmsUserId`; a row without one is rejected as `MISSING_LMS_ID`). Accounts it
  creates have role STUDENT, status ACTIVE and `passwordHash = null`, so they
  cannot sign in until LMS sign-in (OIDC) ships in Phase 10. Needs a
  decision: an interim, audited super-admin password-set flow, or waiting.
- **What the roster import never does.** It never changes a role, an account
  status or a password; never touches a staff account (`STAFF_ACCOUNT`);
  never deactivates students missing from the file; and leaves roll-number
  changes (`ROLL_NUMBER_CHANGED`: same LMS id, different roll number) and key
  conflicts (`KEY_CONFLICT`: the LMS id, roll number and email point at
  different accounts) to a super-admin. Every line sharing a key with another
  line of the same file is rejected (`DUPLICATE_IN_FILE`), not only the
  second one. The flow is a stored dry run (`RosterImport`, 60 minutes) and a
  separate commit that re-plans and refuses unless the hash of the plan equals
  the one on the importer's screen. New accounts get a handle built from the
  name (`priya-s`, `priya-s-2`, …), never from the roll number. A cohort move
  re-labels only the open-period XpBucket rows (all-time, this month, this
  week); closed periods keep their history.
- **`/admin/discuss` is not built.** Discussion ships with Phase 11 together
  with TA_MENTOR moderation (PLAN decision 13); the admin navigation does not
  link it.
- **Cohorts are derived.** A cohort is the (batch, department, section) of
  LMS-owned User columns; there is no Cohort model. The URL key is
  `2027.CSE.A`, or `2027.CSE.-` without a section.
- **AdminScope boundaries.**
  - Scope is department and/or batch only; section is not a dimension. A
    null dimension means every value; a grant with both null is the whole
    college. An ADMIN with no active grant sees no students (fail closed).
    SUPER_ADMIN is never scoped. Every scoped query also requires
    `role = STUDENT`, so staff never appear in admin student pages.
  - `/admin/judge` fleet figures (lane latency, language mix, verdict
    distribution, the stuck and internal-error lists and their totals) stay
    college-wide aggregates; in the lists, a student outside the viewer's
    scope is shown as "Outside your scope" with no identity and no Rejudge.
    The rejudge action refuses an out-of-scope submission as not found.
    Because scoping also requires role STUDENT, a staff account's own test
    submission can no longer be rejudged from `/admin/judge` (a SUPER_ADMIN
    can use the global rejudge), and a judge-cap override can be granted only
    to a student account ("No student has the roll number …").
  - The fence (`tests/repo/admin-scope.test.ts`) covers code an ADMIN can
    run. SUPER_ADMIN-only code (`app/super/**`, `components/super/**`,
    `server/{actions,queries}/super-*.ts`, `lib/privileged/**`,
    `lib/accounts/**`) is outside it: an ADMIN cannot reach it, and a
    SUPER_ADMIN's scope is the whole college anyway. A read keyed by a
    `ScopedStudent.scopedId` counts as scoped (only `lib/auth/scope.ts` can
    mint one). This is a textual check, so a plain id named `scopedId` would
    pass it; the branded type is what keeps it honest in review. Relation
    includes of private data (for example a submission's `source`) are not
    detected by the fence; admin code reads submissions as metadata only by
    convention.
  - Fixed exemptions (exact counts, listed in the test): the `/admin/judge`
    fleet queries above, and in `lib/admin/roster.ts` the unscoped key lookup
    (conflicts with accounts outside the scope must be seen; it selects keys
    and cohort only), the global handle lookup and the `createManyAndReturn`
    of new accounts.
  - The student page links a SUPER_ADMIN to `/super/users?q=<roll number>`
    for status changes; an ADMIN has no status mutation anywhere in `/admin`.
- **Plans (sheets and tracks).** College-wide content with no audience
  targeting; enrolment figures shown in `/admin` count only the viewer's
  students. There is no delete (unpublish instead, because deleting a plan
  would delete students' enrolments); a slug is lower-case and never changes.
  A seed-managed plan is read-only in `/admin` until detached (audited, with a
  reason), after which the seed sync leaves it alone and logs "detached".
  Every item change recounts the plan and every enrolment in one statement
  (`lib/plans/recount.ts`, shared with the seed sync): `completedAt` is
  cleared when a plan grows past a student, matching the seed sync, unlike
  `enroll()`, which keeps it. A plan whose last problem is removed is
  unpublished automatically; publishing needs at least one problem.
- **Accommodations.**
  - An ADMIN requests; only a SUPER_ADMIN approves, rejects or revokes
    (`requireSuperAdmin`). Requester ≠ approver is not enforced (the spec
    does not ask for it). A SUPER_ADMIN may "approve now" when requesting.
  - Kinds (a disability label), the reason and the decision note are never
    written to audit metadata; the metadata is an allow-list (id, from, to,
    validUntil, extra time, exempt signals, supersedesId). The one exception
    is the revoke reason, recorded as `revokeReason` in the audit row because
    the database keeps decision fields final (coordinator decision); the
    revoke form says "Do not include medical or disability details."
  - The list page shows terms and validity only; kinds and reason appear only
    on `/admin/accommodations/[id]`. There is no document upload: documents
    stay with the accessibility office.
  - A change of terms is a new request that supersedes the approved one when
    approved. A plain request is refused while an approved one exists, and a
    superseding request whose predecessor is no longer approved (revoked)
    must be rejected and filed again. Reject and withdraw clear
    `supersedesId`.
  - The suggested exempt signals for MAGNIFIER (full-screen exit) and
    SPEECH_INPUT (typing bursts, software-inserted text) are inferences; the
    SUPER_ADMIN confirms the list. The bounds extraTimeMinutes ≤ 240,
    breakMinutes ≤ 120 and a validity of at most 400 days are Phase 4
    readings. `ProctorEventKind` holds the 24 spec kinds; whether a
    snapshot-jump kind exists is left to Phase 6.
- **Announcements.** Plain text, no scheduling; published text, audience and
  recipient count are fixed. The fan-out happens once, at publish, to the
  in-scope ACTIVE and SOFT_RESTRICTED students of the audience: students
  imported later do not receive it. A banner runs at most 30 days; archiving
  hides it early and keeps the notifications. A draft is edited by its author
  or a SUPER_ADMIN; any admin whose scope covers the audience may archive.
  "Every student" is an audience only a whole-college scope covers.
- **Reports.** Active and SOFT_RESTRICTED students only, from the maintained
  read models (never the XP ledger). No export: a PII export is super-admin
  only, through a PrivilegedOperation. A `cohort` link outside the viewer's
  scope falls back to the whole scope with a notice.
- **Admin student page.** No status changes for an ADMIN; submissions as
  metadata only, never source; notes and code drafts are never readable from
  admin code (fence rule R5). "Sign out everywhere" is the one mutation
  (audited SENSITIVE with a reason).
- **Student search.** An exact roll number or email, or a first/last-name
  prefix ("Priya", "Priya Sh"); no trigram index at about 5,000 students.

### Phase 4 — I1 capabilities and the role × capability matrix

- **Three tiers, one map.** `lib/auth/capabilities.ts` now binds every server
  action: the twelve SUPER_ADMIN capabilities (unchanged), twelve staff
  capabilities (ADMIN + SUPER_ADMIN) and nine self-service ones (every
  signed-in role, from `requireActionUser`). Outside the capabilities there
  are four lists: super-only supporting actions, super-only supporting
  pages (`/super`, `/super/jobs`, `/super/settings/integrations`), the
  impersonator action (`endImpersonation`) and the public sign-in and
  sign-out.
- **Roles are recorded as the code has them.** Every staff action is ADMIN +
  SUPER_ADMIN. That includes `withdrawAccommodation` and every
  problem-review action: the "never your own" approver rule lives in
  `lib/authoring/review.ts`, not in the guard.
- **Problem keys.** The authoring actions split into `problems.author`,
  `problems.validate`, `problems.review`, `problems.publish` and
  `problems.import`. Validation got its own key because it enqueues judge
  work.
- **`students.view` has pages only.** The overview, students, cohorts and
  reports pages are reads, with no action.
- **The page dimension covers `/admin` and `/super` only.** Student pages
  are guarded by `requireUser()` and are not mapped to capabilities.
- **Routes in the map:**
  - every `app/api/admin/**` and `app/super/**` route method;
  - every mutating `app/api` route except the judge-node ones (bearer token).

  Read-only `GET` routes (`/api/search`, `/api/runs/*`,
  `/api/submissions/*`) check ownership in their own code and are not
  capabilities.
- **`capabilityMatrix()` still returns the role → keys record** (design §3).
  The Markdown table comes from `capabilityMatrixMarkdown()`, and
  docs/SECURITY.md carries it between `capability-matrix` markers.

### Phase 4 — I2 student exposure

- **"STUDENT-reachable" for the static fence** (`tests/repo/student-exposure.test.ts`)
  means every page, layout, route, loading, error, global-error, not-found,
  template or default under `src/app` except `admin/**`, `super/**`,
  `api/judge/**` and `api/admin/**`, plus `src/middleware.ts` and
  `src/pages/**`. Their whole value-import closure must avoid
  `SENSITIVE_PREFIXES`; `import type` is ignored because it loads nothing.
- **One sensitive file is student-reachable on purpose:**
  `server/actions/super-impersonate.ts`. The root layout renders the
  impersonation banner, whose form posts `endImpersonation`. The fence still
  follows the graph through that file, and requires every export to be
  SUPER_ADMIN-guarded or `requireImpersonator()` first.
- **`server/actions/privileged.ts` counts as sensitive**, next to
  `lib/privileged/**`, which it runs. It is SUPER_ADMIN-only.
- **Checker sources count as hidden test data.** Outside the sensitive paths,
  `checkerSha256` is flagged like `testBlob`, `readBlobBytes` and
  `getTestDataStore`. So are SQL literals naming `"TestBlob"`, `"inline"` or
  `"storageKey"`.
- **`import "server-only"`** is required on sensitive library modules
  (`lib/**` and `server/queries/**`), except the pure helpers listed with a
  reason in `SERVER_ONLY_EXEMPT`: `lib/testdata/{blobs,bundle,keys,tar,local-fs,s3}`
  and `lib/privileged/{csv,payloads,policy,types}`.
- **The canary test** (`apps/web/test/student-exposure.db.test.ts`) calls
  every server-action export as the student. The self-service ones run with
  fixture inputs. Every other export must return exactly the Forbidden result,
  except `endImpersonation`, which throws Forbidden outside an impersonation.
  So an action that starts admitting students fails the test until it gets a
  fixture.

### Phase 4 — I3 DB hardening and test infrastructure

- **The Accommodation supersede rules lock what they read**
  (migration `20261010100200_phase4_integration_hardening`). The successor
  check reads the REQUESTED successor `FOR SHARE`, and the successor-lock
  check reads the predecessor `FOR SHARE` whatever its status. A concurrent
  withdraw, delete or supersede now waits for the other transaction and is
  then refused. If the two lock waits cross, Postgres aborts one transaction
  with 40P01 instead. The admin actions already lock with `FOR UPDATE` first,
  so they only see the waits.
- **"PrivilegedOperation decision timestamps" means `decidedAt`.** The
  deciding UPDATE may not date it more than 5 minutes after the database
  clock. `executionStartedAt` and `executedAt` are not clock-bounded.
- **Accommodation timestamps are bounded only against the request:**
  `decidedAt >= requestedAt` and `grantedAt >= requestedAt` (CHECKs).
  `requestedAt` itself has no insert-time clock window, unlike
  PrivilegedOperation and ImpersonationSession. **Decided 2026-10-18: it does
  not get one** (the narrower reading — §0 "ask before inventing" — and no
  spec line asks for a third window). The window is load-bearing on the other
  two because `startedAt` / `requestedAt` there anchor a *database-enforced
  expiry*: `expiresAt <= startedAt + 15 min` and `expiresAt <= requestedAt +
  24 h`, with PENDING -> APPROVED | REJECTED gated on the database clock being
  before `expiresAt`. A forged insert timestamp would therefore buy a longer
  live impersonation or a longer approval window — a privilege. Accommodation
  has no such lever: no Accommodation CHECK or trigger compares anything to
  the clock, and nothing derives an expiry from `requestedAt` (`validUntil` is
  supplied by the admin and tied to nothing). `requestedAt` anchors only the
  two CHECKs above, and the failure modes are self-limiting — a future
  `requestedAt` makes the row *undecidable*, because a decision taken from a
  real clock would then violate `decidedAt >= requestedAt`, and a back-dated
  one only lowers that floor. The real request time is in the
  `accommodation.requested` audit row either way. Revisit if an Accommodation
  rule ever becomes clock-gated (an auto-expiry on `validUntil`, say): the
  window would then be protecting something, and it is a two-line trigger.
- **`normaliseGrant` widens on a malformed `batchYear`** (noted
  2026-10-19, reviewing Phase 4; code unchanged). `lib/auth/scope-where.ts`
  maps a `batchYear` that is not an integer to `null`, and `null` means
  "every batch" — a fail-**open** in a module whose stated posture is
  fail-closed everywhere else (no grants matches nothing; an empty scope is
  `FALSE` in raw SQL). It is not reachable today: grants are read from
  `AdminScope.batchYear`, which is `Int?`, so Postgres guarantees
  integer-or-null, and `buildStudentScope` is the only way to mint a scope.
  Left as is on the narrower reading — changing it would alter behaviour on a
  path nothing can take, for no gain. Revisit if a grant ever arrives from
  somewhere other than that column (an import, a cache, an API), because then
  one bad value silently grants an ADMIN every batch in its department.
- **Approve-now writes one clock reading.** `requestAccommodation` now
  INSERTs `requestedAt` from the same `now` that the approving UPDATE uses
  for `grantedAt` and `decidedAt`. Before, Prisma's own `now()` for
  `requestedAt` was taken a few milliseconds after the action's `now`. That
  dated the grant before the request, which the new CHECKs refuse.
- **Announcement `id` and `createdById` never change, drafts included.** A
  draft's `recipientCount` stays 0 (CHECK). The publish UPDATE writes the
  count.
- **An ImpersonationSession is INSERTed open** (no `endedAt` or
  `endReason`). Its closing UPDATE may not date `endedAt` more than
  5 minutes after the database clock.
- **Web database test files run one at a time** when `RECX_DB_TESTS=1`.
  These are every `*.db.test.ts` file plus `judge-routes.test.ts`. They run
  in vitest's "db" project, in a single fork, after the parallel "unit"
  project. Modules are reset between files, but `process.env` and
  `globalThis` (the shared Prisma client) carry over within that fork.
  Without `RECX_DB_TESTS`, the configuration is the old single project.
- **`retryingTransaction` / `withTransientRetry` (deadlock retry) stays.**
  Every call site keeps its side effects (audit, bundle writes, run
  dispatch, revalidation) outside the retried transaction. Its blob writes
  run before it and are idempotent. The one exception was the import's
  topic warning, which was appended once per attempt. It is now reset at
  the start of each attempt.
- **Box ids of the adversarial self-check suite: 950–952.** The live
  maintenance range is 900–909 and verify-toolchains uses 800–899.

## Phase 5 — decisions recorded during the build

- **The rating formula's three corrections are in tension; the resolution is
  written into `packages/shared/src/rating.ts`.** The spec fixes the order:
  level the field so Σdelta = 0, *then* shift the top
  min(n, round(4·√n)) by pre-contest rating so their delta sum is ≤ 0,
  *then* clamp |delta| ≤ 200 — and it also asks the gate test to assert
  "Σdelta ≈ 0". Those cannot all hold literally:
  - **The top-set shift.** Taking the top set's excess off them and
    discarding it breaks the Σdelta = 0 that the previous step just
    established. We therefore **redistribute** the excess to the rest of the
    field instead of destroying it: the top set lands at exactly 0 (≤ 0 as
    required) and the total stays 0, so both invariants hold exactly. The
    reference implementation instead derives a bounded negative increment
    from the top set and applies it to *everyone*, which is deliberately
    deflationary (it also subtracts a flat 1 point in the levelling step).
    Ours is the narrower reading: it does what the spec's two sentences each
    ask for, and nothing extra. Revisit if the college wants deliberate
    rating deflation over time, which is a policy choice, not a bug.
    For n ≤ 16, round(4·√n) ≥ n, so the whole field is the "top set" and
    there is nobody to redistribute to; the excess is simply removed.
  - **The clamp wins.** Because the clamp is ordered last, a field extreme
    enough to need it loses the discarded excess and Σdelta is then no
    longer ≈ 0. So "Σdelta ≈ 0" is a property of the formula *when the clamp
    does not bind*, which is the normal case: the gate fixture is a realistic
    round (local upsets, no delta within 200) and asserts no delta is
    clamped, so the zero-sum assertion means something; a separate test
    drives a reversed field, shows the clamp binding at ±200, and asserts
    that the total is then non-zero, so the trade-off cannot change
    unnoticed.
- **Ranks passed to the rating engine are competition ranks (1, 2, 2, 4).**
  Tied participants must share a rank, or tying with somebody would move
  your rating. `competitionRanks()` is exported next to the engine so the
  live board and `rebuild-standings` cannot disagree about ties.
- **`computeRatingChanges` throws rather than guessing** on a non-finite
  rating, a non-integer or non-positive rank, or a duplicated participant.
  Rating runs in one transaction per contest, so a refusal aborts cleanly;
  a silently wrong rating would be far worse and is hard to detect later.
- **A `datetime-local` field is CAMPUS time, and the client makes it
  absolute before sending** (found 2026-10-19 by the contest e2e; fixed).
  `<input type="datetime-local">` yields a timezone-naive string
  ("2026-10-19T02:36"). The contest form first sent that string straight to
  the server, where `new Date(...)` parsed it in the SERVER's zone — and the
  dev stack runs on a UTC host, so a contest an author set for 10:00 was
  stored as 10:00 UTC, i.e. 15:30 IST. The e2e caught it because the contest
  it had just created for "five minutes ago" rendered as *Upcoming*.
  The fix follows the convention the announcement form already used
  (`announcement-form.tsx`): the field is populated with `istLocalInput()`
  and converted back with an explicit `+05:30` before it leaves the browser,
  so the server only ever parses an unambiguous instant. Any future form
  with a date-and-time field must do the same — on a Windows development box
  whose local zone IS Asia/Kolkata the bug is invisible, because the
  server's zone and the author's zone agree.
- **A student who registers and submits nothing is not on the board, and is
  not rated** (decided 2026-10-19, surfaced by the 150-participant
  simulation: 148 of 150 registrants had submitted, and exactly those 148
  were rated). `ContestStanding` is materialised from
  `ContestProblemAttempt` (SPEC §4e), so a student with no attempt row has
  no board row, and `releaseContestRating` reads the board — so they are
  outside the rated field and their rating does not move. It also means they
  do not count towards the 30-participant minimum.
  This is the narrower reading of "materialised from the attempts", and it is
  what the code does. The trade-off is worth stating plainly, because the
  reference implementation does the opposite — it rates every registrant,
  placing a no-show last:
  - **For our reading:** a student who registers and then has a class, or a
    power cut, loses nothing. In a college where contests are scheduled
    against timetables, that is the kinder default.
  - **Against:** registering costs nothing, so there is no reason not to
    register for everything, and a student who turned up and finished last
    is treated worse than one who never appeared.
  Revisit with the placement cell once a few real rounds have run: the fix
  is to seed a zero-score standing row for every registration at the start,
  which makes a no-show a last place rather than an absence.

## Phase 6b — the attempt engine

- **The auto-submit sweeper also finalises DISCONNECTED sittings, not only
  IN_PROGRESS ones** (decided 2026-10-19). SPEC §5 writes the sweeper's
  predicate as `status = IN_PROGRESS AND expiresAt <= now()`, which is one
  status short: DISCONNECTED is a sitting in progress whose candidate lost
  their connection, and whose clock the spec is explicit never stopped. On
  the literal reading, a candidate whose wifi dies at minute 20 of a
  60-minute paper is never finalised — the row sits past its deadline for
  ever, holding a seat on the invigilator's dashboard and never scoring the
  work already submitted. The status machine already allows
  `DISCONNECTED → AUTO_SUBMITTED` for exactly this case. Widened, and the
  reason recorded here rather than left as a silent departure.
- **The deadline is `expiresAt + pausedMs`, everywhere** (decided
  2026-10-19). The same §5 sentence says the sweeper finalises on
  `expiresAt <= now()`, and two lines later defines
  `msRemaining = expiresAt + pausedMs − now()` and warns that this is "the
  bug that voids an exam". Both cannot be right: sweeping on bare `expiresAt`
  auto-submits a candidate in the middle of an invigilator-granted break.
  One SQL expression (`packages/db/src/attempt.ts`) is the deadline for the
  sweeper, the lazy guard and the heartbeat alike, and
  `attempt-sweep.db.test.ts` covers the break case directly — dropping
  `pausedMs` from that expression fails that test and nothing else
  (mutation-checked).
- **A request on a different session re-binds the sitting rather than ending
  it** (decided 2026-10-19). `AssessmentAttempt.lockSessionId` exists "so an
  admin force-logout ends it" (SPEC §4), but a session also simply expires,
  and a candidate who signs in again must be able to resume — §5 is emphatic
  that a connectivity or session hiccup must not cost someone their exam.
  So the guard distinguishes two cases: the original session is **gone**, and
  the lock moves to the new one (a resume); or it is **still alive** and a
  second one is beating, which is a genuine `CONCURRENT_SESSION` — recorded
  for a human, lock unmoved, request still allowed, because no signal
  auto-penalises (§0). `lockSessionId` is deliberately outside the
  write-once tuple the `AssessmentAttempt_machine` trigger freezes.
- **A null sequence high-water mark reports no gap** (decided 2026-10-19).
  `SEQUENCE_GAP` needs a server-side high-water mark, which is what
  `AssessmentAttempt.lastClientSeq` is for (migration
  `20261019180000_phase6b_heartbeat`). Treating "no client message yet" as
  `-1` would raise a gap on every attempt whose client happens to start
  counting at 1 — a signal about a counting convention, not about a
  candidate. The first message sets the baseline instead.
- **Clock drift is logged, not recorded as a ProctorEvent** (decided
  2026-10-19). §5 asks the client to "correct and log drift over 5s". None of
  the 25 `ProctorEventKind` members covers a clock, and the 25 are a closed
  set the spec enumerates deliberately; a candidate's laptop being twenty
  seconds out is a fact about their laptop, not evidence about them. The
  heartbeat logs it and the client corrects itself from `serverNow` on the
  same response. Revisit only if a real sitting shows drift being used to
  explain something.
- **`computeExpiresAt` delegates to Phase 4's `accommodatedDurationSec`**
  (decided 2026-10-19). Two modules were computing "how long does this
  candidate get" by different arithmetic — Phase 4 floors the percentage then
  adds the flat minutes, Phase 6b rounded once at the end — which differ by
  up to a second on odd durations. The accommodation screens have shipped
  that formula since Phase 4, so the clock now calls it rather than
  re-deriving it, and a test sweeps durations × percentages × minutes
  asserting the two agree. A deadline one second away from the extra time a
  student was told they had is unanswerable when it lands on the last
  question.

### Not a Phase 6b decision, but found while gating it

- **The `db` suites belong to the Linux gate, not the Windows one**
  (2026-10-19). Several governance fixtures write an app-clock timestamp into
  a column a CHECK compares against a database-clock one (e.g.
  `PrivilegedOperation_decided_after_request_check`). Run from Windows
  against the WSL2 Postgres those are two different clocks, and WSL2's drifts
  from the host across a suspend — a measured 210 ms was enough to fail 13
  tests on an unmodified checkout. Inside the mirror, where
  `scripts/dev/linux-gate.sh` runs them, there is one clock and they pass.
  Worth noting that the fragility is not purely a test artefact: in
  production the app and the database are on separate hosts, so an
  app-supplied `decidedAt` really can land before a database-supplied
  `requestedAt`. The durable fix is for those columns to come from one clock
  — `now()` in the same statement — rather than for the test to be retimed.
  Not changed here: it is Phase 4 and Phase 5 code, outside this slice, and
  changing a guard's inputs deserves its own gated change.

## Phase 6c — the exam surface (server side)

- **Snapshot deltas are a compact line patch, not literal `diff -u` text**
  (decided 2026-10-19). SPEC §5 says "the rest as unified diffs,
  reconstructed on read". The operative requirement is the reconstruction,
  and a JSON array of keep/drop/insert ops round-trips EXACTLY by
  construction — no hunk headers to generate or parse, no ambiguity about a
  trailing newline, and `applyLinePatch(from, diffLines(from, to)) === to` is
  a property a test can assert over arbitrary input (it does, over 200
  seeded rounds). The stored `contentHash` of every version is the
  independent check, and `readSnapshotTimeline` reports per version whether
  the rebuilt text matched it rather than presenting a reconstruction as
  fact. If a later phase needs real unified-diff text (to show a reviewer a
  patch, say), it can be rendered from this at read time.
- **A snapshot is stored whole whenever the delta would not be smaller**
  (decided 2026-10-19). For a small file the JSON patch envelope exceeds the
  text itself, so "whole" is genuinely the smaller option; the writer
  measures rather than following a rule about file size. It also re-bases the
  chain, which is how a question whose stored timeline cannot be rebuilt
  still records the candidate's current work instead of failing their save.
- **`SNAPSHOT_JUMP`'s token count is a coarse, language-agnostic scan**
  (decided 2026-10-19). The signal is a RATIO between two snapshots of the
  same file in the same language, not a parse, so identifiers/numbers count
  as one token each, a string literal counts as one however long, and
  comments are not stripped — which is conservative in the right direction (a
  pasted commented block counts MORE, and the threshold is about code
  appearing, not about how good it is). The proper web-tree-sitter lexing
  SPEC §5 specifies is for similarity detection, which is a different job
  with a different budget.
- **A candidate's exempt signals are derived from the accommodation KINDS
  frozen onto the attempt, not from `Accommodation.exemptSignals`** (decided
  2026-10-19, and the narrower reading is recorded here rather than silently
  taken). `AssessmentAttempt.accommodationFlags` freezes the kinds at start —
  correctly, because what counts against a candidate must not change
  mid-sitting — and Phase 6c derives the exempt list from them with Phase 4's
  `suggestedExemptSignals`. A super-admin who hand-edits
  `Accommodation.exemptSignals` beyond the suggestion is therefore NOT
  honoured during the sitting. The derivation errs towards exempting, which
  is the right way for this to be wrong, but it is a real gap: the fix is to
  freeze the resolved signal list onto the attempt at start (one column, one
  migration) and should land with slice 6e, which is where a reviewer reads
  the exemption.
- **An exempt signal does not count towards the focus-warning limit at all**
  (decided 2026-10-19). Exempting it from *acting* while still counting it
  would end a screen-reader candidate's sitting at warning three anyway,
  which is the bug the exemption exists to prevent. The events are still
  recorded and the attempt's counters still move, so a reviewer sees the
  whole timeline next to the note that these signals are discounted — SPEC §5
  requires the evidence both ways.
- **The focus-limit auto-submit is a second auto-submit, distinct from the
  deadline one** (noted 2026-10-19). The deadline sweeper records
  `submittedAt` at the deadline; this one records it at the moment the limit
  was reached, because the clock has not run out. Both are audited as
  `assessment.attempt.auto_submitted` with a `by` of `sweeper`,
  `lazy_guard` or `focus_limit`. Neither voids, scores or flags: the
  `IntegrityFlag` a human then reviews arrives with slice 6e, and until it
  exists the audit row is the record.

## Phase 6c — the exam surface (client side)

- **The attempt seed comes from the sitting's natural key, not its id**
  (decided 2026-10-19, and the database decided it). SPEC §5 writes
  `seed = HMAC-SHA256(assessment.secret, attemptId)`. The attempt id is
  assigned on insert, so seeding from it means creating the row and then
  writing `seed` and `layout` into it — and both are in the tuple
  `recx_refuse_attempt_change()` freezes, so Postgres refused that second
  write. It refused the first draft of `startOrResumeAttempt` with exactly
  the message the trigger exists to give.
  The seed is now `HMAC-SHA256(seedSecret, "assessmentId:userId:attemptNumber")`
  — the sitting's `@@unique` key, known BEFORE the insert, so the row is
  created complete and the write-once guard needs no exception carved into
  it. No weaker: the key is unique per sitting, the secret is per-assessment
  and never leaves the server, and a dispute can now reproduce the paper from
  the key it would quote rather than from an opaque cuid.
- **`Assessment.seedSecret` is per assessment, with a database default**
  (migration `20261019200000`). Per assessment rather than platform-wide so
  one leaked secret cannot precompute papers for every assessment in the
  college. Note the schema must spell the default the way Postgres STORES it
  — `(gen_random_uuid())::text`, parenthesised — or `prisma migrate diff`
  reports drift on every run and `migrate dev` generates a no-op migration
  for it. It did: the generated migration's timestamp sorted BEFORE the
  hand-written one, so a fresh `migrate deploy` ran an
  `ALTER COLUMN "seedSecret" SET DEFAULT` against a table that did not have
  the column yet, and failed. Removed, resolved as rolled back, and the
  schema's literal corrected.
- **Question SELECTION against an `AssessmentBlueprint` is not built**
  (recorded 2026-10-19). SPEC §5 wants "2×EASY + 2×MEDIUM + 1×HARD from pools
  ≥5× the needed count" and a prepare-time refusal of "any pool whose
  historical per-problem acceptance rates span more than 25 percentage points
  inside one difficulty band". That needs a model that does not exist. Phase
  6c randomises ORDER and derives a per-question seed, which is the half that
  costs the honest student nothing and has no bypass. `AttemptLayout` is
  versioned (`v: 1`) so adding selection later changes what goes into
  `questions` and nothing about the stored shape.
- **The exam pins CodeMirror even on a wide screen** (decided 2026-10-19).
  SPEC §5 requires editor telemetry from "CodeMirror 6 transaction
  annotations (updateListener + transactionFilter), not DOM events", because
  CM6 reports the exact inserted character count and whether the origin was
  `input.type`, `input.paste` or programmatic. Monaco has no equivalent that
  distinguishes typed from programmatic input, so the practice workspace's
  width-based choice would buy a nicer editor at the cost of the signal.
  `CodeEditor` gained a `forceKind` prop for this; the exam passes
  `"codemirror"` and says why at the call site.
- **The readiness check's network test round-trips the page, not the
  attempt** (decided 2026-10-19). The obvious implementation beats the
  heartbeat, but no sitting exists yet and it must not — the clock starts
  when the candidate starts, not when they test their wifi. A `HEAD` of the
  readiness URL proves the same path: this machine, this network, this
  server, this session.
- **A mutating route outside `app/api/` is bound by no fence** (found and
  closed 2026-10-19). The submit route was first written at
  `app/(exam)/assessments/[slug]/attempt/submit/route.ts`, where
  `capabilities.test.ts` does not require it to be bound to a capability or
  to call a guard — its `required` list covers `app/api/**` (non-GET),
  `app/api/admin/**` and `app/super/**`. It passed every gate. Moved to
  `app/api/exam/[attemptId]/submit`, which is covered and is where the other
  three exam routes live. The fence's scope is still worth widening: any
  `route.ts` exporting a mutating method should have to be bound wherever it
  lives.

## Phase 7 — aptitude, verbal and logical reasoning

SPEC §0: *ask before inventing — implement the narrower reading and note it.*
Every entry below is a reading of SPEC §5 that the spec does not settle, with
the narrower choice this phase implements. None of them is a licence to widen
later without a gated change.

- **There is NO overall cutoff on a mock** (decided 2026-10-19). SPEC §5 lists
  "per-section cutoff" and nothing else. A `MockPattern.overallCutoffPercent`
  and a conjunction-of-gates rule on top of it would be an invented rule
  deciding whether somebody clears a funnel, so `scoreMock()` passes a
  candidate exactly when EVERY section clears its own cutoff and the column
  does not exist. A candidate at 90% quant and 10% verbal still fails — that
  part is the spec's, and it is the whole reason the placement cell wants the
  round simulated. Widening this later is one column, one predicate and one
  line of copy on the cover page; inventing it now would mean every candidate's
  result depended on a threshold nobody published.
- **An UNANSWERED question scores exactly zero, never a penalty** (decided
  2026-10-19). Negative marking exists to discourage guessing. Penalising a
  blank would punish running out of time instead, which is the opposite of
  what a section timer is for, and every public description of the funnels
  this phase models agrees. `gradeAnswer()` returns `0` and `isCorrect: null`
  for an unanswered question, and the gate test asserts it across all six
  seeded patterns.
- **A partially correct MULTI_CHOICE answer scores zero, not a fraction**
  (decided 2026-10-19). All-or-nothing on an exact set match, with the
  negative mark applied ONCE for any wrong set however many options were
  wrong. Partial credit needs a published formula a candidate can check their
  own marks against; the alternatives (per-option credit, per-option penalty)
  differ by recruiter and none is publicly documented. Widening it needs the
  formula written down first, on the cover page, before the first question.
- **A negative section total carries into the paper's total; the reported
  percent is floored at zero** (decided 2026-10-19). None of the published
  funnels states which. `MockAttempt.totalRaw` carries the true signed sum so
  a total is honest, `percent` is clamped to `[0, 100]`, and `passedCutoff`
  reads the floored percent — so a badly guessed section can never change
  another section's OUTCOME, and no candidate is ever shown a negative
  percentage. `CHECK MockAttempt_score_check` deliberately does not floor
  `totalRaw`.
- **A cutoff of zero is how "no cutoff" is said** (decided 2026-10-19). The
  Accenture pattern's English section contributes to the total without gating.
  A nullable `cutoffPercent` would make `passedCutoff` a three-valued answer
  on every surface that reads it, including the student's own result page;
  zero is cleared by every candidate, including one who scored nothing.
- **`PASSAGE_GROUPED` answers exactly as single-choice** (decided
  2026-10-19). SPEC §5 lists it as a KIND alongside single-choice and
  multi-choice, which leaves the answering shape unstated. It takes exactly
  one correct index (`CHECK AptitudeQuestion_single_answer`) and is the only
  kind that may carry a `passageId` (`CHECK AptitudeQuestion_passage_kind`,
  stated as an equality so the two directions cannot drift). A multi-choice
  reading-comprehension item would need the partial-credit convention this
  phase deliberately does not have. Widening it later is one CHECK and one
  zod variant; revisit with the verbal authors.
- **The seed patterns live in `@recx/shared`, not in
  `apps/web/scripts/content/`** (decided 2026-10-19, and the gate decided
  it). SPEC §5's gate test is "negative marking and per-section cutoffs
  compute correctly across all seeded patterns". `packages/shared` declares
  one dependency (zod) and its vitest config is "pure unit tests: no I/O", so
  a test there cannot import `apps/web` — the gate test and the patterns have
  to be in the same package, and the arithmetic is the half that cannot move.
  `MOCK_PATTERN_SEEDS` is therefore in `packages/shared/src/mock-pattern.ts`
  and the seed script reads it from there.
- **A section carries a stable `key` as well as a `position`** (decided
  2026-10-19). Not cosmetic: a seed script must upsert on something that
  survives a renumbering, and `scoreMock()` indexes a candidate's answers by
  section — keying that on a cuid would make a result unreadable in a dispute
  and keying it on `position` would silently rebind a score if a pattern were
  ever reordered.
- **The 29 topic members, their spellings and their groupings are this
  phase's choice** (recorded 2026-10-19). The spec lists them in prose.
  `INTEREST` covers simple and compound; `AVERAGES_MIXTURES` is one topic;
  `SERIES` covers number and letter series. Implemented exactly as written in
  `packages/shared/src/aptitude-taxonomy.ts` and going to the placement cell
  for confirmation, as the 14 problem topics did.
- **A PUBLISHED question's key is frozen and its explanation is not**
  (decided 2026-10-19, migration `20261019250000`). Students have already
  been scored on that question, so rewriting its stem, options, key, kind,
  area, topic or passage silently rescores the past — while improving the
  wording of the worked solution harms nobody. A published question is
  RETIRED, never unpublished and never deleted: answer rows reference it and
  past percentiles must stay honest. `contentHash` deliberately excludes the
  explanation, so a re-import that only improves the working reports
  UNCHANGED rather than trying to create a second question.
- **`AptitudeQuestionStat.timesServed` moves where the question is SERVED,
  not at finalise** (decided 2026-10-19). Served and answered are different
  events. Incrementing both at finalise would make `lastServedAt` a lie, make
  `CHECK timesAnswered <= timesServed` vacuous rather than protective, and
  record nothing at all for an abandoned attempt — so the dud-question
  detection the table exists for ("99% correct, or 3% correct") would be
  computed over a denominator biased by exactly the attempts that went badly.

### Phase 7c/7d — the sitting engine and the pipeline

- **A full mock sitting keeps the 768px floor; practice does not** (decided
  2026-10-19). SPEC §7's DO NOT list says plainly "Do not build a serious
  phone-based solving experience", with no arena or proctoring qualifier. The
  Phase 7 design read that as applying only to proctored attempts and made
  the sitting page a *gating* 375px accessibility row, which is a serious
  phone sitting experience built as a gate. **Narrower reading:** `/aptitude`
  and `/aptitude/[topic]` are fully supported at 375px — browsing a topic and
  answering one question with the working shown is the one thing a phone is
  genuinely good at, and the students who most need the aptitude round are
  the likeliest to be on one — while `/aptitude/mock/attempt/[id]`, a timed
  multi-section paper, is hard-blocked below 768px with an explanation, the
  same floor the contest arena has. Widening it later is a design decision
  with a named owner, not a CSS change.
- **A re-imported edit to a PUBLISHED question fails the ROW, not the file**
  (decided 2026-10-19). The design never said what happens here, and it is
  the single most likely real use of the export round trip: an operator
  exports the bank, corrects a stem, and uploads it again.
  `recx_refuse_published_question_change` would refuse that write and roll
  the whole transaction back — one edited row discarding 299 good ones, which
  is exactly what SPEC §5's "one bad row cannot discard a 300-question file"
  forbids. So `planImport()` refuses it as a FAILED row carrying the sentence
  an operator can act on ("retire it and add a new question, or edit only its
  explanation"), and the other rows still land.
- **A passage's questions are the CONSECUTIVE rows of one topic** (decided
  2026-10-19). A CSV row cannot carry a database id, so the importer has to
  decide which rows share a passage. Consecutive-and-same-topic is how a
  human writes them in a spreadsheet, and any cleverer rule would be one
  nobody could predict from looking at the file. A group of fewer than two is
  refused: SPEC §5 says "one shared passage, N questions".
- **A mock answer carries no client timestamps; a practice answer does**
  (decided 2026-10-19, after the live canary sweep found the first draft
  wrong). A mock has a server-written section clock, so both `firstSeenAtMs`
  (when the server served the question) and `answeredAtMs` (when the request
  arrived) are measured on it and the action accepts neither from the client
  — a graded row must not carry a time the client chose. Practice has no
  section clock to measure against, so it does take the candidate's elapsed
  time, bounded to half an hour by `secondsOn()`; it feeds nothing but their
  own pacing average, so a student who inflates it misleads only themselves.
- **The capability fence does not cover a student GET route** (recorded
  2026-10-19). `apps/web/test/capabilities.test.ts` requires a binding for the
  admin and super trees and for every MUTATING api route, and refuses a
  binding for anything else as stale — so
  `GET /api/aptitude/attempts/[attemptId]/clock` is left unbound, with the
  reason at the `aptitude.sit` call site. It guards with
  `requireActionUser()` plus an ownership `where` and returns only the
  candidate's own clock. Widening the fence to cover student GETs is worth
  doing and is not a change to make inside a slice; it joins the same note
  Phase 6c left about mutating routes outside `app/api/`.
- **Aptitude counts as activity but does not advance the streak** (decided
  2026-10-19). `ActivityDay` gains `aptitudeAnswers`, `mocksFinalised` and
  `xpAptitude`, and `User.lastActiveAt` is touched, because SPEC Phase 8's
  nightly job takes its candidate set from `User [status, lastActiveAt]` and
  counts "days with a qualifying ActivityDay" — without a row, a student who
  practises aptitude every day and nothing else shows an empty heatmap, a
  zero streak, and is swept toward SOFT_RESTRICTED by a policy engine that
  cannot see them. The STREAK is left alone: the spec's own
  `countsAsActivity` default is
  `{"submission":true,"solve":true,"login":false,"lesson":true}` with no
  aptitude key, and adding one here would be inventing Phase 8's policy a
  phase early. The counters are written so that policy can count them when it
  is designed.
- **`xpAptitude` is a maintained column, not an aggregate** (decided
  2026-10-19, and `tests/repo/xp-ledger.test.ts` decided it). The 200/day
  aptitude cap is a read-then-write, and SPEC §4(d) forbids aggregating
  `XpEvent` on a request. `ActivityDay.xpEasy` already exists for the
  identical reason (the 600/day Easy cap), so the aptitude cap reads a
  maintained column the same way. The fence then also refused an
  `xpEvent.count()` for the "has this question been paid" pre-check, which
  was right twice: the ledger's unique `idempotencyKey` IS that check, so the
  insert is conditional on it and the pre-check is gone.

---

## Phase 8 — inactivity as a policy engine

Every entry here is a place where the spec, or the college's own ask, could be
read more than one way. The rule is §0's: **implement the narrower reading and
write it down**, where "narrower" means the reading that does less to a
student.

### The college asked for five days then disabled. That is not what ships.

The ask, verbatim in the brief, was "five days of inactivity, then the account
is disabled". The shipped defaults are nudge 3, warn 5, pause 10, and
automatic disabling **off**, so day five is a warning to the student and their
mentor and no account is ever closed by a job.

This is a real gap and not a reading of the words, so it is recorded rather
than smoothed over. Two reasons it is the right gap:

- The spec itself says the maximum automatic consequence in the system is a
  flag or a pause, and that hard disabling is "only ever a manual, reasoned,
  audit-logged admin action". A five-day cron-driven lockout contradicts the
  document that asked for it.
- Every threshold is a row, and the settings page writes new versions, so the
  college can have day five restrict — `softRestrictAfterDays: 5` — the
  afternoon they decide to, with no deploy and an audit row naming who chose
  it. That is the spec's own answer to the mismatch.

An earlier draft of the design claimed the day-five state "reads restricted in
administrative reporting, which satisfies the policy's wording". That was
arithmetically false against its own default row, and it is the kind of claim
worth catching: the honest version is above.

### There is no floor on the auto-disable threshold in the database.

A draft had `disableAfterDays >= 14` inside
`InactivityPolicy_auto_disable_check`, justified as refusing a threshold short
enough to catch a fortnight's illness. Dropped, because it contradicted the
spec clause three sentences away: *every threshold is configurable without a
deploy*, and a constant in a CHECK is a constant that needs a migration — the
college's own stated wish would have become unreachable by the one mechanism
the spec protects.

*Narrower reading, and what ships:* the fortnight argument is product copy.
`AUTO_DISABLE_FLOOR_REASON` renders above the field, a threshold under 14 days
needs `I ACCEPT THIS THRESHOLD` typed, and the save audits at `SECURITY`. A
database that refuses the college's policy is not safer than one that makes
somebody sign for it.

### What `SOFT_RESTRICTED` cancels, and in which lane.

The spec: "cancel queued and in-flight submissions for an account that has
just been restricted, so judge capacity is never spent on a locked lane."
Taken literally against every lane, that kills the very submission that is the
documented way out of the restriction — the spec also says solving is not
blocked, and one solve clears the stage automatically.

*Narrower reading:* the lane `SOFT_RESTRICTED` locks is the **contest** lane,
so that is the only lane cancelled. Practice and assessment submissions run to
completion. The reason clause in the spec's own sentence is what settles it.

### A pending integrity appeal holds the sweep back — and so does an open flag.

The spec says "never sweep a student with … a pending appeal". `IntegrityFlag`
(`schema.prisma:277`) and `IntegrityAppeal` (`:334`) both shipped in Phase 6,
so this is SQL rather than a parameter waiting for a later slice.

*Broader reading, deliberately taken:* the sweep also holds back a student with
an `OPEN` IntegrityFlag, which is not yet an appeal. A student waiting on a
human decision about their integrity, who is then swept by a job for being
quiet while they wait, is the exact combination this platform must never
produce. Over-holding costs the institution a few days of enforcement;
under-holding costs a student their account while they are already arguing for
it.

### `countsAsActivity` has four keys and two of them cannot fire.

`submission` reads `ActivityDay.submissions` and `solve` reads
`ActivityDay.solved`. The other two have no source: `ActivityDay` has no login
column (and `User.lastActiveAt` is the counting window's own start, so reading
it would make the counter self-referential), and lessons live in the LMS,
where REC Code never creates a student record.

*Narrower reading:* accept both keys, ignore them, and record
`loginSignalAvailable: false` / `lessonSignalAvailable: false` in the evidence,
so nobody later reads a missing signal as inactivity. The settings page renders
both as disabled controls with the reason beside them — a toggle that silently
does nothing is worse than one that says so. `login` stays false by default on
the spec's own argument: a policy counting logins teaches a daily one-minute
login that pollutes the engagement data worse than inactivity does.

### `kind` and `isWorkingDay` are read separately, and the toggle switches one.

A draft CHECK forced every non-`REGULAR` calendar day to `isWorkingDay =
false`. That collapsed the two columns into one for the counter and left the
spec's `excludeNonWorkingDays` toggle with nothing to switch off.

*What ships:* no CHECK ties them. `kind <> 'REGULAR'` is a structural
exclusion and always applies — nobody owes practice during a semester break.
`isWorkingDay = false` is the weekend and the declared closure, and that is the
one `excludeNonWorkingDays` controls. An exam week is a working week and the
calendar may truthfully say so.

### An empty or sparse calendar is the counter's harshest reading, so it stops the engine.

A day with no `CalendarDay` row counts. A college that had not entered its
holidays would therefore restrict students for being away over Pongal.

*Narrower reading, and recommended:* the sweep refuses to escalate **anybody**
while the calendar does not cover the evaluation window, reports
`calendarIncomplete` and raises an administrative item instead.
`/super/calendar` leads with how many days are unentered for this reason —
otherwise an empty queue reads as "nothing to do" when it means "the engine is
reaching nobody".

### A past calendar day is immutable, so a mis-entered holiday is corrected elsewhere.

Evidence rows cite days by date. Editing one rewrites the explanation of a
decision already taken, so `CalendarDay_past_immutable` refuses UPDATE and
DELETE of a day before today (and refuses moving a future day into the past).

*Narrower reading:* a day that was counted wrongly is put right by approving a
retroactive `LeaveException` covering it, which is the spec's own reversal
mechanism. A super-admin override would need its own
`PrivilegedOperationKind`, which Phase 8 does not add.

### "Once per semester" self-clearing needs a definition of semester.

The spec gates student self-service on `selfClearedCount < 1` and calls it
"once per semester" without saying what a semester is.

*Narrower reading:* `termKeyFor()` derives the term from `SEMESTER_BREAK`
boundaries in the calendar — "the term that began after the break ending 18 May
2026". While the calendar holds no break rows the key falls back to the
academic year (June to May), which spans longer than a semester and therefore
allows **fewer** self-clears. The stricter reading is the one to ship when the
data is missing. Revisit once a real calendar is loaded.

### `notifyParentEmail` cannot be turned on at all.

A draft said it "stays false, needs a SUPER_ADMIN flip and a recorded
`ConsentRecord`". `ConsentRecord` is in the spec's model inventory but is in no
phase of this plan, so that precondition had no owner.

*What ships:* CHECK `InactivityPolicy_parent_email_check` refuses `true`
outright. The column exists because the spec's field list has it; a parent
address is third-party personal data. The CHECK is dropped by the migration of
whatever phase builds consent, never by a flag flip, and the switch renders
disabled with that sentence as its reason.

### Who the "named human" is when no mentor resolves.

The spec's point is that non-progress must be visible to a named human who can
intervene, so the notification must never silently go nowhere.

*Narrower reading:* the student's `TA_MENTOR` by cohort; when none resolves,
the department `ADMIN` rather than nobody; and the evidence records which was
notified, so "we told somebody" is checkable rather than assumed.

### Restoring withheld XP: there is nothing to restore.

*Narrower reading:* nothing was lost. The ledger is append-only and events are
written with `meta.restricted`, so a reversal clears that flag's effect on
bucket visibility and writes no compensating row and no re-award.

### Who may reopen a closed account.

The spec: "DISABLED → ACTIVE is Super-admin only." A draft gave the staff
clearing action `requireAdminScopeAction()` with no floor, which would have let
a department ADMIN de-escalate a disabled account.

*What ships:* enforced three times — the pure `canStaffClear()` returns false
for `DISABLED`, the action refuses before it tries, and CHECK
`AccountStatusEvent_undisable_check` requires a row leaving `DISABLED` to come
from `MANUAL_SUPER` or `LEAVE_REVERSAL`.

### "Every student must make progress" cannot be enforced by software.

The spec asks for this to be recorded honestly, so it is its own entry. What
the platform can do: make the next action unambiguous (one Continue card, not
a wall of choices), keep the weekly goal small (three problems, not thirty),
make non-progress visible to a named human who can intervene, and make
progress legible to the student. The honest promise is **"nobody falls through
unnoticed and nobody is ever unsure what to do next"** — not "everyone
progresses". A platform that claimed the second would be lying, and the lie
would be load-bearing: it is exactly the claim that justifies closing an
account for silence.

## Phase 9 — placement readiness

### The coverage targets are a choice, and they decide what "ready" means.

The spec gives the component WEIGHTS for all three tiers and does not give
the targets those components are measured against. The weights decide how
much each part counts; the targets decide how much work counts as full marks,
and they are therefore the more consequential of the two.

*What ships:* `TIER_TARGETS` in `packages/shared/src/readiness.ts` —

| Tier | Coverage target | What it counts | Per topic |
|---|---|---|---|
| SERVICE | 120 | easy or medium problems solved, hint or no hint | — |
| PRODUCT | 80 | medium problems solved without a hint or an editorial | 4 |
| TOP | 120 | medium or hard problems solved without a hint or an editorial | 8 |

TOP's number is not smaller than PRODUCT's despite being the harder tier,
because the three columns count different things: a hundred and twenty
unassisted medium-or-hard solves is a much larger ask than eighty unassisted
mediums. The equality with SERVICE's 120 is a coincidence of the units.

**For the placement cell to confirm against a real cycle.** Changing a target
changes every student's score, so it is a `READINESS_RULES_VERSION` bump and
not an edit: a snapshot stores the version it was computed under, and
`ReadinessSnapshot_recompute_only` refuses a row whose version goes
backwards.

An earlier draft shipped 80 / 60 / 50, which made the hardest tier the
easiest to max out — a student could reach full TOP coverage with fewer
problems than full PRODUCT coverage. Caught while reading the design for the
role slice, not by a test, which is why the table above is now in the
document the placement cell reads.

### A rating counts after eight rated contests, not five.

SPEC §7: "Do not treat a contest rating as meaningful before ~8–12
contests." `PROVISIONAL_CONTESTS = 5` stays what it is — the display rule for
the "?" suffix on a rating — and readiness has its own, stricter floor
`READINESS_RATING_MIN_CONTESTS = 8`, the earliest the range permits.

*Why it is the one floor worth arguing about:* `RATING_PERCENTILE` is 35 % of
TOP. A student who won one lucky round would read as top-tier ready and a
strong student two contests in would read as not, and both errors are larger
than anything else readiness can get wrong. Below the floor the component is
MISSING with its own reason, so the student is told "a rating starts counting
after 8 rated contests" rather than "no data" — the first is true and
actionable, the second is neither.

### `mockInterviewScore` has no source, and will not have one this year.

It is 10 % of SERVICE, 10 % of PRODUCT and **15 % of TOP**, and the
mock-interview scheduler is Phase 11 or later. So it is permanently
`MISSING / NO_SOURCE_YET` at launch, and no TOP score can exceed 85.

*What ships:* the weights are **not** renormalised over the present
components, and three constraints make that non-negotiable rather than
conventional — a score may never exceed the measurable weight, a tier with
nothing measurable has NO score rather than a zero, and both are CHECKs in
the database. Every surface states the denominator, including the officer
ones, where a 70 compared against an absolute threshold of 70 would mark a
whole cohort as under-prepared because of a component nobody has built.

Renormalising would make a student who has never done a mock interview look
exactly as ready as one who has done five. That is the single largest honesty
risk in the phase and it is worth stating plainly: a TOP score is a score out
of 85, computed from three components, and the fourth is not coming this
year.

### A cohort under thirty is not ranked at all.

`MIN_PERCENTILE_COHORT = 30`. Below it a percentile is a disguised ranking: in
a cohort of eleven, "you are at the 9th percentile" identifies you to anybody
who can count. The three percentile components come back
`MISSING / COHORT_TOO_SMALL` instead, and the officer overview says which
cohorts those were, because that is a fact an administrator acts on.

*The cost, stated:* a small department's students see a lower score than a
large department's equally-prepared students, because fewer of their
components are measurable. The denominator is shown everywhere precisely so
that this is visible rather than mistaken for being behind.

### The public verify page downloads JavaScript it does not use.

`/verify/[code]` is server-rendered and renders fully without JavaScript —
the `serverRendered` check in `apps/web/size-budgets.json` proves the page
itself adds 0.2 KB, Next's page stub and nothing else. But its first load
measures ~117 KB, because the App Router sends the framework bundle and the
`(public)` layout chain to every route whether the route needs them or not.

*Why it is worth a decision rather than a shrug:* this is the only page in the
product whose audience has never seen the product. A recruiter opens it once,
often on a phone, on whatever connection they have, and forms their whole
impression of the college's platform from it. 117 KB to render a table of
nine numbers is not a failure, but it is not nothing either.

*What ships:* the budget records the measured figure (125 KB, with headroom)
and the comment says what the number is made of, so nobody reads it as the
page being heavy.

*The option, for whoever picks this up:* `/login` already achieves a true
zero-JS render through the Pages Router, with a `zeroJs: true` budget that
asserts no `<script src>`, no preload and no `__NEXT_DATA__`. The same
treatment would work here, and `/verify` is the strongest candidate in the
product for it — it has no interactivity at all. It was not done in Phase 9f
because moving a route between routers is a change to how it is rendered, not
a tweak to its budget, and the phase was not the place to make it quietly.

## Phase 10 — ops, observability and the things that cannot be run here

### An eleventh metric, because an alert needs a series.

SPEC §10 lists ten required metrics and, in the same sentence, eight alerts.
One of those alerts — "failed logins >100/min" — has no metric in the list to
read. So `auth_login_failures_total{reason}` exists, and the ten are treated
as what the spec requires rather than as a ceiling.

The alternative was a rule written against the log stream: pino → Loki, with
Loki's own ruler. That is a second alerting system with a second set of
failure modes (a label changed in a log line silently empties the query), for
one rule, and it would have been chosen only to keep a list at ten.

`reason` is the sign-in failure CODE, a closed set of nine declared in
`apps/web/src/lib/auth/sign-in-errors.ts`. Never the account, never the
hashed address. That is not squeamishness: Prometheus is scraped by another
host, retained for months and rendered on screens people photograph, and
`audit()` already records a failed sign-in against the account in a table
with access control over it. The counter answers "is somebody spraying us",
which is a rate and not an identity.

Counted at the route's `failed()` funnel rather than inside `signIn()`,
because a cross-site post and a body that is not our form never reach
`signIn` — and those are the shapes an attack has.

### Half the alert rules cannot have their condition produced here, and the harness says so.

Four of the eight fire against the real stack: a 250-job backlog, a job left
to wait a real sixty seconds, a `JudgeNode` row that stopped checking in, and
120 refused sign-ins against the running web app. The other four are
asserted against samples, and each for a different reason:

- **disk >80%** and **DB connections >80%** read node_exporter and
  postgres_exporter. Neither installs on this machine without root. The DB
  condition is itself producible — opening eighty connections is a loop — but
  producing a condition that no metric observes proves nothing.
- **INTERNAL_ERROR rate >2%** needs a problem whose checker exits 3, run
  through the whole pipeline. That is the mid-contest judge drill, which is a
  manual 10f item against a judge host, not a row for a script to write into
  a database.
- **e2e p95 >30s** needs a 31-second verdict, which means making the judge
  slow on purpose. That is a load test; `scripts/load/burst.ts` is where that
  lives.

What is open: the first two stay synthetic until the college's monitoring VM
exists, at which point the exporters are installed and the two rules should
be fired for real on it — that is twenty minutes of work there and
impossible here. The third is closed by the judge drill when it is run. The
fourth is arguably best left synthetic for ever: an alert test that requires
the platform to be slow is a load test wearing a different hat.

### The harness mirrors each expression; it does not evaluate it.

Every rule carries a `reduce` that reads the number its PromQL computes, and
`packages/shared/test/alerts.test.ts` asserts each rule fires just above its
threshold and stays quiet just below it. That catches the mistakes that
matter in practice — a threshold that disagrees with the YAML, a metric name
that does not exist, a histogram read through the wrong series — but a mirror
is not an engine: `reduce` and the expression are two implementations of one
intention, and they could agree with each other and both be wrong.

`promtool check config` and `promtool check rules` close the syntax half, in
CI. What remains open is semantic: nobody has watched Prometheus itself
evaluate `histogram_quantile(0.95, …)` over these buckets and return the
number `reduce` returns. The honest way to close it is a one-off on the
monitoring VM — load the rule file, feed it the harness's own samples through
`promtool test rules`, and record the result in the runbook. `promtool test
rules` takes a unit-test file of series and expected alerts, which this
repository could write today; what it cannot do is run it.

### The `runbook_url` in a rule points at a GitHub blob.

`RUNBOOK_BASE_DEFAULT` is this repository's own `docs/RUNBOOK.md` on `main`,
and the generator takes an override. For an on-call person at 10:40 on the
morning of a drive, a link that needs a GitHub account and a VPN is a link
they will not open. The right answer is the runbook published where the
college's ops people can read it — a static page on the app host, or a PDF in
the department share — and the override exists for exactly that. Left as the
repository URL because inventing a URL that does not resolve would be worse
than a slow one that does.

### No `statementVersion` column: `Problem.version` already is one.

The design asked for a new counter, bumped by the publish path. There is
already one: `Problem.version`, the optimistic-concurrency token, is
incremented by exactly the two writes that can change what a student reads —
the publish flip and a retire — and the statement itself lives on a
`ProblemVersion` that is frozen at publish and can never be edited in place.

So `problem:{id}:v{version}` uses it. A second counter would have to be kept
in step with the first, and the failure mode of getting that wrong is
precisely the bug the versioned key exists to eliminate: a student reading an
old statement. The one cost of reusing it is that a future write which bumps
`version` for an unrelated reason would orphan a cache entry that was still
valid — a wasted re-read, in the direction that is safe.

### The catalogue ROWS are not cached, and should not be.

SPEC asks for the problem list under `unstable_cache` with the tag
`problems`. What is cached is the company filter options — the one part of
`/problems` that is identical for every student. The rows are not, because
one SQL statement returns the page, its window count, the viewer's solve
state from `UserProblemStatus` and their bookmarks: a tuned single round
trip, and every row in it is user-scoped.

Caching it per student (a `userId` in the key, which the rule allows) would
mean a student who has just solved a problem is told for the next minute that
they have not. The staleness lands on the one column they are looking for.
Splitting the statement into a shared id page plus a per-user overlay would
make it cacheable, at the cost of two round trips and the window-count
pagination; worth revisiting only if `/problems` ever shows up in a slow
query log, which at a page size of 20 over a few thousand problems it will
not.

### The leaderboard ZSET was measured, and not built.

SPEC asks for "a Redis ZSET for ZREVRANK" so a student's own rank is O(log n)
rather than a count. Measured first, on PostgreSQL 17.11 in the WSL mirror,
against a table with the board's index shape and **50,000 rows — sixteen
times a 3,000-student campus**:

| case | rows counted | execution |
|---|---|---|
| a student at the very bottom (every row ahead) | 50,000 | **5.2 ms** |
| a student in the middle | 24,842 | **4.4 ms** |

At this campus's scale that is a fraction of a millisecond, and a Redis round
trip is 0.2–0.5 ms of it. So the ZSET would save a few milliseconds and cost
a second source of truth for the number students care about most.

That cost is not hypothetical, and it is why this is recorded rather than
done:

- **It would be stale.** `XpBucket` moves on every solve. A ZSET rebuilt by
  the nightly job gives a rank that is hours old, while the count is live. A
  stale rank is worse than a slow one — the student refreshes and sees the
  same number after solving.
- **It cannot express the board's own rules.** The visible rank subtracts
  the students who have opted out of the public board (`aheadAll -
  aheadHidden`), and the tiebreak is `lastXpAt` ascending, then `userId`. A
  ZSET scores by one number: encoding xp and the timestamp into one float is
  doable (xp × 2³¹ + an inverted second count fits in a float64 mantissa for
  xp under 4 million), and the opt-out needs a second ZSET or a second query.
  Two structures that must agree with each other and with Postgres.
- **The fallback path doubles it.** "Falls back to the table when Redis is
  down" means two implementations of rank, which can disagree — and the
  disagreement surfaces as a student's rank changing when nothing about
  their XP did.

What would change the decision: a single board over ~200,000 rows, or that
count over 50 ms in production. Both are a different institution.

One thing the measurement did show, recorded because it looks like a bug and
is not: the planner chooses a **sequential scan**, not the
`(period, periodKey, xp DESC, lastXpAt ASC)` index, because the predicate is
`xp > me.xp OR (xp = me.xp AND lastXpAt < me.lastXpAt)` and an OR across two
columns is not a range on that index. At these sizes the seq scan is the
cheaper plan anyway. Making it index-only would mean a row-comparison
predicate, which does not express a mixed `DESC, ASC` order without
rewriting the index — work worth doing at the row counts above, and not
before.

### `Cache-Control: public` on statements was not added.

SPEC's caching line asks for `public, max-age=300,
stale-while-revalidate=86400` on problem statements. The caching is
implemented — immutable key, nothing invalidated, only orphaned — as a
SERVER-side cache rather than an HTTP header, and the header was left off
deliberately:

- **A statement is not anonymous content on this platform.** `/problems`
  requires a session; a publicly cacheable statement endpoint would make the
  problem set readable by anyone who can guess an id. That is a product
  decision, not a caching one.
- **There is no shared cache in the topology.** `deploy/compose.app.yml` puts
  Caddy in front of two web replicas with no CDN behind it, so `public` would
  grant permission to a cache that does not exist while opening the one risk
  it carries.
- **The page is server-rendered by requirement.** SPEC §5 requires the
  workspace to render without JavaScript, so the statement arrives inside the
  page rather than as a subresource a browser could cache on its own. There
  is nothing for `max-age` to apply to.

What the spec wanted from the header — a reload that costs nothing and no
invalidation to get wrong — is what the immutable key delivers: the render
and the two queries behind a statement happen once per version, not once per
request. What is open is the browser-cache half, which needs either a
decision that statements are public or a statement subresource; if the
college ever puts a CDN in front of the app host, this is the first thing to
revisit.

### Field vitals have no user id, and "which students see a slow editor" is therefore unanswerable.

`POST /api/vitals` takes a metric, a value and a route pattern. It stores a
bucketed histogram per metric per route per day in Redis, with a 35-day
expiry set on every write. There is no user id, no session, no address, and
the dynamic segment is collapsed in the browser before the beacon goes out:
`/problems/two-sum` is reported as `/problems/[slug]`.

The trade, stated rather than discovered later: a `WebVital` row per page
view per student would answer "whose editor is slow" — and would be a
browsing history with a performance column, in the datastore with the least
access control over it. The questions this platform actually needs answered
("is the p75 LCP on the statement page within its 2.5 s budget this week")
need the route and the number and nothing else.

What is lost is real, and worth naming: a single student on a bad device
cannot be found from this data, and a complaint ("the editor is slow for me")
cannot be confirmed or refuted from it. The answer to that is the `perf`
Playwright project on a device, not a per-student table.

### A vitals report is attributed to the route the document was LOADED with.

LCP, FCP and TTFB are document-level, and CLS and INP accumulate over a
document's life. The handlers are registered once per document, so a layout
shift caused by a client-side navigation to `/leaderboard` is attributed to
whatever route the student entered on — usually `/dashboard`.

Re-registering per navigation would double-count, which is worse. The
honest alternatives are to accept the attribution (what is done) or to
report a route change as a new "page view" with its own partial metrics,
which web-vitals v4 supports but which needs a reset discipline this
platform has no use for yet. Revisit if a route's p75 ever looks wrong in a
way that only SPA navigation explains.

### One page load in four reports, so a quiet day has thin data.

`VITALS_SAMPLE_RATE` is 0.25. A p75 per route per day needs tens of samples,
and a contest hour will produce thousands; a quiet Sunday on a small route
may produce five, and `vitalPercentile` will happily compute a percentile
from five samples. Nothing in the pipeline marks that as thin.

The fix, if it ever matters, is to report the total alongside the bucket —
`vitalPercentile` already returns it — and to refuse to draw a p75 under
some minimum. Not done, because there is no dashboard yet to draw it on.

### Lighthouse CI's budgets are enforced in CI, which this repository has never run.

`apps/web/lighthouserc.json` holds the assertions and
`.github/workflows/ci.yml` runs them against a production build with the
reference device's throttling. The configuration was validated by running
`@lhci/cli` locally against a production build (recorded in
`docs/RUNBOOK.md` §3), which is the part that can be done here; the GitHub
job itself has never run, because nothing in this project has ever been
pushed.

What that leaves open: whether the budgets pass on a CI runner. The numbers
come from `docs/CAPACITY.md` §8 and are targets for the reference device,
and §7.2 already records that this development laptop does not meet the
editor's timing targets under its own load. A runner is a different machine
again. The first CI run will say, and the honest expectation is that one or
two assertions will need a documented adjustment — which must be an
adjustment with a reason in CAPACITY.md, not a quiet loosening of the
budget.

### The topology is written and has never been started, and that is the honest state.

`deploy/compose.app.yml`, `compose.db.yml`, `compose.judge.yml`, the
`Caddyfile` and `pgbackrest.conf` are the artefacts the college's ops person
will use. None of them has been run: one Windows laptop with a WSL2 mirror,
no second host, no registry, no public hostname, no certificate, no object
store, nowhere offsite.

What that leaves genuinely unknown, as opposed to merely untried:

- **Whether the app image runs as `node apps/web/server.js`.** The repository
  has no Dockerfile yet — CI builds and tests, it does not package. The
  compose files name `RECX_WEB_IMAGE` and assume a standalone Next build.
  Writing the Dockerfile without being able to build and run it would add a
  second unverified file rather than remove one, so it is named here instead.
- **Whether `mc ready local` is the right MinIO health check** for whichever
  release the college pins. It is right for recent ones.
- **Whether the judge container's `privileged` + `cgroup: host` is enough for
  isolate inside Docker.** The worker runs natively in WSL2 here, where every
  judging test in this repository runs; nobody has run it inside a container.
  The systemd unit in `infra/judge/systemd/` is the path that IS exercised,
  and a college with two judge hosts should probably use it.
- **Whether a rolling restart actually preserves an SSE stream.** The deploy
  script restarts one replica at a time and waits for health, but a student
  whose stream was pinned to the restarted replica reconnects — the client
  does reconnect, and what that looks like mid-contest has not been watched.
  It is why the script refuses to deploy during a contest at all.

### The restore drill runs here; the offsite half cannot.

The drill is the part that gets skipped everywhere, so it is the part that
runs: 67 seconds, into a scratch database, with the drift check and the row
counts and the blob consistency check (`docs/RUNBOOK.md` §3). What it does
not cover is pgBackRest: WAL archiving, the 5-minute RPO, the encrypted
offsite repository and the 2-hour RTO are configured and untested, because
testing them needs a second host and an object store.

The gap matters in a specific way worth writing down: the drill proves a
`pg_dump` set restores. It does NOT prove that point-in-time recovery works,
and those are different mechanisms — a dump is a snapshot, WAL replay is a
sequence. A college that wants the 5-minute RPO must run `pgbackrest
restore --type=time` once on the real host before believing it.

### There is no Dockerfile in this repository. *(Closed in Phase 11e — see below.)*

Mentioned twice because it is the thing somebody will look for. CI builds the
application and runs the gates; it does not produce an image. The compose
files take one by digest. Writing a Dockerfile that has never been built
would be the third unverified artefact in a phase already carrying two, and
the image is also the one artefact whose correctness is cheap to establish
the moment a registry exists.

What it will have to do, recorded so the next person does not have to derive
it: a Next standalone build, the Prisma client generated for the right
platform, `prisma/migrations` present (the health endpoint counts the
folder), the judge worker and scheduler as separate entrypoints from the same
image, and no toolchain in it at all — those belong to the judge image, which
`infra/judge/` already defines.

### The manual items carried out of earlier phases, and why each is still open.

Phase 10 closes with these outstanding. They are listed together because a
deferred manual check that is not written down anywhere becomes a check
nobody remembers was never done.

| Item | From | Why it is still open |
|---|---|---|
| A full assessment sat with a **screen reader in each proctor mode** | 6 | An hour or more per mode, with NVDA, actually sitting it. Clicking through it quickly would produce a gate row that says PASS and means nothing. `docs/ACCESSIBILITY.md` §6 now says so rather than implying every gate included one |
| **Drop the network mid-attempt** and watch the save path | 6 | Producible here (the service worker and the write-ahead to IndexedDB exist), and it needs a person watching a real attempt rather than a script: the question is what the student SEES, which is the one thing automation here cannot judge |
| Sit a full seeded **TCS-NQT mock** end to end | 7 | Two hours of sitting. The sections, the per-section clocks and the auto-submit are covered by tests; what is not is the experience of the whole thing |
| Import a **300-question CSV with three broken rows** | 7 | The importer's row-level errors are unit-tested; what is untested is whether a staff member can tell from the report which three rows to fix |
| Read a **Phase 8 dry-run sweep report** end to end | 8 | The sweep's dry run is tested; the report is for a human to read before a live run, and nobody has read one |
| **axe on `/account/leave` and `/account/reactivate`** | 8 | Both are in the suite's page list now; what was deferred was the manual pass at 400% zoom |
| The **readiness card for three lopsided students** | 9 | Needs three seeded students with deliberately uneven profiles. The arithmetic is unit-tested; the question is whether the card reads as fair to the student it describes |
| The **nightly job, dry-run then live**, read end to end | 9 | Producible here; it is a reading task, not a scripting one |

None of these is blocked by anything external. Every one is a person-hours
item, and the honest reason they are open is that they are person-hours
items. The two Phase 10 manual items the spec named — the judge plug-pull and
the Redis restart — were done (`docs/RUNBOOK.md` §3), and the plug-pull found
a bug that none of the automated suites had, which is the argument for
getting through the rest of this list rather than retiring it.

### Prometheus never evaluated these rules; `promtool test rules` would close that.

Recorded in the 10b section above and repeated here because it is the one
observability gap that survives the phase: `reduce` in
`packages/shared/src/alerts.ts` mirrors each alert expression and the harness
asserts the number crosses, but nothing on this machine has watched
Prometheus itself evaluate `histogram_quantile(0.95, …)` over these buckets.
`promtool test rules` takes a unit-test file of series and expected alerts;
this repository could write one today and cannot run it.

### GlitchTip is configured nowhere, and that is a deliberate gap rather than an oversight.

SPEC §10 asks for GlitchTip rather than Sentry SaaS, so that stack traces
containing student data stay on college infrastructure. There is no host to
run it on, and adding a DSN to the application now would mean either
pointing it at nothing or pointing it at a SaaS — the second being the thing
the spec rules out. What exists instead: pino JSON on stdout, which the
compose files rotate, and `console.error` with a reference id on every
unexpected path (`lib/errors.ts`), so an incident is traceable from a
student's reference number without an error tracker.

What to do when the host exists: add the DSN as a Docker secret, initialise
in `instrumentation.ts`, and **scrub before send** — the same label rule the
metrics follow, because a stack trace carries local variables and those
include a student's code.

## An expired sitting is not banded (Phase 11b)

`submitAttempt` bands a sitting when the candidate submits, which is where
the integrity engine was finally connected. An attempt that runs out of
time is auto-submitted by the scheduler's sweep
(`autoSubmitExpired` in `@recx/db`), and that path does NOT band it.

Why that is acceptable rather than a hole: the sweep moves a status and
nothing else — an expired attempt has no `Submission` rows at all, because
the only place a sitting's submissions are created is `submitAttempt`. A
band's one consequence is withholding a result from the public
leaderboard, and there is no result to withhold.

Why it is still written down: the two paths live in different processes.
The engine is `apps/web/src/lib/integrity/flag.ts`, which the scheduler
cannot import, so if an expired sitting ever starts producing a result —
the more interesting question, and a real one for a candidate whose
browser died at minute 55 — banding it needs either the engine moved into
`@recx/db` or an internal endpoint for the scheduler to call. Neither is
worth building before the first case exists.

## PR #1 was never merged, and it still holds work (Phase 11d)

`phase4/integration-aenby5` — the Phase 4 adversarial review — is open as
pull request #1 against `phase4/integration`. It is **14 commits ahead and
77 behind**, and the assumption that it had been superseded is wrong. Some
of it was re-implemented on the integration branch, usually more thoroughly:
`tests/repo/render-read-only.test.ts` is 183 lines here against its 107, and
`tests/repo/admin-scope.test.ts` 742 against 710. Some of it was not
re-implemented at all.

The triage: for each of the 29 source files the branch touches, take the
distinctive lines it adds and ask how many appear in our copy of that file.
Full coverage means the change landed by another route; near-zero means it
did not. Every low score still needs reading, because a file the integration
branch restructured for Phases 5–10 scores zero whether the change is
missing or obsolete.

**Ported in Phase 11d**, with the branch's own tests, all four about the
same failure — a student leaves something open, the generated driver is
swallowed into it, and the compiler reports the judge's own code at them:

* `remap.ts`: when g++ says `expected '}' at end of input`, that is now the
  only generated-code message shown. The fixture in the ported test is real
  g++ 13 output for the two-sum reference with its closing `};` removed — 14
  errors about `recx_harness` and `Solution::main()`, which collapse to one
  error and the student's own `to match this '{'` note.
* `remap.ts`: a line still naming `recx_harness` after the qualifier is
  stripped is dropped, rather than becoming `'' has not been declared`.
* `remap.ts`: CPython's `(detected at line N)` is mapped like `on line N`,
  so an unterminated string reports the student's line — or
  `(detected after your last line)` when only the driver noticed.
* `values.ts`: an integer token longer than 20 characters is refused without
  constructing a BigInt from it. A four-million-digit token printed by
  student code took seconds; it now fails in under 200 ms.
* `values.ts`: a FUNCTION test whose `IN_PLACE_MUTATION` expected value has
  a different length from the input is refused at authoring time, because
  Java passes a fixed-length array and no Java solution could ever pass it.
* `cpp.ts`: the harness reads doubles with `strtod` and checks the whole
  token was consumed, instead of `stod`, which accepts trailing garbage.

**Not yet assessed**: the other 26 source files, which are concentrated in
`lib/privileged/**`, `server/actions/privileged.ts`, `server/queries/submissions.ts`,
`apps/scheduler/src/{mail,outbox,governance}.ts`, the import spool, and
`packages/design`'s dialog and `derive.ts`. Their commit titles name real
defects — "purge vs rejudge", "SMTP stall", "legal hold", "governance
races", "AdminScope on submission views", "a non-dismissible dialog reopens
if the browser force-closes it" — and each needs the same read: is this
defect still present, and does the fix still apply to code that has moved on
by 77 commits?

**Do not merge the branch.** It is 77 commits behind and its tests are older
than the ones here; merging would take back the weaker versions. Port file
by file, with the branch's tests, as above.

### The second pass over PR #1, and what is left after it

Eleven more of that branch's fixes are in, each with the branch's own tests,
each checked against this tree before porting rather than applied on trust.

**Governance and the two-person rule.**

* An approval now requires the REQUESTER to still be an active super-admin.
  Without it, a super-admin who is demoted or disabled — say because the
  account was compromised — leaves pending requests that a second
  super-admin can still approve, which is the two-person rule holding in
  form and not in substance. The check is in the action (with a message that
  says what to do: reject it, or ask again) and in the approve UPDATE's own
  WHERE, so a demotion that commits during the approval is refused too.
* A PII export names its accounts at request time. The payload carried only
  a filter, and the filter was evaluated again at execution, so the set of
  accounts exported was not necessarily the set the approver reviewed — a
  roster import, a status change or a role change in between would quietly
  change it. The approved payload now carries `userIds` (at most
  `PII_EXPORT_MAX_ACCOUNTS`, 10,000), and the download streams exactly those.
* The decision and its SECURITY audit row commit together. They were two
  statements; a crash between them left a decided operation with no audit
  trail of who decided it.
* An operation APPROVED but never executed is swept to FAILED after 15
  minutes. Nothing else could move it: the process that died between the
  approval and the claim left the row APPROVED forever.

**Purge versus rejudge.** A submission whose source was archived — by a
`SUBMISSION_PURGE` or by retention — keeps its verdict row forever, and
rejudging it would compile an empty file and overwrite that verdict with a
compile error. Rejudge selection now excludes archived sources (global and
single), and the claim refuses one outright, so neither path can reach the
judge.

**The scheduler's tick.**

* SMTP gets explicit timeouts (10 s to connect, 10 s for the greeting, 20 s
  on the socket) instead of nodemailer's defaults of 2 minutes and 10
  minutes. The outbox drains inside the tick that also runs the judge
  reconciler.
* The drain has a 30-second send budget. Rows it does not reach go back to
  PENDING with their attempt refunded, rather than the tick stretching to
  the length of the slowest relay.
* Every outbox UPDATE matches the `attempts` value it claimed with, so a row
  another instance reclaimed after a lease expired is not finished twice.

**A lost update in the study-plan recount.** The recount counted enrolment
progress in one statement that read the count before waiting on a finalise's
lock and wrote it after — losing the solve the finalise was committing. The
enrolments are now locked in their own statement first.

**The design system.** A derived theme's `--muted` is clamped to the spec's
DO-NOT bounds (never lighter than #6f6a87 in light, never darker than
#9c95b4 in dark); the contrast clamp alone could stop short for some hues,
and a super-admin's brand colour is what runs through that code. `Dialog`
gained `dismissible={false}`, closes itself on unmount so focus returns to
the control that opened it, and asks the parent on Escape instead of closing
natively. Its one caller is the judge-node token, shown once and held only
in memory, where Escape or a stray backdrop click lost it and forced another
rotation — with the node unable to claim jobs in between.

**Still not ported**, and still worth a read: `lib/authoring/import/{run,spool}.ts`
and `lib/authoring/tests.ts` with the new `function-tests.ts` (the import
spool and lock, canonical FUNCTION tests), `lib/admin/roster{,-plan}.ts`
(the roster preview), `server/queries/submissions.ts` and
`server/queries/super-dashboard.ts` (AdminScope on submission views), and
about twenty one-to-two-line edits across `/super` and `/admin` pages. The
same question applies to each: is the defect still here, and does the fix
still apply after 77 commits? The branch stays open until somebody answers
that for all of them; it still must not be merged.

### PR #1 is finished, and can be closed

The third pass took the rest. What it brought, beyond the eleven above:

* **An ADMIN could see any student's submission.** `canView` on the
  submission and run views admitted any staff role, so an ADMIN whose
  AdminScope covers one department could open a submission belonging to a
  student in another — through the page and through
  `/api/submissions/[id]`. It now resolves the owner through the scope
  (`findScopedStudent`), and an ADMIN with no active grant matches nobody.
  Separately, an ADMIN now sees a submission's metadata and verdicts but
  never its code: `sourceWithheld`, the same rule the admin student page
  already followed. The owner and a SUPER_ADMIN still see everything.
* **FUNCTION tests are canonical on every path into a revision.** Only bulk
  import checked. A test added in the editor, or already stored when a
  signature changed, could be accepted by the C++ reader ("009", "+9",
  "9.0", trailing text) and rejected by the Python and Java harnesses — so a
  correct solution failed in two languages out of three. `addDraftTests` and
  publish now run the same check.
* **A validation run on a superseded toolchain no longer counts.** After a
  compiler or interpreter upgrade a revision could be approved and published
  on measurements taken with the old one. Only runs on the language's
  current `LanguageConfig` are read.
* **The import read the problem before taking its lock**, so a revision
  another admin started a moment earlier could be missed. It re-reads after
  the lock.
* **`countActiveSuperAdminsLocked`** replaces an unlocked count in the bulk
  status executor, so two concurrent operations cannot each believe a
  super-admin remains.
* **The roster preview stopped going stale for no reason.** Its hash
  included each matched account's `updatedAt`, so a student signing in or
  submitting between preview and commit invalidated the whole plan. The hash
  now covers what the plan actually depends on — every change's current
  value, the link, and the outcome kind — and not `updatedAt`.
* A PENDING bulk status change now shows the approver who is in it (counts
  by role, every non-student named), the mobile admin menu closes on
  navigation, two focusable scroll regions got a `role`, and `/super/` is
  now in the Monaco-free budget (79 routes checked, up from 64).

**Deliberately not taken:** `tests/repo/render-read-only.test.ts`,
`tests/repo/student-exposure.test.ts` and `tests/repo/support/exposure-rules.ts`,
where this branch's versions are the later and larger ones (183 lines
against 107, for instance) — applying the branch's would be a regression.
Also `apps/web/test/seed-content.test.ts`, a test-runtime optimisation
(caching generated inputs, explicit timeouts) that no longer applies to the
file as it stands; worth redoing from scratch if that suite ever gets slow
in CI.

So PR #1 is done: everything from it that is still a defect here is fixed,
with its tests, and the rest is recorded above. The branch can be closed
without merging.

## The Dockerfile exists now, and what "verified" means for it (Phase 11e)

The earlier entry argued against writing one: an image nobody had built
would have been "the third unverified artefact in a phase already carrying
two". That argument was right about the risk and wrong about the cost of
the alternative — `deploy/compose.app.yml` names `RECX_WEB_IMAGE` and
`scripts/ops/deploy.sh` refuses anything that is not a digest, so until
something built that image the whole deployment path was theory.

`docker build` still cannot run here: there is no engine on this machine.
So the Dockerfile was verified by **reproducing it without Docker** — a
clean `git archive` tree, the same hoisted install, the same `prisma
generate` and the same three builds, the same `pnpm deploy`, assembled into
the same layout the `COPY` lines produce, and then every entrypoint started
from it. That found three defects, each of which would have produced an
image that builds and then fails on its first request:

1. **pnpm's symlinks are absolute.** The default layout links each package
   to an absolute path under the build directory, and `next build` copies
   those links into `.next/standalone` as links. In the runtime stage they
   point at nothing, and the server dies on its first require with
   `Cannot find module 'styled-jsx/package.json'`. Fixed with
   `--config.node-linker=hoisted`, which makes them real directories.
2. **The bundles' dependencies are not the web app's.** The standalone tree
   carries what the web imports; `pino` and `nodemailer` are in the
   scheduler and in no part of it, so `node apps/scheduler/dist/main.js`
   could not resolve them. Each service now gets its own production tree
   from `pnpm deploy`.
3. **`pnpm deploy` writes a stub Prisma client.** It re-runs the db
   package's postinstall in the new tree and leaves a 40 KB stub where the
   ~50 MB generated client should be — `Prisma.sql` and `Prisma.raw` absent
   — so the scheduler died on its first raw query with
   `Prisma2.raw is not a function`. The build copies the generated client
   over it and asserts it landed.

Also found and fixed: the bundles need their own `package.json` beside them
or Node reparses them on every start (`MODULE_TYPELESS_PACKAGE_JSON`).

What the dry run proved: `/login` 200, `/api/health` with `"db":"up"`,
`"redis":"up"` and `"migrations":"current"` — the migrations folder resolves
inside the standalone tree, which is the one thing the health endpoint's
`../../packages/db/prisma/migrations` depends on — a `.next/static` chunk
200, `/monaco/vs/loader.js` 200 from `public/`, the scheduler connected to
Postgres and Redis and running a tick, and the judge worker loading, running
its hardening check and refusing for the right reason.

What it did not prove, and what the first real build must: the base image
(`node:22.17.1-bookworm-slim`), the two apt packages, and the Prisma query
engine built for `debian-openssl-3.0.x` instead of Windows. The assembled
tree was 254 MB before the base image, which is the number to compare the
first `docker build` against.

`tests/repo/deploy-topology.test.ts` holds the parts that are easy to undo
by accident: the hoisting flag, the Prisma copy, the per-service
`node_modules` and `package.json`, a non-root `USER`, one `ARG` for the base
image, no toolchain in any `apt-get install`, and no path by which a `.env`
could enter a layer.

## An admin-set initial password, and why it is good for one sign-in (Phase 11f)

The request was plain: adding a user should work one at a time and in bulk,
each account should get a default password, and a new user should replace
that password with their own while everybody else changes theirs with the
old one first.

Both halves of the first part already existed — `/admin/students/new` (Phase
11b) and the roster CSV import (Phase 4) — but both created accounts with no
password at all, on the reasoning that nobody should choose a password for
somebody else; the holder set one through the one-time link (Phase 11a).
That reasoning is still right where email works, and blank is still the
default. What it could not do is a lab of first-years signing in on day one
with no mail flowing.

**The danger, stated plainly.** A default password is almost always ONE
password given to a whole batch. Every account that still holds it is an
account anyone in that batch can open — including, if the list leaks, from
outside. A feature that stops there would be worse than no feature.

**So the password is good for exactly one sign-in.** `User.mustChangePassword`
is set when an admin supplies one, and while it is set:

* `requireUser` redirects every page to `/account/new-password`, and
  `requireActionUser` throws on every action. The two guards that admit such
  an account (`requireUserSettingInitialPassword` and its action half) are
  used by that page and that action and by nothing else;
* the replacement is refused if it IS the password they were given — which
  is the single thing this flow exists to prevent;
* a database CHECK refuses the flag on an account with no password at all:
  a password you do not have cannot be the one you must change;
* sign-out still works, because it reads the session directly rather than
  through a guard — an account should always be able to leave.

The flag is the gate rather than the login page deciding where to send
somebody, because a session minted with that password would otherwise
outlive the sign-in that made it.

**What was deliberately not built.**

*Per-account generated passwords, handed back to the admin.* It is the
stronger design — one leak is one account — but it needs a way to carry five
hundred plaintext passwords from the import to the admin and then to the
students, and every version of that (a CSV in the response, a column in the
import report, an email per student) is a worse place for them than the
admin's own mouth. The one-time link already solves the same problem
properly wherever mail works. If the credentials path ever has to exist,
generate at import, hand it back ONCE in the response, and never store it.

*An expiry on the initial password.* An account that never signs in keeps it
indefinitely. A sweep that disabled such accounts after N days would be
easy, and is not obviously right: the account that never signs in is usually
the student who has not been told the platform exists yet. Revisit with the
placement cell after the first intake.

*Changing an initial password an admin already set.* There is no "reset this
student's password" button for an admin, and that is unchanged: the holder
uses the one-time link. An admin who set a password and wants a different
one deletes nothing and sets nothing — they tell the student to use the
link.

## Assessments can be created now, and are always proctored (Phase 12a)

Two things, and the second is the reason the first could wait this long.

**There was no way to create an assessment.** The sitting engine has existed
since Phase 6 — the readiness check and its consent moment, the exam
surface, the telemetry client, the attempt clock, the heartbeat and its
allowlist re-check, the invigilation page, the integrity queue and its
72-hour SLA — and every assessment that ever ran through it was made by a
test fixture. `/admin/assessments` is the missing half: create a draft, pin
its questions at their frozen revisions, schedule halls with their
allowlists, publish, open, close.

**An assessment is always proctored.** `NONE` is gone as a choice, in the
schema (`ASSESSMENT_PROCTOR_MODES`), at the server boundary and as a
database CHECK. The Phase 11b audit is why: the engine never read the mode
at all. A `NONE` assessment collected the same sixteen client signals as any
other, triaged them the same way, and could flag an attempt and withhold its
result exactly the same. The mode told a student nobody was watching while
the product watched.

Of the two ways to make that true, collecting nothing under `NONE` would
leave a sitting that counts for something with no record of how it went —
and the thing a reviewer needs most when a student appeals is the record. So
the other way: say what is actually happening. A sitting nobody watches
already has two homes, practice and contests, and neither has a proctor mode
at all.

`NONE` stays in the `ProctorMode` enum, deliberately: `AssessmentAttempt`
freezes the mode on a finished sitting, old rows hold it, and the type is
shared with the telemetry vocabulary.

**The migration refuses rather than rewrites.** A database that already
holds a `NONE` assessment fails this migration, and should. Moving those
rows would mean disabling `Assessment_published_immutable` to rewrite what a
candidate was told — and `packages/db/test/frozen-coverage.test.ts` fails
the build for a migration that disables a guard, which is exactly the fence
working. An operator decides each row by hand. (Production holds none:
nothing could create an assessment until now.)

**Not built, and worth naming.** There is no edit for a DRAFT's terms — an
admin who mistypes the window deletes the draft and makes another, which is
cheap while it is a draft and impossible after. There is no seat mapping
(SPEC §5 asks for a seat label per candidate; the hall exists, the seat does
not). There is no way to remove a hall once scheduled, only to stop using
it. And nobody has yet run a real assessment end to end: the drill that
proves this is a cohort sitting one, not a fixture.

## The AI helper, and the thing it has never actually done (Phase 12b)

A student stuck on a **practice** problem can now ask the assistant what
they have got wrong, or how to approach it. Three decisions are worth
recording, and one gap is worth naming loudly.

**It goes through the existing help chokepoint, not beside it.**
`apps/web/src/lib/help/access.ts` says of itself that every hint and
editorial read — "anything later phases add" — asks `getHelpState()` and
obeys its answer, and that there are no per-feature branches. The assistant
is that later phase. `aiAllowed()` takes the same `HelpState` the hints do,
with the same server-decided context, so the assistant cannot be reachable
on a surface where a hint is not. A new `if (context === "PRACTICE")`
somewhere in the AI code would have worked today and rotted the moment
somebody added a fourth context.

**Asking makes a later first solve ASSISTED.** This is the decision that
cost the most thought and is the least visible in the UI. Readiness (SPEC
§9) is built on *unassisted* coverage; an assistant that reads a student's
draft and names the bug is past anything a tier-3 hint does, and a solve
that followed one is not evidence the student could have got there alone.
An assistant that did not mark the solve would have inflated every
readiness number in the college, silently, and nobody would have found it
from the outside. So `AiAssist` is a row the finaliser reads exactly as it
reads `HintReveal`, and the table is append-only — a deletable row would
let the XP and the readiness number resting on it be rewritten afterwards.

**The key is environment-only and the model is a setting.** The super-admin
asked for "customisable between multiple models, and the ability to turn it
off". Both are on `/super/settings/ai`, read per request so the kill switch
takes effect on the next one. The API key is not there and cannot be put
there: a key in a `PlatformSetting` row is a key in every `pg_dump` and on
every admin's screen. The model catalogue is closed for the same kind of
reason — the id reaches an external API, and "whatever somebody typed" is
not a thing to send to one. The one escape hatch is *College-hosted model*,
where the deployment names the endpoint.

**NOT RUN: no model has ever answered.** This is the gap. There is no
`AI_API_KEY` on this machine and no account to get one from, so every path
up to the HTTP call is tested — the refusals, the prompt bytes, the
recording, the sanitising, both request shapes, the timeout, the failure
row — against a fake `fetch`, and the real call has never been made. What
that leaves unproven is small but real: that a live Anthropic response
parses as this code expects, and that a real model obeys the system prompt's
"never a complete solution" under pressure from a student's half-written
program. The first is a ten-minute check with a key. The second is a
judgement that has to be made by reading real answers, in practice, over a
week — and the daily per-student allowance exists partly so that week is
affordable.

**Also not built, and deliberate.** There is no conversation: each question
is answered on its own, because a thread is a place for a student to argue
the model into writing the solution. There is no "ask about this line".
There is no per-cohort or per-problem switch — the helper is on for
everyone or nobody, which is the only setting a super-admin can reason
about on the morning somebody complains. And the assistant is not offered
to staff: an admin who wants to know whether a problem is confusing should
read the hint tiers and the submission log, which are the evidence.

## Spaced revision, and the bug the arithmetic hid (Phase 12c)

SPEC §11's post-launch list calls this "the highest-value thing here that
LeetCode does not have, because the documented failure mode of sheet prep is
solving 300 problems once and retaining none." It is now built: a problem
you solve comes back after a day, then three, seven, twenty-one and sixty,
and clearing the last step retires it.

**The bug worth recording.** The XP ledger row was first keyed on the rung
the card came due on — `revision:{user}:{problem}:{stage}` — which reads as
the tightest possible key and is wrong. A card that lapses from rung 2 back
to rung 1 has to climb rung 1 a second time, and that rung's key was spent
on the first climb. Because the ladder deliberately only advances when the
ledger row was actually inserted, the second climb would have paid nothing
AND never moved: a student who forgot one problem once would have been stuck
on it forever, seeing the same card every day with no way to clear it.

Nothing about the design on paper showed this. It appeared the moment a test
walked a real card up the ladder, down one rung and up again. The key is now
the campus day, which the schedule already makes unique — a review pushes
the card at least a day out, and a lapse pays nothing — and the comment on
`XP_KEYS.revision` says why, because the rung version will look like an
improvement to the next person who reads it.

**Why three a day, and why the backlog is stated.** A queue with no ceiling
is a debt, and a debt is a tab you stop opening. `REVISION_DAILY_CAP` is
applied to what is shown; `/revision` and the dashboard card both print how
many more are past their date. A page that quietly dropped work would be a
page nobody trusts twice.

**Why the migration backfills.** Without it the feature does nothing for
anybody until tomorrow and nothing at all for the students who need it most
— the ones who solved two hundred problems last term and remember forty.
With a naive backfill those same students open it on launch day and find two
hundred cards due. So the dates are spread, three a day per student, oldest
solve first, at rung 0: the product has never asked them to recall any of
it, so it does not get to claim they are on the 60-day step.

**NOT RUN: a card has never been moved by the real judge.** The ladder is
walked end to end against recx_test — create, not-yet-due, climb, retried
finalise, lapse, re-climb, learn, rejudge, daily cap — but every one of
those submissions is a row written by the test rather than a program a
student wrote and a worker judged. What that leaves unproven is only the
seam into `finalize.ts`, which this phase did not change; the surfaces were
read from the running production build against the backfilled cards.

**Not built, and deliberate.** No self-graded difficulty (SM-2's quality
score needs an honest self-report; the judge already knows whether they got
it right, which is a smaller and more explainable input). No way to snooze
or dismiss a card — if the ladder is wrong the fix is the ladder, not a
per-card escape hatch that turns the queue into a to-do list. No notification
when cards fall due: the dashboard says it, and an email every morning about
homework is how a feature gets muted. No revision for aptitude questions,
which have their own once-per-question XP rule and would need their own
answer.

## Discussion, with the moderation role in the same change (Phase 12d)

SPEC §11: "discussion and solution sharing gated behind an unassisted solve
(with the TA_MENTOR moderation role shipping simultaneously, not after)."
Both halves are here: the board, and the tools to run it.

**The one place this reads the spec more finely than it is written.** The
spec names a single gate; the implementation splits it. Reading a problem's
solutions needs a solve of any kind, and POSTING needs an unassisted one.
The reason is that the single sentence is doing two jobs. The spoiler
problem is solved by any solve — once you have an accepted submission,
nobody's answer can spoil anything. The quality problem is the other one,
and it is the one the word "unassisted" is about: "here is how I did it"
from somebody who did it with the editorial open is not what other students
came for. Splitting them means a student who needed a hint can still read
and still ask, and the people posting are the people who got there alone.
If that reading is wrong, the fix is one line in `discussionAccess()`.

**Why only the asker and a mentor may reply to a question.** This is the
hole an anti-spoiler gate on solutions alone leaves open: a question thread
that any student could answer is the solution list again, reachable by
exactly the people the gate keeps out. Narrowing replies also makes the
thread a help channel rather than a second board, which is what a stuck
student actually wants.

**Why the moderation role could not wait.** A place where students post
about problems, with nobody able to take a post down, is not a feature at
launch. So `/mentor/moderation` (the report queue, with every post hidden
in the last 30 days listed underneath so a decision can be looked at again)
and `/mentor/doubts` (every unanswered question, oldest first) ship in the
same change as the board. The three capabilities that have carried
`arrives: { phase: 11, models: ["DiscussionPost", "DoubtThread"] }` since
Phase 4 are now wired to real guards.

**Hidden, never deleted — and the notice says who and why.** A post that
simply vanishes teaches everybody that posts vanish, and leaves an appeal
with nothing to look at. The author sees the moderator's sentence word for
word, which is also why hiding asks for ten characters minimum and the
database refuses a hidden row without one.

**Deciding a report and hiding a post are two buttons.** One button that
did both is how a queue gets cleared without anybody reading it, and the
reason the author would be shown would be a sentence written to close a
ticket.

**Not built, deliberately.** No votes or reputation: a score on a post is a
reason to post, and the thing being optimised stops being the explanation.
No editing of a student's words by a moderator — hide and explain, never
rewrite, or the byline is a lie. No discussion on contest or assessment
problems outside practice, and no notifications when somebody replies: the
first is the gate, and the second needs a digest rather than a per-event
email, which is its own phase. No per-cohort moderation queues; one college
has one board.

**NOT RUN: nobody has moderated anything they did not themselves create.**
The whole loop was driven against the production build — a student asks, a
mentor answers with the badge, another student reports, a mentor hides with
a reason, the author sees the notice and not the body, un-hide puts it back,
the report is dismissed with a person and a sentence attached — but all of
it with six seeded accounts and one problem. What a real board does to a
report queue, and whether one TA can keep up with a cohort, is a question
only a term answers.

## The interview archive, and why it has no writing box (Phase 12e)

SPEC §11: "the moderated InterviewExperience archive — structured fields,
not prose — which is the only legal and genuinely REC-specific source of
company tags and 'asked at' frequency, and is therefore load-bearing rather
than a nicety".

**No prose means none.** Not a short note, not a moderated tips field. One
free-text column exists — the company name, so a student can report a
company nobody has entered — and everything else is a closed list or a
number. Two reasons, and the first is the one that decided it: an account
of an interview written in a hurry names interviewers, repeats questions
under an NDA, and says things about a company the college would have to
answer for; moderating three hundred of those is not a job anybody would
keep doing. The second is that prose cannot be counted, and counting is
what makes this load-bearing rather than a scrapbook. Where a tips box
would have been there is a closed "what helped" list instead.

**Attributed in the database, anonymous on the page.** A rejection with a
name on it is a thing students will not post, and an archive nobody posts
to is worth nothing — so students see "An ECE student, batch of 2027". The
section is deliberately dropped: batch plus department plus section is
three or four people, which is not anonymity. Moderators see the name,
because a claim about a named company with nobody behind it cannot be
followed up.

**Three bugs this phase found, all of them by running the thing.**

The CHECK that was meant to refuse an experience naming no round kind
accepted every one of them: `array_length(x, 1)` returns NULL for an empty
array, a comparison with NULL is NULL, and a CHECK that evaluates to NULL
passes. It reads correctly and does nothing. Found on the database test's
first run; the constraint now coalesces, and the migration says why.

`withdrawInterviewExperience` had no zod boundary — it took
`{ experienceId: string }` on trust, so a malformed call reached Prisma and
came back as a masked "something went wrong" instead of a refusal. The
student-exposure sweep called it with a nonsense id and the error surfaced
in the log. Every other action in the product parses its input; this one
was written last and skipped it.

A company created from a reported interview is `curated: false`, which is
honest — it is not the placement cell's guess — and the catalogue's company
filter selected `curated: true` only. So the archive produced real
"asked at" tags for a company that could not be filtered for. Found by
loading `/problems?company=…` after the first real approval. The filter now
offers a company that is curated OR has an approved experience.

**Not built, deliberately.** No bulk importer for the pre-launch
collection: the schema takes BOOTSTRAP rows with no author and a CHECK that
says a row without one can only be that, but somebody still has to type
them, and a CSV format for fifteen fields is a thing to design after seeing
real collected data rather than before. No editing a submission after
sending it — withdraw and send another, which is simpler to reason about
and leaves no half-moderated row. No per-company page: the filter on
`/interviews` and the one on the catalogue cover it, and a third surface
would be a third place for the anonymity rule to be got wrong.

**NOT RUN: the pre-launch collection, and a curated track seen on screen.**
Nobody has collected anything from the two most recent graduated batches,
which is the bootstrap SPEC §11 asks for and an operational task rather than
a code one. And the "curated by the placement cell … best guess" label has
been asserted in two test suites but never seen in a browser, because the
development database has no curated company — the only one in it was
created by the archive itself, which is the other label.

## The recommender, and the rung order that is an argument (Phase 12f)

SPEC §11: "the rule-based, explainable recommender (no ML — it has neither
the data nor an evaluation harness to beat a good rule, and it cannot
explain itself; always render the reason inline, and rotate topics after 3
consecutive picks from the same one)".

**The reason travels with the pick.** `recommend()` returns the sentence,
and the Continue card renders that string. The alternative — a component
that switches on the rule and writes its own copy — is what the card did
before this phase, and it is a second place the explanation can drift from
the decision. A wrong explanation is worse than none, because a student
believes it.

**Two rung placements are decisions rather than conventions.** FINISH is
top because a problem already in the student's head is the cheapest thing
they can finish tonight. DRIVE is above REVISE because a drive has a date
and a revision has a schedule designed to tolerate a day: missing today's
revision costs a day on a ladder built for that, and missing the one
problem a company has been reported asking costs the interview. The first
draft had REVISE above DRIVE, and the browser run is what made the question
concrete — every seeded student got "due for revision" while a drive six
days away sat underneath it.

**Rotation reads activity, not our own suggestions.** The spec says
"3 consecutive picks from the same one". This reads the topics of the
student's last three judged PROBLEMS instead, one topic per problem.
Where the two agree it is the same signal; where they differ this one is
better — a student who ignored three array suggestions has not done three
array problems, and rotating them off arrays for it would be the product
arguing with itself.

**A gap this phase found.** `createDrive` has always taken a free-text
`companyName` and never set `companyId`, so no drive in the system had a
catalogue company — and the DRIVE rung, which needs one to look up "asked
at" tags against, could never fire. It matches on the slug now, the same
way the interview archive matches a typed company name; a drive for a
company nobody has entered keeps a null link, which is right, because
there are no tags for it either.

**Not built, deliberately.** No stored picks: the recommendation is derived
on every render, so there is nothing to go stale and nothing for a GET to
write (`tests/repo/render-read-only.test.ts`). No "not interested" control
— a dismissal needs somewhere to live, and the honest version of it is
fixing the rung that produced the bad pick. No weighting or scoring across
rungs: an ordered list is a thing a student can be told, and a weighted sum
is not. No contest rung, because a contest is a scheduled event the
dashboard already shows separately.

**NOT RUN: the DRIVE rung has never been seen in a browser.** It is proved
end to end against recx_test — the drive's company matched, the most-asked
unsolved problem chosen, a draft problem and a solved one skipped, the
horizon, the archive flag, the batch and the department filters all
refused — but the development database has one published problem and every
seeded student has solved it, so there is no unsolved tagged problem for
the rung to pick. The first cohort with two published problems closes that.

## The aptitude taxonomy cannot grow, and that is load-bearing (Phase 12g)

**ATTEMPTED AND REVERTED.** SPEC §11 lists core-CS MCQ (OS, DBMS, CN, OOP)
as a problem kind. The natural home for it is a fourth `AptitudeArea`
beside QUANT, LOGICAL and VERBAL — the question format, the sitting, the
scoring and the readiness input already exist, and the whole feature is a
taxonomy entry plus content.

It cannot be built that way. `AptitudePassage_area_topic_check` and
`AptitudeQuestion_area_topic_check` enumerate every (area, topic) pair in
the CHECK body itself, so a fourth area means dropping and recreating two
catalogued CHECKs — and `packages/db/test/frozen-coverage.test.ts` fails
the build for any migration that drops, alters, disables or bypasses a
catalogued guard. There is no allowlist, on purpose: the whole value of
that fence is that it has no "except this once" in it. The work was
reverted whole — the taxonomy, the readiness change, the schema, the
migration, the two CHECKs restored in both databases and the
`_prisma_migrations` row removed — rather than weakening the fence to fit
a feature.

**The fix is a human's decision, not ours.** The shape that would let the
taxonomy grow afterwards is to move the area→topic rule out of the CHECK
body and into an `IMMUTABLE` function the CHECK calls, so a new area is a
function body change rather than a constraint drop. That migration itself
needs one guarded drop. Someone with the authority to say "this specific
drop, once, to stop needing drops" has to approve it; nothing in the
product should route around the fence to get there. Until then core-CS
MCQ stays unbuilt, and that is the right trade: a missing question bank
costs a cohort some practice, and a fence with one exception in it stops
being a fence.


## Mock interviews, and the three decisions inside them (Phase 12h)

**Read-only is the feature.** SPEC §11 contrasts "read-only spectate mode"
with collaborative editing. The interviewer's half of the room renders the
candidate's code as a `<pre>`, not as a disabled editor. A disabled editor
is a control somebody eventually enables, and the moment an interviewer
can type into a candidate's buffer the thing being practised stops being
an interview. There is no server path that writes a candidate's editor
from anybody else's side, and the mirror read re-checks permission on
every two-second tick rather than once at connect, so the stream closes
with the interview instead of outliving it.

**Polling rather than a socket, again.** The mirror is a snapshot `POST`
every four seconds from the candidate and an SSE stream on the
interviewer's side that re-reads an indexed row every two seconds. The
same argument as the invigilation dashboard: one viewer, one row, and the
candidate's typing never waits on a network round trip. If a cohort ever
runs dozens of concurrent mock interviews this becomes a real cost and a
pub/sub fan-out becomes worth its operational weight; at a handful it
would be weight for nothing.

**Three clock rules that each cost somebody something.** A student may
hand a slot back until an hour before, and after that the only way out is
to call it off with a reason the mentor reads — the cutoff exists because
a slot abandoned at five minutes' notice is an hour of a mentor's evening
nobody can refill. A no-show cannot be marked for the first ten minutes
after the start, because a slow lift is not a no-show on somebody's
record. Between the cutoff and the room opening there is a window where a
booked slot can be neither given back nor joined; that is deliberate, and
the refusal says so rather than looking like a bug.

**The feedback counts for nothing, and nothing reads it.** Three ratings
and a markdown note, written once, addressed to the candidate. It is not
an XP source, not a leaderboard input, not a readiness signal and not a
band. A mentor's judgement of one hour is exactly as good as a mentor's
judgement of one hour, and the moment it feeds a number it starts being
gamed from both ends.

**Not built, deliberately.** No video, audio or screen share — the
platform collects none of those anywhere (`docs/PROCTORING.md`), and
bolting a room onto the one feature that would want it is how that rule
erodes. Both sides are expected to be on a call of their own choosing.
No recording of the session, no replay, no transcript. No rescheduling:
cancel and offer again, because a reschedule is two notifications and a
new consent pretending to be an edit. No automatic matching of candidate
to mentor; a mentor offers hours and students take them.

**NOT RUN: the mirror has never been watched by two real browsers at
once.** It is proved against recx_test — the snapshot write is refused
before the interview starts and after it ends, `mirrorFor` refuses the
other mentor, another student and the candidate themselves, and the
stream's own re-check is the same function — and proved by hand against
the production build with a candidate pushing and a mentor's SSE stream
reading. What has not happened is two people in two places at the same
time on the campus network, which is the only way to find out whether
four seconds feels live or laggy to the person watching.

## A rubric before the answer, and the number it deliberately is not (Phase 12i)

**The rubric is published with the question.** It would have been less
work to let a TA invent criteria at marking time. The reason not to is
that a student who can read "names the read path and why it is cheap,
weight 5" before they start has been told what the exercise is; one who
reads it afterwards has been told how they did. The second is a mark,
the first is teaching. It also puts a floor under the grading -- a TA
working through four named criteria writes something more useful than a
TA working through a feeling -- and it is why the rubric is frozen the
moment the question opens: a student marked 12 of 16 against four
criteria did not get that score against five.

**The score feeds nothing, and that is the same decision as the mock
interview's.** Three ratings there, a weighted percentage here, and
neither reaches XP, the leaderboard, readiness or a band. A weighted
percentage from one person reading one answer is exactly that; wired to
a dashboard it would be optimised from one end and inflated from the
other. `tests/repo/written-posture.test.ts` fences it on the import
graph of every scoring module rather than on a comment.

**Handing back, rather than marking low.** A grader can push an answer
back to the student's drafts with a sentence instead of giving it 4 of
16. The sentence is the point: a low mark tells a student they did
badly, "you have described the API and not the storage" tells them what
to do next, and the answer is still there to do it in. The transition is
the grader's and not the student's, because a student who could withdraw
a submission at will would make a shared queue meaningless.

**The time box is advice.** A question says "about 45 minutes" because
knowing the intended size is part of the exercise. Nothing enforces it.
A timer on an unproctored text box would only teach students to draft
somewhere else and paste, and would make an answer written over three
evenings -- which is still worth marking -- feel like cheating.

**The grader sees the name, unlike the interview archive.** Those two
surfaces answer the question differently on purpose. An archive entry is
one student's account of a company's process, read by every student, and
anonymity is what makes it safe to write. An answer is coursework, read
by one TA who is writing back to a person. The page says so above the
box before anything is handed in.

**One answer per student per question.** A second attempt at a design
question is a different question, not a retry: re-answering the same
prompt after reading the marks measures nothing except how recently the
marks were read. The unique key is `(promptId, authorId)`, so the
product cannot drift into attempts without a migration saying so.

**Not built, deliberately.** No model answer: publishing one would turn
the next cohort's exercise into a recall test, and the rubric already
says what a good answer does. No peer marking -- a student marking a
student is a different product with different consent, and the honest
version needs calibration nobody here has. No per-criterion re-mark
after a grade: the grade is final and a second opinion is a
conversation, not a column. No LaTeX or diagram upload; "say it in
words" is what a design round actually asks for. No timer, as above.

**NOT RUN: nobody has marked a real cohort's answers.** The whole
lifecycle is proved -- against recx_test (15 cases: the rubric that must
be whole and must belong to this question, the grader who may not be the
author, the hand-back that keeps the student's words, the retired
question that stays readable by whoever answered it, and the CHECKs
refusing a half-written mark however it is attempted) and by hand against
the production build with four signed-in people. What has not happened is
a TA marking thirty answers in an evening, which is the only way to find
out whether three criteria or six is the right number, and whether the
0-4 ladder's rungs mean the same thing to two different TAs.

## Two settings that did nothing, and the keymaps that found them (Phase 12j)

**The bug this phase was really about.** `fontSize` and `tabSize` have
been on the profile settings page since Phase 3. The form saved them, the
page read them back to re-render itself, and **no editor ever asked for
them**: Monaco and CodeMirror both hard-coded 14 px and 4 spaces. A
student who set 18 px because they could not read 14 got a page that said
"Settings saved." and changed nothing. Nobody noticed because the setting
appeared to work -- it persisted. It was found while looking for somewhere
to put the keymap, which is the honest version of how most of these are
found.

**Why the keymaps are self-hosted.** `monaco-vim` is 372 KB and
`monaco-emacs` 31 KB, and the obvious way to load either is the CDN build
both READMEs show. That would work on every developer's machine and fail
in the lab: the exam LAN has no route off campus, and the CSP does not
name a CDN. They are copied beside Monaco's own files at build time and
loaded through Monaco's AMD loader, which also keeps them out of every
JavaScript bundle -- a student on the standard keys downloads nothing, and
the size budgets did not move by a byte.

**Esc then Tab had to move above the editor.** Both keymaps bind Esc
(vim's normal mode, emacs's Meta prefix) and both bind Tab. The escape
hatch WCAG 2.1.2 requires cannot be something a preference switches off,
so it is now a capture-phase listener on the wrapper around the editor,
where it runs before Monaco, before CodeMirror and before the keymap.
That shadows `<Tab>` after Esc in vim (jump forward in the jumplist) and
`M-Tab` in emacs. Both are stated in the setting's own words, because a
vim user pressing Esc then Tab and leaving the editor deserves to have
been told, and because the alternative -- a keyboard trap for anybody who
turned a keymap on -- is a defect rather than a trade.

**The proctored arena keeps the standard keys, and that is not caution.**
SPEC §5 defines the exam's typing telemetry in terms of CodeMirror's own
transaction origins: `input.type` for typing, `input.paste` for a paste,
absent for a programmatic change. A keymap's register commands -- vim's
`"+p`, emacs's yank -- put text in the document through a path those
origins do not describe, so the same signal would mean different things
depending on a preference. Rather than ship that, the arena hands the
editor `DEFAULT` and the page says why. Font size and tab size DO apply
there: they change no signal, and somebody who needs 18 px to read needs
it most in an exam.

**Not built, deliberately.** No custom keybinding editor -- a student who
wants `jk` mapped to Esc wants vim, and vim is what the keymap gives
them; a bindings UI is a product of its own. No `:w` writing to the
server (vim's command line accepts it and does nothing): saving is
automatic, and a command that silently did nothing would be worse than
one that is not there. No vim mode for the plain textarea fallback, which
exists precisely because the editor has not loaded. No per-language
keymaps, no `.vimrc` import, no macros across page loads.

**NOT RUN: a contest with a keymap on.** Both keymaps are proved in a
real browser in both editors -- modal editing, the status line, the `:`
command line, emacs's `C-k`, the escape hatch, and nothing fetched on the
standard keys. What has not happened is two hours of a real contest,
which is where a keymap either disappears into the work or gets in the
way.

## The sandbox is a database, and three decisions that came from that (Phase 12k, slice 2)

**One fixed student role, not a role per job.** The design document said a
fresh read-only role per submission. Building it changed the answer: a role
is a cluster-wide object, creating one needs `CREATEROLE` in the judge
(a privilege whose whole point is escalation), and a crashed process would
leak roles the way it would otherwise leak schemas. A role holds no state,
so "fresh" bought nothing that mattered. What does the work is that the
student's statement runs on its OWN CONNECTION as that role — not `SET
ROLE` on the owner's session — so there is no privileged `session_user` to
go back to, and `set_config('role', …)` in a single statement buys nothing
because the role is a member of nothing. The boot check asserts all three.

**The hang that only a real database could find.** The first run against
PostgreSQL timed out six tests at once, and every one of them was a case
whose statement ERRORED. The cause was not the SQL: a query executed with
a row limit is a portal, and when such a query errors node-postgres can
leave its queue waiting, so the `ROLLBACK` in the cleanup never settles.
An `await` on a promise that never settles is invisible to `catch` — it is
a hang, not a failure, which is why it looked like the database was stuck.
Nothing is sent on that connection now: a `READ ONLY` transaction has
nothing to roll back, and closing the socket is what ends it. The close has
a deadline and destroys the socket if it is not honoured, because a judge
that waits forever on a socket stops judging. Two things follow from that
run: the schema drop has its own `lock_timeout`, and there is a sweep at
boot — those six hangs left six schemas behind, each a dataset the student
role still had `SELECT` on.

**A parse error is a compile error.** PostgreSQL refusing to prepare a
statement is the same event as a compiler refusing to compile one: it is
deterministic, it is about the query rather than the data, and running the
other four cases would say it four more times. So class 42 and `3F000` are
CE and end the submission, with the database's own sanitised message in
`compileOutput` where a compiler's would be; a refused write or a privilege
is RE for that case, because it happened while running; `statement_timeout`
is TLE; and more rows than the cap is OLE, because too much output is too
much output whatever produced it. MLE has no meaning here — `work_mem`
spills to disk rather than failing — and that is written down in the module
rather than left for somebody to go looking for in a log.

**Not built in this slice, deliberately.** The service judges jobs, and
nothing enqueues one yet: the model, the authoring and the student surface
are slices 3 and 4, and the web side's lane eligibility for a `postgres`
node is slice 5 (the current rule is written in terms of a CPU
calibration, an isolate self-check and kernel hardening, so a SQL node is
correctly barred from ASSESSMENT and CONTEST until that rule learns the
second engine). No metrics endpoint yet. No per-case setup caching: the
author's script runs once per case, which is a few milliseconds and keeps
the cases independent.

**NOT RUN: two fleets at once, and the clean stop.** `SIGTERM` is not
delivered to a Node process on Windows, so the drain path is unproved
here. And the development seed registers one judge node, so an isolate
worker and a SQL judge have not yet heartbeaten side by side; the
`JudgeNode` row's `driver` column shows whichever beat last, which is fine
in development and would not be on a real fleet.

## A SQL problem is a `TestCase` with different bytes in it (Phase 12k, slice 3)

**No new table, and that was the design's whole bet.** A `TestCase`
already carries an input blob and an output blob. For a SQL problem those
are the case's dataset and its expected result set — same immutability,
same sha256 discipline, same bundle, same blob route. Reusing them is why
`Submission` needed no column, and so why XP, the leaderboard, contests,
assessments and rejudges needed no change at all. The alternative — a
`SqlProblem` table beside `Problem` — would have been quicker to write and
would have left every one of those features with a second case to handle.

**`sqlOrdered` is per version, not per case.** The wire carries it per
case because the judge has no opinion about where it came from, but the
model has one value: ordering is a property of the QUESTION, and a problem
whose second case silently changed the rule would be a problem nobody
could answer twice.

**SQL is a language the student writes in, and not a toolchain.**
`LANGUAGE_KEYS` describes `/opt/toolchains` directories, compile argv, run
argv, process limits. A statement handed to a database has none of those,
and the judge worker validates that a runtime points inside
`/opt/toolchains`. So `sql17` is a `LanguageConfig` row whose runtime is a
`SqlRuntime` — five fields that say which engine judges it — and nothing
was invented to fit a shape that describes something else.

**The engine is read from the row, not passed in.** There are five enqueue
call sites and not one of them has the problem version in hand. A
parameter would have been five chances to pass the wrong engine, and a SQL
job on an isolate queue is a job an isolate node claims and cannot run; the
cost of being right is one indexed lookup on the submit path. The
scheduler's reconciler reads it the same way, as a `CASE WHEN` on the row
it is already locking.

**A lane's queue depth is now the sum of two queues.** The gauge is
labelled by lane, and the metric contract and the alert rules are written
against those labels, so the two engines' depths are summed and the older
age reported. "Is anybody waiting too long on this lane" is still
answerable; which engine they are waiting on is not, and a per-engine
label is a change to the contract rather than to a line of code.

**NOT RUN: nothing enqueues a SQL job yet.** The model holds one, the
claim builds the spec, the queues are separate and the sandbox judges what
it is given — but no page creates a SQL submission, because the authoring
surface and the expected-result capture are the rest of slice 3. The
end-to-end path (a TA writes a question, a student answers it, a verdict
comes back) has therefore not run, and the gate row says so rather than
implying a feature that is three commits from working.

## Nobody types the expected rows (Phase 12k, slice 3b)

**A validation run IS the capture run.** For a program, validation asks
"does the model solution pass the tests?". For a SQL problem the question
is circular — the reference query is the only definition of the right
answer — so the run executes it against each dataset and REPORTS the rows,
and the server stores them as the version's expected results. An author
never types expected rows, for the same reason they never type expected
stdout, and the run still fails loudly when the reference query does not
parse or returns more rows than the cap.

**The capture path is narrow because the alternative is a wrong answer
nobody notices.** A validation job only (a submission could otherwise
choose its own answer), a SQL version only, an unfrozen version only,
cases that exist by index only, and only when EVERY case reported — a
half-capture would leave one case's expected rows over from a previous
dataset, and that version would publish looking complete.

**Three gates had to learn there is a second engine, and the end-to-end
run is what found all three.** The approve and publish gates demanded a
C++ model solution, so a SQL problem could never publish. The submit
boundary refused `sql17` outright, so no student could answer one. And
`enabledConfigs` validated every `LanguageConfig` runtime against the
toolchain schema, so the SQL row was SKIPPED WITH AN ERROR and its
reference query was never "runnable" — which silently meant a SQL problem
could not be validated, captured or published at all. Every one of them
typechecked, every unit test passed, and the feature did not work. That is
the argument for driving a phase end to end on the production build rather
than trusting a green suite.

**The frozen guard cannot be cleaned up after, and that is correct.** One
database case needs a published version, to prove a capture cannot reach
one. A frozen version and its children refuse deletion in the DATABASE —
`ReferenceSolution of frozen ProblemVersion … is immutable` — so the case
makes its own problem and leaves it behind in `recx_test` rather than the
suite disabling a guard to tidy up. A test that disables a guard teaches
everybody that guards are negotiable.

**Not built, deliberately (it is slice 4).** The workspace still renders a
SQL problem with the ordinary code editor: no SQL grammar, no dialect
notice, no read-only or one-statement sentence, and a WA that does not
show which row differed (the judge sends that sentence for a visible case;
the submission result compaction drops it). A student could answer one
today through the real action, and the page would not help them do it.

## A SQL answer is a result set (Phase 12k, slice 4)

**The whole student surface follows from that one sentence.** A case's
result is a dataset and two result sets, not three streams of text, so it
is rendered as two tables; NULL is written as a word because `''` and NULL
are different answers and a blank cell cannot say which; the Description
tab states a query's own limit rather than a C++ time limit and a memory
figure, neither of which describes a query; and there is no custom input,
because a SQL question's input is the author's dataset.

**The sentence a student reads is written once.** Every rule — the
dialect, one statement, the read-only role, the timeout, the ordering, the
refusals — is `SQL_NOTICES` / `SQL_REFUSALS` in `@recx/shared`, and a
repository test refuses a second copy, including the dialect's own name
anywhere in `apps/web/src`. Two copies of a sentence is one copy that goes
stale, and the stale one is always the one on the screen.

**Two channels were reused rather than invented.** The student's rows
travel in the protocol's `stdout`, because a SQL submission's output IS a
result set — so the rule that already drops a hidden case's stdout needed
no new code at all. The judge's sentence travels in `TestResult.message`,
which the protocol has carried since Phase 1 and the web boundary dropped
on the floor; it is now kept for the indexes the VERSION marks as samples,
read from the database rather than from the body a worker sent. A worker
that marked a hidden case visible would otherwise be deciding what a
student may read.

**Clip by rows before cutting by bytes.** A visible case's stored field is
capped at 4 KB and a result set may be 2,000 rows: JSON cut at a byte
budget is not JSON, so a table would have arrived as unparseable text.
Both sides are clipped to `SQL_DISPLAY_ROWS` first — by the judge for the
student's rows, by `finalizeSubmission` for the expected ones — and the
page says it is showing a prefix. Anything that still does not parse is
shown as text rather than as an error where a result should be.

**What this slice does NOT cover.** A SQL problem in a CONTEST or an
ASSESSMENT: the arena and the attempt surface build their own language
lists, which do not know about `sql17`, so such a problem offers a
programming language and the submit action then refuses it — safe, and
unusable. Nobody should place a SQL problem in a contest until that is
built. The narrow-screen grammar is in the build as a lazy chunk but was
not opened in a browser.

## Operating a second engine (Phase 12k, slice 5)

**An instrument written for one engine is wrong for two, and it is wrong
quietly.** `loadQueueDepths` read `QUEUE_NAME[lane]` — the isolate queue —
so every SQL job waiting was absent from the page whose entire job is to
show waiting work, and nothing failed. That is the shape of every bug in
this slice: not an error, an omission that reads as "there is nothing
there". The fix is the boring one (read both, sum them, show the split),
and the lesson is that adding an engine means re-asking every number what
it now means.

**A label on an existing metric is a change to every rule that reads it.**
Adding `engine` to `judge_queue_depth` would have turned
`max by (queue) (judge_queue_depth) > 200` into a per-engine maximum: 150
waiting on each of two engines would stop firing a rule that fires at 200.
The split is a separate series for that reason alone, and the per-engine
rule that reads it has a lower threshold and a longer `for:`, because
"half the fleet is not keeping up" is a warning rather than a page.

**A SQL node does not judge an exam, and the honest reason is a missing
benchmark rather than a missing surface.** Calibration guards time limits:
an isolate node whose CPU deviates from the fleet does not get the
sensitive lanes. The analogue for the SQL engine is real — a slow cluster
turns a passing query into a `statement_timeout` — and it does not exist
yet, so the node is refused those lanes and TOLD SO in those words. The
alternative, relaxing the rule because "a query's limit is enforced by the
database", would have been true and would still have let an exam be judged
on an unmeasured host. Slice 4 recorded that the contest and exam SURFACES
do not offer SQL either; both have to be built before a SQL question can
appear in either, and this is the half that would otherwise be forgotten,
because it is the half nothing on a screen complains about.

**The SQL judge publishes no `/metrics`, and that is a decision.** Its
queue depth, its heartbeat age and its verdicts are already published by
processes there is exactly one of; a second listener republishing them is
how two numbers that should agree stop agreeing. What is genuinely absent
is the engine's own internals — how much of a case is the author's setup
script versus the student's statement, how many stale schemas the boot
sweeper found — and those are worth a counter each the first time somebody
needs to tune this engine rather than operate it.

**Still not run.** `deploy/compose.sql-judge.yml` and
`scripts/ops/sql-sandbox-provision.sh` have never been started: there is no
SQL judge host, as there is no judge host and no database host. What IS
exercised on every change is the thing they would deploy — the judge
process against a real PostgreSQL 17, including the eleven-case adversarial
suite — which is the half that would hurt if it were wrong.

## Authoring an interactive problem (Phase 12l, slice 2)

**The expected output of an interactive case does not exist, and the empty
blob is the honest way to say so.** `TestCase.outputSha256` is required for
every kind of problem and three other things depend on it (the bundle, the
manifest, the import pairing). Making it nullable for one compare mode
would weaken a constraint that holds everywhere else — the Phase 12g
lesson — so an interactive case stores the empty blob, the authoring form
stops asking for output, and `versionContentIssues` refuses a case that
carries any. The one rule that cannot be a CHECK is exactly that one: no
constraint can say "these bytes are meaningless".

**One `testlibId` serves both programs.** A version has a checker or an
interactor, never both, because `compareMode` is a single value and the
database refuses the pair. A second column would have been a second place
to disagree.

**SPEC's assessment rule has a date on it, so it is enforced where it can
be lifted deliberately.** A trigger on `AssessmentProblem`, a sentence in
the action, and an entry in the guard catalogue: dropping the trigger makes
`frozen-coverage.test.ts` fail until somebody also removes the catalogue
line, which means lifting the rule costs a line in the gate log. That is
the whole point — the two practice contests SPEC asks for have not happened,
and nothing in a database remembers an intention.

**A limit for a language nobody can choose.** The first publish of an
interactive problem printed `sql17 2000 ms` beside `cpp20`, because the
limit derivation walked every enabled `LanguageConfig` and Phase 12k put
SQL in that list. Harmless in itself, and the other direction was not: a
SQL problem was getting C++ limits. The derivation now takes the io mode,
which is the same rule the workspace and the submit boundary follow — and
the lesson is that adding a LANGUAGE, like adding an engine, means
re-asking every list what it is a list of.

**Two clocks in an invariant suite.** `governance-invariants.test.ts` set
timestamps from Node in some steps and from PostgreSQL in others, and on a
machine whose database runs in WSL2 those clocks drift by a second — so
rows got an "end" before their "start" and the right constraint fired for
the wrong reason, differently on each run. The suite now takes every
Node-side timestamp from the database's clock. An invariant about ORDER
cannot be tested with two rulers.

## The student's side of a conversation (Phase 12l, slice 3)

**A case with no expected output must show none.** The console's three
blocks are input, expected and yours; an interactive case has the first and
the third, and the slice-2 live stage found what happens when nobody says
so — an empty box headed "Expected output", which reads as a question the
student failed to answer. Two blocks, and the second one is the
conversation.

**The transcript is the only thing a student has.** There is no output
file in an interactive case: without the relay's record there would be
nothing to look at after a wrong answer, which is why the worker keeps it
(slice 1) and why the label says what it is rather than calling it output.
A hidden case still shows nothing at all — not the transcript, not the
interactor's words, which describe the hidden data.

**No custom input, said twice.** The console offers no tab and the action
refuses one. A field that is accepted and ignored is worse than an absent
field: a student types what they think the input is, gets a verdict about
something else, and learns nothing.

**The missing flush gets its own sentence everywhere.** It is the one
mistake every student makes once, its symptom is a program that appears to
hang, and the verdict it earns (TLE) says nothing about flushing by
itself. So the chips say it, the Description tab says it with the language
incantations, and the deadlock message says it again at the moment it
happens.

**Still not done: a contest.** SPEC allows an interactive problem in a
contest and nothing refuses one, but the arena builds its own language
list and its own console and neither has been read with a conversation in
mind. And the two clean practice contests SPEC asks for before an
ASSESSMENT may hold one have not happened — which is the whole reason the
assessment trigger exists. An interactive problem is a practice problem
today.

## The edit budget of a debugging problem (Phase 12m, slice 1)

**A kind that is one rule is that rule, not an enum.** `maxEditedLines`
non-null IS a debugging problem. A `ProblemKind` enum beside it would be a
second source of truth about the same fact, and the first time the two
disagreed the student would see one and the judge the other.

**The budget is checked before the row, and never by the judge.** A
submission that cannot be judged on its merits must not cost a student one
of their daily submissions, and the Run path is checked for the same
reason — a Run that quietly judged an over-budget program would teach the
rule's absence. The worker is told nothing: it has no starter, and a
second place that could refuse a submission is a second place that could
refuse it differently.

**One count, or the number means nothing.** The editor's live counter, the
refusal and the publish gate all call `countEditedLines`. Trimmed lines
and dropped blank lines are a decision, not an accident: re-indenting is
not a fix, and a student who spaces a program out while reading it has not
spent part of their budget.

**The languages are the starters.** A debugging problem is offered in the
languages its broken program is written in — each language would be a
different program with a different mistake, and an author who wrote one
did not write nine. The picker and the submit action agree on this, so
nothing offered is a locked door and nothing hidden is reachable by typing.

**The gate proves solvability.** The author's own AC model solution must
fit the budget against the starter it belongs to. It is the only check
that can tell a question that cannot be answered from one that merely
looks hard, and no CHECK could hold it: it spans three tables and compares
source.

**Still open: a debugging problem in a CONTEST or an ASSESSMENT.** The
budget is enforced in `submitSolution` and `runCode`, which the practice
workspace uses. A contest arena and an exam attempt build their own
editors and their own submit paths; until those are read with a budget in
mind, a debugging problem is a practice problem.

## Why a debugging problem is not sat in an assessment (Phase 12m, slice 2)

**The rule is refused where it can be explained.** The edit budget is
checked in `submitSolution` and `runCode`, before the row, so a student
reads two numbers and fixes their program. An assessment submits every
answered question when the sitting ends: the same check there would reject
a candidate's answer at the moment they can no longer do anything about
it, which is not a rule being enforced but work being destroyed.

**So the pin is refused instead**, exactly as Phase 12l did for
interactive problems: a trigger on `AssessmentProblem`, a sentence in the
admin action, and both names in the guard catalogue so that lifting the
rule later cannot be quiet.

**A contest needed nothing, today.** Its arena links to
`/problems/<slug>` — the ordinary workspace — so the budget is shown as
the student types and refused before the row. The arena builds no editor
of its own, which is also the answer to the question Phase 12l left open
about interactive problems in a contest. Worth writing down, though: no
code path writes a CONTEST-origin submission yet (`finalize.ts` has the
scoring branch and nothing reaches it), so whoever builds one must send it
through `submitSolution` rather than writing the row itself — otherwise
the budget, and SQL's two rules beside it, would go unenforced in exactly
the sitting that matters most.

**What would lift it:** an exam path that shows the budget while the
candidate types and refuses an over-budget answer at submit time, rather
than at the end. Until then the trigger stands, and the catalogue entry
makes the decision to remove it a recorded one.

## The student's side of a debugging problem (Phase 12m, slice 3)

**The count is on the screen, or the budget is a trap.** A rule that is
only enforced at submit time is a rule a student meets as a rejection. So
the bar over the editor shows the budget and the lines changed so far, from
the same function the action refuses on, against the same starter: the two
cannot disagree, which is the only reason the number is worth showing.

**Red, not disabled.** Over budget the counter turns red and the Submit
button still works — and the action refuses it with both numbers. A button
that disables itself tells a student nothing about why, and the one thing
they need is the number.

**Reset says what it does.** On a debugging question the starter is the
broken program, so the control that restores it is labelled for that, in
the toolbar and in the dialog. A student who has lost their way needs the
original back, and nothing else here gives it to them.

**The picker is short on purpose.** Only the languages the broken program
is written in. The Description tab says why, because a student who knows
the platform offers nine languages will otherwise read a two-language
picker as a fault.

**Still not watched: the number changing as somebody types.** The counter
is rendered and asserted at, below and over the budget, and the fence
proves the bar and the server share one count — but no browser has been
driven through a keystroke-by-keystroke edit. The same gap as the
narrow-screen SQL grammar left open in Phase 12k.

## A submission that is the answer (Phase 12n, slice 1)

**Why the judge fleet and not the web process.** Comparing two pieces of
text needs no sandbox, and a verdict decided in the web process would have
been fifty lines. It would also have been a second pipeline: no node, no
lane, no rejudge, no metrics row — and, the moment a problem wanted
partial credit, the author's checker running in the process that holds
`DATABASE_URL`. The answer path is in the worker for that one reason.

**Why `language` is nullable rather than a pretend runtime.** A spec
carrying a C++ runtime that never compiles anything would mislead the
first person to read one, and `assertRuntimeKnown` would have had to be
taught to skip it anyway. Null is the fact. `requireRuntime()` is the one
place that turns it back into a program's runtime, and it throws for the
job that has none.

**One case, and visible.** The answer is one answer, so the question is
one instance; and the student cannot answer data they cannot see. A hidden
case on one of these would be a second question nobody could read, so the
gate refuses it — and so does the spec builder, because a version that
reached a node in that state would have been judged against something the
student never had.

**The scoring mode is the author's, and it decides more than it looks.**
ICPC has no partial credit: a checker's PARTIAL becomes WA. The real
isolate run found this in the first builder, which forced ICPC. A
best-effort answer-problem is scored PER_TEST, and SUBTASK is refused
because one case is not a table of subtasks.

**Still to come in this phase:** the authoring side (slice 2) and the
student's answer box (slice 3). Until then an output-only version can be
built only by hand, which is why nothing is published yet.
