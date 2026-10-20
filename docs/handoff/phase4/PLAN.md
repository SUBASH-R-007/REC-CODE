# Phase 4 — integrated implementation plan (coordinator decisions)

The six per-stream designs in this folder are the detailed specs. Where they
disagree, THIS FILE WINS. Read this file first, then your stream's design.

Repo: C:\Users\SUBASH\OneDrive\Documents\GitHub\REC-CODE (Windows). Linux mirror for
DB/isolate tests: WSL Ubuntu, ~/recx, synced by scripts/dev/linux-sync.sh. Postgres
in WSL on port 5433 (db recx, test db recx_test), Redis 6379. Run Linux commands by
writing a bash script file into the session scratchpad
(C:\Users\SUBASH\AppData\Local\Temp\claude\C--Users-SUBASH-OneDrive-Documents-GitHub-REC-CODE\488a8ed9-9b4f-4a0f-9859-3a195105ba00\scratchpad)
and running `wsl -d Ubuntu -- bash "/mnt/c/Users/SUBASH/AppData/Local/Temp/claude/C--Users-SUBASH-OneDrive-Documents-GitHub-REC-CODE/488a8ed9-9b4f-4a0f-9859-3a195105ba00/scratchpad/<file>.sh"`
(PowerShell mangles inline quoting). pnpm on Windows: `npx pnpm@9.15.9 ...`. In WSL:
`corepack pnpm@9.15.9 ...` inside ~/recx.

## Hard rules (repeat of the spec; violating any is a defect)
- Student code never runs in the web process. apps/web must not import child_process.
- apps/judge-worker must not import @recx/db or have a DATABASE_URL.
- RBAC server-side in every page guard and every action; never by hiding nav.
- Mutations: server actions in apps/web/src/server/actions/*.ts, `runAction()`, zod at
  every boundary, the guard is the FIRST statement inside the runAction callback.
- Every sensitive mutation calls audit(). Never put Date objects in audit metadata
  (ISO strings only). Never store a raw IP (requestIpHash only). Never log secrets,
  passwords, tokens or email addresses.
- Frozen ProblemVersion and children immutable; edit = clone a new DRAFT revision.
  Contests/assessments pin problemVersionId.
- Never hard-delete a student. Never aggregate XpEvent to render a page.
- The words [banned phrase 1 — see tests/repo/forbidden-words.test.ts] / [banned phrase 2 — see tests/repo/forbidden-words.test.ts] / "[banned phrase 3 — see tests/repo/forbidden-words.test.ts]" / [banned phrase 4 — see tests/repo/forbidden-words.test.ts] /
  "[banned phrase 5 — see tests/repo/forbidden-words.test.ts]" must not appear ANYWHERE (code, comments, UI, docs), not even negated.
  Use "tamper-evident", "monitored and recorded", "layered containment".
- No hex colour literals in .tsx (lint). Tokens only. --success/--warning/--danger/--info
  never themeable. Monaco only under src/components/editor/**; no Monaco on admin/super.
- Do not touch C:\Users\SUBASH\OneDrive\Documents\GitHub\REC-LMS (read-only reference).
- Never scrape content; every problem/statement/test/editorial is originally authored.
- Do not commit, push, or modify system/security settings (no sysctl, no WSL config).
- Never print the contents of any .env / .env.local file or seed credentials.
- Ask-before-inventing: implement the narrower reading and add it to
  docs/OPEN-QUESTIONS.md under a "Phase 4 decisions" section (append; other streams
  append too — re-read the file right before editing and keep your entries in your own
  sub-heading "### Phase 4 — <stream name>").

## Resolved cross-stream decisions
1. **AdminScope** = the admin-cohorts design's model: `adminId` (relation to User),
   departmentCode?, batchYear?, reason, grantedById, createdAt, revokedAt?, revokedById?,
   `@@index([adminId, revokedAt])`. Fail-closed (no active row = no students).
   Written ONLY by governance actions (`super-roles#grantAdminScope/revokeAdminScope`,
   requireSuperAdmin, SECURITY audit, revoke sets revokedAt, never delete). Read ONLY via
   the admin stream's `lib/auth/scope-where.ts` + `lib/auth/scope.ts`.
   Active-grant uniqueness: foundation tests whether a partial unique index
   (`NULLS NOT DISTINCT WHERE "revokedAt" IS NULL`) leaves `prisma migrate diff` clean;
   if yes keep it, if not drop it and the grant action dedupes under
   `pg_advisory_xact_lock(hashtext('admin-scope:'||adminId))`. Same test decides the
   Accommodation "one APPROVED / one REQUESTED per user" partial indexes (fallback:
   advisory-lock + check in the action, plus a trigger).
2. **PrivilegedOperationKind** = BULK_STATUS_CHANGE, SUBMISSION_PURGE, GLOBAL_REJUDGE,
   PII_EXPORT, PROBLEM_DELETE, VERSION_DELETE. (RATING_RECOMPUTE arrives in Phase 5.)
   Execution model = governance design (request → approve/break-glass → executor).
3. **Problem retire / delete / global rejudge are governance-owned** (super-only):
   `apps/web/src/server/actions/super-problems.ts` exports
   `retireProblem({problemId, expectedProblemVersion, reason})`,
   `requestProblemDeletion({problemId, reason})`,
   `requestVersionDeletion({problemVersionId, reason})`;
   `super-judge.ts` exports `requestGlobalRejudge(...)`. Executors in
   `lib/privileged/executors/problem-delete.ts` implement deleteDraftVersion /
   deleteUnpublishedProblem (only never-frozen, unreferenced; frozen → "retire instead").
   The authoring stream does NOT implement retire/delete; its problem page renders those
   controls only for SUPER_ADMIN and imports the super-problems actions (guarded
   server-side regardless). Governance creates super-problems.ts EARLY with these exact
   signatures so authoring can import them.
4. **Capabilities**: `apps/web/src/lib/auth/capabilities.ts` owned by governance. It
   contains the 12 SUPER_ADMIN capabilities (governance design §3; later-phase ones
   declared with `arrives`), SUPER_ADMIN_SUPPORTING_ACTIONS, and STAFF_CAPABILITIES with
   at least `judge.operate`. Export `roleHas(role,key)` and alias `can = roleHas`, plus
   `capabilityMatrix()`. Other streams' staff actions are added to STAFF_CAPABILITIES in
   the INTEGRATION stage (not by streams). Accommodation approve/reject/revoke are
   super-only but NOT among the twelve (list them as supporting actions).
   `grantJudgeQuotaOverride` is a supporting action.
5. **lib/errors.ts**: foundation adds `ConflictError extends AppError` (status 409) and
   `ImpersonationReadOnlyError extends ForbiddenError` + `IMPERSONATION_READ_ONLY_MESSAGE`.
   `FrozenVersionError` from @recx/db must surface to users: runAction maps it to a
   ConflictError-style message (foundation).
6. **Audit append moves to @recx/db** (governance). `@/lib/audit` API unchanged.
7. **validation.ts is owned by the authoring stream.** The harness stream (D1) must NOT
   edit apps/web/src/lib/judge/validation.ts; it provides pure functions
   (`comparatorIssues`, `supportsFunctionMode`) and authoring wires them in: runnable
   rule for FUNCTION (no harness → not runnable, distinct note), comparator gate in
   publish/approve, judgeSeq, approval gate, bundle-after-freeze.
8. **Comparator storage**: no new column; comparator stays in frozen `functionSignature`
   JSON (D1 design §3). D1 adds the SQL-only CHECK migration. All six comparators become
   judgeable; authoring's `versionContentIssues` calls D1's `comparatorIssues`.
9. **Protocol**: JUDGE_PROTOCOL_VERSION 2→3, done once by D1. Nobody else edits protocol.ts.
10. **Languages**: FUNCTION harness for cpp17/cpp20/py312/pypy310/java21. java21 stays
    `enabledByDefault:false`. "Enabled language" for the golden gate =
    `LANGUAGE_CATALOG[k].enabledByDefault` (cpp20, py312); the golden suite ALSO runs every
    java21 reference that exists (RECX_GOLDEN_EXTRA_LANGUAGES=java21 in linux-gate.sh).
11. **Seed problems**: six new originally-authored problems REC-0007..REC-0012 (D1 design
    §9 table) as modules in apps/web/scripts/content/, appended to AUTHORED_PROBLEMS, each
    with cpp20 + py312 + java21 model solutions, ≥1 deliberately-wrong solution, 2 samples,
    ≥10 hidden tests from a deterministic generator, 3 hints + editorial. Checkers for the
    3 CUSTOM_CHECKER problems are testlib checkers.
12. **Golden test** lives in apps/judge-worker/test/integration/golden.isolate.test.ts and
    imports seed content by relative path from apps/web/scripts/content (content modules
    import only @recx/shared — enforced by tests/repo/content-purity.test.ts). No separate
    packages/content.
13. **/admin/discuss is NOT built** (discussion deferred to Phase 11+; record in OPEN-QUESTIONS).
14. **Admin page guard rule (fence R8)**: every app/admin/**/page.tsx calls
    `requireAdminScopePage(` OR `requirePageRole("ADMIN", "SUPER_ADMIN")` (problem
    authoring pages don't read students). Pages that read students MUST use
    requireAdminScopePage.
15. **Admin nav**: owned by the admin stream; it includes `/admin/problems` (authoring
    creates the pages) and, for SUPER_ADMIN only, a link to `/super`.
16. **New dependencies are installed by FOUNDATION only** (lockfile has one writer):
    apps/web: `yauzl` + `@types/yauzl` (dev); apps/scheduler: `nodemailer` +
    `@types/nodemailer` (dev). Exact versions pinned; verify they exist with `pnpm view`.
    Nobody else runs `pnpm add`/`pnpm install` in Phase 4 streams.
17. **Seed users are added by FOUNDATION**: RECADMIN02 (ADMIN, AdminScope CSE / all
    batches), RECSUPER02 (second SUPER_ADMIN for two-person approval), two ECE batch-2026
    students (2116226002001, 2116226002002), student 2116231001004 (authoring e2e). Passwords
    come from the existing SEED_* env vars the seed already uses — do not invent new
    secrets and do not print them. Seed must stay idempotent.
18. **Email** = governance's EmailOutbox + scheduler drain; transports smtp | log (dev
    only, refused in production) | disabled.
19. **Migrations**: ONE Phase 4 migration directory written by foundation:
    `packages/db/prisma/migrations/20261010100000_phase4_admin_authoring/` (generated SQL
    + hand-written sections, each headed by a comment naming its stream), plus D1's
    SQL-only `20261010100100_function_comparator_checks/`. Must sort after
    20261010001004_phase3_student_surface. Drift check must be clean.

## Stage plan
- Stage 1 FOUNDATION (single agent): schema + migration + generate + drift check;
  frozen.ts (born-frozen guard, exported FROZEN_CHILD_MODELS/FROZEN_EXEMPT_MODELS);
  TestBlob immutable trigger; frozen-coverage + frozen-children tests; errors.ts
  additions; dependencies; seed users; shared enum-mirror constants (PROCTOR_EVENT_KINDS
  in packages/shared/src/proctor.ts, ACCOMMODATION_KINDS in
  packages/shared/src/accommodation.ts, CONTENT_ORIGINS in
  packages/shared/src/authoring/index.ts exposed as "@recx/shared/authoring") + enum
  parity entries. Gates on its own output: lint/typecheck/test Windows + DB tests Linux.
- Stage 2 STREAMS in parallel (shared working tree; own your files; for shared files make
  minimal hunks and RE-READ the file immediately before every edit):
  A governance/super, B admin surface + AdminScope, C authoring/content pipeline,
  D1 harness/comparators/Java/protocol/golden, D2 six seed problems, E /judge + footer.
- Stage 3 INTEGRATION: STAFF_CAPABILITIES completion + role×capability matrix test,
  student-exposure (static + DB canary) tests, rbac + authoring Playwright specs, full
  gates Windows + Linux, adversarial review, fixes.
- Stage 4 LIVE: seed + validate-and-publish the new problems on the WSL stack, authoring
  e2e, rbac/a11y e2e (admin + super pages), manual checks → docs/RUNBOOK.md rows.

## File ownership (Stage 2)
| Stream | Owns (create/modify freely) | Shared files it may touch (minimal hunks) |
|---|---|---|
| A governance | app/super/**, components/super/**, components/impersonation/**, lib/auth/capabilities.ts, lib/auth/impersonation.ts, lib/flags.ts, lib/outbox.ts, lib/accounts/**, lib/privileged/**, lib/judge/rejudge.ts, lib/judge/node-token.ts, server/actions/super-*.ts, server/actions/privileged.ts, server/queries/super-*.ts, packages/shared/src/governance.ts, packages/db/src/audit*.ts, apps/scheduler/src/{mail,outbox,governance,job-status}.ts | lib/auth/session.ts, lib/auth/guards.ts, lib/audit.ts, lib/audit-chain.ts, server/actions/auth.ts, server/actions/admin-judge.ts (extract reset only), server/actions/xp-settings.ts, scripts/judge-node.ts, app/layout.tsx (banner), apps/scheduler/src/{main,config,classify}.ts, packages/db/package.json exports, packages/shared/src/index.ts (1 line), .env.example |
| B admin | app/admin/** EXCEPT app/admin/problems/** and app/admin/judge/**, components/admin/** EXCEPT components/admin/problems/**, lib/auth/scope*.ts, lib/admin/**, lib/plans/recount.ts, server/actions/admin-{roster,students,plans,announcements,accommodations}.ts, server/queries/admin-{overview,students,cohorts,reports,plans,announcements,accommodations,roster}.ts, server/queries/announcements.ts, components/dashboard/announcement-banner.tsx, tests/repo/admin-scope.test.ts, packages/shared/src/{proctor,accommodation,roster}.ts (extend foundation stubs) | app/admin/judge/page.tsx + server/queries/admin-judge.ts + server/actions/admin-judge.ts (scope retrofit hunks only), components/admin/stuck-table.tsx, app/(student)/dashboard/page.tsx (banner), app/(student)/notifications/**, scripts/content/study-plans.ts, packages/shared/src/index.ts (export lines) |
| C authoring | app/admin/problems/**, components/admin/problems/**, app/api/admin/problems/**, lib/authoring/**, server/actions/admin-problems.ts, server/actions/admin-problem-content.ts, server/queries/admin-problems.ts, packages/shared/src/authoring/** (extend foundation stub), scripts/import-problems.ts, scripts/check-approved.ts, docs/AUTHORING.md | lib/judge/validation.ts (OWNER), lib/testdata/bundle.ts, server/queries/submissions.ts + app/(student)/problems/[slug]/submissions/[id]/page.tsx (pinned revision), scripts/seed.ts (stop draft bundles), scripts/validate-and-publish.ts, lib/env.ts (IMPORT_SPOOL_DIR), next.config.ts (serverExternalPackages yauzl) |
| D1 harness | packages/shared/src/harness/**, packages/shared/src/protocol.ts (2→3 bump), apps/judge-worker/src/**, apps/judge-worker/test/**, migrations/20261010100100_function_comparator_checks, tests/repo/content-purity.test.ts | packages/shared/src/languages.ts (append JVM helpers), packages/shared/src/index.ts (harness export lines), packages/shared/src/samples/two-sum.ts (java ref), lib/judge/job-spec.ts, server/actions/judge.ts (custom-input validation), server/queries/problems.ts (functionUnavailable), components/workspace/problem-description.tsx + result-view.tsx, lib/judge/view.ts, scripts/content/{two-sum,handle-maker,lab-power-budget}.ts (java refs only), apps/web/test/seed-content.test.ts, scripts/dev/linux-gate.sh (golden env) |
| D2 content | scripts/content/{conveyor-shift,playlist-fold,bench-blackout,session-order,exact-change-pair,no-neighbour-seating}.ts (+ checker sources), scripts/content/index.ts (append to AUTHORED_PROBLEMS) | none else |
| E judge page | app/(public)/**, components/shell/public-shell.tsx, lib/judge/transparency.ts, lib/judge/judge-links.ts, server/queries/judge-languages.ts, components/workspace/language-version.tsx | packages/shared/src/verdict.ts (append), packages/shared/src/languages.ts (append), apps/judge-worker/src/sandbox/isolate.ts (FORCED_ENV import only), apps/judge-worker/src/judge/verdict.ts (comment), lib/judge/claim.ts (startup cap), app/u/layout.tsx, server/queries/problems.ts (version), components/workspace/workspace.tsx (footer), app/(student)/help/page.tsx, server/actions/admin-judge.ts (revalidate call), components/shell/nav.ts + nav-icon.tsx, size-budgets.json + scripts/size-budget.mjs, e2e/a11y.spec.ts (append row), test/sw-routes.test.ts |

Stage 2 agents: run `npx pnpm@9.15.9 --filter <your package> typecheck`, `lint` on your
files (`npx eslint <paths> --max-warnings=0`), and your tests. Expect transient breakage
from OTHER streams' in-progress files — do not edit their files to fix it; report it.
Do NOT run `pnpm build` of apps/web concurrently with others (one shared .next); the
integration stage builds. Do not start/stop servers. Do not run linux-gate.sh. DB tests:
sync the mirror with linux-sync.sh (no --install unless foundation changed deps) and run
only YOUR db test files with RECX_DB_TESTS=1 against recx_test.
