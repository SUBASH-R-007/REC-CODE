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
