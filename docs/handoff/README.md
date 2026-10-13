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
| 4 Authoring, admin, `/super` | **Built, integrated and adversarially reviewed. The Linux gate is green (cloud, 2026-10-13). Not gated:** the Windows gate on the final tree, the real-isolate suites, the live stage and CI are still to run (below) |
| 5–10 | Not started |

## Phase 4: what was done in the cloud session (2026-10-13)

Branch `phase4/integration-aenby5`, pushed to GitHub.

- **Leftovers:**
  - `schema.prisma` `///` comments for the 20261010100200 rules;
  - the sensitive-path naming section in `docs/CONVENTIONS.md`;
  - `tests/repo/render-read-only.test.ts`.
- **Size budgets.** `/judge` measures 116.8 KB (budget 125) and
  `/dashboard` 120.0 KB (budget 160), recorded in `docs/CAPACITY.md` §7.1.
  The Monaco-free check now covers `/super` too (43 routes).
- **Adversarial review.** Six dimension reviewers raised 46 findings (about
  41 once duplicates are merged). Then two skeptics per finding, one on
  reachability and one on reproduction. Every confirmed finding is fixed,
  with a test that fails without the fix. The decisions are in
  `docs/OPEN-QUESTIONS.md` under "Phase 4 — adversarial review". The headline
  fixes:
  - ADMINs could read any student's submissions and code (AdminScope now
    applies, and an ADMIN never gets the code).
  - A rejudge could overwrite the verdict a purge keeps.
  - FUNCTION tests typed in the UI skipped the canonical-form check.
  - An SMTP outage could stall the judge reconciler.
  - Super-admins could demote each other to zero.
  - An approved operation could be stranded forever.
  - A PII export grew past the approved set.
  - Roster previews were invalidated by student activity.
  - Several fence gaps (R3 could be fooled; the new R9 covers seed content).
  - Thirteen UI and accessibility fixes.
- **Gate (cloud, Linux).**
  - Lint, typecheck, test and build all pass, and so does `pnpm size`.
  - The DB and Redis suites pass with nothing skipped: db 354, scheduler
    163, web 2,838, repo 607, shared 503, judge-worker 403, design 86.
  - Postgres was 16 on port 5433, because the network policy blocks the
    PGDG repository. Re-run on Postgres 17 locally.
  - Rows are in `docs/RUNBOOK.md` §3.

## Phase 4: what is left before the gate (do these on the local machine)

1. **Windows gate on the final tree.** Run `pnpm lint && pnpm typecheck &&
   pnpm test && pnpm build && pnpm size`. The last Windows run predates the
   review fixes.
2. **Linux mirror on Postgres 17:** `scripts/dev/linux-gate.sh` in full. This
   includes the real-isolate suites and the golden suite with java21. It
   could not run in the cloud: no isolate, no cgroup v2 delegation, no
   `/opt/toolchains`.
3. **Live stage**, on a stack with a real judge:
   - Rebuild the judge worker and scheduler. Protocol 3 means web and
     worker deploy together (`docs/RUNBOOK.md` §2.9). The scheduler sends
     mail through `MAIL_TRANSPORT=log` in dev.
   - Seed, then `validate-and-publish --approve` the six new problems
     REC-0007..0012.
   - Run Playwright with `E2E_JUDGE=1`: projects `a11y`, `keyboard`, `rbac`,
     `authoring` and `judge`. The worker needs at least 5 slots, with
     `judge-rejudge` in RECX_QUEUES.
   - Manual checks (spec):
     - author a problem end to end in the UI;
     - fail validation with a wrong reference solution, fix it, publish;
     - edit the statement and confirm an older submission still shows its
       revision;
     - two super-admins approving a 30-user DISABLED change;
     - break-glass with the log transport;
     - impersonation being read-only.
   - New since the review, worth a look in the browser:
     - the impersonation banner over the sidebar;
     - the admin phone menu closing when you navigate;
     - the node-token dialog (Escape does not close it);
     - an ADMIN opening an out-of-scope submission (404);
     - an in-scope submission showing no code.
   - Record every check, with its date, in `docs/RUNBOOK.md` §3.
4. **CI.** `ci.yml` runs on pull requests (a manual dispatch needs the file
   on `main`, which has only the initial commit). Opening a PR from this
   branch runs the Windows and Linux verify jobs and the real-isolate
   judge-integration job.
5. **Needs a person:**
   - Name the owners of the 450-problem content target
     (`docs/OPEN-QUESTIONS.md`, top). This is a project commitment the spec
     asks for.
   - Open question: should Accommodation `requestedAt` get the ±5-minute
     insert window?
6. Then Phases 5–10, in order, each gated.

## Moving this session to the local machine

The cloud session is pushed. To continue on the Windows + WSL2 machine:

1. In WSL, `cd` into the REC-CODE clone, then `git fetch origin` and
   `git checkout phase4/integration-aenby5`.
2. Run `claude --teleport`, pick this session (or use claude.ai/code →
   Open in → Terminal for the exact command). The same claude.ai account
   is needed, and the git state must be clean.
3. The `.env` files are not in the repo. Keep the existing local ones
   (`apps/web/.env.local`, `apps/judge-worker/.env.local`,
   `packages/db/.env`).

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
