# Handoff: where REC Code stands (2026-10-19)

These are coordinator working notes, committed so a cloud session can continue
the build. They are not product documentation. `phase4/` is kept even though
Phase 4 is gated: `p4-review.workflow.js` was never run and is still the ready
deeper review, and `docs/RUNBOOK.md` §3 cites it. Delete the directory once
that review has happened or been dropped.

- `SPEC.md` is the full implementation prompt the platform is built from. The
  five banned proctoring phrases are redacted to `[banned phrase N]`; the real list
  lives in `tests/repo/forbidden-words.test.ts`.
- `phase4/` holds the Phase 4 integrated plan, the foundation report (database
  rules every app path must satisfy), the six stream designs, and the stream and
  integration task briefs and reports. File paths inside them refer to the original
  Windows checkout (`C:\Users\SUBASH\…\REC-CODE`) and a scratchpad. Read them as
  repo-relative.

## Phase status

| Phase | State |
|---|---|
| 1 Thin vertical slice | Gated 2026-10-10 (`docs/RUNBOOK.md` §3) |
| 2 Judge hardening and capacity | Gated 2026-10-10 |
| 3 Student product surface | Gated 2026-10-10 |
| 4 Authoring, admin, `/super` | Gated 2026-10-19 (`docs/RUNBOOK.md` §3) |
| 5 Contests | Gated 2026-10-19 (`docs/RUNBOOK.md` §3) |
| 6 Assessments and proctoring | **Next** |
| 7–10 | Not started |

## Phase 4: what is done

Everything below is in this commit. Every Windows unit and structure suite was green
on 2026-10-13 (web 2,637, repo 564, shared 497, judge-worker 403, …). The Linux
mirror's DB, Redis and services suites were green twice in a row, and all 260
real-isolate tests pass, including the golden suite with java21.

- **Database.** Migrations `20261010100000` through `20261010100200`: 11 new
  models and the database-enforced invariants (frozen versions; two-person
  privileged operations; AdminScope; accommodation state machines;
  impersonation windows; announcement immutability; TRUNCATE guards; comparator
  CHECKs). Static and live guard fences live in `packages/db/test`.
- **Streams.**
  - `/super`: the 12 capabilities, impersonation, privileged operations with
    break-glass, the email outbox, scheduler jobs, branding, policy (XP override)
    and judge settings.
  - `/admin`: AdminScope plus the query fence, roster import, cohorts,
    sheets/tracks, reports, announcements and accommodations.
  - Authoring: the review queue, zip import, validation tied to content, and
    bundle-after-freeze.
  - Judge: the FUNCTION harness for C++, Python and Java with six comparators,
    compile-error remapping, and protocol v3.
  - Content: six new seed problems, REC-0007 to REC-0012.
  - Public `/judge` page and the workspace footer link.
- **Integration.**
  - Role × capability matrix covering the whole app (`capabilities.ts`, a static
    test and a runtime test; the generated table is in `docs/SECURITY.md`).
  - Student-exposure fence: a static test plus a DB canary test.
  - Database test files run serially when `RECX_DB_TESTS=1`.
  - Playwright projects `rbac`, `authoring` and `judge`, plus 22 gating a11y rows
    for the admin, super and `/judge` pages.

## Phase 4: gated 2026-10-19

Every "Done when" item passed and is recorded in `docs/RUNBOOK.md` §3 with its
date: the four gates on Windows (4,485 tests) and Linux (`linux-gate.sh` 7/7,
incl. 260/260 real-isolate), `pnpm size` (`/judge` 116.8 KB, `/dashboard`
120.1 KB -- `docs/CAPACITY.md` §7.1), the §5 item-3 leftovers, a focused
review of the two highest-severity surfaces, and the live stage: the six new
problems validated on a real judge and published, Playwright `a11y` 140/140
plus `rbac`, `judge`, `keyboard` and the `authoring` journey with
`E2E_JUDGE=1`, and the two-person and break-glass governance checks.

`phase4/p4-review.workflow.js` was NOT run -- it is multi-agent and billed, and
needs its own go-ahead. It stays available if a deeper review is wanted; the
gate rows say plainly that the review performed was a focused read, not the
six-dimension workflow.

## Phase 5: gated 2026-10-19

`phase5/DESIGN.md` holds the plan it was built from. Every "Done when" item
is a dated row in `docs/RUNBOOK.md` §3: the four gates on Windows (4,748
tests) and Linux (7/7, every suite at full count, 260/260 real isolate), the
rating fixture and idempotence, `rebuild-standings` byte-for-byte, the
150-participant simulated contest, `pnpm size` with two new budgets, and the
`contest` Playwright project.

Two findings worth carrying forward, both in `docs/OPEN-QUESTIONS.md`:
a `datetime-local` field is campus time and the client must make it absolute
before sending (invisible on an IST dev box, wrong on a UTC host); and a
student who registers but submits nothing is not on the board and so is not
rated, which is the narrower reading of "materialised from the attempts" but
the opposite of what the reference implementation does.

## Ground rules carried over (see `SPEC.md` §0 and §7)

- **Gates.** A phase closes only when lint, typecheck, test and build are green on
  Windows and Linux, plus the phase's extra and manual checks, recorded in the
  RUNBOOK with a date. Never weaken a gate. If one fails, fix it or stop and
  report.
- **Never** run student code in the web process. No signal ever auto-penalises.
  No banned phrases anywhere. No cron hard-disables an account. Ask before
  inventing: take the narrower reading and record it in `docs/OPEN-QUESTIONS.md`.
- **Never** touch the REC-LMS repository or share its database. Never scrape
  content. Never store a raw IP. Never hard-delete a student.
- **Dev environment of the original machine:** Windows plus a WSL2 mirror at
  `~/recx` (Postgres 17 on 5433, Redis 7, isolate 2.7, toolchains). See
  `docs/RUNBOOK.md` §1. Seed and dev credentials live only in the git-ignored
  `apps/web/.env.local`, `apps/judge-worker/.env.local` and `packages/db/.env`;
  `.env.example` documents them.
