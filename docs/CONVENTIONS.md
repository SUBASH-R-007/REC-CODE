# REC Code — Implementation Conventions

Mirrors the REC Learning LMS conventions. Read fully before writing code.

## Stack (pinned)

pnpm 9 workspaces (`packageManager: pnpm@9.15.9`), Node 22, TypeScript strict
(`noUncheckedIndexedAccess` on), Next.js 15 App Router, React 19, Tailwind v4,
Prisma 6 + PostgreSQL 17, Redis 7 + BullMQ 5, IOI isolate 2.7, vitest.

> On Windows, if a globally installed pnpm 10 fails to switch to 9.15.9, run
> commands as `npx pnpm@9.15.9 <command>`.

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

### Sensitive-path naming

Code that reads hidden test bytes, checker sources or reference solutions is
confined to fixed path prefixes, and the file's name is what puts it there.
`tests/repo/student-exposure.test.ts` (`SENSITIVE_PREFIXES`, each with its
reason) enforces this; `apps/web/test/student-exposure.db.test.ts` is the
runtime canary.

| Kind | Name it | Example |
|---|---|---|
| Staff query | `src/server/queries/admin-*.ts` | `admin-problems.ts` |
| SUPER_ADMIN query | `src/server/queries/super-*.ts` | `super-users.ts` |
| Staff action | `src/server/actions/admin-*.ts` | `admin-problems.ts` |
| SUPER_ADMIN action | `src/server/actions/super-*.ts` | `super-xp.ts` |
| Staff / SUPER_ADMIN page | `src/app/admin/**`, `src/app/super/**` | |
| Staff / SUPER_ADMIN UI | `src/components/admin/**`, `src/components/super/**` | |
| Library | `src/lib/authoring/`, `src/lib/testdata/`, `src/lib/privileged/` | |
| Staff route handler | `src/app/api/admin/**` | |
| Judge-node route | `src/app/api/judge/**` | |

Outside those prefixes the test refuses any mention of reference solutions,
test blobs, `readBlobBytes`, `getTestDataStore` or `checkerSha256`, in code or
SQL. A `testCase` query that selects `input`/`output` must filter
`isSample: true`. A value import of a sensitive module is also refused (a
type-only import is fine). Student entries (every page, layout and route
outside `admin/`, `super/`, `api/judge/` and `api/admin/`, plus middleware)
must not reach a sensitive module through the import graph. In practice:

- A new staff file goes under the matching prefix from the start. Don't name it
  `authoring.ts` and add an allow-list entry later.
- A sensitive `lib/**` or `server/queries/**` module starts with
  `import "server-only"`. The only exceptions are pure helpers listed in
  `SERVER_ONLY_EXEMPT`, each with its reason.
- Every export of a sensitive `"use server"` file opens its `runAction` body
  with a staff-only guard (`requireSuperAdmin()`, or `requireActionRole(...)`
  that names ADMIN or SUPER_ADMIN and never STUDENT). Never write an inline,
  function-level `"use server"`.
- If a student entry has to load a sensitive action (the impersonation
  banner's `endImpersonation`, for example), list it in
  `STUDENT_REACHABLE_ACTIONS` with its reason. The graph is still followed
  through it.

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
