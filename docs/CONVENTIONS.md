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
