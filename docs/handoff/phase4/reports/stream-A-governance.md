The governance stream is built: all 12 `/super` routes, impersonation, two-person approval with break-glass, the email outbox and the scheduler jobs. Typecheck, lint and every test pass on Windows and in the WSL mirror. `super-problems.ts` has the three agreed exports, and the authoring stream already imports them (`components/admin/problems/super-controls.tsx`).

**What you need to know first**
- **Every ActionRef resolves; none are missing.** This includes `admin-accommodations#approveAccommodation/rejectAccommodation/revokeAccommodation` (stream B's file now exists) and `admin-judge#grantJudgeQuotaOverride`. Each starts its runAction body with `requireSuperAdmin()`, and the reverse check (no super-only action left unlisted) passes.
- **Two test files outside my table were edited, both small.**
  - `apps/web/test/admin-judge.test.ts`: three expectations now match the extracted `resetForRejudge` (`updateMany`/`deleteMany` with `{in:[id]}`).
  - `apps/web/test/login-route.test.ts`: its fake DB gained `session.findUnique → null`. `destroySession()` now looks up the session first so it can end a live impersonation. Without that, sign-in rotation fails against this fake only; the real flow works.
- **One flake fixed, one seen in another stream.** The first full parallel run of all web DB tests had two failures. One was in my break-glass test (another suite created a super-admin mid-test); I fixed the assertion. The other was a deadlock in C's `problem-authoring.db.test.ts`. I also changed my teardown to lift only the guards of tables that hold my rows. The next full run was green, 25 files.
- **No schema change, dependency or migration requested.**

**Tests (all passing)**

| Where | Command | Result |
|---|---|---|
| Windows, web | `npx pnpm@9.15.9 --filter @recx/web exec vitest run` | 88 files passed, 24 skipped; 1,704 passed, 143 skipped |
| Windows, repo | `npx vitest run --config vitest.repo.config.ts` | 10 files, 387 passed |
| Windows, scheduler | `npx pnpm@9.15.9 --filter @recx/scheduler test` | 8 files passed, 6 skipped; 123 passed, 35 skipped |
| Windows, shared | `npx pnpm@9.15.9 --filter @recx/shared test` | 22 files, 497 passed |
| Windows, db | `npx pnpm@9.15.9 --filter @recx/db test` | 2 files passed, 6 skipped; 115 passed, 196 skipped |
| Mirror, my DB tests | `scratchpad/ga_dbtest.sh` | web 4 files 15/15; scheduler 2 files 9/9 |
| Mirror, all web + scheduler DB | `scratchpad/ga_dbtest_all.sh` | web 25 files 154/154; scheduler 14 files 159/159; 0 triggers left disabled in recx_test |

The new tests are the full §9 list except the optional render-read-only test. The headline ones:
- `capabilities.test.ts` (44 tests): a TypeScript-parser check that every ActionRef has the right guard first.
- `capability-matrix.test.ts` (199 tests): every role calls every listed action with the real guards, plus an impersonating SUPER_ADMIN.
- `impersonation-read-only.test.ts` (34 tests): every server action, plus `/api/drafts` and `/api/activity`, returns the read-only refusal while impersonating.

**Typecheck and lint**
- `npx pnpm@9.15.9 --filter @recx/web --filter @recx/scheduler --filter @recx/db --filter @recx/shared typecheck` exits 0.
- `npx tsc --noEmit -p tests/repo/tsconfig.json` exits 0.
- `npx eslint --max-warnings=0` over all my paths (plus `apps/web/test`, `tests/repo`, `apps/scheduler`, `packages/db/src`, `packages/shared/src`) exits 0.

**Not done, and choices worth checking**
- The optional `render-read-only` test (§9.11) was not written.
- `/super/jobs` counts the judge backlog with its own queries. Stream B is changing `loadStuckSubmissions`, so I avoided depending on it.
- `/super/settings/judge` imports B's `LanguageToggle`. If B changes its props, that page breaks.
- The `/super` link in the admin header belongs to stream B.
- PLAN overrides the design in two places: AdminScope grant/revoke are SECURITY-audited, and duplicate grants are refused by the partial unique index (P2002 → "already has exactly that scope").
- `requestSubmissionPurge` also writes a `submission.purge_requested` audit row, which the design did not list.
- Docs: SECURITY.md (new §8a, §8 path fix), RUNBOOK.md (§2.11, not the gate log), ARCHITECTURE.md (new governance section), `.env.example` (mail block). 22 decisions are under `### Phase 4 — A governance` in OPEN-QUESTIONS.md. Two are open questions: which SMTP relay production uses, and whether a later job should clean up orphaned test blobs.

**Files** (repo `C:\Users\SUBASH\OneDrive\Documents\GitHub\REC-CODE`)

Created:
- `packages/shared/src/governance.ts`: flags, retention schema, limits, mail and job names.
- `packages/db/src/audit.ts`, `packages/db/src/audit-chain.ts`: audit append moved from web, plus `createChainVerifier`.
- `apps/web/src/lib/auth/capabilities.ts`: the 12 capabilities, supporting actions, `judge.operate`, `roleHas`/`can`, `capabilityMatrix`, `actionRoles`.
- `apps/web/src/lib/auth/impersonation.ts`: begin, close and close-for-user.
- `apps/web/src/lib/flags.ts`, `lib/outbox.ts`, `lib/accounts/status.ts`.
- `apps/web/src/lib/privileged/`: `payloads.ts`, `policy.ts`, `operations.ts`, `types.ts`, `rate.ts`, `retention.ts`, `csv.ts`, and `executors/` (`bulk-status`, `global-rejudge`, `submission-purge`, `problem-delete`, `pii-export`).
- `apps/web/src/lib/judge/rejudge.ts`, `lib/judge/node-token.ts`.
- `apps/web/src/server/actions/`: `super-problems`, `super-users`, `super-roles`, `super-settings`, `super-flags`, `super-branding`, `super-judge`, `super-audit`, `super-impersonate`, `super-xp`, `super-data`, `super-integrations`, `privileged`.
- `apps/web/src/server/queries/`: `super-dashboard`, `super-users`, `super-audit`, `super-jobs`, `super-data`.
- `apps/web/src/app/super/`: `layout.tsx`, `error.tsx`, the 12 `page.tsx` files, and `data/exports/[id]/route.ts`.
- `apps/web/src/components/super/`: `nav.ts`, `super-nav`, `super-strip`, `super-shell`, `ui`, `reason-dialog`, `operation-card`, `bulk-status-form`, `status-dialog`, `role-form`, `scope-form`, `xp-ledger`, `branding-form`, `xp-rules-form`, `legal-hold-form`, `rotate-token-button`, `global-rejudge-form`, `test-email-button`, `audit-verify-button`, `impersonate-form`, `flag-toggle`, `pii-export-form`, `purge-form`.
- `apps/web/src/components/impersonation/impersonation-banner.tsx`.
- `apps/scheduler/src/`: `mail.ts`, `outbox.ts`, `governance.ts`, `job-status.ts`.
- Tests:
  - `apps/web/test/`: `capabilities`, `capability-matrix`, `impersonation-read-only`, `impersonation`, `impersonation-actions`, `privileged-policy`, `account-status`, `super-shell`, `audit-verify`, `rotate-token`, `branding-actions`, `pii-export-route` (`.test.ts`); `privileged`, `xp-void`, `impersonation`, `audit-verify` (`.db.test.ts`); `support/governance-db.ts`, `support/action-modules.ts`.
  - `tests/repo/action-guards.test.ts`, `tests/repo/platform-setting-writes.test.ts`, `tests/repo/support/action-guards.ts`.
  - `apps/scheduler/test/`: `outbox.test.ts`, `mail-config.test.ts`, `outbox.db.test.ts`, `governance.db.test.ts`.
  - `packages/shared/test/governance.test.ts`.

Changed (small edits):
- `packages/shared/src/index.ts`: one export line.
- `packages/db/package.json`: `./audit` and `./audit-chain` exports.
- `apps/web/src/lib/audit.ts`: delegates to `@recx/db/audit`; adds `auditMany`.
- `apps/web/src/lib/audit-chain.ts`: re-exports from `@recx/db/audit-chain`.
- `apps/web/src/lib/auth/session.ts`: `CurrentUser` with `impersonation`, `currentSessionId`, `destroySession`/`destroyAllSessions` end impersonations.
- `apps/web/src/lib/auth/guards.ts`: read-only refusal in `requireActionUser`; new `requireImpersonator`.
- `apps/web/src/server/actions/auth.ts`: logout is attributed to the impersonator.
- `apps/web/src/server/actions/admin-judge.ts`: reset replaced by `resetForRejudge`.
- `apps/web/scripts/judge-node.ts`: uses `generateNodeToken()`.
- `apps/web/src/app/layout.tsx`: renders the banner.
- `apps/scheduler/src/config.ts` (mail settings), `classify.ts` (shared retention schema), `main.ts` (outbox and governance jobs, per-job status).
- `apps/web/test/admin-judge.test.ts`, `apps/web/test/login-route.test.ts`: as described above.
- `docs/SECURITY.md`, `docs/RUNBOOK.md`, `docs/ARCHITECTURE.md`, `docs/OPEN-QUESTIONS.md`, `.env.example`.

`session-token.ts`, `pages-server.ts`, `sign-in.ts` and `pages/login.tsx` are untouched, and `tests/repo/pages-router.test.ts` passes.