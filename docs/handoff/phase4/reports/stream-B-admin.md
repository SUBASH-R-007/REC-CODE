The admin tree, AdminScope and the fence are built; typecheck and lint are clean, and every test below passes on Windows and in the WSL mirror.

**What landed**
- **Scope helpers:** `lib/auth/scope-where.ts` and `lib/auth/scope.ts`, as designed, plus `findScopedStudent`. An ADMIN with no active grant sees no students.
- **Fence:** `tests/repo/admin-scope.test.ts` passes 194/194, including R1–R10, self-tests per rule, a check that the student-model list matches `schema.prisma`, and the exact-count exemptions. The authoring stream's one violation (unscoped author-name lookup in `server/queries/admin-problems.ts`) has already been fixed on their side.
- **Pages:** every page you listed exists; `/admin/discuss` is not built.
- **Shell and nav:** sidebar at 1024 px and wider, a no-JS `<details>` menu below, a scope chip, `/admin/problems`, and "Super-admin console" for SUPER_ADMIN only.
- **Actions:** roster, students, plans, announcements and accommodations, with the database rules from your reports.
- **/admin/judge retrofit:** identities outside scope are redacted, and rejudge and cap overrides reach in-scope students only. I built on governance's `resetForRejudge` extraction and the judge-page stream's revalidate call, re-reading each file before every edit.
- **Student side:** dashboard banner, the student announcements query, and `MarkReadButton` moved to `components/notifications/`.
- **Plans:** `lib/plans/recount.ts`; the seed sync uses it, marks plans it creates as seed-managed, and skips detached ones.

**Behaviour changes to know about**
- Scoped queries require role STUDENT. A staff account's own stuck submission can no longer be rejudged from `/admin/judge`, and a judge-cap override goes only to a student ("No student has the roll number …").
- Fence rule R1 also accepts a `scopedId` key. That check is textual, so a plain id named `scopedId` would also pass it.
- I narrowed the design in one place: SUPER_ADMIN-only paths (`app/super/**`, `components/super/**`, `server/{actions,queries}/super-*.ts`, `lib/privileged/**`, `lib/accounts/**`) are outside the fence, because an ADMIN cannot reach them.

**Files** (all under `apps/web/src` unless shown otherwise)
- **Created, library and data:**
  - `lib/auth/scope-where.ts` and `lib/auth/scope.ts`
  - `lib/admin/{cohort,student-filters,roster-csv,roster-plan,roster,announcement-audience,campus-week}.ts`
  - `lib/plans/recount.ts`
  - `server/queries/admin-{overview,students,cohorts,reports,plans,announcements,accommodations,roster}.ts`, `server/queries/announcements.ts`
  - `server/actions/admin-{roster,students,plans,announcements,accommodations}.ts`
- **Created, UI:**
  - `components/admin/admin-nav.ts`, `admin-ui.tsx`
  - `components/admin/students/*` (3), `roster/*` (3), `plans/*` (6), `announcements/*` (3), `accommodations/*` (3), `reports/*` (2)
  - `components/dashboard/announcement-banner.tsx`, `components/notifications/read-buttons.tsx` (moved)
  - Pages under `app/admin/`: `students/` (+`[id]` with `not-found.tsx`, `import`, `import/[importId]`), `cohorts`, `sheets` and `tracks` (each with `new` and `[id]`), `reports`, `announcements` (+`new`, `[id]`), `accommodations` (+`new`, `[id]`)
- **Created, shared and tests:**
  - `packages/shared/src/roster.ts`, `packages/shared/test/accommodation.test.ts`
  - `tests/repo/admin-scope.test.ts`
  - `apps/web/test/{admin-scope,roster-csv,roster-plan,admin-rbac,announcements,admin-nav}.test.ts`
  - `apps/web/test/{admin-scope,roster-import,accommodations,announcements,admin-plans}.db.test.ts`
  - `apps/web/test/support/{routes,admin-db}.ts`
- **Changed:**
  - `packages/shared/src/accommodation.ts` (terms schema, limits and helpers), `proctor.ts` (event labels), `index.ts` (one export line)
  - `app/admin/{page,layout,error}.tsx`, `components/admin/admin-shell.tsx` (rewritten)
  - `app/admin/judge/page.tsx`, `server/queries/admin-judge.ts`, `server/actions/admin-judge.ts`, `components/admin/stuck-table.tsx` (scope hunks only)
  - `app/(student)/dashboard/page.tsx` (banner); `app/(student)/notifications/page.tsx` (import path); deleted `app/(student)/notifications/read-buttons.tsx`
  - `apps/web/scripts/content/study-plans.ts`
  - `apps/web/test/admin-judge.test.ts` (scope mocks, plus an out-of-scope rejudge case)
  - `docs/OPEN-QUESTIONS.md` (new section "### Phase 4 — B admin surface and AdminScope"), `docs/ARCHITECTURE.md` (new section on AdminScope and the fence)

**Tests, typecheck and lint**

| Command | Result |
|---|---|
| `npx vitest run --config vitest.repo.config.ts` | 10 files, 387 passed (admin-scope fence 194) |
| `npx pnpm@9.15.9 --filter @recx/shared test` | 22 files, 497 passed (`accommodation.test.ts` 29) |
| `npx vitest run` in `apps/web` (Windows) | 88 files passed, 24 skipped (DB); 1703 passed, 142 skipped |
| my web unit tests | admin-scope 26, roster-csv 9, roster-plan 18, admin-rbac 144, announcements 8, admin-nav 16, admin-judge 18 |
| WSL, `scratchpad/b_dbtest.sh` (sync, then `RECX_DB_TESTS=1 RECX_REDIS_TESTS=1 … --filter @recx/web exec vitest run` on the six files below) | 6 files, 32 passed: admin-scope.db 6, roster-import.db 7, accommodations.db 7, announcements.db 5, admin-plans.db 4, seed-plans.db 3 |
| `npx pnpm@9.15.9 --filter @recx/web typecheck` (src and e2e) | exit 0 |
| `npx pnpm@9.15.9 --filter @recx/shared typecheck`; `tsc -p tests/repo/tsconfig.json` | exit 0 |
| `npx eslint --max-warnings=0` on every file above | exit 0 |

The DB tests left no trigger disabled in recx_test.

**Requests** (no schema changes, no new dependencies)
- **Integration:**
  - add my actions to `STAFF_CAPABILITIES`;
  - add a11y rows to `e2e/a11y.spec.ts` (stream E's shared file) for `/admin`, `/admin/students`, `/admin/students/import`, `/admin/reports`, `/admin/accommodations` and `/admin/announcements/new`;
  - add a scoped admin account to `e2e/support/accounts.ts`, which is not in my ownership row.

**Not verified**
- The `/dashboard` size budget. The banner's Dismiss button adds client code to that route, and I did not run a build.
- Layout at 375 px. I started no server, so the admin pages have not been rendered or run through axe.