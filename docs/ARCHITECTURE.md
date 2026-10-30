# REC Code — Architecture

REC Code is a coding practice, contest and proctored-assessment platform for
Rajalakshmi Engineering College (~5,000 students). It is a separate
application from the REC Learning LMS: same stack and design language, its own
database (`recx`), and the LMS remains the identity source of record.

## Processes

```
                 ┌──────────────────────────── app host ─────────────────────────────┐
 browser ──TLS──▶│ Caddy ─▶ apps/web (Next.js 15, ×2)  ── pooled ──▶ Postgres 17 (recx)│
                 │            │  ▲  SSE ◀── Redis pub/sub ◀───────────┐                │
                 │            │  └── BullMQ enqueue ──▶ Redis 7 ──────┤                │
                 │ apps/scheduler ── direct URL ──▶ Postgres          │                │
                 │   reconciler (10s), node sweep, later cron jobs    │                │
                 │ MinIO (test-data bundles)                          │                │
                 └────────────────────────────────────────────────────┼────────────────┘
                                                                      │
                 ┌──────────── judge host(s) — credential-free ───────┼────────────────┐
                 │ apps/judge-worker ── claims jobs from Redis ───────┘                │
                 │   │  HTTPS (node token) ─▶ apps/web /api/judge/*  (claim, blob,     │
                 │   │                        result, release, heartbeat)              │
                 │   └─▶ IOI isolate 2.7 boxes (cgroup v2, no network, RAM box root)   │
                 └────────────────────────────────────────────────────────────────────┘
```

* **apps/web** is the only process with `DATABASE_URL`. Server components read
  with `db` directly; mutations are server actions returning
  `ActionResult<T>`; judge workers talk to it over `/api/judge/*`.
* **apps/judge-worker** holds no database URL, no auth secret, no storage
  master key and no student PII. Its node token can only: claim a job, fetch
  the blobs of the job it currently holds, post that job's result, release
  it, and heartbeat. Egress is allow-listed to the app host and Redis.
* **apps/scheduler** owns periodic work: the judge reconciler every 10 s
  (submissions, runs, validation runs), the node-offline sweep and lane
  hygiene, RunRequest TTL and retention purges (legal-hold aware), the daily
  challenge (prepared before campus midnight) and the leaderboard freeze
  (closed weeks and months → LeaderboardSnapshot); the dormancy sweep arrives
  in Phase 8. It uses the direct, non-pooled database URL because it needs
  advisory locks and `SKIP LOCKED` leases.

## Packages

| Package | Contents | Imported by |
|---|---|---|
| `@recx/shared` | Verdict, limits table, XP rules, 14-topic enum, language catalog, judge protocol (zod) + `JUDGE_PROTOCOL_VERSION`, FUNCTION harness (C++, Python, Java) + structured comparators (`@recx/shared/harness`), output sanitiser, the two-sum seed problem | everything |
| `@recx/db` | Prisma schema + migrations, `createPrismaClient()` with the frozen-version guard | web, scheduler — **never** judge-worker |
| `@recx/design` | verbatim LMS tokens, Tailwind v4 theme bridge, utilities, 13 primitives, `VerdictBadge`, server-only palette derivation | web |

Single-source rule: Verdict, the limits table, XP constants, the topic enum and
`JUDGE_PROTOCOL_VERSION` are defined only in `@recx/shared`. The Prisma enums
are storage mirrors held equal by a parity test; any other copy fails
`tests/repo/single-source.test.ts`.

## Judge pipeline (Phase 1)

1. **Submit** (server action): validate (zod, 256 KB source cap), write
   `Submission` (`QUEUED`/`PENDING`) + `SubmissionSource` in one transaction,
   **then** enqueue on BullMQ with `jobId = submission.id`, then mark
   `DISPATCHED`. If Redis is down the row stays `QUEUED`; the reconciler
   enqueues it later. Postgres is truth; Redis is transport.
2. **Claim**: the worker POSTs `/api/judge/claim`; the web app runs the lease
   `UPDATE … WHERE status IN ('QUEUED','JUDGING') AND (leaseExpiresAt IS NULL
   OR leaseExpiresAt < now()) RETURNING …`, writing a fresh `claimToken` and a
   2-minute lease. The response is the `JudgeJobSpec`: pinned problem version,
   language runtime (from the `LanguageConfig` row), limits, test manifest
   (sha256 + size only).
3. **Fetch**: blobs come from `/api/judge/blob/{sha256}` (authorised only for
   the claimed job's version) into a sha256-verified LRU cache on the judge.
4. **Compile** in its own box (separate uid), then **run** each test in the
   run box: only the current input is staged (`/box/input.txt`, 0444) and it
   is unlinked before the next. Expected output never enters the box.
5. **Progress** goes over Redis pub/sub (`recx:submission:{id}`) — never a DB
   row per test. The browser receives it over SSE.
6. **Result**: the worker POSTs `/api/judge/result` with its `claimToken` and
   protocol version. The finalise transaction is guarded by `claimToken` and
   `judgeState IN ('DISPATCHED','RUNNING')`, so a stale node's late result or a
   retried callback is a no-op. Deterministic verdicts are never retried; only
   infrastructure failures (`release`) are, up to 3 attempts, after which the
   submission becomes `INTERNAL_ERROR` and is excluded from scoring.

## Data model principles

The five structural decisions from the prompt are load-bearing:

1. Immutable `ProblemVersion` (frozen on publish; repository guard + DB trigger).
2. Narrow `Submission` with jsonb per-test results; source in a 1:1 side table.
3. Content-addressed `TestBlob` + immutable bundle keys.
4. Append-only XP ledger with period buckets (Phase 3).
5. Authoritative contest attempts + materialised standings (Phase 5).

## Spaced revision (Phase 12c)

A `RevisionCard` per student per problem, written by the progress engine the
first time they solve it and moved by the same engine afterwards. The ladder
is five rungs — 1, 3, 7, 21 and 60 days (`REVISION_INTERVALS` in
`@recx/shared`); a due re-solve climbs one and pays 25 % of the first solve,
a due attempt that fails drops one and stays due today, and clearing the top
rung sets `learnedAt` and retires the card.

Three decisions are worth knowing before changing anything here:

* **The ladder moves only when the ledger did.** `applyRevision` advances the
  card after `insertXpEvent` reports an insert, so a retried finalise can
  neither pay twice nor climb twice. The idempotency key is the campus DAY,
  not the rung: a card that lapses has to climb the same rung again, and a
  rung-keyed row would have been spent the first time — which would have
  stuck that card forever. A real walk up the ladder found this; the
  arithmetic looked right on paper.
* **Three a day is a property of the QUEUE, not of the data.**
  `REVISION_DAILY_CAP` is applied in `dueQueue()`; the backlog keeps its
  order and the surfaces state its length.
* **The migration backfills.** Every problem already solved gets a card,
  three per student per day, oldest solve first — otherwise the feature is
  empty for exactly the students it exists for.

## Problem authoring (Phase 4)

**Revisions and review.** A problem's content is a chain of
`ProblemVersion` revisions. A revision whose `frozenAt` is null is the
problem's one open draft, and only a DRAFT is editable. The review stages
are DRAFT → IN_REVIEW → APPROVED → PUBLISHED, then SUPERSEDED or RETIRED.
They are derived by `reviewStageOf()` (`@recx/shared/authoring`) from the
unchanged `ProblemStatus` plus `approvedAt`.

**One chokepoint for edits.** Every edit goes through `touchDraft()`
(`lib/authoring/draft.ts`). It locks the revision and bumps `editSeq`
(optimistic concurrency for the forms). An edit that changes judging also
bumps `judgeSeq` and cancels running validation, and only `ValidationRun`
rows of the current `judgeSeq` count. Statement edits leave validation
alone.

**Gates.**
- Approval (`lib/authoring/review.ts`) needs a different admin from the
  creator, the last editor and the submitter, publishable validation, and
  content without errors (`versionContentIssues`, which includes the
  harness stream's declared-comparator rule).
- Publish (`publishVersion` in `lib/judge/validation.ts`) re-checks all of
  that plus the approval and RETIRED. In one transaction it freezes the
  revision with its pinned bundle keys and flips `Problem.liveVersionId`
  under `Problem.version`. The bundle bytes are written after the commit:
  drafts never write bundles.

**Bulk import.** Imports (`lib/authoring/import/`) read a zip with yauzl or
a directory (CLI), one problem directory at a time. Each directory is its
own transaction with its own `ProblemImportRow`, so one bad entry never
discards a batch. The upload is a raw `application/zip` route handler that
spools to disk with a byte cap and imports in `after()`.

**Student view.** A submission keeps showing the revision it was judged
against (its pinned `problemVersionId`).

Every module that can read hidden tests or reference sources lives under
the sensitive paths: `lib/authoring/`, `server/queries/admin-`,
`server/actions/admin-`, `app/admin/` and `app/api/admin/`. See
docs/AUTHORING.md.

## Super-admin governance (Phase 4)

`/super` is a separate tree with its own layout (`app/super/layout.tsx`,
`components/super/super-shell.tsx`) and a persistent
`bg-danger-subtle text-danger` strip: "Super-admin — all actions are
audited". The layout guards, and every page guards again with
`requireSuperAdminPage()`; no super page loads Monaco.

| Route | Purpose |
|---|---|
| `/super` | privileged requests waiting for me / mine (approve, reject, cancel, break-glass), alerts, chain head, scheduler health |
| `/super/users` | find accounts; status (≤ 25 directly, more by request), role, XP void, impersonate |
| `/super/roles` | staff roles and ADMIN scopes (grant / revoke; never deleted) |
| `/super/settings/branding` | two seeds + radius, previewed and contrast-checked on the server |
| `/super/settings/policy` | XP rules override, read-only retention schedule, legal hold |
| `/super/settings/judge` | language toggles, node token rotation (shown once), global rejudge request |
| `/super/settings/integrations` | mail transport status, Redis, test-data driver, test email |
| `/super/audit` | the full audit log on indexed filters, per-day chain verification |
| `/super/impersonate` | read-only, 15-minute view as a user; history |
| `/super/flags` | the two governance kill switches |
| `/super/jobs` | queues, backlog, scheduler job status, outbox, running operations |
| `/super/data` | PII export and submission purge requests; export download (`exports/[id]/route.ts`) |

* **Capabilities.** `lib/auth/capabilities.ts` is the role × capability map
  as data: the twelve SUPER_ADMIN capabilities (ratings, integrity and
  calendar declared for Phases 5, 6 and 8), the supporting super-only
  actions and the staff capabilities. Tests prove each listed action starts
  with its guard, statically and at runtime.
* **Privileged operations** (`lib/privileged/`): request → second
  super-admin approves (or audited break-glass) → executor. Payloads are
  resolved and hashed at request time; the database enforces the state
  machine, the two-person rule and the 24-hour window.
* **Impersonation** (`lib/auth/impersonation.ts`): a pointer on the
  super-admin's `Session`; `getCurrentUser()` returns the target with
  `impersonation` set and `requireActionUser()` refuses every mutation.
* **Audit append lives in `@recx/db`** (`packages/db/src/audit.ts`), so the
  scheduler audits the governance sweep (expired requests, stuck executions,
  lapsed impersonations) and failed security email. The scheduler also
  drains `EmailOutbox` (`smtp | log | disabled`) and records
  `SchedulerJobStatus` per job.
* PlatformSetting and PlatformTheme are written only by the four
  super-admin settings actions (`tests/repo/platform-setting-writes.test.ts`).

## AdminScope and the query-shape fence (Phase 4)

An ADMIN sees students by department and/or batch, through `AdminScope`
rows that only the governance actions write (grant and revoke, SUPER_ADMIN,
audited). A null dimension means every value; a grant with both null is the
whole college. An ADMIN with no active grant sees no student at all: the
scope fails closed. A SUPER_ADMIN is never scoped. The scope is applied in
the application, not with Postgres row-level security (spec §7: with one app
role behind transaction pooling a missing `SET LOCAL` would read as "no
data", and owner connections bypass it).

Two modules hold the whole mechanism. `lib/auth/scope-where.ts` is pure:
`buildStudentScope` turns an actor and its grants into a branded
`StudentScope`; `scopedStudentWhere(scope, extra)` returns
`{ AND: [{ role: "STUDENT" }, <grants or nothing>, extra] }` for Prisma
(`where:` on User, `user:` on a relation model) and `scopedStudentSql(scope,
"u")` the same filter as parameterised SQL for a joined `"User" u`;
`staffOnlyWhere` is for names of grantors and deciders; `scopeCovers` checks
a cohort (an announcement's audience, a roster row's target cohort).
`lib/auth/scope.ts` (server-only) loads the active grants once per request
and provides the guards every admin page and action starts with —
`requireAdminScopePage()` and `requireAdminScopeAction()` — plus
`requireScopedStudent(scope, id)`, which returns a `ScopedStudent` (an
out-of-scope id and a missing id are the same "not found") whose branded
`scopedId` is the only key per-student admin queries accept.

`tests/repo/admin-scope.test.ts` is the build-breaking fence. It finds every
file an ADMIN can reach (the admin pages, components, `lib/admin/**`,
`server/{actions,queries}/admin-*.ts`, anything importing the scope helpers or
running an admin role guard, and their `@/server/**` / `@/lib/admin/**`
imports), computes the student models from `schema.prisma` (every model with
a `userId` or a User relation, so later models are fenced automatically) and
fails on: a read, count, aggregate or bulk write of a student model without
`scopedStudentWhere(` (or a `scopedId` key); raw SQL naming a student table
without `${scopedStudentSql(`; `$queryRawUnsafe`; a single-row write not keyed
by a `scopedId`; any read of notes, code drafts, submission sources or the
audit log; a spread scope filter; a scope or `ScopedStudentId` built outside
the two scope modules; an admin page or action without its guard (pages that
read students must use the scoped guard); `@/lib/db` in admin pages and
components; and any hard delete of a user. The few deliberate exceptions —
`/admin/judge` fleet aggregates and the roster import's conflict lookup — are
listed in the test with exact counts and reasons, so a new call in an exempt
file fails it too. SUPER_ADMIN-only code (`/super`) is outside the fence; its
scope is the whole college.

## Theming

`packages/design/tokens.css` holds the LMS tokens verbatim. The admin-chosen
brand (two seeds + radius) is derived once on save (`derive.ts`, server-only)
into a `PlatformTheme` row; the root layout injects it as a nonce'd
`<style id="rec-brand">` after the tokens. No client JS, no flash, works with
JS disabled. `--success/--warning/--danger/--info` are never themeable.

## The Pages Router exception: `/login`

Everything is App Router (`apps/web/src/app`) except one page. `/login` is a
Pages Router page (`src/pages/login.tsx`, with `_document.tsx` and `_app.tsx`)
exported with `config.unstable_runtimeJS = false`, so its production HTML
carries **no JavaScript at all** — no framework, no `<script src>`, no
`__NEXT_DATA__`; the inline theme script (CSP hash) is the only script. The
App Router cannot do this: every App Router page ships the React runtime and
Next client (~100 KB gzip here), which put a student's first visit over the
90 KB `/login` budget, and sign-in needs none of it. The form is a plain
`POST` to the route handler `/api/auth/login`, which answers every outcome
with a `303` (the role's home, or `/login?error=<code>`); failure messages,
`aria-invalid`, `aria-describedby` and the autofocus target are all
server-rendered. The page reads the session and the brand through
`src/lib/pages-server.ts` and `src/lib/db-client.ts` (Next refuses
`server-only` and `next/headers` in a `pages/` import graph; the database
client is the same process-wide one `src/lib/db.ts` uses), and `_document`
injects the brand `<style>` after the global stylesheet, as the root layout
does. `tests/repo/pages-router.test.ts` keeps `src/pages` to these three
files, and `pnpm --filter @recx/web size` serves every production build and
fails if `/login` ever loads a script. Sign-in security: `docs/SECURITY.md`
§2.

## Local development topology

Windows hosts run `apps/web` natively; Linux-only pieces (isolate, the real
judge, Postgres/Redis when Docker is unavailable) run in WSL2 Ubuntu 24.04.
See `docs/RUNBOOK.md` → "Local development".
