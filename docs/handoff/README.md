# Handoff: where REC Code stands (2026-10-13)

These are coordinator working notes, committed so a cloud session can continue
the build. They are not product documentation. Delete `docs/handoff/phase4/`
once Phase 4 is gated.

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
| 4 Authoring, admin, `/super` | **Built and integrated; not gated yet** |
| 5–10 | Not started |

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

## Phase 4: what is left before the gate (spec §5, Phase 4 "Done when")

1. **Four gates on Windows and Linux.** On Linux run `scripts/dev/linux-gate.sh`;
   it needs Postgres on 5433, Redis, isolate 2.x with cgroup v2 and the toolchains
   under `/opt/toolchains`. Then `pnpm size` after the build: record the `/judge`
   budget line in `docs/CAPACITY.md` §7, and check that `/dashboard` (the
   announcement banner adds a client button) is still ≤ 160 KB.
2. **Adversarial review** of the Phase 4 change. `phase4/p4-review.workflow.js` is a
   ready workflow: six dimension reviewers, with two skeptics per finding. Fix the
   confirmed findings, then re-run the gates.
3. **Small leftovers.**
   - `schema.prisma` `///` comments for Accommodation, Announcement,
     ImpersonationSession and PrivilegedOperation should mention the rules added in
     `20261010100200` (comments only).
   - `docs/CONVENTIONS.md` should document the sensitive-path naming that
     `tests/repo/student-exposure.test.ts` enforces.
   - Optional: `tests/repo/render-read-only.test.ts` (governance design §9.11).
   - Open question: should Accommodation `requestedAt` get the same ±5-minute
     insert window as the other governance tables?
4. **Live stage**, on a stack with a real judge.
   - Rebuild the judge worker and scheduler. Protocol 3 means web and worker
     deploy together (`docs/RUNBOOK.md` §2.9). The scheduler now sends mail
     through `MAIL_TRANSPORT=log` in dev.
   - Seed and then `validate-and-publish --approve` the six new problems.
   - Run Playwright with `E2E_JUDGE=1`: `a11y`, `keyboard`, `rbac`, `authoring`
     and `judge`. The worker needs ≥ 5 slots with `judge-rejudge` in RECX_QUEUES,
     or validation never runs.
   - Manual checks (spec): author a problem end to end in the UI, fail validation
     with a wrong reference solution, fix it, publish, edit the statement, and
     confirm an older submission still shows its version. Also: two super-admins
     approving a 30-user DISABLED change; break-glass with the log transport;
     impersonation being read-only.
   - Record every check, with its date, in `docs/RUNBOOK.md` §3.
5. Then Phases 5–10, in order, each gated.

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
