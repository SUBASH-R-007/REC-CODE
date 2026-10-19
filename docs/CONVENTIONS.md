# REC Code — Implementation Conventions

Mirrors the REC Learning LMS conventions. Read fully before writing code.

## Stack (pinned)

pnpm 9 workspaces (`packageManager: pnpm@9.15.9`), Node 22, TypeScript strict
(`noUncheckedIndexedAccess` on), Next.js 15 App Router, React 19, Tailwind v4,
Prisma 6 + PostgreSQL 17, Redis 7 + BullMQ 5, IOI isolate 2.7, vitest.

> On Windows, if a globally installed pnpm 10 fails to switch to 9.15.9, run
> commands as `npx pnpm@9.15.9 <command>`.
>
> **It fails green.** That switch error (`Failed to switch pnpm to v9.15.9 …
> ENOENT`) goes to stderr and the process still **exits 0**, so a bare
> `pnpm lint` or `pnpm test` reports success while having run nothing at all.
> Never read a gate as passed without its exit code and its test counts: run
> each gate on its own, and assert `$?` (a pipe into `tail` or `grep` masks
> it — that is the pipeline's exit code, not pnpm's).

## Golden rules

1. **Student code never runs in the web process.** Not in a server action,
   not in a route handler, not for local dev convenience. `apps/web` may not
   import `child_process` (lint).
2. **RBAC is server-side.** Every page calls a guard; every action calls
   `requireActionUser()` / `requireActionRole(...)` / `requireSuperAdmin()`
   from `@/lib/auth/guards`. Never trust params. Hiding a link is not RBAC.
3. Server components fetch with `db` (`@/lib/db`) directly. Mutations are
   server actions in `src/server/actions/*.ts` returning `ActionResult<T>` via
   `runAction()` from `@/lib/errors`.
4. Client components are leaf-level only (`"use client"`). Feedback via
   `useToast()` from `@recx/design`.
5. Zod validates at every server boundary (actions, route handlers, the judge
   protocol, env).
6. Every sensitive mutation calls `audit()` from `@/lib/audit` (hash-chained,
   never throws).
7. No signal ever auto-penalises a student. The maximum automatic consequence
   anywhere is: flag for review and withhold from the public leaderboard.
8. Never claim proctoring prevents cheating. Use "monitored and recorded",
   "tamper-evident", "layered containment". The forbidden-words test
   (`tests/repo/forbidden-words.test.ts`) scans code, UI strings and docs
   for the five banned phrases listed in the prompt — even in negation.
9. No hardcoded hex in any component (`*.tsx`) — lint rule. Use tokens.
10. A verdict renders only through `VerdictBadge` (colour + icon + label +
    monospace code). Difficulty is never a bare coloured word.
11. Never a raw IP: `hashIp()` from `@/lib/ip` (sha256 + pepper).
12. Ask before inventing: implement the narrower reading and record it in
    `docs/OPEN-QUESTIONS.md`.

## Design tokens (Tailwind classes)

Backgrounds `bg-background` (page), `bg-surface` (cards), `bg-elevated`.
Text `text-text`, `text-text-secondary`, `text-muted`. Borders `border-border`,
`border-border-strong`. Primary `bg-primary text-primary-fg`, subtle
`bg-primary-subtle text-primary`. Semantic `success | warning | danger | info |
accent` (+ `-subtle`). Headings `font-display font-bold tracking-tight`.
Shadows `shadow-card`, `shadow-pop`. Radius `rounded-2xl` cards, `rounded-xl`
controls.

## Components (`@recx/design`)

`Button` / `ButtonLink`, `Card` / `CardHeader` / `CardBody`, `Badge`,
`ProgressBar` / `ProgressRing`, `Avatar`, `EmptyState`, `StatCard`,
`Skeleton` / `CardSkeleton` / `PageSkeleton`, `Tabs` / `TabList` / `Tab` /
`TabPanel`, `Dialog`, `Dropdown` / `DropdownItem`, `ToastProvider` /
`useToast`, `Field` / `Input` / `Textarea` / `Select` / `Label`,
`VerdictBadge`, `DifficultyBadge`, `SolveStatus`. Utilities: `cn`,
`publicName` ("Priya S."), `initials`, `formatBytes`, `clamp`, `pluralize`.

## Web app layout

- `src/app/(auth)/login` — sign in (no public sign-up; accounts come from the
  LMS roster or the seed).
- `src/app/(student)/…` — authenticated product surface (guard in layout).
- `src/app/api/judge/*` — judge-node protocol (node-token auth, protocol
  version check → 426 on mismatch).
- `src/app/api/submissions/[id]` (+ `/stream` SSE), `src/app/api/runs/[id]`
  (+ `/stream`).
- `src/lib/*` — env, db, redis, errors, audit, ip, auth, judge, brand.
- `src/server/actions/*` — server actions.
- `src/server/queries/*` — read helpers shared by pages.

Pages export `metadata = { title: "…" }`. Params are Promises:
`{ params }: { params: Promise<{ slug: string }> }`.

## Sensitive paths (hidden tests, checkers, reference solutions)

Hidden test bytes, checker sources and `ReferenceSolution.source` are the one
class of data a student must never reach. Rather than auditing every file,
the repo confines that code to a fixed set of paths and lets
`tests/repo/student-exposure.test.ts` (static, part of `pnpm test`) plus
`apps/web/test/student-exposure.db.test.ts` (live canaries) police the rest.
`SENSITIVE_PREFIXES` in the static test is the list; **put new code that
touches that data at one of these paths, and name it accordingly**:

| Path | What goes there |
|---|---|
| `src/app/admin/**`, `src/app/super/**` | staff pages |
| `src/app/api/admin/**`, `src/app/api/judge/**` | staff and judge-node routes |
| `src/components/admin/**`, `src/components/super/**` | staff UI |
| `src/server/queries/admin-*.ts`, `super-*.ts` | staff read helpers |
| `src/server/actions/admin-*.ts`, `super-*.ts`, `privileged.ts` | staff actions |
| `src/lib/authoring/**`, `src/lib/testdata/**`, `src/lib/privileged/**` | authoring, the blob store, SUPER_ADMIN executors |
| `src/lib/judge/claim.ts`, `finalize.ts`, `validation.ts` | job specs, finalise, validate-and-publish |

The `admin-` / `super-` **filename prefix is the convention that carries the
rule** under `src/server/queries` and `src/server/actions`: a staff query in
`src/server/queries/accommodations.ts` is not sensitive as far as the test is
concerned, so the fences below would reject it. Rename, don't exempt.

Everywhere else under `apps/web/src` (comments never count):

- no `referenceSolution(s)` / `ReferenceSolution`, in code or in SQL text;
- no `testBlob` delegate, `readBlobBytes`, `getTestDataStore`, `checkerSha256`,
  and no SQL naming `TestBlob`, `inline`, `storageKey` or `checkerSha256`;
- a `testCase(s)` query selecting `input` / `output` must say `isSample: true`;
- no value import of a sensitive module (a type-only import is erased, so it
  is fine).

And across the import graph:

- every **student entry** — `page` / `layout` / `route` / `loading` / `error` /
  `global-error` / `not-found` / `template` / `default` under `src/app` outside
  `admin/**`, `super/**`, `api/judge/**` and `api/admin/**`, plus
  `src/middleware.ts` and `src/pages/**` — must have no sensitive module
  anywhere in its closure;
- every `"use server"` file whose closure reaches a sensitive module must start
  **every** export's `runAction` body with a staff-only guard
  (`requireSuperAdmin()`, or `requireActionRole(…)` naming ADMIN or
  SUPER_ADMIN and never STUDENT, or a composite that itself starts so). No
  function-level `"use server"` anywhere in `src`;
- every route handler under `src/app/api/admin/**` calls a staff-only guard
  before it reads the body or touches the database;
- every sensitive `lib/**` and `server/queries/**` module starts with
  `import "server-only"`. The exemptions are pure helpers and store drivers
  loaded outside the react-server condition (`SERVER_ONLY_EXEMPT`).

A module that genuinely has to be reachable from a student entry goes in
`STUDENT_REACHABLE_ACTIONS` with its reason, and the graph is still followed
*through* it — the root layout's impersonation banner is the only entry today.

## Judge worker

No `@recx/db`, no `@prisma/client`, no `DATABASE_URL` in its env schema
(lint + `tests/repo/judge-isolation.test.ts`). All judge logic is pure and
unit-tested; `IsolateDriver` builds argv through one function whose output is
asserted never to contain `--share-net`.

## Tests

- Unit/integration: vitest, colocated `test/` per package.
- Repo-wide structure: `tests/repo/*.test.ts` (run by `pnpm test`).
- Linux sandbox integration: `apps/judge-worker/test/integration/*` (only
  with `RECX_ISOLATE_INTEGRATION=1` on Linux with isolate + toolchains).

## Gate

`pnpm lint && pnpm typecheck && pnpm test && pnpm build` must be green on
Windows and Linux before a phase is closed; extra checks and manual
verification are recorded in `docs/RUNBOOK.md` with a date.

## Tailwind colour utilities fail silently

Tailwind v4 emits a colour utility only for a `--color-*` entry in
`packages/design/theme.css`. A class naming anything else — `text-fg`,
`bg-surface-raised`, `text-on-accent` — compiles to **nothing**: no error, no
warning, no missing module. The element simply inherits, which on a dark
background often looks close enough to pass a glance.

Five such classes were written into the Phase 6c exam shell from memory of a
different design system and went green through `lint`, `typecheck` and
`build`. The real token names are deliberately not the ones most design
systems use:

| Looks right | Actually |
|---|---|
| `text-fg`, `text-fg-muted` | `text-text`, `text-text-secondary` |
| `bg-surface-raised` | `bg-elevated` |
| `text-on-accent`, `bg-accent` | `text-primary-fg`, `bg-primary` |
| `outline-accent` | `outline-ring` |

`tests/repo/design-tokens.test.ts` now fails on any colour utility whose
suffix contains one of our token stems and does not resolve. Read
`packages/design/theme.css` rather than guessing; it is the whole list.

## A Postgres CHECK with a bad regex is created happily and fails on every insert

Postgres' regex engine caps a bounded repetition at **255**, so
`'^[A-Za-z0-9_-]{16,1024}$'` is an invalid regular expression. It parses the
pattern **lazily**, at evaluation time — so

```sql
ADD CONSTRAINT "X_check" CHECK ("col" ~ '^[A-Za-z0-9_-]{16,1024}$')
```

is accepted by `ALTER TABLE`, recorded in `pg_constraint`, reported by
`guard-state.db.test.ts` as present and correct, counted by
`frozen-coverage.test.ts` in the migration SQL — and then raises
`invalid regular expression: invalid repetition count(s)` on **every** insert
that reaches it.

Three of Phase 6d's constraints shipped like that (2026-10-19). Every catalog
fence passed; `device-invariants.db.test.ts` caught it on its first run. The
lesson is about the fences as much as the regex: a catalog fence proves a
guard EXISTS, and only an invariant test proves it WORKS. A migration that
adds a CHECK gets both.

Write the character class and the length as separate conjuncts:

```sql
CHECK ("col" ~ '^[A-Za-z0-9_-]+$' AND length("col") BETWEEN 16 AND 1024)
```

## A Postgres CHECK that evaluates to NULL is SATISFIED

A `CHECK` constraint refuses a row only when it evaluates to **FALSE**. NULL
passes. So a CHECK that reaches through a nullable column can silently accept
exactly the write it exists to refuse:

```sql
-- WRONG: with "firstRationale" NULL, length(btrim(NULL)) is NULL, so
-- `NULL BETWEEN 40 AND 4000` is NULL, the disjunct is NULL, `false OR NULL`
-- is NULL — and the row is accepted.
CHECK (
  ("firstReviewerId" IS NULL AND "firstRationale" IS NULL)
  OR ("firstReviewerId" IS NOT NULL AND length(btrim("firstRationale")) BETWEEN 40 AND 4000)
)
```

```sql
-- RIGHT: guard the column you are about to reach through.
CHECK (
  ("firstReviewerId" IS NULL AND "firstRationale" IS NULL)
  OR ("firstReviewerId" IS NOT NULL
      AND "firstRationale" IS NOT NULL AND length(btrim("firstRationale")) BETWEEN 40 AND 4000)
)
```

Phase 6e shipped the wrong version, and `integrity-invariants.db.test.ts`
caught it: a verdict with no rationale at all was accepted by the constraint
whose entire job is the mandatory written rationale.

The safe shape most of this schema already uses is different and does not
have the problem — `"col" IS NULL OR <comparison on col>` is TRUE whenever
the column is null, so the comparison is never reached. The trap is only
there when the disjunct guards one column and then reaches through another.
An audit of every hand-written CHECK across all migrations (2026-10-19) found
these two and nothing else; the `ProblemVersion` checks that reach into jsonb
already wrap the reach in `COALESCE(..., false)`.

Two rules follow, and they are the same rule twice:

- any CHECK that reaches through a nullable column needs its own
  `IS NOT NULL`, or a `COALESCE(..., false)`;
- a catalog fence proves a guard EXISTS; only an invariant test proves it
  WORKS. Every migration that adds a CHECK gets both.

## Do not touch `recx_test` while a gate is running

`scripts/dev/linux-gate.sh` syncs the mirror, then runs `migrate deploy`
against `recx_test` and the `RECX_DB_TESTS=1` suites against the code it
synced. Applying a LATER migration to `recx_test` from Windows while that is
in flight leaves the mirror's guard catalog describing a database that has
moved on, and the two catalog fences fail with a shape that looks alarming
and means nothing:

```
TRUNCATE > every guarded table has an enabled BEFORE TRUNCATE trigger
  expected [ Array(29) ] to deeply equal [ Array(25) ]
no other trigger runs a guard function
  expected [ 'IntegrityFlag_no_truncate', …(3) ] to deeply equal []
```

Seen 2026-10-19: Phase 6e's migration was applied to `recx_test` while Phase
6d's Linux gate was still on its services step. Nothing was wrong with either
slice. Start the next slice's migrations after the gate reports, or gate the
two slices together.

## `next build` succeeding is not the same as the app routing

Next refuses two different dynamic slug NAMES at the same path position, and
it does not say so at build time. Phase 6e added
`/assessments/[attemptId]/report` while the exam group already owned
`/assessments/[slug]/attempt`:

```
✓ Compiled successfully in 66s
…
[Error: You cannot use different slug names for the same dynamic path ('attemptId' !== 'slug').]
```

The build passed. `pnpm typecheck` passed. `pnpm test` passed. The error only
appeared under `pnpm size`, because that script **serves the production build
and asks it for a page** — and every page answered 500.

Two things follow:

- give the same path position the same slug name everywhere, or put the route
  somewhere else (the report moved to `/sittings/[attemptId]`, which is also
  what the codebase calls an attempt);
- `pnpm size` is not only a size check. It is the only gate that proves the
  built app can serve a request, so a red `size` with a routing error in it is
  a real failure and not a budget problem.

A stale `.next/types` directory also reports phantom `TS2307` errors for a
route that has just been moved. Rebuild before believing them:
`rm -rf apps/web/.next && npx pnpm@9.15.9 build`.

## Fixing a migration means rolling it back in BOTH databases

There are two: the dev database (`packages/db/.env`'s `DATABASE_URL`, `recx`)
and the test database the `.db.test.ts` suites use (`recx_test`, applied by
`applyMigrations()` in `packages/db/test/support/test-db.ts`). Prisma records a
checksum per applied migration, so an already-applied migration that is then
edited cannot simply be re-deployed — it has to be rolled back and re-applied,
and that is **per database**.

Rolling back only one of them produces a confusing failure: the fix is proven
by hand against the dev database while the suite, which runs against
`recx_test`, keeps exercising the old definition and keeps failing. It cost
three rounds of "but I just fixed that" in Phase 7b. The rollback script takes
the target as an explicit argument for exactly this reason, and the suite's own
`expect(current?.name).toBe(dbName)` is what tells you which database you are
actually looking at.

While you are there: `prisma migrate reset` is refused in this environment
("Prisma Migrate detected that it was invoked by Claude Code"), so a targeted
rollback script is the only route. Drop exactly what the migration created,
delete its `_prisma_migrations` row, then `migrate deploy`.

## An edit script that does not assert is an edit script that silently did nothing

Several files here are edited with short Python or `sed` scripts because
heredocs fight TypeScript quoting. A `str.replace` whose needle does not match
returns the string unchanged and exits 0, and `sed -i` with a pattern that
matches nothing does the same — so the edit reports success, the next command
runs against the old file, and the resulting failure points anywhere but at the
cause. In Phase 7b a regex-escaping slip meant a "roll back the TEST database"
script rolled back the dev database a second time, and the real target was
never touched.

Every edit script in this repository therefore asserts its needle was found
(`assert old in s` before the replace), and anything that picks a target prints
it (`console.log("target:", …)`) so the output says what was done rather than
that something was done.

## "Tests N passed" does not mean the suite passed

Vitest reports a `beforeAll` or `afterAll` failure as a failed test FILE while
still printing every assertion that ran as passed:

```
 Test Files  1 failed | 119 passed (120)
      Tests  3293 passed (3293)
```

A Phase 7c teardown tripped `MockPattern_published_has_paper` — deleting the
only section of a PUBLISHED pattern drives its totals to zero, which is
exactly the write that CHECK exists to refuse — and a grep for `×` and
`Tests ` reported a clean run twice before the Linux gate caught it. Always
read the **Test Files** line, and prefer the process exit code to any line of
output.

The teardown fix is also the rule: bring a fixture's status DOWN before
deleting what the status depends on.

## A CHECK that spans the app clock and the database clock will fail

`startedAt DateTime @default(now())` with a `finishedAt` written by the
application, and a CHECK that `finishedAt >= startedAt`, compares two clocks.
On this development machine the WSL2 Postgres runs 174–214 ms ahead of the
Windows host, so the application's "now" is genuinely earlier than a default
Postgres wrote milliseconds before — and the CHECK refuses a row that is
perfectly correct. In production the application and the database are
different machines, so this is not a development artefact.

It has now bitten three times: the Phase 4/5 governance fixtures (RUNBOOK §3,
which is why the `db` suites are a Linux-gate item), and `AptitudeImport`'s
own `finished_check` in Phase 7d.

So: when two timestamp columns are compared by a CHECK, **write both from one
clock**. The Phase 7d importer sets `startedAt` explicitly rather than taking
the default, and clamps `finishedAt` so it is never earlier — a clock stepping
backwards mid-import (an NTP correction, a resumed laptop) must not cost the
whole import report. The alternative, taking both from `now()` in SQL, works
too and is better where nothing else needs the value.


### The drift has a SIGN, and WSL's clock changes it while you work

Two further things, learned in Phase 8a.

**The number above is not a constant.** Mid-session the WSL Postgres clock had
drifted to **370 ms BEHIND** the Windows host — the opposite sign — and 21
Phase 4 governance tests failed at once with
`PrivilegedOperation_decided_after_request_check` and
`Accommodation_decided_after_request_check`. Nothing in the repository had
changed; the same suites had passed on the Linux gate an hour earlier, where
the application and the database share one clock and the skew is zero by
construction. WSL2 does not keep its clock in step with the host across a
host sleep or a long session.

So before believing a timestamp CHECK failure is a code bug, **measure the
skew and its sign**:

```js
const before = Date.now();
const [row] = await db.$queryRawUnsafe("SELECT extract(epoch from now()) * 1000 AS ms");
const after = Date.now();
console.log("skew", Math.round(Number(row.ms) - (before + after) / 2), "ms");
```

A few hundred milliseconds either way is the environment. `wsl --shutdown`
(then restart Postgres and Redis) resyncs it from the host and needs no sudo;
`hwclock -s` does too but prompts for a password and will hang a
non-interactive shell.

**A `.db.test.ts` is subject to the same rule as the application.** A test
that writes one timestamp from the host (`new Date()`, or a Prisma default
Prisma fills client-side) and the other from SQL (`now()`) is comparing two
clocks, so whether it passes depends on the drift's sign that afternoon. The
Phase 4 fixtures above do exactly this. They are correct in intent and they
pass on the gate, so Phase 8a left them alone rather than widening a
constraint to accommodate a broken clock — but a new `.db.test.ts` should take
both ends of any compared pair from one side, the same rule the Phase 7d
importer follows.

## Do not run the whole `.db.test.ts` set from Windows

`RECX_DB_TESTS=1 vitest run` across the `@recx/db` package fails on Windows
with twenty copies of

```
Error: P1001: Can't reach database server at `localhost:5433`
```

and it is not the database. Each `.db.test.ts` file calls `applyMigrations()`,
which spawns its own `prisma migrate deploy`; twenty of those at once saturate
WSL2's localhost port forwarding, and once saturated **the forwarding stays
dead for every later connection until `wsl --shutdown`** — including the
serial re-run, which is why `--no-file-parallelism` does not help after the
fact. Inside WSL, `pg_isready` keeps answering happily the whole time, so the
database looks fine from the Linux side and unreachable from the Windows side.

This was never part of a gate. The Windows `pnpm test` step runs without
`RECX_DB_TESTS`, so every `.db.test.ts` **skips** (that is the 991 skipped the
Phase 7 gate reports), and the Linux gate's `services-tests` step runs them
with the flags set *inside* WSL, where there is no forwarding to saturate.

So, while developing on Windows:

- run live DB suites **one file at a time** (`npx vitest run calendar-invariants`),
  which works and is fast;
- take the whole set from the Linux gate, which is the thing that gates anyway;
- if forwarding has already died, `wsl --shutdown`, then wait for
  `systemctl is-active postgresql@17-main redis-server` to report active —
  systemd starts both, so no `sudo service` call is needed, and `sudo` here
  prompts for a password and will hang a non-interactive shell.

A restart also resyncs the clock, which fixes the skew above at the same time.

## A test that sweeps a shared table globally must drain it first

`recx_test` is one database and vitest runs test files in parallel, so a
suite that calls a sweeper with no id — `autoSubmitExpired(db, { limit: 1 })`
— is asking a question about every row in the table, including fixtures
another file created seconds ago. The assertion then silently becomes about
somebody else's row.

Phase 7d's Linux gate failed exactly this way, and the failure read as a bug
in the sweeper's `ORDER BY` rather than as cross-suite interference. The fix
is one line before the fixtures: sweep with a generous limit to drain whatever
is already overdue, so the ordering claim is about the rows this test made.

Prefer the scoped form (`{ attemptId }`) wherever the test does not
specifically exist to prove the batching.
