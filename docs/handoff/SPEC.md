REC Code — Implementation Prompt
You are building REC Code, a LeetCode-class coding practice, contest and proctored-assessment platform for Rajalakshmi Engineering College (~5,000 students). Its purpose is placement preparation: practice, measurable progress, defensible assessment, and a readiness signal the placement cell can act on.

This is a new application, not a feature inside the existing REC Learning LMS. It shares the LMS's stack and design language and treats the LMS as the identity source of record.

Read this entire document before writing code. Then follow the phases in order.

0. Ground rules that override everything else
Phases are gated. Do not begin Phase N+1 until Phase N's "Done when" gate passes in full. If a gate fails, fix it; do not proceed and do not weaken the gate.
Student code never runs in the web process. Not in a server action, not in a route handler, not "just for local dev convenience".
No signal ever auto-penalises a student. Proctoring and plagiarism signals are evidence for a human. The maximum automatic consequence anywhere in this system is: flag for review and withhold a result from the public leaderboard.
Never claim the proctoring is [banned phrase 1 — see tests/repo/forbidden-words.test.ts]. The words "[banned phrase 1 — see tests/repo/forbidden-words.test.ts]", "[banned phrase 2 — see tests/repo/forbidden-words.test.ts]", "[banned phrase 3 — see tests/repo/forbidden-words.test.ts]", "[banned phrase 4 — see tests/repo/forbidden-words.test.ts]" and "[banned phrase 5 — see tests/repo/forbidden-words.test.ts]" must not appear in any code comment, UI string, documentation page or commit message. Use "monitored and recorded", "tamper-evident", "layered containment".
No account is hard-disabled by a cron job. See Phase 8.
Ask before inventing. If something here is ambiguous, implement the narrower reading and note it in docs/OPEN-QUESTIONS.md.
1. Stack, repository layout, tooling
Stack (pin these)
pnpm 9 workspaces, Node 22 LTS, TypeScript strict everywhere
Next.js 15 App Router, React 19, Tailwind v4
Prisma 6 + PostgreSQL 17 (its own database recx, same cluster as the LMS is fine; never the same database)
Redis 7 + BullMQ 5 (required, not optional)
MinIO (S3 API) for test-data bundles
IOI isolate 2.x (cgroup v2) as the sandbox
Monaco on desktop, CodeMirror 6 below 768px
vitest for unit/integration, Playwright + @axe-core/playwright for E2E and a11y
culori for colour derivation, react-resizable-panels ^2.1.7, @tanstack/react-virtual ^3.10, lucide-react, zod, pino, prom-client
Layout
recx/
  apps/
    web/                  # Next.js 15 — the only thing with DB credentials
    judge-worker/         # Node 22 + TS. isolate driver. NO Prisma, NO DB URL.
    scheduler/            # cron jobs: dormancy sweep, leaderboard freeze, retention purge, reconciler
  packages/
    db/                   # prisma/schema.prisma + generated client + migrations
    shared/               # zod contracts, Verdict enum, XP rules, LanguageConfig types,
                          #   JUDGE_PROTOCOL_VERSION, limits table, topic taxonomy
    design/               # tokens.css, theme.css, utilities.css, 13 UI primitives, derive.ts
  docs/
    CONVENTIONS.md  ARCHITECTURE.md  SECURITY.md  JUDGE.md  PROCTORING.md
    CAPACITY.md  RUNBOOK.md  ACCESSIBILITY.md  OPEN-QUESTIONS.md
  .claude/launch.json
Hard rules, each enforced by a test or lint rule:

apps/judge-worker must not import @recx/db, and must have no DATABASE_URL in its env schema.
apps/web must not import child_process (ESLint no-restricted-imports).
Verdict, the limits table, XP constants, the 14-topic enum and JUDGE_PROTOCOL_VERSION live only in packages/shared. A duplicate definition anywhere is a build failure.
The web app refuses results from a worker reporting a mismatched JUDGE_PROTOCOL_VERSION.
Conventions (mirror the LMS)
Server components fetch with db directly. Mutations are server actions in src/server/actions/*.ts returning ActionResult<T> through a runAction() wrapper. Client components are leaf-level only. Zod validates at every server boundary. RBAC is enforced server-side in every page guard and every action — never by hiding a nav link. Every sensitive mutation calls audit().

2. Design system — embed these tokens verbatim
Create packages/design/tokens.css with exactly these values. Do not retype or "improve" the hex codes.

/* Copied verbatim from the REC Learning LMS src/app/globals.css.
   These are the canonical values — do not retype or "improve" them. */
:root {
  --rec-purple: #6d28d9;
  --rec-purple-bright: #7c3aed;
  --rec-purple-deep: #5b21b6;
  --rec-gold: #f59e0b;
  --background: #f7f5fb;
  --surface: #ffffff;
  --surface-elevated: #ffffff;
  --glass: rgba(255, 255, 255, 0.78);
  --border: #e6e2ef;
  --border-strong: #d4cee4;
  --text: #1c1730;
  --text-secondary: #55506b;
  /* Carries every deadline, timestamp and hint in the student UI, so it must
  clear WCAG AA (4.5:1). #8b86a3 was 3.48:1 on --surface and 3.22:1 on
  --background — unreadable on a cheap phone in daylight. Now 5.14 / 4.75. */
  --muted: #6f6a87;
  --primary: #6d28d9;
  --primary-hover: #5b21b6;
  --primary-active: #4c1d95;
  --primary-subtle: #f1ecfc;
  --primary-soft: #e3d9f8;
  --primary-fg: #ffffff;
  --accent: #b45309;
  --accent-subtle: #fef3c7;
  --success: #15803d;
  --success-subtle: #dcfce7;
  --warning: #b45309;
  --warning-subtle: #fef3c7;
  --danger: #b91c1c;
  --danger-subtle: #fee2e2;
  --info: #1d4ed8;
  --info-subtle: #dbeafe;
  --ring: #8b5cf6;
  --shadow-color: 262 30% 30%;
  --radius: 0.75rem;
}

:root.dark {
  --background: #12101c;
  --surface: #1a1727;
  --surface-elevated: #211d31;
  --glass: rgba(26, 23, 39, 0.72);
  --border: #2c2840;
  --border-strong: #3b3556;
  --text: #f0edf8;
  --text-secondary: #b6b0cc;
  /* 4.22:1 on --surface previously — below AA. Now 6.16 / 6.60. */
  --muted: #9c95b4;
  --primary: #8b5cf6;
  --primary-hover: #9d74f8;
  --primary-active: #7c3aed;
  --primary-subtle: #241d3d;
  --primary-soft: #322859;
  --primary-fg: #ffffff;
  --accent: #fbbf24;
  --accent-subtle: #3a2e14;
  --success: #4ade80;
  --success-subtle: #14301e;
  --warning: #fbbf24;
  --warning-subtle: #3a2e14;
  --danger: #f87171;
  --danger-subtle: #3b1717;
  --info: #60a5fa;
  --info-subtle: #172448;
  --ring: #a78bfa;
  --shadow-color: 262 40% 3%;
}
Also port verbatim from the LMS: the Tailwind v4 @theme inline bridge (mapping the tokens to colour utilities, plus --radius-sm/md/lg/xl and --font-sans/--font-display), and the utility layer — .app-backdrop, .glass, .shadow-card, .shadow-pop, .scroll-thin, .skeleton, .progress-fill, .animate-pop-in, .animate-slide-up, the global :focus-visible ring rule, and the @media (prefers-reduced-motion: reduce) block.

Port the 13 primitives: Button/ButtonLink, Card/CardHeader/CardBody, Badge, ProgressBar/ProgressRing, Avatar, EmptyState, StatCard, Skeleton/CardSkeleton/PageSkeleton, Tabs, Dialog, Dropdown, useToast, Field/Input/Textarea/Select/Label.

No component may contain a hardcoded hex value. Add a lint rule.

Admin-changeable brand, with guardrails
Exactly two colours are admin-settable — brandSeed and accentSeed — plus radius (0.5rem | 0.75rem | 1rem).

--success, --warning, --danger, --info and their -subtle variants are NOT themeable and must not appear in the derivation output. They carry verdict and exam-timer meaning; a purple "danger" would destroy the one scanning cue that matters in a timed test.

Implement packages/design/derive.ts — pure, server-only, unit-tested, using named culori imports (oklch, formatHex, wcagContrast, clampChroma). It emits plain #rrggbb (not oklch() — old lab-machine Chrome). Algorithm:

Parse seed to OKLCH; reject unparseable at the zod boundary.
Clamp c ≤ 0.21; run clampChroma(..., 'oklch', 'rgb') after every construction.
Light primary: start l = clamp(l, 0.38, 0.56), step l -= 0.01 until wcagContrast(primary, '#fff') ≥ 4.5 and wcagContrast(primary, background) ≥ 3.0. Floor l = 0.30; if unreachable, fail the save with measured ratios.
primary-hover = l - 0.06, primary-active = l - 0.12, ring = l + 0.12.
primary-subtle = oklch(0.965, c*0.16, h); primary-soft = oklch(0.915, c*0.30, h); assert wcagContrast(primary, primary-subtle) ≥ 4.5.
Neutrals are hue-tinted, not grey — this is what makes the product feel violet rather than grey-with-purple-buttons: background = oklch(0.975, 0.008, h), border = oklch(0.915, 0.012, h), border-strong = oklch(0.865, 0.018, h), text = oklch(0.22, 0.045, h), text-secondary = oklch(0.46, 0.035, h), muted = oklch(0.53, 0.030, h).
Then clamp muted darker in 0.01 steps until it clears 4.5:1 against both --surface and --background. This is the automated form of the hand-written fix above.
Dark: primary l into [0.62, 0.76] stepping up until ≥ 4.5 against #1a1727; background = oklch(0.165, 0.022, h), surface = oklch(0.195, 0.024, h), surface-elevated = oklch(0.225, 0.026, h), border = oklch(0.285, 0.030, h), border-strong = oklch(0.355, 0.038, h), text = oklch(0.955, 0.015, h), text-secondary = oklch(0.745, 0.028, h), muted = oklch(0.655, 0.026, h) clamped lighter until ≥ 4.5 on both dark surfaces.
--shadow-color = "{round(h)} 30% 30%" light / "{round(h)} 40% 3%" dark.
Presets: rec-purple (default — short-circuits derivation and emits the verbatim hex above, so REC Code and the LMS are pixel-identical), indigo #4f46e5, teal #0f766e, crimson #be123c, slate #475569.

Storage: a singleton PlatformTheme { id @default("default"), presetKey, brandSeed, accentSeed, radius, palette Json, css String, paletteVersion Int, updatedAt, updatedById }. Derive once on save, never per request, never in the browser.

Application: a server-rendered nonce'd inline <style id="rec-brand"> in the root layout <head>, after the tokens import, containing :root{...}:root.dark{...}. Zero flash, zero client JS, works with JS disabled. Invalidate with revalidateTag('platform-theme'). Keep the LMS's hash-allow-listed pre-paint dark-mode script and port its CSP drift test. Derive <meta name="theme-color"> from the palette. Do not use cookies+middleware, CSS-in-JS, a generated file on disk, or localStorage for the brand.

/super/settings/branding shows a live two-theme preview of real components and a blocking contrast report over: text/surface, text/background, text-secondary/surface, muted/surface, muted/background, primary-fg/primary, primary/surface (3.0), primary/background (3.0), primary/primary-subtle, primary/primary-soft, accent/surface, accent/accent-subtle, border-strong/surface (3.0), ring/surface (3.0), ring/primary (3.0). Save is disabled while any required pair fails. No override. Advisory-only warnings: brand hue within 25° of danger red (~25°) or success green (~145°); chroma clamped from the submitted value (show both swatches). Include a one-click deuteranopia/protanopia/tritanopia/grayscale simulation of the preview.

Tests: a snapshot asserting seed #6d28d9 reproduces the verbatim palette within ΔE 2; a per-preset test asserting every required pair passes in both themes; a property test over 360 hues × {0.05, 0.12, 0.21} chroma asserting the derivation either passes all required pairs or explicitly fails the save — never silently ships an illegal palette.

Verdict colour language — triple-encoded, always
One VerdictBadge component is the only way a verdict renders. Four independent encodings: token colour, distinct icon silhouette, full text label, monospace short code.

Verdict	Code	Tokens	Icon	Shape cue
Accepted	AC	text-success bg-success-subtle	CheckCircle2	solid 3px left border
Wrong Answer	WA	text-danger bg-danger-subtle	XCircle	solid 3px left border
Time Limit Exceeded	TLE	text-warning bg-warning-subtle	Clock	dashed left border
Memory Limit Exceeded	MLE	text-warning bg-warning-subtle	MemoryStick	dashed
Output Limit Exceeded	OLE	text-warning bg-warning-subtle	FileOutput	dashed
Runtime Error	RE	text-danger bg-danger-subtle	AlertTriangle (triangle, deliberately not a circle)	dotted
Compile Error	CE	text-info bg-info-subtle	FileWarning	dotted
Partially Accepted	PARTIAL	text-accent bg-accent-subtle	CircleDotDashed + n/m	solid
Skipped	SKIPPED	text-muted bg-surface	SkipForward	none
Queued	—	text-muted bg-surface border-border	Hourglass	none
Running	—	text-info bg-info-subtle	Loader2 (static under reduced motion)	none
Internal Error	IE	text-muted bg-surface border-border-strong	ServerCrash	none
The circle/triangle/document/chip silhouette split is load-bearing: at 16px a red circle and a red triangle are distinguishable in grayscale; two red circles are not. CE sits in the info/blue family, not warning — "your code never ran" is a different thing from "your code was too slow", and that distinction is the most useful one for a first-year.

There is no separate PE verdict; presentation errors fold into WA and the UI explains the whitespace policy.

Hard rules, enforceable in review:

Never a bare coloured dot or colour-only table cell. The submissions table has a real monospace Verdict column with code + label.
Difficulty is never a bare coloured word: Easy = success-subtle + 1 filled bar of 3, Medium = accent-subtle + 2, Hard = danger-subtle + 3, always with the word.
Problem-list status: solved = filled CircleCheck + "Solved" in text-success; attempted = hollow CircleDashed + "Attempted" in text-accent; untouched = nothing (absence, not a grey dot).
The activity heatmap varies lightness, not hue: five steps of color-mix(in srgb, var(--primary) {8,24,44,68,100}%, var(--surface)), every cell with aria-label="12 March 2026: 4 problems solved".
Rationale to keep in docs/ACCESSIBILITY.md: ~8% of men have red-green CVD. In a 5,000-student engineering cohort that is 250–350 students, and the two most frequent signals in the product — AC vs WA, and Easy vs Hard — are both exactly on the red-green axis. Colour is the fast secondary channel; icon + text is primary. WCAG 2.2 SC 1.4.1 makes this conformance, not preference.

3. Judge isolation — non-negotiable
Running untrusted student code is the single biggest risk in this system. Every item below is a requirement, not a suggestion.

Topology
apps/judge-worker is a separate deployable on dedicated Linux hosts (Debian 12, kernel ≥ 6.1, cgroup v2 unified only). It holds no DATABASE_URL, no AUTH_SECRET, no object-storage master key, no student PII. It authenticates with a per-node mTLS client cert (or narrowly scoped token) that can only: claim jobs, fetch the bundle for the problem it is currently judging, post results, heartbeat. Egress is nftables default-DROP with an allowlist of exactly the app host and the Redis host, plus a drop rule matching sandbox uid range 60000-60999, and 169.254.169.254 blackholed. The host is rebuildable from cloud-init in under 10 minutes. Treat it as cattle.

Sandbox
IOI isolate 2.x for both compilation and execution. One --box-id=N per worker slot; slot N runs as uid 60000+N in cgroup /sys/fs/cgroup/recjudge/slot-N. Box root is a per-slot tmpfs: mount -t tmpfs -o size=256m,nr_inodes=4096,mode=0700,uid=6000N. Teardown is rm -rf on RAM; nothing leaks to disk. Toolchains live read-only at /opt/toolchains/<lang>-<version>/, bind-mounted read-only per language; a toolchain upgrade is a new directory plus a new LanguageConfig row, never in-place, so a 2026 submission rejudges byte-identically in 2029.

Never pass --share-net. Provide no configuration key that could enable it. Add a unit test asserting the generated argv never contains it. The box gets a fresh netns with no interface up at all — not even loopback — so connect()/bind() fail and abstract AF_UNIX sockets are unreachable. No /etc/resolv.conf, /etc/hosts or /etc/nsswitch.conf is bound in. Compilation is also offline, so every dependency must be vendored into the toolchain image.

Limits table — implement exactly
Limit	Default	Ceiling	Enforced by
CPU time (authoritative)	per-language derived TL	15s	isolate --time
Extra grace	0.5s	0.5s	--extra-time=0.5 (accurate overrun reporting instead of a hard kill)
Wall time (safety net)	ceil(2.5 × CPU TL) + 2s	30s	--wall-time
Memory (authoritative)	256 MB	1024 MB	--cg-mem=262144
Address space	unset for every language	—	deliberately no --mem / RLIMIT_AS — the JVM, Go and Node reserve tens of GB of virtual address space and an AS limit yields bogus RE before main()
Stack	= memory limit	1024 MB	--stack; deep recursive DP in C++ must not spuriously segfault
Processes	1 (C/C++/Rust/Python) / 64 (JVM/Go/Node/Kotlin)	128	--processes → RLIMIT_NPROC + pids.max; cgroup-wide kill on teardown
Open files	64 native / 256 JVM+Node	1024	--open-files
Output file size	64 MB	256 MB	--fsize=65536 (SIGXFSZ → OLE)
Early OLE trip	poll stdout size every 200ms, kill cgroup past min(64MB, 2×expected_output_bytes + 1MB)	—	supervisor
stderr capture	8 KB truncated	64 KB	supervisor
Scratch disk	256 MB / 4096 inodes	512 MB	per-slot tmpfs
Core dumps	0	0	RLIMIT_CORE=0 + kernel.core_pattern=|/bin/false
Environment	empty except PATH, HOME=/box, LANG=C.UTF-8, lang vars	—	--env= allowlist; never --full-env
Source size	256 KB	512 KB	zod before enqueue
Filesystem: --no-default-dirs, then explicit binds only — /box rw tmpfs nosuid,nodev; /usr, /lib, /lib64, minimal /bin read-only nosuid,nodev; /opt/toolchains/<lang>-<ver> read-only for the submission's language only; /proc with hidepid=2; isolate's minimal /dev. No /tmp, /var, /home, and no /etc beyond a 3-line synthetic /etc/passwd for getpwuid() callers like the JVM.

Only the current test's input is copied to /box/input.txt mode 0444, unlinked before the next test is staged. Expected output never enters the contestant's box — the checker runs in a separate box, different uid, different tmpfs, with answer.txt bound read-only.

Kernel hardening — verified at worker boot, refuse ONLINE if wrong
/etc/sysctl.d/99-recjudge.conf: kernel.unprivileged_userns_clone=0, kernel.unprivileged_bpf_disabled=2, net.core.bpf_jit_harden=2, kernel.io_uring_disabled=2, kernel.dmesg_restrict=1, kernel.kptr_restrict=2, kernel.perf_event_paranoid=3, kernel.yama.ptrace_scope=3, vm.unprivileged_userfaultfd=0, kernel.modules_disabled=1 (set last in boot), fs.protected_symlinks=1, fs.protected_hardlinks=1, fs.suid_dumpable=0, kernel.core_pattern=|/bin/false. Blacklist dccp sctp rds tipc n-hdlc cramfs freevxfs jffs2 hfs hfsplus squashfs udf.

Verdict mapping from isolate --meta
status:TO with time ≥ TL → TLE. status:TO with CPU below the limit (wall exceeded, CPU idle) → TLE with an admin-visible idleness flag (still TLE to the student). cg-oom-killed:1 or cg-mem ≥ limit → MLE. status:SG → RE with the signal name (SIGXFSZ → OLE). status:RE → RE with exit code. status:XX → IE (retryable, never a student-facing failure). Language refinements: JVM exit 1 with java.lang.OutOfMemoryError/StackOverflowError in stderr → MLE/RE not bare RE; Python MemoryError likewise.

Toolchains (pin exactly, in both LanguageConfig and the path)
c17/cpp17/cpp20 GCC 13.2.0 (-O2 -pipe -static -s); java21 Temurin 21.0.4+7 with an AppCDS archive and -XX:+UseSerialGC -XX:ActiveProcessorCount=1; py312 CPython 3.12.6 with numpy 1.26.4 only; pypy310 PyPy 7.3.17 (the real answer for Python users on tight limits — offer it alongside CPython); node22 22.11.0; go123 1.23.2 with CGO_ENABLED=0, GOMAXPROCS=1; kotlin20 2.0.21. Phase-2: rust180.

Compile runs in its own box: CPU 10s (Kotlin/Rust 25s), wall 20s (40s), --cg-mem=1048576, --processes=64, --fsize=131072, no network. Compiler output truncated to 8 KB and sanitized — strip /box/, /opt/toolchains/... and every absolute host path, collapse the version banner — before storing or displaying. Non-zero compiler exit → CE, terminal, scores 0, consumes no test-running capacity; a compile killed by the caps reports CE with "compilation exceeded resource limits" (the correct answer to a template-metaprogramming compile bomb). Compiler and run flags are fixed server-side. Students can never inject flags, env vars or extra files.

Sandbox self-check suite — a test file AND a runtime gate
Run at worker boot and every 6 hours. Twelve adversarial fixtures with asserted expected verdicts: fork bomb; while(1) putchar('x'); 4 GB allocation; fallocate 10 GB; socket()+connect(); open("/etc/shadow"); ptrace of the supervisor; /proc/1/environ read; setuid(0); a 3-hour sleep; io_uring_setup; a cross-slot box read. Any deviation → node QUARANTINED, claims nothing, admin alert. This is the only mechanism that catches a kernel upgrade quietly re-enabling something dangerous.

Determinism
Pin slot N to one physical core via cpuset.cpus, with its SMT sibling left idle in a cpuset nothing runs in. On 8c/16t: cores 0–1 plus siblings for OS/supervisor/IO, slots one per physical core on 2–7. Two runs sharing a physical core differ by 15–40%, which is unacceptable for graded work; halving nominal throughput is the right trade. cpupower frequency-set -g performance; turbo off; intel_idle.max_cstate=1 processor.max_cstate=1. Decide verdicts on cgroup CPU time; wall time is only the safety net. Store judgeNodeId and calibrationScore on every SubmissionTest row so a timing dispute is auditable. A 1-second calibration benchmark at boot and every 6 hours; a node deviating >10% from the fleet median is barred from the assessment and contest lanes.

Driver abstraction (required for Windows development)
JudgeDriver interface with three implementations: IsolateDriver (production, Linux only), DockerDriver (optional local Linux dev — document as slow and not timing-accurate), MockJudgeDriver (deterministic fixture verdicts). The mock prints a loud banner on every run and the process exits at boot if NODE_ENV=production. CI runs the mock suite on every push plus a Linux-only integration job exercising the real sandbox against the adversarial fixtures.

State plainly in docs/JUDGE.md: no sandbox is provably [banned phrase 4 — see tests/repo/forbidden-words.test.ts]; kernel CVEs touching namespaces, cgroups, eBPF and io_uring appear several times a year. The documented guarantee is blast-radius containment on a disposable, credential-free judge host, continuously re-verified by the self-check suite.

4. Data model shape
Separate database recx. The LMS stays the identity source: nightly roster sync plus on-login upsert keyed on collegeId (roll number) and lmsUserId. Never create a student record in REC Code.

PgBouncer transaction mode, ?pgbouncer=true&connection_limit=10 for web. The judge dispatcher/reconciler gets its own direct non-pooled URL (advisory locks and SKIP LOCKED leases).

Core enums
enum Role { STUDENT TA_MENTOR ADMIN PLACEMENT_OFFICER SUPER_ADMIN }
enum AccountStatus { ACTIVE SOFT_RESTRICTED DISABLED GRADUATED ARCHIVED }
enum RestrictionStage { NONE NUDGED WARNED SOFT_RESTRICTED DISABLED }
enum Difficulty { EASY MEDIUM HARD }
enum ProblemStatus { DRAFT IN_REVIEW PUBLISHED RETIRED }
enum IoMode { STDIN FUNCTION }
enum Verdict { AC WA TLE MLE RE CE OLE PARTIAL SKIPPED IE }
enum SubmissionStatus { QUEUED JUDGING DONE INTERNAL_ERROR CANCELLED }
enum JudgeState { PENDING DISPATCHED RUNNING DONE FAILED CANCELLED }
enum JudgeLane { ASSESSMENT CONTEST RUN PRACTICE REJUDGE }
enum SubmissionOrigin { PRACTICE CONTEST ASSESSMENT CUSTOM_RUN }
enum ScoringMode { ICPC SUBTASK PER_TEST }
enum CompareMode { EXACT TOKEN FLOAT CHECKER INTERACTIVE }
enum SubtaskAggregation { MIN SUM_FRACTION }
enum ProctorMode { NONE ADVISORY REMOTE_MONITORED KIOSK_SEB LAB_SUPERVISED }
enum AttemptStatus { NOT_STARTED IN_PROGRESS DISCONNECTED SUBMITTED AUTO_SUBMITTED EXPIRED TERMINATED VOIDED }
enum FlagStatus { OPEN REVIEWING UPHELD DISMISSED }
enum Severity { INFO LOW MEDIUM HIGH }
enum EventSource { CLIENT SERVER INVIGILATOR }
The five structural decisions that must not be compromised
(a) Immutable problem versions. Problem holds stable identity plus a liveVersionId pointer and no statement content. All content — statement, constraints, limits, test cases, subtasks, starter code, reference solutions, checker — lives on ProblemVersion, which sets frozenAt on publish and is then immutable. The repository layer refuses any write to a frozen version or its children, with a test proving it. "Edit problem" clones a new DRAFT revision; publishing flips Problem.liveVersionId under optimistic concurrency on Problem.version. Submission.problemVersionId, AssessmentProblem.problemVersionId and ContestProblem.problemVersionId all reference a pinned version, never the live pointer — so a mid-contest edit cannot silently rescore anyone.

(b) Narrow Submission, jsonb test results. Volume to design against: ~7M submissions/year × 15–60 tests each. One row per test result is 150–400M rows/year of almost-never-read data — do not create that table. Per-test results are a compact jsonb array on Submission: [{"i":0,"v":"AC","ms":12,"kb":2048}] (~20 bytes/case, TOAST-compressed), plus denormalised counters passedCases, totalCases, maxTimeMs, maxMemoryKb, firstFailedIndex. Source goes in a 1:1 SubmissionSource side table (@db.Text, 256 KB cap in zod and a CHECK constraint) with sourceSha256 denormalised onto Submission and indexed — it doubles as the duplicate-code signal. Visible-case stdout/stderr/diff goes in SubmissionTestDetail, truncated to 4 KB per test and 32 KB per submission, purged after 30 days.

(c) Content-addressed test data. TestBlob { sha256 @unique, sizeBytes, inline String? (≤64KB), storageKey String? }. Bundles in MinIO under immutable versioned keys problems/{problemId}/v{n}/tests.tar.zst (+ manifest.json with per-file sha256, sizes, subtask membership, isSample; checker/{sha256}, validator/{sha256}), zstd-19, behind a TestDataStore interface with s3 and local-fs drivers so dev and CI need no MinIO. Worker cache at /var/cache/recjudge/blobs/<sha256>, 40 GB LRU, sha256-verified on write. Inputs over 64 MB stream decompressed straight into the box. Problem edits write v(n+1) — keys are never mutated.

(d) Append-only XP ledger + period buckets. XpEvent { id BigInt, userId, kind, amount Int, idempotencyKey String @unique, rulesVersion Int, problemId?, submissionId?, contestId?, assessmentId?, reversesEventId?, grantedById?, meta Json, occurredAt } — no UPDATE, no DELETE (a Postgres rule plus a test). Voiding XP writes a compensating REVERSAL row. idempotencyKey formats: solve:{userId}:{problemId}, streak:{userId}:{milestone}, contest:{contestId}:{userId}:participation, daily:{userId}:{yyyy-MM-dd}.

XpBucket { userId, period ALL_TIME|MONTH|WEEK, periodKey, xp, solvedEasy/Medium/Hard, batchYear?, departmentCode?, section?, lastXpAt, @@unique([period, periodKey, userId]) } with indexes [period, periodKey, xp DESC, lastXpAt ASC] and the batch/department variants. No page may aggregate XpEvent — add a test that greps the codebase for it. Board page = one ordered index scan over ≤5,000 rows. "My rank" = an index-only count(*) WHERE xp > $me OR (xp = $me AND lastXpAt < $mine). Closed weeks freeze into LeaderboardSnapshot (top 200 as jsonb) so historical boards stop being written.

(e) Authoritative contest state + materialised standings. ContestProblemAttempt @@id([contestId, userId, contestProblemId]) is authoritative (wrongAttempts, points, solvedAt, penaltyMinutes, bestSubmissionId). ContestStanding @@id([contestId, userId]) is materialised with a version column under optimistic concurrency, index [contestId, score DESC, penalty ASC, lastAcceptedAt ASC]. rank is recomputed by ONE job every 15 seconds, never per submission (5,000 rank renumberings per minute is a deadlock generator). Ship a tested rebuild-standings {contestId} command before the first real contest.

Judge queue and lease
Submission is written to Postgres as QUEUED first, enqueued second. jobId = submissionId (BullMQ dedupe). Claim atomically:

UPDATE "Submission" SET status='JUDGING', "claimedByNodeId"=$n, "claimToken"=$t,
  "leaseExpiresAt"=now()+interval '2 minutes', "attemptCount"="attemptCount"+1
WHERE id=$id AND status IN ('QUEUED','JUDGING')
  AND ("leaseExpiresAt" IS NULL OR "leaseExpiresAt" < now())
RETURNING ...;
Every result write carries the claimToken; a stale node's late result is rejected. A 10-second reconciler re-enqueues any QUEUED row with no live job and any JUDGING row with an expired lease. This is what makes an in-memory queue acceptable for an exam-bearing system: Redis is transport only, Postgres is truth, a Redis flush loses queue position and zero submissions. Document in the runbook that restarting Redis is safe.

Five queues with a worker-side weighted slot allocator (BullMQ priority alone provably starves the low lane): judge:assessment (1, up to 60% of slots), judge:run (3, ≥2 hard-reserved slots), judge:contest (5, up to 50%), judge:practice (10, ≥25% floor), judge:rejudge (20, ≤20% ceiling, dropping to 0 while assessment depth > 50). Soft reservations release after 2s idle; the 2 run slots stay hard so the editor's Run button is never slow during a contest.

Retry only infrastructure failures (IE, sandbox init, bundle fetch, node death): attempts: 3, exponential 2s. Never retry a deterministic verdict — it double-awards XP and masks bugs. At attemptCount ≥ 3 → INTERNAL_ERROR, excluded from scoring, admin notified, one-click rejudge on an admin page. Three consecutive node IEs → DRAINING.

JudgeNode { id, hostname, workerVersion, isolateVersion, languages Json, slots, calibrationScore, status ONLINE|DRAINING|OFFLINE|QUARANTINED, lastHeartbeatAt, lastSelfCheckAt }. Heartbeat every 5s; lastHeartbeatAt older than 20s → OFFLINE and leases reclaimed.

The judge-finalise transaction
One prisma.$transaction, taking pg_advisory_xact_lock(hashtext('user:' || userId)) first (the daily XP cap is a read-then-write): update Submission guarded by WHERE judgeState IN ('DISPATCHED','RUNNING') so a retried callback is a no-op; createMany the SubmissionTestDetail rows for visible cases; upsert UserProblemStatus, ProblemStat, ActivityDay; insert XpEvent; upsert the three XpBucket rows; increment UserStats; advance the streak; for contests update ContestProblemAttempt + ContestStanding. Counters use { increment: n }. Do not write one DB row per test as it completes — publish progress over Redis pub/sub instead.

Other required tables
Subtask (points, aggregation MIN|SUM_FRACTION, dependsOn Int[]), TestCase (isSample, blob refs, points), ProblemLanguageLimit (timeLimitMs, memoryLimitKb, measuredModelMs, measuredOnGeneration, @@unique([problemVersionId, language])), LanguageConfig, StarterCode, ReferenceSolution (expectedVerdict — including deliberate brute-force TLE solutions; source never exposed to STUDENT by any query path), Hint (+ HintReveal), Editorial (+ unlockPolicy), Tag/ProblemTag (14-topic closed enum), Company/ProblemCompanyTag, UserProblemStatus @@id([userId, problemId]) — the critical denormalisation that keeps the problem-list status column off Submission, ProblemStat (maintained acceptance rate, never computed on read), ActivityDay @@id([userId, date]) (streak source, heatmap, and the inactivity evidence), UserStats, Badge/UserBadge, StudyPlan/Section/Item/Enrollment (with maintained itemsTotal/itemsDone — "done" is UserProblemStatus.status = SOLVED, so there is one source of truth and no StudyPlanItemProgress table), RunRequest (24h TTL), CodeDraft @@unique([userId, problemId, language]), AuditLog (with a per-UTC-day tamper-evident hash chain whose terminal hash is exported off-box — tamper-evident, not [banned phrase 2 — see tests/repo/forbidden-words.test.ts]; say so), AdminScope, PrivilegedOperation, Accommodation, ConsentRecord, CalendarDay, LeaveException, InactivityPolicy, AccountRestriction, AccountStatusEvent, CodeFingerprint, IntegrityFlag, ThemePreset, PlatformSetting.

Indexes — only these query shapes
Problem [status, difficulty, displayCode]; ProblemTag [tagId, problemId]; ProblemCompanyTag [companyId, frequency DESC]; Submission [userId, createdAt DESC], [userId, problemId, createdAt DESC], [problemId, verdict, createdAt DESC], [contestId, userId, problemId], [assessmentAttemptId, problemVersionId, createdAt DESC], [judgeState, queuedAt], [status, leaseExpiresAt], [sourceSha256], [createdAt]; SubmissionTest @@unique([submissionId, testIndex]); UserProblemStatus [userId, status, firstAcceptedAt DESC], [problemId, status]; ActivityDay [date], [userId, date DESC]; User [status, lastActiveAt] (the dormancy sweep), [batchYear, departmentCode, section]; AssessmentAttempt [status, expiresAt] (auto-submit sweeper), [assessmentId, integrityScore]; ProctorEvent [attemptId, atMs], [attemptId, severity], [occurredAt]; ContestStanding as above; RatingChange [userId, computedAt]; AuditLog [targetUserId, createdAt], [sensitivity, createdAt]. Add pg_trgm + GIN on Problem.title — never bare ILIKE '%x%'.

Partitioning
Launch Submission, XpEvent, AuditLog unpartitioned — 7M rows/year with these indexes is unremarkable on PG17, and premature partitioning costs real Prisma ergonomics (the partition key must join the PK, and prisma db pull does not round-trip partitions). Partition ProctorEvent monthly on occurredAt from day one via a hand-written migration, because a college-wide exam adds millions of rows that must be dropped wholesale by DETACH PARTITION at the retention boundary. Pre-write but do not apply the monthly RANGE (createdAt) conversion for Submission (@@id([id, createdAt])), with a documented trigger of 25M rows or 80 GB and a row-count alert.

Retention (in PlatformSetting key retention, enforced by a job, batches of 10,000)
SubmissionTestDetail 30 days. SubmissionSource for non-accepted PRACTICE 18 months, then set archivedAt (the verdict row is kept forever — profile counters, acceptance rates and plagiarism history depend on it); accepted and all contest/assessment sources retained. ProctorEvent + AttemptSnapshot 180 days after result release, or until every open IntegrityFlag is decided, whichever is later. Similarity fingerprints pseudonymised after 24 months. AuditLog 3 years (7 for the chain if the college requires it). A Super-admin-only, audited legalHold flag suspends the purge. Never hard-delete a student — GRADUATED/ARCHIVED and anonymisation, keeping submissions so past standings stay honest. Never store a raw IP — only ipHash = sha256(ip + pepper).

5. Phased delivery
Each phase ends with a gate. The gate is pnpm lint && pnpm typecheck && pnpm test && pnpm build all green, the stated extra checks, and the stated manual verification actually performed and written into docs/RUNBOOK.md with a date. Do not start the next phase until the gate passes. If you are tempted to proceed with a failing gate, stop and report instead.

Phase 1 — Thin real vertical slice (auth → one problem → sandboxed judge → verdict)
Build the smallest thing that is genuinely real end to end. No stubs in the judge path.

Monorepo, packages/design with the verbatim tokens, rec-purple preset, SSR brand injection, light/dark toggle.
Prisma schema for: User, Session, AuditLog, Problem, ProblemVersion, TestCase, TestBlob, StarterCode, ReferenceSolution, LanguageConfig, Submission, SubmissionSource, SubmissionTestDetail, JudgeNode, PlatformTheme.
Auth: DB-backed sessions, httpOnly/Secure/SameSite=Lax cookie storing only a sha256 token hash, Argon2id (m=19456, t=2, p=1), seeded admin + three students, no public signup.
requireUser(), requirePageRole(), requireActionRole(), requireSuperAdmin() in one guards module.
One seeded problem (two-sum), IoMode = FUNCTION, C++20 and Python 3.12 starter code and reference solutions, 2 sample + 12 hidden tests.
/problems list and /problems/two-sum workspace: Monaco (self-hosted, lazy, textarea fallback), Run, Submit.
apps/judge-worker with IsolateDriver and MockJudgeDriver, BullMQ judge:practice, lease claim, reconciler, result API with claimToken + protocol-version check.
Verdict delivery over SSE at /api/submissions/[id]/stream with the documented poll fallback.
VerdictBadge with all four encodings.
Done when:

pnpm lint && typecheck && test && build green on Windows and on the Linux CI runner.
A Linux integration test submits C++ and Python solutions to two-sum through the real isolate sandbox and asserts AC.
Unit test: generated isolate argv never contains --share-net.
Test: apps/judge-worker has no dependency path to @recx/db; apps/web has no child_process import.
Test: seeding #6d28d9 reproduces the verbatim palette within ΔE 2.
Test: MockJudgeDriver exits non-zero when NODE_ENV=production.
Manual: sign in as a student, solve two-sum in both languages, see AC stream in live; submit a wrong answer and see WA with the correct failing test index and no hidden-test leakage; toggle dark mode with no flash; load the page with JS disabled and confirm the brand colours are still correct.
Phase 2 — Judge hardening, verdict completeness, capacity
Full limits table, all verdict mappings including idleness, cg-oom-killed → MLE and the JVM/Python refinements.
All compare modes: TOKEN (default, whitespace-tolerant — this alone removes ~90% of "my output looks identical" tickets), EXACT, FLOAT (abs and rel eps 1e-6, per-problem), CHECKER (testlib-compatible, prebuilt at publish time, run in its own sandbox with answer.txt read-only; exit 0=AC, 1=WA, 2=PE→WA, 3=FAIL→IE with an admin alert, never WA, partial via _pc 16..116).
All scoring modes: ICPC with stopOnFirstFailure default true (≈40% fewer slot-seconds — the cheapest capacity win available), SUBTASK (points, MIN aggregation, dependency SKIPPED), PER_TEST.
ProblemLanguageLimit derived from measured reference solutions: TL = clamp(ceil_100ms(max(2.5 × measured_model_ms, baseTL × fallbackMultiplier)), 200ms, 15000ms) plus a per-language startup credit measured by running hello-world 20× at node boot. Fallback multipliers (used only with no model solution in that language): C/C++/Rust 1.0; Go 1.5; Java 2.0+300ms; Kotlin 2.0+500ms; C# 2.0+300ms; Node 2.5+150ms; CPython 5.0+1000ms; PyPy 2.0+300ms. A C++ model solution is mandatory to publish; the pipeline blocks publish if any model solution fails or any deliberately-wrong solution passes.
Five lanes + weighted slot allocator. Per-user caps: 2 in-flight judge submissions, 1 in-flight run, 300 practice/day, 60 runs/hour, 20 CPU-minutes/day with admin override.
Custom-run lane: one execution, no checker, no scoring, no XP; CPU min(problem TL, 5s); stdin ≤64 KB; stdout 64 KB / stderr 8 KB; RunRequest 24h TTL. Compile-artifact cache keyed sha256(language + toolchainVersion + flags + source), 1h TTL, 5 GB budget, shared with the submission path (≈0.9s saved for C++, ≈1.6s for Java, and Submit-after-Run becomes near-instant).
Self-check suite as runtime gate + sysctl verification at boot. Calibration benchmark and >10% fleet-median gating.
/admin/judge health page (requirePageRole("ADMIN")): node list with heartbeat/calibration/self-check, per-lane depth and p95 wait, stuck submissions with one-click rejudge, per-language mix, drain/quarantine. Every drain, rejudge, limit change and language-config edit calls audit().
Integration tests — required, not optional. Unit tests do not prove isolation. Write a Linux integration suite with real submissions that:

TLEs — a busy loop; assert TLE, assert reported CPU time ≥ the limit, assert the box was torn down.
MLEs — allocates past --cg-mem; assert MLE via cg-oom-killed, not RE.
Tries to open a socket — socket()+connect(); assert RE/non-zero and that no connection succeeded.
Forks — a fork bomb; assert RE and that the entire cgroup was killed with no stray processes left on the host.
Plus: output flood → OLE within 1s via the early trip; fallocate 10 GB → fails inside the 256 MB tmpfs; open("/etc/shadow") → fails; a cross-slot box read → fails; a compile bomb → CE with "compilation exceeded resource limits"; a sanitization test asserting no /box/ or /opt/toolchains/ path appears in any stored compileOutput.

Done when: all four gates green; the full adversarial suite passes on the Linux runner; docs/CAPACITY.md written with the real numbers (5 slot-seconds per average submission, ~720 submissions/hour per slot, slots = peak-per-hour ÷ 720 + 30% headroom, one 8-core host ≈ 700–1,000 students in an active contest, a 5,000-student simultaneous mock needs ~21 slots ≈ four 8-core hosts or staggered slots of 1,000–1,200 — which is the honest operational recommendation). Manual: run a 200-submission synthetic burst and confirm p95 assessment-lane queue wait < 2s and practice < 5s, with the practice floor never starved to zero.

Phase 3 — Student product surface
Full route map under (student): /dashboard, /problems, /problems/[slug] (tabs Description · Editorial · Solutions · Submissions · Discussion · Hints), /problems/[slug]/submissions/[id], /sheets, /learn, /leaderboard, /u/[handle], /profile, /profile/settings, /bookmarks, /notes, /notifications, /help, /accessibility, /offline.
App shell matching the LMS: sidebar ≥1024px grouped PRACTICE / COMPETE / ASSESS / ME, five-item bottom bar below, glass top bar with Ctrl+K palette.
Workspace layout: react-resizable-panels, statement 38% / right 62%, editor min 380px, console as an OVERLAY drawer (never a squeeze — this is the single most important 1366×768 decision), data-density="compact" below 700px viewport height (controls 36→30px, floor 30px for WCAG 2.2 target size), three-tab single column below 1024px, CodeMirror 6 below 768px, focus mode on Ctrl+Shift+F.
Draft persistence in both IndexedDB (400ms debounce) and server CodeDraft (3s debounce + blur + pagehide via sendBeacon), newest wins with a non-blocking "Restore the version from this device" bar. A student losing 40 minutes of code to a campus wifi drop is the fastest way to lose the cohort's trust.
Monaco: self-hosted from /public/monaco/vs (never the jsdelivr AMD loader — strict CSP, cold cross-origin cost on 3 Mbps campus wifi, dead on an exam LAN), ESLint-fenced to src/components/editor/**, ship only editor.worker.js with the TS language service disabled (~700 KB of a ~1.0 MB bundle), themes built at runtime from getComputedStyle of the CSS variables with a MutationObserver reapplying on dark toggle, ligatures off, minimap off.
Hints and editorial gating at ONE chokepoint keyed off a submission context discriminator (PRACTICE | CONTEST | ASSESSMENT), never per-feature branches. Tier 2 after 1 failed submission or 10 active minutes; tier 3 after 2 failures or 25 minutes; editorial when solved, or past editorialVisibleAt, or (≥5 attempts and ≥45 active minutes). In CONTEST and ASSESSMENT all of it is off unconditionally. A solve after tier-3/editorial is ASSISTED: counts as solved, pays 40% XP, excluded from unassisted-solve inputs to readiness.
XP: Easy 50 / Medium 120 / Hard 250 first solve only; daily challenge 2×; assisted 40%; revision re-solve 25%; repeat 0; aptitude 10/correct capped 200/day; mock 100 + 1/percentile above median; contest 150 + 2/percentile. Caps: Easy-problem XP 600/day, total 2,000/day — without them the leaderboard top converges on Easy-grinding within two weeks and the signal the placement cell reads is destroyed. Every constant in one tested module, super-admin adjustable with audit.
Leaderboards: college / department / batch / section / weekly, defaulting to the viewer's section weekly board, top 10 plus the viewer's ±2 neighbourhood with their own rank pinned, display names via a publicName helper ("Priya S."), never email or roll number, rating board separate and excluding provisional, student opt-out that hides them from peers but not from faculty analytics. Virtualise with @tanstack/react-virtual — never 5,000 DOM rows on a 4 GB machine.
Profile: solved-by-difficulty, 365-day lightness-ramp heatmap, streaks, skill radar over the 14 topics, badges, language split, assisted-vs-unassisted split (the honest mirror that makes readiness legible), time-to-solve vs cohort median. Public /u/[handle] with visibility public / REC-only / private, defaulting to REC-only, exposing only solved counts, rating, badges, heatmap and radar — never email, roll number, department identifiers, assessment scores or readiness score.
Done when: four gates green; @axe-core/playwright passes with zero serious/critical on /login, /dashboard, /problems, /problems/[slug], /leaderboard; the keyboard-only solving journey passes as a Playwright test (filter → open → read → enter editor → type → run → read verdict → submit → review failing case → next problem) including Esc to leave Monaco and Ctrl+M tabFocusMode; per-route size-limit budgets pass (/login ≤90 KB, /dashboard ≤160 KB, /problems ≤170 KB, /leaderboard ≤150 KB, /problems/[slug] shell ≤220 KB with the Monaco chunk ≤1,050 KB lazy, mobile CodeMirror chunk ≤190 KB, shared first-party ≤120 KB) with zero Monaco bytes on /problems, /dashboard, /leaderboard and every admin list. Manual: on a 1366×768 window at 4× CPU throttle and 3 Mbps, solve a problem start to finish without the console ever pushing the cursor off screen; confirm the textarea fallback is typable before Monaco arrives.

Phase 4 — Problem authoring, admin, content pipeline
/admin cohort dashboard; /admin/students (+/[id], /import with a dry-run diff before commit); /admin/cohorts; /admin/problems (+/new, /[id], /[id]/testcases, /[id]/validate); /admin/sheets; /admin/tracks; /admin/reports; /admin/announcements; /admin/accommodations; /admin/discuss.
/super/* as a separate tree with a separate layout and a persistent bg-danger-subtle text-danger strip reading "Super-admin — all actions are audited": /super, /super/users, /super/roles, /super/settings/branding, /super/settings/policy, /super/settings/judge, /super/settings/integrations, /super/audit, /super/impersonate (read-only, 15-minute box, mandatory reason, full-width banner, audit on start and end), /super/flags, /super/jobs, /super/data.
The twelve SUPER_ADMIN-exclusive capabilities as a single exported constant with a test asserting each corresponding action calls requireSuperAdmin(): role/scope management; PlatformSetting writes; DISABLED/ARCHIVED/restore-to-ACTIVE and any bulk status change over 25 users; retire a published problem, delete a version, global rejudge; release/recompute/override ratings; overturn an integrity decision; full audit read; impersonate; rotate judge keys; full PII export; edit the academic calendar and approve MEDICAL leave; void XP.
PrivilegedOperation two-person approval (requester ≠ approver, 24h expiry) for: bulk status change >25 users, submission purge, global rejudge, rating recompute, PII export, problem/version deletion. A super-admin break-glass self-approval is permitted but writes a SECURITY audit row and emails all super-admins — allowed, never quiet.
AdminScope (department/batch) folded into the where of every student-facing query an admin can run.
FUNCTION harness: a closed type grammar validated by zod — int | long | double | bool | char | string | list<T> | matrix<T> | pair<A,B> | TreeNode | ListNode | void, LeetCode-style serialisation (level-order with nulls for trees). Per-language harness templates live in the repository, not the database — a harness bug is fixed by a deploy and a rejudge, not by hand-editing rows. Comparators: EXACT, FLOAT_TOLERANCE, SET_EQUAL, ROWS_ANY_ORDER, IN_PLACE_MUTATION (compare a named param after the call), CUSTOM_CHECKER. A problem cannot publish without a declared comparator. Seed at least three IN_PLACE_MUTATION and three CUSTOM_CHECKER problems so both paths are exercised.
Compile-error line remapping is a hard requirement, not polish: strip generated driver lines and remap line numbers to the student's own code. Unmapped errors pointing into generated code make the product unusable for beginners, who are most of a first-year cohort.
ProblemDraft review queue DRAFT → IN_REVIEW → APPROVED → PUBLISHED → RETIRED, bulk import (statement.md + meta.json + testcases/ + per-language reference solutions + optional checker) with per-row import results so one bad entry cannot discard a 300-item batch. CI enforces that every APPROVED problem's reference solutions pass all its tests in every enabled language.
All content must be originally authored — faculty, reviewed senior-student contributions, or faculty-reviewed AI-assisted drafts. Never scrape or paste statements, editorials or test cases from LeetCode, GeeksforGeeks, InterviewBit or anywhere else. State the launch content target as a project commitment with named owners: 450 problems (180 E / 200 M / 70 H). Content, not code, is the binding constraint on launch — write that in docs/OPEN-QUESTIONS.md.
Public /judge transparency page: exact compiler and interpreter versions and flags, per-language multipliers, memory limits, how TLE is measured (sandboxed CPU time, excluding queue wait), output limits, verdict precedence. Show the active language version in the workspace footer. Every judge that hides this accumulates a permanent background of "the judge is broken" tickets that are actually language multipliers.
Done when: four gates green; the role × capability matrix test passes; golden-file tests assert every seeded problem's reference solution gets AC in every enabled language; a test asserts a frozen ProblemVersion and its children reject writes; a test asserts two concurrent Problem publishes produce one success and one conflict; a test asserts no STUDENT-reachable route can return a non-sample test file or a ReferenceSolution.source. Manual: author a problem end to end in the UI, fail validation deliberately with a wrong reference solution, fix it, publish, then edit the statement and confirm an older submission still shows the version it was judged against.

Phase 5 — Contests
/contests, /contests/[slug] (landing + rules), /contests/[slug]/arena (no sidebar), /contests/[slug]/standings (live), /contests/[slug]/analysis.
ICPC (20-minute penalty per rejected submission on a later-solved problem) and IOI subtask partial credit. Standings freeze for the final 30 minutes of contests ≥90 minutes. Virtual contests replay against the original clock, unrated, excluded from standings.
Rating — the full concrete formula, not "Elo-like": seed s_i = 1 + Σ_{j≠i} 1/(1 + 10^((R_i − R_j)/400)); target m_i = sqrt(s_i × actualRank_i); solve seed(R'_i) = m_i by 25-iteration binary search on [0, 4000]; delta_i = (R'_i − R_i)/2; subtract Σdelta/n from everyone; then shift the top min(n, round(4·sqrt(n))) by pre-contest rating so their delta sum is ≤ 0; clamp |delta| ≤ 200. Seed 1200. First 5 contests provisional (shown with "?", excluded from readiness). A contest with fewer than 30 rated participants is automatically unrated and says so in advance. Divisions: Div 3 <1400, Div 2 1400–1799, Div 1 ≥1800. No decay; an "inactive" marker after 90 days.
Rating computation: one transaction per contest, SELECT ... FOR UPDATE on the Contest row, abort if ratingComputedAt IS NOT NULL, store seed on every RatingChange so a dispute is reconstructable.
Standings over SSE, 2s coalesced pushes, Redis ZSET authoritative, snapshot to Postgres every 60s and at contest end.
Hard-block the arena below 768px with an explanatory page, not a degraded experience.
Done when: four gates green; a rating unit test reproduces a known Codeforces-shaped fixture and asserts Σdelta ≈ 0 and the top-set constraint; a test asserts rating computation is idempotent; rebuild-standings reproduces a standings table from ContestProblemAttempt byte-for-byte after a simulated Redis flush. Manual: run a 150-participant simulated contest, confirm standings update within 2s, the freeze engages, the practice lane is never starved, and a mid-contest problem edit does not change any already-judged verdict.

Phase 6 — Assessments and proctoring
Read this section as written. It is the part most likely to be built wrong.

The honest posture, stated in the product
Browser-based proctoring is detection, evidence and deterrence — never prevention. Implement the strongest realistic layered detection. Never describe it to students, faculty or admins as [banned phrase 1 — see tests/repo/forbidden-words.test.ts]. Write the limitation into the product's own admin documentation.

Create docs/PROCTORING.md and surface its substance in the admin UI, containing at minimum:

A content script injected at run_at: document_start executes before any page script and can Object.defineProperty(document, 'visibilityState', {get: () => 'visible'}), redefine document.hidden, stub document.addEventListener so our handlers are never registered, and neuter document.hasFocus(). Our guard then faithfully reports a perfectly attentive candidate. There is no page-level defence; the extension wins the race by specification.
A page cannot enumerate or detect installed extensions. chrome.management is extension-only; probing chrome-extension://<id>/manifest.json reveals only extensions declaring web_accessible_resources — which a purpose-built cheating extension does not. "Detect and block extensions" is not implementable.
Fullscreen can never be enforced. requestFullscreen() needs a user gesture and ESC always exits by specification. The strongest achievable behaviour is: request on start, detect exit, record it, warn visibly, allow a 10-second re-entry grace.
Blocking copy/paste does not stop clipboard transfer. A ten-line AutoHotkey or Karabiner script types the clipboard as synthetic keystrokes. Blocking converts a loud, well-characterised signal into a silent one.
Devtools detection is unreliable in both directions. The outerHeight − innerHeight heuristic fires on zoom, resize, bookmark bars and OS scaling, and reports nothing for undocked devtools on a second monitor. The debugger probe freezes the tab and is disabled by one "Never pause here" click. Weight it near zero; never act on it alone.
Multiple monitors cannot be reliably detected. screen.isExtended is Chromium 100+ only; Firefox and Safari expose nothing. Absence means nothing.
VMs, RDP/Parsec/Chrome Remote Desktop, HDMI splitters and capture cards cannot be detected from a web page at all. A candidate running the exam in a VM while a helper watches the host screen produces a flawless report.
A phone, tablet or second laptop beside the candidate is undetectable by any browser-delivered software, full stop. This is the largest hole, it is unclosable by software, and in the LLM era it is the dominant vector. Only a human in the room addresses it.
Our telemetry is self-reported by the adversary, which inverts the usual reliability assumption: a competent cheater produces a cleaner report than an honest student on flaky hostel wifi using a screen reader. Flag counts are therefore not evidence of guilt, and an empty report is not a clearance.
Typing-cadence analysis cannot distinguish cheating from fast typing, autocomplete, snippet expansion, speech-to-text, or a student who drafted on paper.
Safe Exam Browser is the strongest realistic lockdown and is still not [banned phrase 1 — see tests/repo/forbidden-words.test.ts]: Windows/macOS/iOS only (no Linux, no Android); anyone who extracts the key from a shared .seb file can forge the verification headers; SEB inside a VM or beside a second device still works.
Genuine device attestation exists only on college-managed hardware (managed Chrome / ChromeOS Verified Access with a force-installed college extension, or a locked lab image). Chrome's Web Environment Integrity proposal, which would have been the generic answer, was abandoned and never shipped. The literal technical answer to "no extension can bypass it" is: only where the college, not the student, controls the extension set and the machine.
WebAuthn proves a registered authenticator is present and was unlocked. It does not prove the device is unmodified, nor that it is the only device in the room, nor that the enrolled student rather than a roommate is typing.
IP/CIDR allowlisting is defeated by a VPN or hotspot outside a lab; inside a lab it usefully detects a candidate who has left the supervised network.
Similarity detection cannot establish direction or intent, and a corpus miss is no evidence at all. Short canonical problems have irreducibly high legitimate similarity.
Editor snapshots are the most tamper-resistant evidence available but are not proof: a candidate who retypes a friend's solution at a plausible pace produces an innocent-looking timeline.
Every threshold shipped is initial engineering judgement with zero calibration data. The retune loop and overturn-rate reporting are load-bearing, not nice-to-haves.
The environmental controls are the actual enforcement, and the product must recommend them explicitly: a supervised lab on college-managed machines, an ExamSession CIDR allowlist re-verified on every heartbeat, a Safe Exam Browser kiosk build with server-side key verification, seat mapping, and a physical invigilator. Only those raise the real cost of cheating.

Hard rule, enforced in code
// Assessment.affectsPlacementEligibility = true REQUIRES proctorMode = LAB_SUPERVISED
Enforce with a zod refinement at the server boundary and a Postgres CHECK constraint. Only a lab-proctored result may ever feed shortlisting, certificates or placement eligibility. This stops the predictable drift where an admin flips a Friday quiz into a shortlisting criterion because it was convenient.

Server-authoritative attempt engine
AssessmentAttempt { id, assessmentId, userId, examSessionId?, attemptNumber, status, seed Int, startedAt, expiresAt, pausedMs, submittedAt, totalScore, maxScore, layout Json (frozen), tokenHash, deviceRegistrationId?, ipHashFirst, ipHashLast, uaHash, lockSessionId, proctorMode, accommodationFlags String[], heartbeatBitmap Bytes?, heartbeatSlotSeconds Int @default(15), lastHeartbeatAt, blurEventCount, fullscreenExitCount, pasteEventCount, maxHeartbeatGapSeconds, integrityScore Int @default(100), version Int, @@unique([assessmentId, userId, attemptNumber]) }

expiresAt = min(startedAt + durationSec × (1 + extraTimePercent/100) + extraTimeMinutes, assessment.closesAt), computed server-side only, never accepted from the client.
Attempt token: 32 random bytes, sha256 at rest, httpOnly SameSite=Strict cookie scoped to the attempt path, mirrored in an X-Attempt-Token header for telemetry, rotated on resume.
Heartbeat POST /api/exam/[attemptId]/hb every 10s returns { serverNow, msRemaining, pendingInvigilatorMessages, revokeReason? }. The client renders msRemaining and never consults local Date.now() for anything authoritative. Measure serverSkewMs at start, re-sync every 30s, correct and log drift over 5s.
Missing heartbeats for 45s → DISCONNECTED, amber on the invigilator dashboard.
Auto-submit: a 15s worker finalising status = IN_PROGRESS AND expiresAt <= now() inside SELECT ... FOR UPDATE SKIP LOCKED, plus a lazy expiry check in the attempt guard on every exam request, so a dead worker cannot grant anyone extra time. The server force-submits on its own schedule — closing the laptop never banks time.
msRemaining = expiresAt + pausedMs − now(); pausedMs accumulates only while an invigilator-initiated pause is open. Specify it exactly and cover it with frozen-clock vitest tests — this is the bug that voids an exam.
DISCONNECTED is never a flag. Resume on the same token with the same frozen paper, deadline unchanged, invigilator able to grant time.
Store heartbeatBitmap, not heartbeat rows
One bit per 15-second slot: 180 minutes = 720 bits = 90 bytes. A row per heartbeat is 3.6M rows for one college-wide sitting. The bitmap answers "was this candidate connected at minute 47?" in 90 bytes, renders directly as a presence timeline, and makes maxHeartbeatGapSeconds server-computed. Store heartbeatSlotSeconds alongside so old attempts stay readable. Keep the bit arithmetic in a small, pure, unit-tested module.

Telemetry: instrument, do not block
Do NOT block paste, copy, cut, right-click or text selection. Allow them and instrument them. Maintain a per-attempt Set<string> of sha256 hashes of text copied inside the exam origin, and classify every paste as INTERNAL_PASTE (hash present) or EXTERNAL_PASTE (hash absent), recording size and hash but never the clipboard text. Blocking is both bypassable and counterproductive: students legitimately paste their own earlier code and sample input, blocking drives them to clipboard-typing macros which silences the signal, and preventDefault on contextmenu/copy breaks assistive technology.

Capture editor telemetry through CodeMirror 6 transaction annotations (updateListener + transactionFilter), not DOM events. CM6 tells you the exact inserted character count and whether the origin was input.type, input.paste or programmatic; a DOM paste listener tells you almost nothing and is silenced by one addEventListener override. Emit PROGRAMMATIC_INSERT for any transaction inserting ≥80 characters with neither input annotation — that is what an extension typing the clipboard looks like.

ProctorEvent { id BigInt, attemptId, kind, source CLIENT|SERVER|INVIGILATOR, severity, clientSeq Int?, atMs Int (server-clamped to [0, elapsed+5000]), durationMs?, size?, hash?, meta Json, occurredAt, @@unique([attemptId, clientSeq]), @@index([attemptId, atMs]) } — partitioned monthly.

Kinds: FOCUS_LOSS (blur + visibilitychange coalesced, durationMs on return, losses <1500ms dropped as UI noise); FULLSCREEN_EXIT (10s re-entry grace); EXTERNAL_PASTE / INTERNAL_PASTE; PROGRAMMATIC_INSERT; COPY / CUT (hash added to the internal set); CONTEXT_MENU (recorded, never prevented); CADENCE_BURST (≥80 chars in 200ms with no paste/programmatic annotation); IDLE_GAP (≥120s); FIRST_KEYSTROKE; WINDOW_RESIZE; MULTI_MONITOR (screen.isExtended, context only); DEVTOOLS_HEURISTIC (weighted near zero); AUTOMATION_HINT (navigator.webdriver); NETWORK_DROP; HEARTBEAT_GAP (server); IP_CHANGED / UA_CHANGED (server); SEQUENCE_GAP (server); CONCURRENT_SESSION (server); SUBMISSION_RATE_ANOMALY (server); CLIENT_SCRIPT_ERROR; INVIGILATOR_NOTE.

Store event shape only: kind, timestamp, duration, byte size, sha256, cadence statistics. Never clipboard text, never keystroke content. Cap raw rows at 2,000 per attempt then increment aggregates only. Payloads ≤32 KB; reject >64 KB with 413. Flush on a 5s tick or 25 events, and via navigator.sendBeacon on pagehide/visibilitychange→hidden with a fetch(..., {keepalive: true}) fallback.

The monotonic clientSeq plus the server watermark is what makes suppression detectable: an extension that filters events leaves a hole the server records as SEQUENCE_GAP, and one that blocks the reporting channel leaves zeros in a bitmap the server owns. That converts "[banned phrase 1 — see tests/repo/forbidden-words.test.ts] detection" (impossible) into "tamper-evident detection" (achievable).

Editor snapshots — the most probative artefact
AttemptSnapshot { id, attemptId, questionId, atMs, language, content String, contentHash, trigger TICK|RUN|SUBMIT|PASTE }. Every 30s while dirty, plus on every run and submit. Cap 200 per attempt, 64 KB each; store the first per question in full and the rest as unified diffs, reconstructed on read.

Server-derived SNAPSHOT_JUMP: one 30-second interval introduces ≥60% of the final accepted solution's token count with no corresponding paste or programmatic-insert event — i.e. code appeared while the instrumentation was blind, which is precisely the footprint of a suppressed-telemetry paste. This fires because the candidate suppressed the paste event, turning a successful bypass into a detectable anomaly. It is the one piece of evidence that survives client tampering, because the answer has to reach the server to be graded. It also exonerates: a timeline growing four lines a minute with failed runs in between is a student working.

Per-candidate randomisation
seed = HMAC-SHA256(assessment.secret, attemptId), feeding xoshiro128**. Resolve: question selection against an AssessmentBlueprint (e.g. 2×EASY + 2×MEDIUM + 1×HARD from pools ≥5× the needed count); MCQ option order (excluding fixedPosition options like "None of the above"); hidden-test execution order; and, where a problem ships a TestGenerator + reference solution, per-candidate test data generated at session-prepare time with expected outputs computed then — never inside the judge, and never from a seed the submission could read. Freeze the whole resolution into AssessmentAttempt.layout so a reload or resume returns an identical paper. Reject at prepare time any pool whose historical per-problem acceptance rates span more than 25 percentage points inside one difficulty band.

Randomisation is the only anti-cheating control that costs the honest student nothing and has no bypass — the server simply never sends the same paper twice.

Similarity detection
MOSS-style winnowing on normalised token streams: web-tree-sitter lexing for c, cpp, java, python, javascript (identifiers → IDENT, literals → NUM/STR/CHAR, comments and whitespace dropped, keywords/operators/punctuation kept as distinct ids); 64-bit Rabin rolling hash; k = 11, window w = 4 (guarantee threshold t = k + w − 1 = 14), minimum-per-window with rightmost tie-break. Store postings in CodeFingerprint { submissionId, hash BigInt, pos Int, @@index([hash]) } plus a denormalised bigint[]. Suppress every hash appearing in >5% of that problem's submissions and all starter-code hashes. Score directional containment C(A,B) = |F(A) ∩ F(B)| / min(|F(A)|, |F(B)|) plus Jaccard for symmetry. Flag only when C ≥ max(0.65, p95 + 2.5 × 1.4826 × MAD) of that problem's own distribution and both submissions exceed 60 post-normalisation tokens. Union-find cluster surviving pairs, largest first. Separately, containment ≥0.75 against an admin-curated PublicSolutionCorpus.

LOW-SOLUTION-DIVERSITY GATE: compute each problem's median pairwise containment; when it exceeds 0.5, disable peer similarity flagging for that problem entirely and mark it lowSolutionDiversity. There is exactly one sensible Two Sum. This means wholesale copying on easy problems goes undetected by similarity — accept it; the alternative is mass false accusation.

Cheap pre-filters first: exact normalised-token-stream hash equality, and "wholesale paste" (one EXTERNAL_PASTE ≥70% of the final submission, accepted on the first run, zero failed runs). Run as a background job after the assessment closes, retrieving candidates through the hash inverted index so only the top ~50 per submission get an exact comparison.

Do not use raw-text diff or Levenshtein (defeated by renaming a variable) and do not use an LLM as the similarity judge (non-deterministic, unexplainable, indefensible in an appeal where the student is entitled to see the reasoning).

Triage banding — structurally unable to touch a score
Severity points, used only to order the review queue: EXTERNAL_PASTE ≥200 chars = 25 each (cap 75); EXTERNAL_PASTE 40–199 = 8 each (cap 32); PROGRAMMATIC_INSERT ≥80 = 20 each (cap 60); FOCUS_LOSS >5s = 4 each (cap 32); any single FOCUS_LOSS >120s = 15; FULLSCREEN_EXIT after the first warning = 6 each (cap 18); SNAPSHOT_JUMP = 30; peer containment ≥0.8 = 40; corpus containment ≥0.75 = 30; DEVTOOLS_HEURISTIC = 5; MULTI_MONITOR = 3; AUTOMATION_HINT = 10.

Bands: 0–14 NONE (no review); 15–34 LOW (bulk-cleared with a mandatory 10% random human sample); 35–69 MEDIUM (one reviewer); 70+ HIGH (two independent reviewers). DEVTOOLS_HEURISTIC, MULTI_MONITOR and AUTOMATION_HINT are context-only and must be structurally incapable of lifting an attempt above NONE on their own.

The maximum automatic consequence in the entire system is: flag for review and withhold the result from the public leaderboard, with a 72-hour review SLA after which the result publishes automatically as CLEARED. The 72-hour auto-publish puts the cost of slow review on the institution, not on the student's placement timeline. Scores are written by the judge; no code path from the banding engine reaches a score column. Add a unit test that fails if the integrity module imports or writes to anything in the scoring path.

Never display a band or an "integrity score" to students or recruiters — it invites exactly the misreading we are preventing, and penalises the honest student with the bad laptop while the competent cheater scores a clean 0.

Exam shell UI
Own route group (exam) with its own layout importing nothing from the app shell: no sidebar, no bottom bar, no search, no command palette, no notifications, no leaderboard, no XP chip, no theme toggle (fixed at start so there is no mid-exam repaint), no outbound links except an in-page "Report a problem" dialog. Explicitly exclude /assessments/*/attempt, /contests/*/arena and /api/* from the service worker and unregister it for the attempt's duration — a stale cached shell must never serve an exam.

Layout: 56px glass top bar (name · section · "Question 7 of 30" · timer · save-state pill · Submit test); 240px left question palette (collapsible below 1024px); main pane; 56px bottom bar with Previous · Mark for review & next · Clear response · Save & next in that order — TCS iON / AMCAT muscle memory, because an exam is the worst possible place to teach new UI.

Question palette, five states each with a distinct shape + icon + full aria-label, as a role="group" of buttons with a roving tabindex and Arrow-key navigation, a text+icon legend, and a counts row ("Answered 12 · Marked 3 · Not answered 15"):

Not visited — bg-surface border-border, square, no glyph.
Visited, unanswered — bg-danger-subtle text-danger, square with bottom notch, Minus.
Answered — bg-success-subtle text-success, rounded-full, Check.
Marked — bg-info-subtle text-info, rounded-full, Flag.
Answered and marked — as 4 plus a small Check badge.
Timer: HH:MM:SS in tabular-nums at 18px; text-warning pill in the last 5 minutes, text-danger in the last 60 seconds; aria-live="assertive" announcements at exactly 10:00, 5:00, 1:00 and 0:10 and at no other time — a chatty live region makes a screen reader unusable. Never role="timer" with a per-second region.

Save-state pill, four explicit colour+icon+text states: "Saved · 3s ago" (Cloud), "Saving…" (Loader2), "Offline — retrying" (CloudOff, with a retry countdown), "Not saved — check your connection" (AlertTriangle, plus a "Copy my code" button so a student can rescue work into Notepad). Write-ahead to IndexedDB BEFORE every network call. Autosave: 2s debounce, immediately on question change, on blur, and on visibilitychange→hidden via sendBeacon.

Fullscreen exit / visibility hidden / window blur: within the same tick render a fixed inset-0 z-[9999] opaque overlay that COVERS THE QUESTION ENTIRELY (aria-modal, focus trapped on its single button): heading "You left full screen", body "Return to full screen to continue. Your timer is still running. This is warning 2 of 3 — at 3 warnings your test is submitted automatically.", a live countdown, one button. Write the ProctorEvent server-side before the overlay becomes dismissible. Covering the content is what makes a tab-switch useless — even where detection can be defeated, the question being hidden the instant focus is lost buys a second monitor far less.

Per-assessment policy: maxFocusWarnings (default 3), onLimit: 'autosubmit' | 'flag_only', strictMode. On limit, auto-submit and flag for human review — never auto-void. A wifi drop or an OS notification produces false positives; auto-submit plus review is defensible, voiding is not.

Pre-exam readiness check (~2 min): fullscreen entry/exit, a paste into a scratch box, a network round-trip, a one-line sample problem, and a plain-language list of exactly which signals are recorded — this doubles as the consent moment. Visible live counters during the exam ("Focus lost — 2 recorded"). No silent trapping: the deterrent requires awareness, and transparency also removes the "I didn't know" appeal. Publishing the signal list tells cheaters what to suppress — accepted knowingly, because the signals are suppressible anyway, suppression often triggers SNAPSHOT_JUMP, and secrecy would buy nothing while costing the fairness that makes the system defensible.

A persistent small "Monitored" chip whose tooltip lists exactly what is recorded.

Safe Exam Browser, device binding, lab controls
When proctorMode = KIOSK_SEB: recompute sha256(absoluteRequestUrl + key) for the session's sebConfigKey and sebBrowserExamKey and compare against X-SafeExamBrowser-ConfigKeyHash and X-SafeExamBrowser-RequestHash; 403 SEB_REQUIRED on mismatch or absence, with an audit row. Keys live in PlatformSetting, rotate per exam session, and are never committed. Server-side key verification is the part most deployments skip and the part that matters.

WebAuthn: supervised in-lab enrolment creates DeviceRegistration { credentialId @unique, publicKey, aaguid, label, attestationKind, enrolledBySupervisorId, enrolledAt, revokedAt } (residentKey: required, userVerification: preferred). A fresh assertion against a server challenge is required to start any REMOTE_MONITORED or LAB_SUPERVISED attempt; max 2 active devices; rebinding is an audited Admin action. Include a supervised single-use loaner-device enrolment so a broken laptop never blocks a student from sitting an exam. Do not implement browser fingerprinting as a device-identity mechanism — unstable, trivially spoofed, and covert tracking is exactly the wrong posture for a college asking students to trust it. WebAuthn also closes impersonation (a senior sitting for a junior), which is a more common and more damaging campus failure than tab-switching.

LAB_SUPERVISED: enforce ExamSession CIDR allowlisting on attempt start and on every heartbeat, so leaving the lab network ends the session. Record a seat label per candidate. Optional requireManagedDevice with chrome.enterprise.deviceAttributes / Verified Access where the college runs managed Chrome — strictly optional; the platform must be fully functional without it.

Note that shared-IP detection is nearly useless on an Indian campus network — thousands of students behind one NAT all present the same ipHash. Scope the signal to IP change within an attempt, not IP sharing across students.

Invigilator dashboard
/invigilate/[examSessionId], SSE at /api/invigilate/[id]/stream, 5s deltas with a 10s polling fallback. One row per candidate: name, roll number, seat label, status chip (ACTIVE / IDLE>120s / DISCONNECTED>45s / SUBMITTED / TERMINATED), time remaining, questions attempted and accepted, live flag chips, last-seen age, source IP outside the allowlist. Top bar: counts by status, a "needs attention" queue by live triage points, session controls. Cap a session view at 300 virtualised rows and shard large halls into sub-sessions.

Every invigilator action — message a candidate (modal they must acknowledge, acknowledgement recorded), issue a formal warning, grant +N minutes, pause/resume the clock, rebind device, TERMINATE — requires a free-text reason and writes an AuditLog row. Terminate additionally requires a second staff confirmation and still does not by itself void the result. The only automatic server action in the entire system is auto-submit at expiresAt, which is a deadline, not a penalty. Show evidence chips, never a guilt verdict, and never a student's photo next to a flag count.

Integrity report, verdicts, appeals
Per-candidate report: zoomable event timeline, snapshot sequence, side-by-side token-aligned similarity matches, environment tier, device binding, consent record. Mandatory human verdict CLEARED | WARNING_ISSUED | PENALTY_APPLIED | VOIDED | ESCALATED with a required written rationale and the reviewer's identity. Every report carries a permanent header: "Client telemetry is self-reported by the candidate's own device. An absence of flags is not evidence of honesty."

The student sees their own full integrity report — every event, every similarity match, side by side — within 48 hours of any flag. A person accused on the basis of evidence is entitled to the evidence. A 7-day appeal to a two-person panel (course owner + Super-admin, excluding the original reviewer), outcome and rationale recorded. An admin page tracks per-signal flag counts, review outcomes and overturn rates, with a documented retune whenever HIGH-band precision on the previous term's reviewed data falls below 0.8.

Accommodations — a legal obligation, not a feature
Accommodation { userId, kinds SCREEN_READER|MAGNIFIER|SPEECH_INPUT|EXTRA_TIME|BREAKS|SEPARATE_ROOM, exemptSignals ProctorEventKind[], extraTimePercent (0–100; 33 ≈ the standard 20 min/hour), extraTimeMinutes, allowBreaks, breakMinutes, fontScalePercent (100–200), allowScribe, highContrast, reason (required), documentFileId?, approvedBySuperAdminId, grantedAt, validUntil } — Super-admin approval only, with expiry and full audit. It feeds the server-side expiresAt computation.

Exempt signals are dropped from banding, and reviewers see only "signal exemptions active: PROGRAMMATIC_INSERT, FOCUS_LOSS" — never a disability label, never visible to invigilators. When SCREEN_READER is active, focus-loss and fullscreen-exit penalties are disabled and the attempt routes to human review instead: NVDA and JAWS legitimately use separate windows and virtual buffers and a magnifier legitimately breaks fullscreen, so penalising that is penalising the disability. Show students their own accommodations on the instruction page ("You have 20 extra minutes for this test") so they are never left guessing. This is an obligation under India's RPwD Act 2016.

Privacy
Forbidden, by name, and not to be built: webcam, microphone or screen recording by default; any desktop agent inspecting processes, windows or installed software; keylogging of content; clipboard content capture; browser-history or saved-credential access; face recognition or biometric matching. For 5,000 students, webcam proctoring is unreviewable by any human in real time, AI review of it is inaccurate and documented to be biased by skin tone, lighting and disability, and under DPDP a consent a student cannot refuse without forfeiting their placement prospects is not freely given consent. If a recruiter contractually demands it for one drive: separately opted into, purpose-limited, retained ≤30 days, access-logged per view, covered by a processor DPA, and paired with an offered lab alternative.

ConsentRecord { userId, assessmentId, policyVersion, policyHash, acceptedAt, ipHash } per assessment, with the named Data Protection Officer / grievance contact on screen. All student PII and proctoring artefacts stay on college-controlled infrastructure in India — this is why self-hosted GlitchTip, not Sentry SaaS. Data minimised to roll number, name, college email, department, batch: no Aadhaar, no personal phone or address. Self-service "download my proctoring data" (JSON + report PDF). A requiresGuardianConsent flag gates proctored assessments for students under 18. Document a breach-notification runbook naming who notifies the Data Protection Board and in what timeframe.

An account must never be disabled while an attempt is open or an appeal is pending, and a disabled account must retain access to its own integrity report and appeal.

Judge isolation as an integrity control
With network access a submission can POST the hidden test inputs to an external endpoint and harvest the entire suite, or call an LLM mid-judge. The Phase 3 isolation is therefore an integrity requirement too, not just an ops one. Hidden-test feedback to students is limited to test index (or subtask), verdict, CPU ms and memory KB — no input echo, no expected output, no contestant output, no diff. Samples get a 256-byte-truncated diff. Admins see everything. Note the asymmetry honestly: expected-output secrecy is a hard guarantee; input secrecy is best-effort, because the student's own program is legitimately handed the input and can print it. Where input secrecy matters, generate test data per attempt. The UI must not imply hidden inputs are confidential.

Done when: four gates green; frozen-clock vitest tests cover expiry, pause and resume; deterministic threshold-engine tests over synthetic event streams; golden tests for the winnowing implementation against known-plagiarised and known-independent pairs; a test asserting the integrity module cannot reach the scoring path; a test asserting affectsPlacementEligibility + non-LAB_SUPERVISED is rejected by both zod and the DB constraint; a test asserting DEVTOOLS_HEURISTIC + MULTI_MONITOR + AUTOMATION_HINT alone cannot exceed band NONE; a test asserting a SCREEN_READER accommodation zeroes focus-loss and fullscreen points; a repo-wide grep test asserting the forbidden words do not appear. Manual: sit a full 60-minute mock assessment yourself; kill the network mid-attempt and confirm resume with the same paper and unchanged deadline; exit fullscreen and confirm the question is covered before you can dismiss; confirm docs/PROCTORING.md is reachable from the admin UI. Then run a documented red-team exercise: a staff member attempts each listed bypass (extension override of visibilityState, clipboard-typing macro, second device, VM, RDP) and records which signals fired — so the college's expectations stay calibrated to reality. Schedule it per term in the runbook.

Phase 7 — Aptitude, verbal, logical reasoning
This is MVP-tier, not a later phase. The majority of REC's 5,000 students will be screened by an aptitude round before anyone looks at their code; a platform that is all DSA optimises for the top decile and ignores the cohort the placement cell is actually worried about. It is also unbuilt elsewhere at this quality and cheap to author relative to coding problems, and the per-section timer and negative-marking machinery is reused directly by the assessment product.

Own schema (AptitudeQuestion, AptitudeSection, MockPattern, MockAttempt) rather than a Problem kind — section timers, cutoffs and negative marking do not fit the judging schema.

Kinds: single-choice, multi-choice, numeric-entry, passage-grouped (one shared passage, N questions). Worked explanations are mandatory, enforced at publish.

Taxonomy — Quantitative: percentages, profit/loss, time-speed-distance, time-and-work, ratio-proportion, averages-and-mixtures, permutations-combinations, probability, number systems, simple/compound interest, ages, calendars-and-clocks, mensuration, data interpretation. Logical: number/letter series, blood relations, syllogisms, seating arrangement, puzzles, coding-decoding, data sufficiency, directions, statement-and-conclusion. Verbal: reading comprehension, sentence correction, para jumbles, synonyms/antonyms, cloze, error spotting.

MockPattern encodes a recruiter funnel declaratively: ordered sections, per-section time limit, question count, per-section cutoff, negative-marking fraction, allowBackNavigation. Seed patterns modelled on the publicly described TCS NQT, Infosys, Wipro, Cognizant and Accenture funnels plus a generic campus pattern, each labelled in the UI "modelled on the publicly described pattern — not an official test."

Reuse the LMS question-bank CSV import/export pipeline with per-row results so one bad row cannot discard a 300-question file. Target ~2,000 questions, sourced from faculty banks that already exist on paper.

Routes: /aptitude, /aptitude/[topic].

Done when: four gates green; a test asserts negative marking and per-section cutoffs compute correctly across all seeded patterns; a test asserts allowBackNavigation: false is enforced server-side, not just in the UI. Manual: sit a full seeded TCS-NQT-pattern mock and verify section timing, cutoffs and the explanation view.

Phase 8 — Inactivity as a policy engine, not a kill switch
The college asked for "inactive 5 days → account disabled". Implement it as a configurable policy engine with a soft restriction by default. Do not implement a hard auto-disable.

Why, stated plainly in docs/RUNBOOK.md and in the super-admin settings UI: in a 5,000-student cohort a literal 5-calendar-day window will, within the first month, fire on students who are hospitalised, in semester exams, on festival travel, at an off-campus placement drive, on internship, or whose laptop died. A disabled account cannot practise, so the policy works against its own stated goal. It also generates a continuous support queue and teaches students to game it with a daily one-minute login, which pollutes the engagement data worse than inactivity does. Hard-disabling a student on medical or exam leave is a real risk, not a hypothetical.

model InactivityPolicy {
  id String @id @default(cuid())
  version Int @unique @default(autoincrement())
  isActive Boolean @default(false)
  batchYear Int?            // null = institution-wide
  departmentCode String?
  nudgeAfterDays Int? @default(3)
  warnAfterDays Int? @default(5)
  softRestrictAfterDays Int? @default(10)
  disableAfterDays Int? @default(30)
  autoDisableEnabled Boolean @default(false)   // DEFAULT FALSE. Super-admin only.
  graceDays Int @default(2)
  countsAsActivity Json @default("{\"submission\":true,\"solve\":true,\"login\":false,\"lesson\":true}")
  minActivityPerDay Int @default(1)
  excludeNonWorkingDays Boolean @default(true)
  excludeApprovedLeave Boolean @default(true)
  notifyMentor Boolean @default(true)
  notifyParentEmail Boolean @default(false)
  createdById String
  createdAt DateTime @default(now())
}
Plus CalendarDay { date @id @db.Date, isWorkingDay, label, kind REGULAR|HOLIDAY|EXAM_WEEK|SEMESTER_BREAK|PLACEMENT_WEEK }, LeaveException { userId, kind MEDICAL|BEREAVEMENT|UNIVERSITY_EXAM|PLACEMENT_DRIVE|INTERNSHIP|SPORTS_EVENT|APPROVED_OTHER, startDate, endDate, status REQUESTED|APPROVED|REJECTED|CANCELLED, reason, evidenceFileId?, requestedById, decidedById?, decidedAt?, decisionNote? }, AccountRestriction { userId @id, stage, stageEnteredAt, graceEndsAt, countedInactiveDays, lastEvaluatedAt, policyVersion, selfClearedCount }, and append-only AccountStatusEvent { userId, fromStage, toStage, fromStatus, toStatus, policyVersion, evidence Json, triggeredBySystem, actorId?, reason?, notifiedAt?, createdAt }.

The evidence JSON must make a disputed lockout explainable months later:

{"lastActiveAt":"2026-10-01T...","calendarDaysElapsed":9,"countedInactiveDays":5,
 "excludedDates":["2026-10-02","2026-10-03"],"excludedReason":["HOLIDAY","MEDICAL_LEAVE"],
 "thresholdDays":5,"policyVersion":3,"evaluatedAt":"2026-10-10T02:00:00Z"}
Without this, "the system disabled me" is unanswerable — and that is the failure mode that destroys trust in a placement platform.

Nightly job, 02:00 Asia/Kolkata, idempotent per (userId, evaluationDate), with a dry-run mode shipped first:

Candidate set from User [status, lastActiveAt].
Counted inactive days = working days since lastActiveAt (from CalendarDay) minus days covered by an APPROVED LeaveException minus days with a qualifying ActivityDay.
Resolve the policy, most specific scope first (department+batch > batch > department > global).
Transition at most one stage per run, so nobody jumps NONE → DISABLED, respecting graceDays after a delivered notification (notifiedAt).
Write AccountRestriction + AccountStatusEvent + AuditLog + Notification in one transaction.
DISABLED is reachable only when autoDisableEnabled = true; otherwise the job stops at SOFT_RESTRICTED and raises an admin review item.
Never sweep a student with an open attempt, a pending appeal, or an assessment scheduled in the next 72 hours.
What SOFT_RESTRICTED blocks: contest registration, leaderboard visibility, new XP accrual (events still recorded, flagged meta.restricted), rewards. What it does not block: signing in, reading problems, solving, or sitting a scheduled assessment. Locking a student out of a graded assessment because they were ill is a worse failure than under-enforcing.

Restoration: solving one problem auto-clears NUDGED/WARNED/SOFT_RESTRICTED; self-service once per semester (selfClearedCount < 1) at /account/reactivate in one click, no approval — anything requiring approval turns a 10-day lapse into a permanent exit. DISABLED → ACTIVE is Super-admin only. An approved retroactive LeaveException covering the counted days automatically reverses the disable and writes the reversal event. Hard disable is otherwise only ever a manual, reasoned, audit-logged admin action.

Show a dormancy countdown chip on /dashboard before anything bites. Keep the word "disabled" out of student-facing copy; the day-5 state reads "restricted for inactivity" in administrative reporting, which satisfies the policy's wording. Every threshold is a Super-admin-configurable, audit-logged setting rather than a constant, so the policy can be tightened without a deploy.

Also: cancel queued and in-flight submissions for an account that has just been restricted, so judge capacity is never spent on a locked lane.

Note honestly in docs/OPEN-QUESTIONS.md: "every student must make progress" cannot be enforced by software. What the platform can do is make the next action unambiguous (one Continue card, not a wall of choices), keep the weekly goal small (3 problems, not 30), make non-progress visible to a named human who can intervene, and make progress legible to the student. The honest promise is "nobody falls through unnoticed and nobody is ever unsure what to do next" — not "everyone progresses".

Done when: four gates green; pure-function unit tests for day counting across holidays, exam weeks, approved leave and partial activity; a test asserting at most one stage transition per run; a test asserting the job refuses to sweep an account with an open attempt or pending appeal; a test asserting autoDisableEnabled = false never reaches DISABLED; a test asserting a retroactive approved leave reverses a disable. Manual: run the sweep in dry-run against seeded data covering all those cases, read the output, then run it live and inspect the AccountStatusEvent.evidence of one affected student.

Phase 9 — Readiness, placement analytics, roles
ReadinessSnapshot, nightly, retaining the component breakdown, with three tier-specific 0–100 scores:
SERVICE (TCS/Infosys/Wipro/Cognizant/Accenture-class): 0.35 × aptitudePercentile + 0.20 × verbalPercentile + 0.25 × easyMediumCoverage + 0.10 × mockInterviewScore + 0.10 × consistency(active days in last 30 ÷ 30)
PRODUCT (Zoho/Freshworks/mid-tier): 0.30 × mediumUnassistedCoverage + 0.20 × topicBreadth + 0.20 × aptitudePercentile + 0.15 × ratingPercentile + 0.10 × mockInterviewScore + 0.05 × consistency
TOP (FAANG-class): 0.35 × ratingPercentile + 0.30 × mediumHardUnassistedCoverage + 0.20 × topicBreadth + 0.15 × mockInterviewScore
topicBreadth is the MINIMUM across the 14 topics of (unassisted solves in topic ÷ tier target), capped at 1 — never the mean. Averaging lets a student look ready with 200 array problems and zero graphs, which is precisely the profile that fails real interviews.
Always render the three largest gaps and one concrete next action ("+9 points available: graphs, 6 unassisted mediums"). Show missing components as missing, never silently as zero.
Mandatory UI framing: readiness is a preparation-coverage measure, explicitly not a prediction of being placed. Never gate a student out of a drive on it; any drive-eligibility use requires a human decision recorded in the audit log. Plan to recalibrate the weights after the first full placement cycle against real outcome data — it has zero validation data at launch.
/placement for students; PLACEMENT_OFFICER cohort dashboard: readiness distribution per tier by department/batch/section; a 14-topic × section weakness heatmap (uniquely actionable — it tells a department which topic to put back in the syllabus); an at-risk list (no activity 7+ days, or SERVICE readiness <40 within 6 months of a drive); aptitude section-level gaps; a per-drive view ("for the Zoho drive on 12 Nov, 214 students at PRODUCT ≥70"); CSV export of a declared column set.
Privacy boundary drawn in the schema and the guards, not in policy: officers may see solved counts, rating, readiness, assessment scores and activity dates. They may never see private notes, draft code, discussion drafts or assistant chat content. Every individual drill-down writes an audit row. The at-risk list routes to a named mentor for a conversation, never an automated email, and the dashboard never produces a shareable public ranking of students by readiness.
Five roles with capabilities in one module and a test over the matrix: STUDENT, TA_MENTOR (moderate discussion, mark a solution editorial-quality, answer doubts with a badge, view assigned mentees — no problem authoring, no assessments, no role changes), ADMIN, PLACEMENT_OFFICER (analytics only — no authoring, no moderation, no role changes), SUPER_ADMIN. The three roles the college asked for would give every placement officer problem-deletion and role-change power; five roles with clean boundaries is barely more work and far safer.
HMAC-signed profile/resume export reusing the LMS certificate + /verify pattern.
Done when: four gates green; a unit test asserting topicBreadth uses MIN and that a 200-array/0-graph profile scores low; a test asserting missing components render as missing; a test asserting PLACEMENT_OFFICER cannot reach notes, drafts or chat content by any route; a test asserting every drill-down writes an audit row. Manual: review the readiness card for three seeded students with deliberately lopsided profiles and confirm the gaps and next action are correct and the framing copy is present.

Phase 10 — Ops, observability, performance, hardening
Topology: docker-compose on named hosts, India region or college hardware. App host (Caddy with HTTP/2 — SSE over HTTP/1.1 hits the ~6-connection-per-origin cap and a student with several tabs starves their own page loads — 2 web replicas, scheduler, Redis AOF everysec, MinIO); DB host (PG17 + pgBackRest); 2–3 judge hosts rebuilt weekly from image. No PgBouncer until web replicas exceed 4.
CI/CD: lint + typecheck + vitest + prisma migrate diff drift check + the Linux judge integration suite + Lighthouse CI + axe + size-limit. Deploy by image digest, health-gated rolling restart one replica at a time. Migrations are a separate supervised step with RUN_MIGRATIONS=false by default, preceded by a backup, using expand/contract so the previous image still runs — auto-migrating on boot runs migrations N times concurrently during a rolling deploy and applies a bad migration before anyone reads the error. Deploys are blocked while a contest or assessment is live unless FORCE_DEPLOY=1; the deploy job queries /api/health for activeContest.
Backups: one timestamped set containing database.dump + testdata.tar.zst + MANIFEST.txt — DB and test data captured together, always. A dump restored next to a test-data snapshot from a different hour leaves submissions judged against test cases that no longer exist, and that is only ever discovered mid-incident. Plus pgBackRest WAL archiving: RPO 5 min, RTO 2 hours, a full snapshot immediately before every contest and 5-minute incrementals during it. Retention 7 daily / 4 weekly / 12 monthly, off-host and encrypted (age/gpg) before offsite upload with retention matching the DPDP schedule, not "forever". A quarterly restore drill into a scratch database, recorded in the runbook with a date and a name — the drill is the deliverable, not the script.
Observability: pino JSON → Loki; prom-client → Prometheus → Grafana on a separate monitoring VM (when the app host is on fire the dashboards must still load); GlitchTip self-hosted, not Sentry SaaS, so stack traces containing student data stay on college infrastructure. Required metrics: judge_queue_depth{queue}, judge_oldest_job_age_seconds{queue}, judge_run_duration_seconds, judge_verdict_total{verdict,language}, judge_worker_heartbeat_age_seconds{worker}, judge_sandbox_init_failures_total, judge_compile_cache_hits_total, submission_e2e_latency_seconds, proctor_event_total{type}, sse_connections_active. Postgres log_min_duration_statement=500ms, pg_stat_statements, auto_explain >2s. Alerts: queue depth >200 for 2 min; oldest job >60s; worker heartbeat >90s; INTERNAL_ERROR rate >2% over 5 min (the canary for a broken compiler image or a cgroup misconfiguration after a host upgrade — otherwise discovered from student complaints); disk >80%; DB connections >80%; failed logins >100/min; e2e p95 >30s.
Security: Argon2id; optional OIDC/SAML to the college Entra/Google tenant with local admin password auth as a documented fallback; server-side session rows so an admin can force-logout mid-assessment (a JWT cannot); CSP with nonces and no unsafe-inline for script-src; server-side sanitisation of problem statements; secrets via sops+age and Docker secrets, no .env in git; lockfile committed, base images pinned by digest, Dependabot weekly, pnpm audit --audit-level=high blocking, judge under 20 direct dependencies. Rate limits (Redis sliding window): login 5/15min/account + 20/15min/IP, API 120/min/session, admin bulk ops 10/min.
On style-src: Monaco injects a runtime stylesheet via document.createElement('style') that a nonce cannot cover. Try the nonce-only policy; if the editor breaks, keep style-src 'unsafe-inline' only and document the tradeoff in docs/SECURITY.md. Do not spend a week on this — style-src 'unsafe-inline' is a low-severity finding; a non-working editor is a product failure.
Reference device, written into the repo as the definition of done: 2019 i3-8130U / 4 GB / 1366×768, Lighthouse 4× CPU throttle, 3 Mbps down / 1 Mbps up / 150 ms RTT. Targets (p75): LCP ≤2.0s (≤2.5s for the problem statement), editor interactive ≤4.0s warm / ≤7s cold with the textarea typable ≤2.5s always (Monaco is ~1.0 MB gzipped even after stripping the TS service — about 3 seconds of transfer alone on 3 Mbps; state the budget honestly rather than implying a cold 4-second Monaco), INP ≤200ms, TBT ≤200ms, CLS ≤0.05 (reserve explicit heights for the editor, console, heatmap and avatars), TTFB ≤600ms. Report real field vitals with web-vitals ^4 to an internal endpoint — actual lab machines, not just lab Lighthouse.
Caching: problem statements under immutable problem:{id}:v{statementVersion} keys with Cache-Control: public, max-age=300, stale-while-revalidate=86400 — nothing is ever invalidated, only orphaned, which eliminates the entire class of "student saw the old statement" bugs and makes a reload on bad campus wifi instant. Problem list via unstable_cache tag problems, 60s, revalidateTag on publish. Global leaderboard from XpBucket + a Redis ZSET for ZREVRANK. Never cache an authenticated payload without userId in the key.
docs/CAPACITY.md, docs/RUNBOOK.md, docs/SECURITY.md, docs/ACCESSIBILITY.md (WCAG 2.2 AA target, the two stated exceptions — the workspace's two-dimensional layout under the 1.4.10 carve-out, and Monaco's Tab capture with the documented Esc / Ctrl+M escape — and a named human contact) all complete.
Done when: four gates green; Lighthouse CI, axe, size-limit and the keyboard journey all pass in CI; a restore drill completes into a scratch database and is recorded with a date; alert rules fire correctly against synthetic conditions. Manual: pull the plug on a judge host mid-contest and confirm leases reclaim, the reconciler re-enqueues, and no submission is lost; restart Redis and confirm the same.

6. Deferred — do not half-build these
Phase 11+ (after launch): discussion and solution sharing gated behind an unassisted solve (with the TA_MENTOR moderation role shipping simultaneously, not after); SQL problems (per-submission ephemeral Postgres schema, read-only role, statement_timeout = 5s, result-set comparison, PostgreSQL dialect only, stated on the problem page); the moderated InterviewExperience archive — structured fields, not prose — which is the only legal and genuinely REC-specific source of company tags and "asked at" frequency, and is therefore load-bearing rather than a nicety (bootstrap it with a one-time structured collection from the two most recent graduated batches before launch; until then show placement-cell-curated company tracks explicitly labelled as curated); spaced revision (RevisionCard, SM-2-lite intervals 1/3/7/21/60 days, cap 3 surfaced per day, 25% XP on a due re-solve — the highest-value thing here that LeetCode does not have, because the documented failure mode of sheet prep is solving 300 problems once and retaining none); the rule-based, explainable recommender (no ML — it has neither the data nor an evaluation harness to beat a good rule, and it cannot explain itself; always render the reason inline, and rotate topics after 3 consecutive picks from the same one); mock-interview scheduler with read-only spectate mode (full Yjs collaborative editing is Phase 12); interactive problems (two boxes, FIFOs, interactor CPU excluded, 2s mutual-idle deadlock detection — the most fragile part of the engine; admin-authored interactors only, and keep them out of high-stakes assessments until they have run cleanly through two practice contests); core-CS MCQ module; rust180 and cs8; vim/emacs keymaps; debugging and output-only problem kinds; written/system-design with rubric grading.

7. DO NOT — anti-requirements and scope traps
Judge and execution

Do not run student code in the Next.js process, a server action, a route handler, or any container holding DATABASE_URL.
Do not give the judge host DB credentials, AUTH_SECRET, an object-storage master key, or student PII.
Do not pass --share-net, or add any config key that could enable it.
Do not use RLIMIT_AS / ulimit -v / --mem as the memory limit — it breaks the JVM, Go and Node before main(). cgroup --cg-mem only.
Do not use Docker-per-submission (150–500ms × 20 tests of pure overhead, coarse accounting, and the worker needs a root-equivalent docker socket), pooled warm containers for untrusted code (state leakage between submissions is the worst judge bug class), gVisor as the default (1.3–3× variable syscall overhead destroys cross-language timing comparability — a correctness bug for a judge), or --privileged anywhere.
Do not retry a deterministic verdict. Infrastructure failures only.
Do not create one DB row per test case. Do not write a row per test as it completes.
Do not let a student inject compile flags, run flags, env vars or extra files.
Do not show a student a hidden test's input, expected output, their own output, or a diff. Index, verdict, CPU ms, memory KB only.
Do not let a submission read the randomisation seed, or generate per-candidate expected outputs inside the judge.
Do not promise deterministic timing. A solution within 10% of the limit may flip between runs; set limits at ≥2.5× the measured model solution, store per-test node identity and calibration score, and say so.
Do not support arbitrary third-party libraries. Compilation is offline; available packages are exactly what is vendored (numpy only, for Python). A scipy/pandas/Boost/npm request is a toolchain-image change with a new version directory, not a runtime feature.
Do not accept GPU, ML, multi-process, distributed, or >15s / >1 GB problems. Say so in the authoring docs rather than discovering it when a faculty member uploads a PyTorch problem.
Do not load Monaco from jsdelivr, or import it outside src/components/editor/**.
Do not ship the Monaco TypeScript language service worker.
Proctoring and integrity

Do not build webcam, microphone or screen recording by default.
Do not build a desktop agent, keylogging of content, clipboard content capture, browser-history or credential access, or face recognition.
Do not block paste, copy, cut, right-click or selection. Instrument them.
Do not trust any client-reported timing, clock, or countdown for anything authoritative.
Do not auto-fail, auto-void, auto-penalise or auto-terminate on any signal.
Do not let the banding engine import or write to the scoring path.
Do not show a band or "integrity score" to a student or a recruiter.
Do not treat an absence of flags as a clearance, in code or in copy.
Do not use raw-text diff, Levenshtein, or an LLM for similarity.
Do not flag similarity on a lowSolutionDiversity problem.
Do not flag IP_SHARED across students on a campus NAT. IP change within an attempt only.
Do not penalise focus loss or fullscreen exit for a SCREEN_READER accommodation.
Do not expose a disability label to a reviewer or invigilator.
Do not write the words "[banned phrase 1 — see tests/repo/forbidden-words.test.ts]", "[banned phrase 2 — see tests/repo/forbidden-words.test.ts]", "[banned phrase 3 — see tests/repo/forbidden-words.test.ts]", "[banned phrase 4 — see tests/repo/forbidden-words.test.ts]" or "[banned phrase 5 — see tests/repo/forbidden-words.test.ts]" anywhere.
Do not hide the proctoring rules until after the start.
Do not let affectsPlacementEligibility be true outside LAB_SUPERVISED.
Data model and performance

Do not add these models to the LMS schema at C:\Users\SUBASH\OneDrive\Documents\GitHub\REC-LMS\prisma\schema.prisma, or share a database with the LMS.
Do not mutate a frozen ProblemVersion, or let an assessment/contest reference Problem.liveVersionId.
Do not mutate a published test-data key. Write v(n+1).
Do not aggregate XpEvent to render any page. Do not UPDATE or DELETE a ledger row.
Do not keep a single hot leaderboard row incremented per submission.
Do not recompute ContestStanding.rank inside a submission transaction.
Do not render 5,000 DOM rows. Virtualise.
Do not insert one row per proctor heartbeat.
Do not store a raw IP. sha256(ip + pepper) only.
Do not hard-delete a student.
Do not partition Submission at launch.
Do not rely on Postgres RLS as the authorization boundary: with one app role behind transaction pooling, a missing SET LOCAL presents as "no data" rather than an error, and any migration or job connecting as the owner bypasses it. App-layer guards plus a build-breaking query-shape test are the fence; RLS is a second fence at most.
Do not poll for verdicts at 250ms. 2,000 students doing that is 8,000 req/s of pure overhead that takes down the judge before its real workload does.
Product and scope

Do not scrape or paste problem statements, editorials, test cases or company-tag data from LeetCode, GeeksforGeeks, InterviewBit or anywhere else.
Do not build coins, a gem store, premium/paid tiering, native mobile apps, shell/bash/concurrency problem classes, a multi-file playground, or any "predict your placement" feature.
Do not build a serious phone-based solving experience, and do not allow the contest arena or a proctored attempt below 768px. A phone-based proctored exam has no meaningful focus or fullscreen guarantees at all.
Do not make --muted lighter than #6f6a87 (light) or darker than #9c95b4 (dark).
Do not make --success/--warning/--danger/--info themeable.
Do not ship an "Accepted" badge that is colour-only.
Do not hard-disable an account from a cron job, or disable one with an open attempt or a pending appeal.
Do not require admin approval to clear a soft restriction.
Do not promise "all the features LeetCode provides". The binding constraint is ~3,600 authored problems, not code. Frame the catalog as curated-for-campus and ship the authoring pipeline on day one.
Do not imply the readiness score predicts placement, or use it to gate drive eligibility without a recorded human decision.
Do not treat a contest rating as meaningful before ~8–12 contests.
Do not build a second XP/streak economy — reuse the LMS awardXp / XPTransaction / levelProgress / streak semantics.
8. Start here
Scaffold the monorepo and packages/design with the verbatim tokens.
Write docs/ARCHITECTURE.md, docs/CONVENTIONS.md and docs/OPEN-QUESTIONS.md before the first feature, recording every decision above that you are accepting and every one you want to revisit.
Build Phase 1. Stop at its gate. Report the gate result — including the manual verification — before touching Phase 2.

Continue implementing each phase when the previous one is done and tested, don't wait for my approval.