## Phase 4 foundation report: all ten deliverables done, every gate green

I checked each part the previous agent did and finished the rest. The migration it had already applied is correct and matches the file on disk (same checksum in recx and recx_test), so I did not create a follow-up migration (`20261010100050`). I found one defect in the inherited work: `frozen-children.test.ts` failed typecheck (TS2353). The nested creates passed `problemId: undefined`, and I fixed that with a `bornContent()` helper.

### Files created or changed
Repo root: `C:\Users\SUBASH\OneDrive\Documents\GitHub\REC-CODE`
- **Changed:**
  - `packages/db/prisma/schema.prisma`
  - `packages/db/src/frozen.ts`
  - `packages/db/src/index.ts`
  - `packages/db/test/enum-parity.test.ts`
  - `packages/shared/src/index.ts`
  - `packages/shared/package.json` (adds the `"./authoring"` export, same style as `./harness`; no typesVersions or tsconfig paths exist)
  - `apps/web/src/lib/errors.ts`
  - `apps/web/scripts/seed.ts`
  - `apps/web/package.json`
  - `apps/scheduler/package.json`
  - `pnpm-lock.yaml`
  - `docs/RUNBOOK.md` (seeded accounts listed)
  - `docs/OPEN-QUESTIONS.md` (new section `## Phase 4 decisions` with `### Phase 4 — foundation`; the streams append under it)
- **Created:**
  - `packages/db/prisma/migrations/20261010100000_phase4_admin_authoring/migration.sql`
  - `packages/db/test/frozen-coverage.test.ts`
  - `packages/db/test/frozen-children.test.ts`
  - `packages/db/test/support/frozen-factories.ts`
  - `packages/db/test/support/test-db.ts`
  - `packages/shared/src/proctor.ts`
  - `packages/shared/src/accommodation.ts`
  - `packages/shared/src/authoring/index.ts`
  - `apps/web/test/errors.test.ts`

### What each part provides
- **Schema:** every model, enum and field from PLAN decisions 1, 2 and 19, with `///` comments stating the invariants.
- **Frozen guard:** the init `ProblemVersion_frozen_guard` refuses every UPDATE once `OLD."frozenAt"` is set. The new columns therefore freeze with the version, with no change to that trigger. Both a static test and a DB test prove it.
  - `@recx/db` exports `FrozenVersionError`, `FROZEN_CHILD_MODELS` and `FROZEN_EXEMPT_MODELS`. The exempt set is Problem, Submission, RunRequest, ValidationRun and ProblemReview.
  - Born-frozen creates are refused, including an `upsert` that would insert.
  - `createManyAndReturn` and `updateManyAndReturn` are covered.
- **errors.ts:** adds `ConflictError` (409), `ImpersonationReadOnlyError extends ForbiddenError`, `IMPERSONATION_READ_ONLY_MESSAGE`, `FROZEN_VERSION_CONFLICT_MESSAGE` and `isFrozenVersionError`.
  - `runAction` recognises `FrozenVersionError` by its name, not by `instanceof`. That way `lib/errors.ts` never loads Prisma, since client components import it with `import type`.
  - A write that only the database trigger refuses (a nested write the guard cannot see) still gets the generic message with a reference id.
- **Shared enum mirrors:** `PROCTOR_EVENT_KINDS` (24, in Prisma order), `ProctorEventKind` and `proctorEventKindSchema`; `ACCOMMODATION_KINDS` and its type; `CONTENT_ORIGINS` and its type at `@recx/shared/authoring`. All three pairs are in the enum-parity test.

### Partial-index decision: kept, so the advisory-lock trigger fallback is not used
Postgres 17, Prisma 6.16.2, shadow database `recx_shadow_check`:
1. `prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma --shadow-database-url <shadow> --exit-code` printed `No difference detected.` with **exit code 0**.
2. Control: a temporary copy of the migrations plus one extra ordinary (non-partial) index on AdminScope gave `[-] Removed index on columns (reason)`, **exit code 2**.
3. Control: a temporary copy with the 3 partial indexes removed printed `No difference detected.`, exit code 0. Prisma does not diff partial indexes.

The three indexes in `recx`:
- `AdminScope_active_grant_key` on (adminId, departmentCode, batchYear) `NULLS NOT DISTINCT WHERE ("revokedAt" IS NULL)`
- `Accommodation_one_approved_per_user` on (userId) `WHERE status='APPROVED'`
- `Accommodation_one_open_request_per_user` on (userId) `WHERE status='REQUESTED'`

The outcome is recorded as a comment in the migration. What the streams need to know:
- A duplicate shows up as `unique_violation` (Prisma P2002).
- The indexes are not deferrable. To approve a superseding accommodation, the old row must leave APPROVED first, in the same transaction.

I also checked every hand-written rule with 33 SQL checks in a rolled-back transaction on recx_test: 0 failures, nothing left behind. They covered AdminScope uniqueness, the Accommodation CHECKs, granted-terms immutability and the APPROVED/REQUESTED uniqueness, the PrivilegedOperation two-person, expiry and immutable-request rules, the ImpersonationSession limits, the Announcement CHECKs, and `approval_state`.

### Dependencies
All versions are pinned exactly and are at least two weeks old on 2026-10-10:
- **apps/web:** `yauzl` 3.4.0 (published 2026-06-07, latest); devDependency `@types/yauzl` 3.4.0 (2026-06-13, latest). 3.4.0 exists and matches yauzl's major version.
- **apps/scheduler:** `nodemailer` 10.0.10 (2026-09-14). 10.0.11 to 10.0.16 are less than two weeks old. devDependency `@types/nodemailer` 8.0.2 (2026-09-15, latest).
- nodemailer 10 ships its own type declarations, and TypeScript resolves to `nodemailer/dist/esm/nodemailer.d.ts` (checked with traceResolution). So `@types/nodemailer` is installed as planned but effectively unused.
- The lockfile diff only adds these four packages and `pend@1.2.0`. The mirror's `pnpm install --frozen-lockfile` succeeded.

### Seeded accounts (no passwords)
Staff use `SEED_ADMIN_PASSWORD`; students use `SEED_STUDENT_PASSWORD`.

| Account | Role | Cohort |
|---|---|---|
| RECADMIN01 | SUPER_ADMIN | — |
| RECSUPER02 | SUPER_ADMIN | — |
| RECADMIN02 | ADMIN | AdminScope: CSE, every batch, reason "seed", granted by RECADMIN01 |
| 2116231001001, 2116231001002, 2116231001003, 2116231001004 | STUDENT | CSE 2027, section A |
| 2116226002001, 2116226002002 | STUDENT | ECE 2026, section A |

- The RECADMIN02 scope is created only while that admin has no AdminScope row at all, so re-seeding never undoes a revoke made in the app.
- I ran the seed twice against `recx`. Run 1 created the 6 new accounts and 1 scope grant. Run 2 printed `admin scope RECADMIN02: 1 grant(s), 1 active — kept` and changed nothing. After both runs: 9 users and 1 audit row for the grant. Both runs exited 0.
- No test counts seeded users.

### Gate output

**Windows**

| Gate | Result |
|---|---|
| `npx pnpm@9.15.9 lint` | exit 0, no findings |
| `typecheck` | exit 0; all six packages Done, plus tests/repo and scripts/load |
| `test` | exit 0 |

Windows `test` per package:

| Package | Files | Tests |
|---|---|---|
| shared | 10 passed | 252 passed |
| judge-worker | 21 passed | 376 passed |
| db | 2 passed, 3 skipped | 57 passed, 48 skipped |
| design | 6 passed | 84 passed |
| scheduler | 6 passed, 4 skipped | 111 passed, 26 skipped |
| web | 55 passed, 12 skipped | 911 passed, 87 skipped (includes errors.test.ts, 10 tests) |
| repo | 6 passed | 134 passed |

**Linux mirror** (`RECX_DB_TESTS=1 RECX_REDIS_TESTS=1 corepack pnpm@9.15.9 test`, after a sync): exit 0.

| Package | Files | Tests |
|---|---|---|
| shared | 10 | 252 |
| judge-worker | 21 | 376 |
| db | 5 | 105 |
| design | 6 | 84 |
| scheduler | 10 | 138 |
| web | 67 | 998 |
| repo | 6 | 134 |

The db package breaks down as: frozen-children 25, frozen-version 16 (still green), xp-ledger 7, frozen-coverage 27, enum-parity 30.

**Migrations:** `prisma migrate status` reports `6 migrations found … Database schema is up to date!` on both recx and recx_test. In both databases all 14 triggers are enabled, and `seedManaged=true` is set for arrays-hashing-basics and rec-starter-sheet in recx. `prisma generate` ran on Windows and in the mirror.

**Drift check:** exit 0 (above).

### What I did not do
- I did not run `build`, as instructed.
- I did not start the judge worker, scheduler or any Next server.
- Nothing is blocked. The mirror matches Windows for every file listed above.

## Fix-up (20261010100050)

Every finding from the two verifier reports (out-p4v_db.md, out-p4v_app.md) is fixed. `20261010100000_phase4_admin_authoring` was not edited; all database changes are in the new migration `packages/db/prisma/migrations/20261010100050_phase4_foundation_fixes/migration.sql`, applied with `migrate deploy` to recx and recx_test (same checksum `66d6fdee…` in both and on disk). The drift check against a private shadow database printed `No difference detected.` with **exit code 0**; the shadow was dropped.

### Files changed
- **Created:** `packages/db/prisma/migrations/20261010100050_phase4_foundation_fixes/migration.sql`, `packages/db/test/governance-invariants.test.ts`
- **Changed:** `packages/db/prisma/schema.prisma` (`///` comments only), `packages/db/src/frozen.ts`, `packages/db/src/index.ts`, `packages/db/test/frozen-coverage.test.ts`, `packages/db/test/frozen-children.test.ts`, `apps/web/src/lib/errors.ts`, `apps/web/test/errors.test.ts`, `apps/web/scripts/seed.ts`, `apps/scheduler/package.json`, `pnpm-lock.yaml`, `docs/OPEN-QUESTIONS.md`

### What the streams must know

**1. New triggers mean DB-test teardown must lift them.** These row triggers refuse DELETE: `PrivilegedOperation_request_immutable`, `AdminScope_grant_immutable`, `Accommodation_granted_terms_immutable` (granted rows only) and `ImpersonationSession_immutable`. A DB test that creates such rows must clean up the way `governance-invariants.test.ts` does: one `db.$transaction([...])` that runs `ALTER TABLE … DISABLE TRIGGER "<name>"`, deletes its rows, runs `ENABLE TRIGGER`, and then asserts `disabledTriggers(db)` is empty. Delete by the suite's own user ids. TRUNCATE is refused on PrivilegedOperation, Accommodation, AdminScope, ImpersonationSession, ProblemVersion, every frozen child table and TestBlob (`<Table>_no_truncate`), so a test can never reset these tables with TRUNCATE. Nothing in the repo used TRUNCATE (repo-wide grep), so all thirteen tables got the trigger.

**2. State machines and column rules (every refusal is SQLSTATE 23514 check_violation; the message names the rule).**
- **PrivilegedOperation**
  - Insert only as an undecided PENDING request: no decidedById, decidedAt, decisionNote, breakGlass, execution fields or downloads (`PrivilegedOperation_insert_pending`).
  - Status: PENDING → APPROVED | REJECTED | CANCELLED | EXPIRED; APPROVED → EXECUTING; EXECUTING → EXECUTED | FAILED. EXECUTED, FAILED, REJECTED, CANCELLED and EXPIRED are final. Nothing moves an APPROVED row to EXPIRED.
  - CHECK `PrivilegedOperation_decided_check`: APPROVED, EXECUTING, EXECUTED, FAILED and REJECTED need decidedById. CANCELLED and EXPIRED may have none.
  - The decision (decidedById, decidedAt, breakGlass, decisionNote) is written only by the UPDATE that leaves PENDING, and is final once decidedById is set. Approve, reject and break-glass must each be a single UPDATE.
  - `executionStartedAt`: set once, by APPROVED → EXECUTING. `executedAt`: set once, by EXECUTING → EXECUTED | FAILED. `result` and `error`: only in that same final UPDATE. `artifactAvailableUntil`: set once, only in the EXECUTING → EXECUTED UPDATE (the PII_EXPORT executor must hand it to the finishing UPDATE, not write it while EXECUTING). `artifactDownloads`: only increases, only while EXECUTED. The 3-download cap stays the route's conditional `artifactDownloads < 3` increment.
  - Request fields (now including `id`) never change; no DELETE.
- **AdminScope**
  - adminId, departmentCode, batchYear, reason, grantedById and createdAt never change: re-scoping is a revoke plus a new grant.
  - revokedAt and revokedById are set once and together (CHECK `AdminScope_revoke_pair_check`), so a revoke must write both.
  - No DELETE.
- **Accommodation**
  - Status: REQUESTED → APPROVED | REJECTED | WITHDRAWN; APPROVED → REVOKED | SUPERSEDED. The other four are final.
  - The decision fields (approvedBySuperAdminId, grantedAt, decidedById, decidedAt, decisionNote, revokedById, revokedAt) are set once. A revoke reason therefore goes into the audit row, or into `decisionNote` only while that is still null.
  - CHECK `Accommodation_granted_status_check`: grantedAt only on APPROVED, REVOKED or SUPERSEDED.
  - supersedesId is frozen once grantedAt is set; it is free while REQUESTED.
  - Supersede order, verified in the test: in ONE transaction the old row goes APPROVED → SUPERSEDED first, then the new row is approved (or, for approveNow, INSERTed as APPROVED). The reverse order fails with unique_violation on `Accommodation_one_approved_per_user`.
  - A row that was never granted may still be deleted.
- **ImpersonationSession**
  - impersonatorId, targetUserId, reason, startedAt and expiresAt never change: no extension and no sliding window.
  - endedAt and endReason are set once and together (CHECK `ImpersonationSession_end_pair_check`); an ended session is never reopened.
  - CHECK `ImpersonationSession_window_check`: expiresAt > startedAt.
  - No DELETE. `Session.impersonationId` is SetNull, but since the row is never deleted, the close path must clear the pointer.
- **Announcement**
  - While publishedAt is null (a draft), everything is editable.
  - publishedAt, publishedById, archivedAt and archivedById are set once.
  - Once published, title, body, tone, link, the audience fields and recipientCount are fixed. **Set recipientCount in the same UPDATE as publishedAt.**
  - endsAt stays writable, and a row can still be deleted.
- **Error shapes through Prisma**
  - A trigger refusal or a CHECK violation carries the rule's message text (e.g. "cannot move from PENDING to EXECUTING", or the constraint name).
  - A partial-index duplicate is P2002 from a model call. From `$executeRaw` it is `Code: 23505` with the key detail, not the index name.

**3. Error codes in `FrozenVersionError`.** `@recx/db` exports `FrozenVersionError` with `code: "frozen" | "born_frozen"` (type `FrozenVersionErrorCode`), plus `FROZEN_VERSION_MESSAGE` and `BORN_FROZEN_MESSAGE`. The constructor is now `new FrozenVersionError(code = "frozen", message?)`; the old message-first form no longer type-checks.
- In `apps/web/src/lib/errors.ts`, `isFrozenVersionError` still matches by name (either code). The new `isFrozenVersionConflict` matches name plus `code === "frozen"`; neither uses `instanceof FrozenVersionError`.
- `runAction` shows `FROZEN_VERSION_CONFLICT_MESSAGE` only for code `"frozen"`.
- `"born_frozen"` (always a code bug) and a same-named error without the code take the generic path: `console.error` with a reference id, and the generic message carrying that reference.

**4. Static fence (`frozen-coverage.test.ts`, runs on Windows).**
- It holds `GUARD_FUNCTIONS` (all 13 `recx_refuse_*` functions, including the audit and XP ledger ones), `GUARD_TRIGGERS` (all 31 guard triggers with timing, table and function) and `PARTIAL_UNIQUE_INDEXES`.
- **A new guard function or guard trigger must be added to those lists, or the test fails.**
- It checks that:
  - the latest definition of each guard function still contains `RAISE EXCEPTION`;
  - the latest `CREATE [OR REPLACE] TRIGGER` of each guard keeps its timing, table and function;
  - no migration has `DROP FUNCTION`, `ALTER FUNCTION`, `DROP TRIGGER`, `ALTER TRIGGER` or `DISABLE TRIGGER` for a guard (or `DISABLE TRIGGER ALL|USER`);
  - each of the three partial unique indexes is created exactly once with its columns and WHERE predicate (and NULLS NOT DISTINCT for AdminScope), and is never dropped or altered.
- The detectors have their own flag/no-flag self-tests.

**5. Seed (`apps/web/scripts/seed.ts`).**
- An existing account (matched by collegeId) gets only the profile fields the seed owns: firstName, lastName, email, handle, batchYear, departmentCode and section.
- role, status and passwordHash are written only when the account is created. A differing role is kept and logged.
- I ran the seed twice in the mirror against recx: all three snapshots (before run 1, after run 1, after run 2) had **identical row counts across all 60 public tables**, and both runs exited 0.
- Between the runs I set RECADMIN02 to STUDENT and 2116231001003 to SOFT_RESTRICTED. Run 2 kept both (it logged `kept RECADMIN02's role STUDENT …`), and the password hashes were unchanged. I then restored both accounts (RECADMIN02 ADMIN, every account ACTIVE).
- Neither seed password appears in the logs.

**6. Dependencies.** I removed `@types/nodemailer` from `apps/scheduler/package.json` and ran `npx pnpm@9.15.9 install`.
- The lockfile diff only removes the `@types/nodemailer@8.0.2` importer entry, package and snapshot.
- `install --frozen-lockfile` reports `Lockfile is up to date` with exit 0 on Windows and in the mirror.
- The scheduler typecheck exits 0. A virtual scheduler file that uses `nodemailer` and `nodemailer/lib/smtp-transport` type-checks against nodemailer's own `dist/esm/nodemailer.d.ts`, and a deliberate type error in it is caught.
- The OPEN-QUESTIONS foundation note now says the package was removed.

**7. schema.prisma comments.**
- For PrivilegedOperation, ImpersonationSession, AdminScope, Accommodation and Announcement, the comments now separate the rules the database enforces (each named) from the rules only the app enforces.
- The ProblemVersion and TestBlob comments mention the TRUNCATE triggers.
- The `Session.impersonationId` comment no longer claims the impersonation row "goes away".
- No model changed.

### Verification
- **SQL probe:** all migrations applied to a private scratch database, plus about 100 allowed and refused cases; every rule behaved as intended. The scratch database was dropped.
- **Mutation check:** I applied 17 mutants, each weakening one rule, to the mirror's copy of the fix-up migration on a private scratch `_test` database. `governance-invariants.test.ts` failed on every one (1 to 13 failing tests each). The unmutated baseline passed 33/33. The mirror copy was restored and is byte-identical to Windows.
- **Databases:** recx and recx_test each have 31 user triggers enabled and 0 disabled, and the 5 new CHECKs are validated. No private shadow or scratch database is left.

### Gate output
**Windows**

| Gate | Result |
|---|---|
| `npx pnpm@9.15.9 lint` | exit 0 |
| `typecheck` | exit 0; all six packages Done, plus tests/repo and scripts/load |
| `test` | exit 0 |

| Package | Files | Tests |
|---|---|---|
| shared | 10 passed | 252 passed |
| judge-worker | 21 passed | 376 passed |
| db | 2 passed, 4 skipped | 114 passed, 81 skipped |
| design | 6 passed | 84 passed |
| scheduler | 6 passed, 4 skipped | 111 passed, 26 skipped |
| web | 55 passed, 12 skipped | 914 passed, 87 skipped (errors.test.ts: 13) |
| repo | 6 passed | 134 passed |

**Linux mirror** (`RECX_DB_TESTS=1 RECX_REDIS_TESTS=1 corepack pnpm@9.15.9 test`, after a sync): exit 0, and 0 triggers left disabled in recx_test.

| Package | Files | Tests |
|---|---|---|
| shared | 10 | 252 |
| judge-worker | 21 | 376 |
| db | 6 | 195 |
| design | 6 | 84 |
| scheduler | 10 | 138 |
| web | 67 | 1001 |
| repo | 6 | 134 |

The db package breaks down as: governance-invariants 33, frozen-children 25, frozen-version 16, xp-ledger 7, frozen-coverage 84, enum-parity 30.

**Drift check:** exit 0.

### Not done, by scope
- The append-only `AuditLog` and `XpEvent` tables did not get TRUNCATE triggers, because the task listed only the thirteen tables above. Their row triggers are now covered by the static fence.
- Nested writes that only a database trigger refuses still show the generic message. That is the documented decision (app verifier finding 3, informational).

## Fix-up 2 (20261010100080)

The remaining low-severity database gaps from the verifier's third report are closed by a new migration, `packages/db/prisma/migrations/20261010100080_phase4_foundation_fixes_2/migration.sql`. No applied migration was edited. It is applied with `migrate deploy` (both URL overrides) to recx_test and then recx, with checksum `0e477fadbebfae3f…` in both databases and on disk. Every refusal is SQLSTATE 23514 `check_violation`, and each section of the migration has a `-- ── <stream>: <purpose> ──` header.

### Files
- **Created:**
  - `packages/db/prisma/migrations/20261010100080_phase4_foundation_fixes_2/migration.sql`
  - `packages/db/test/guard-state.db.test.ts`
  - `packages/db/test/support/guard-catalog.ts`
  - `packages/db/test/support/sql-text.ts`
- **Changed:**
  - `packages/db/test/frozen-coverage.test.ts`
  - `packages/db/test/governance-invariants.test.ts`
  - `packages/db/test/support/test-db.ts` (`disabledTriggers` now reports any trigger whose `tgenabled` is not `'O'`)
  - `packages/db/prisma/schema.prisma` (`///` comments only; the drift check is clean)
  - `docs/OPEN-QUESTIONS.md` (a new bullet under `### Phase 4 — foundation`)

### What the governance and admin actions must do
Every rule below is enforced by the database. An action that does not follow it gets a 23514 error. A CHECK error names the constraint; a trigger error carries the rule's message. A partial-index duplicate is still P2002 / 23505.

**PrivilegedOperation (governance)**
- **Request.**
  - `createPrivilegedOperation` INSERTs a PENDING row with no decision or execution fields.
  - Leave `requestedAt` at its default (now). The database refuses a value more than 5 minutes from its own clock.
  - `expiresAt` must be after `requestedAt` and at most 24 hours later.
- **Decide (approve, reject, break-glass) in ONE UPDATE.** That UPDATE writes `status` together with `decidedById` and `decidedAt`:
  - `decidedById` and `decidedAt` always go together (`PrivilegedOperation_decision_pair_check`).
  - `decidedAt` must be at or after `requestedAt`.
  - `breakGlass` is true exactly when `decidedById = requestedById`.
  - `decisionNote` is optional, and only in that same UPDATE.
  - The database refuses the UPDATE once its clock (`statement_timestamp()`) has reached `expiresAt`. Make the conditional update use the same clock, so the boundary is decided in one place: `UPDATE … WHERE "id" = $1 AND "status" = 'PENDING' AND "expiresAt" > (statement_timestamp() AT TIME ZONE 'UTC')`, then treat 0 rows as "expired or already decided". An app-clock `expiresAt: { gt: new Date() }` still works, but near the boundary it can raise 23514 ("expired at … can no longer be approved or rejected"). Map that to the expired message.
- **Cancel (requester).** UPDATE `status = 'CANCELLED'` with no `decidedById`, no `decidedAt` and no `breakGlass` (`PrivilegedOperation_undecided_close_check`). An optional `decisionNote` may go in that same UPDATE.
- **Expiry sweep (scheduler).**
  - UPDATE `status = 'EXPIRED'` with no decider, no `decidedAt` and no `breakGlass`.
  - The database refuses EXPIRED before `expiresAt` on its clock. Select by the database clock: `WHERE "status" = 'PENDING' AND "expiresAt" <= now()`. `now()` (the transaction start) is never later than the trigger's `statement_timestamp()`.
  - Do not use the scheduler's own clock. One row it judges expired too early aborts the whole batch UPDATE.
- **Execute.**
  - The claim is APPROVED → EXECUTING and must set `executionStartedAt` in that UPDATE (CHECK). It is deliberately not time-limited: an approval may run after `expiresAt`.
  - The finishing UPDATE is EXECUTING → EXECUTED or FAILED. It must set `executedAt` (CHECK) and may set `result` or `error`.
  - **PII_EXPORT → EXECUTED must set `artifactAvailableUntil` in that same UPDATE** (CHECK `PrivilegedOperation_export_artifact_check`).
  - The sweep that fails a stuck EXECUTING row must also write `executedAt`.
- Downloads are unchanged: a conditional `artifactDownloads < 3` increment, only while EXECUTED.

**ImpersonationSession (governance)**
- **Start.** INSERT with the default `startedAt` (now). The database refuses a value more than 5 minutes from its clock. The 15-minute box and `expiresAt > startedAt` are unchanged.
- **End.** ONE UPDATE that sets `endedAt` and `endReason` together (`ImpersonationSession_end_pair_check`), conditional on `endedAt IS NULL`. `endedAt` must be at or after `startedAt` (`ImpersonationSession_end_after_start_check`). When the closing machine's clock may lag, write `endedAt = GREATEST(now, startedAt)`, or use the database `now()`.

**Accommodation (admin; approve, reject and revoke run as SUPER_ADMIN)**
- **INSERT only as REQUESTED**, with no `approvedBySuperAdminId`, `grantedAt`, `decidedById`, `decidedAt`, `decisionNote`, `revokedById` or `revokedAt`.
  - `supersedesId`, if set, must name another accommodation of the **same student**, never the row itself.
  - A second open request for the same student is P2002 (`Accommodation_one_open_request_per_user`).
- **Approve** (`approveAccommodation`, and approve-now) is ONE UPDATE REQUESTED → APPROVED that writes `approvedBySuperAdminId`, `grantedAt`, `decidedById` and `decidedAt`, plus an optional `decisionNote`.
- **Reject** is ONE UPDATE → REJECTED that writes `decidedById`, `decidedAt` and `decisionNote`. It must not write an approver or `grantedAt`.
- **Withdraw** is ONE UPDATE → WITHDRAWN that writes `decidedById` (the person withdrawing, either the requester or a SUPER_ADMIN) and `decidedAt`. The note is optional.
- **Revoke** is ONE UPDATE APPROVED → REVOKED that writes `revokedAt` and `revokedById` together (`Accommodation_revoke_pair_check`).
  - Revoke fields are NULL on every other status.
  - **The revoke reason goes to the audit row only.** `decisionNote` cannot be written after the update that left REQUESTED.
- **Decision fields** (`decidedById`, `decidedAt`, `decisionNote`, `approvedBySuperAdminId`, `grantedAt`) are written only by the UPDATE that leaves REQUESTED. After that they never change. No action may "add a note later".
- **Never changes:** `id`, `userId`, `requestedById` and `requestedAt`. `documentFileId` is editable only until the grant.
- **Approve now** (SUPER_ADMIN): one transaction that **INSERTs the row as REQUESTED and then runs the approving UPDATE**. Inserting APPROVED is refused. If the student already has an open REQUESTED row, the INSERT fails with P2002. Refuse with "decide the open request first", or approve that request instead.
- **Supersede order.** In ONE transaction:
  1. The successor exists as REQUESTED with `supersedesId` = the old row and the same `userId`. For approve-now, INSERT it now.
  2. UPDATE the old row APPROVED → SUPERSEDED. The database refuses this unless that REQUESTED successor exists.
  3. UPDATE the successor REQUESTED → APPROVED, the single approving UPDATE above.

  Doing step 3 before step 2 fails with 23505 on `Accommodation_one_approved_per_user`. Once the old row is SUPERSEDED, the successor can only be approved: it cannot be withdrawn, rejected, unlinked or deleted.
- **Delete.** Only a row that was never granted, and never the REQUESTED successor of a SUPERSEDED row.

**Announcement (admin)**
- **`saveAnnouncementDraft` INSERTs a draft.** It has no `publishedAt`, `publishedById`, `archivedAt` or `archivedById`, and `recipientCount` stays at 0.
- **`publishAnnouncement`** is ONE UPDATE that sets `publishedAt`, `publishedById` and `recipientCount` together (`Announcement_publish_pair_check`).
- **`archiveAnnouncement`** sets `archivedAt` (and `archivedById` if used) once.
- **Delete.** Only drafts may be deleted. A published row, archived or not, is refused: archive it instead.

**Ledgers**
- TRUNCATE is refused on `XpEvent`, `AuditLog` and `Announcement` as well (16 tables in all).
- AuditLog row DELETE stays allowed for the 3-year retention purge (legal hold excepted). UPDATE is still refused.

### DB-test teardown (governance, admin and integration test suites)
- Create fixtures only through the allowed paths:
  - an Accommodation is INSERTed REQUESTED and then UPDATEd;
  - an Announcement is INSERTed as a draft and then published;
  - an "already expired" PrivilegedOperation uses `requestedAt = now − 4 min` and `expiresAt = now − 3 min`, which is inside the insert window;
  - a "lapsed" impersonation uses `startedAt = now − 4 min` and `expiresAt = now − 1 min`.
- **Never TRUNCATE.** Delete your own rows by your own ids.
- In ONE `db.$transaction([...])`, run `ALTER TABLE … DISABLE TRIGGER "<name>"` for every delete guard on the tables you clean, delete the rows, then `ENABLE TRIGGER` each one. Afterwards assert `disabledTriggers(db)` is empty. It now also reports REPLICA ('R') and ALWAYS ('A') triggers.
- The delete guards are:
  - `PrivilegedOperation_request_immutable`
  - `AdminScope_grant_immutable`
  - `Accommodation_granted_terms_immutable`
  - `ImpersonationSession_immutable`
  - `Announcement_published_immutable` (**new: published rows**)
  - `XpEvent_append_only`
  - `ProblemVersion_frozen_guard`
  - `<Child>_frozen_guard`

  `governance-invariants.test.ts` shows the pattern.
- A `<Table>_no_truncate` trigger never needs lifting, because tests do not truncate.

### Static and live fence
**Catalogue** (`test/support/guard-catalog.ts`):
- 16 guard functions;
- 37 guard triggers, 16 of them `_no_truncate` triggers;
- 43 hand-written CHECKs, from every migration through `CHECK_CATALOG_THROUGH = 20261010100080`;
- 3 partial unique indexes.

**`frozen-coverage.test.ts`** (static, 84 tests, runs on Windows) now:
- parses SQL with a lexer, so comments (nested ones too) never count as code, and function bodies quoted with any dollar tag are found;
- requires every guard function to be dollar-quoted plpgsql whose live body raises;
- anchors each guard trigger's whole definition: exact events, no `UPDATE OF`, no WHEN clause except the one known `ProblemVersion_born_frozen_guard` predicate;
- flags DISABLE TRIGGER, ENABLE REPLICA/ALWAYS TRIGGER and DISABLE TRIGGER ALL/USER on guarded tables, and any `session_replication_role` setting;
- flags DROP, RENAME or ALTER CONSTRAINT of a listed CHECK, and a listed CHECK that is NOT VALID, created twice, missing or on the wrong table;
- flags a CHECK in migrations through the cutoff that is not listed.

Every rule has self-tests with flagged and clean snippets.

**`guard-state.db.test.ts`** (live, 86 tests) checks the database itself:
- every catalogued trigger exists once on its table, runs its function, fires on exactly its events (`tgtype`), has no column list and only its allowed WHEN, and has `tgenabled = 'O'`;
- no other trigger runs a guard function;
- no user trigger anywhere is in a state other than 'O';
- each guard function exists once, is plpgsql and raises;
- every CHECK exists on its table and is validated;
- the partial indexes are unique, valid and keep their predicates;
- `session_replication_role` is `origin` and is not overridden for a database or role.

### Verification
**Drift check** (private shadow `recx_shadow_f2_*`, dropped afterwards): `No difference detected.`, **exit 0**. Live recx and recx_test against the schema: exit 0.

**Mutation check (database).** Each mutant weakened one rule in a clone of a template database that had all eight migrations; the mutations were applied as SQL. `governance-invariants` and `guard-state` were then run against the clone. **50 of 50 mutants were caught.** The unmutated baseline passed 138/138. The mutants covered:
- every new trigger branch: Accommodation insert, identity, needs-successor, successor lock (update and delete), set-once, decision-only-when-leaving-REQUESTED, supersedes same-student and self (insert and update), `documentFileId`; PrivilegedOperation insert window, decide-after-expiry, expire-before-expiry; ImpersonationSession insert window; Announcement insert, no-delete, and the trigger narrowed to UPDATE;
- every new CHECK replaced by `CHECK (true)` under the same name, which needed the trigger-off probes for `Accommodation_requested_undecided_check`;
- the three new `_no_truncate` triggers dropped;
- live-only changes: ENABLE REPLICA, ENABLE ALWAYS (only `guard-state` catches it), a dropped `two_person` CHECK, a dropped `Hint_tier_check` (only `guard-state`), a NOT VALID CHECK (only `guard-state`), a WHEN clause, a dead-branch RAISE (16 behaviour tests), and a dropped partial index.

**Static fence mutants**, run on a throw-away copy outside the workspace with one extra migration each: **21 of 22 caught.** The one not caught is the verifier's M6 (RAISE kept only in a dead `IF false` branch). It is a semantic change that a static fence cannot judge; the database mutant `live_dead_branch_raise` shows the TRUNCATE tests catch it. The 21 caught include:
- the verifier's M1–M5;
- `$fn$` and `$body$` bodies;
- a commented-out raising copy, and a RAISE only inside a body comment;
- a single-quoted body;
- `UPDATE OF`, and the born-frozen WHEN widened;
- ENABLE ALWAYS, DISABLE TRIGGER USER and ALL;
- `session_replication_role`;
- DROP CONSTRAINT IF EXISTS and RENAME CONSTRAINT;
- a trigger re-pointed to another function;
- DISABLE inside a DO block.

**Databases.** recx and recx_test each have 37 user triggers, all 'O', and 43 public CHECKs, all validated. Only postgres, recx and recx_test exist; every private scratch or shadow database was dropped.

### Gates
**Windows**

| Gate | Result |
|---|---|
| `npx eslint packages/db --max-warnings=0` | exit 0 |
| `--filter @recx/db typecheck` | exit 0 |
| `--filter @recx/db test` | exit 0; 2 passed, 5 skipped (DB); 114 passed, 186 skipped |
| repo tests | 7 files, 139 passed |
| Full `npx pnpm@9.15.9 lint` | exit 0 |
| Full `typecheck` | exit 0; all six packages Done |
| Full `test` | exit 0 |

Full `test` per package:

| Package | Files | Tests |
|---|---|---|
| shared | 17 | 438 |
| judge-worker | 23 | 403 |
| db | 2 passed, 5 skipped | 114 passed, 186 skipped |
| design | 6 | 84 |
| scheduler | 6 passed, 4 skipped | 111 passed, 26 skipped |
| web | 65 passed, 12 skipped | 1068 passed, 87 skipped |
| repo | 7 | 139 |

**Linux mirror** (after a sync):

| Suite | Result |
|---|---|
| `RECX_DB_TESTS=1 RECX_REDIS_TESTS=1` packages/db | 7 files, **300/300**, exit 0 |
| apps/web DB suites (12 `*.db.test.ts` + `judge-routes`) | 13 files, **98/98**, exit 0 |

The packages/db breakdown is governance-invariants 52, guard-state 86, frozen-coverage 84, frozen-children 25, frozen-version 16, xp-ledger 7 and enum-parity 30. recx_test had 0 non-'O' triggers before and after.

`prisma generate` ran on Windows and in the mirror.

### Left to the application (unchanged, recorded in OPEN-QUESTIONS)
- The PII-export 3-download cap and its download window.
- The value of `AdminScope.revokedAt`.
- Later CHECK migrations (e.g. the function-comparator CHECKs) must be added to `HAND_WRITTEN_CHECKS`, with `CHECK_CATALOG_THROUGH` moved forward.

## Coordinator decisions after Fix-up 2 (binding for streams A, B, C)

1. **Accommodation revoke reason.** The database refuses `decisionNote` on a revoke. Pass the revoke reason as `revokeReason` in the audit metadata of `accommodation.revoked`.
   - This is the one exception to the admin design's accommodation-metadata allow-list.
   - The revoke form must say: "Do not include medical or disability details."
   - `kinds`, the accommodation `reason` and `decisionNote` still never go into audit metadata.
   - Stream B: record this in OPEN-QUESTIONS.
2. **Concurrency in accommodation decisions.** Every action that changes an accommodation's status must first lock every row it reads or changes, in one transaction: `SELECT … FOR UPDATE` on the target row, on the row it supersedes, and on any successor. Those actions are approve, approve-now, reject, withdraw, revoke and supersede.
   - The database successor rule is not race-safe on its own; FOR SHARE locks will be added in the integration stage.
   - Reject and withdraw of a superseding request must set `supersedesId = NULL` in the same UPDATE. A re-request then does not hit the unique index (23505).
3. **Publishing an announcement** sets `publishedAt`, `publishedById` (the actor) and `recipientCount` in ONE UPDATE. The database requires the publish pair.
4. **Clock comparisons in SQL.** The database session time zone is UTC: migration 20261010000000 sets it per database, and Prisma `DateTime` columns are `timestamp(3)` holding UTC wall-clock time.
   - In raw SQL, compare against `(statement_timestamp() AT TIME ZONE 'UTC')`, or just `now()`, which works because the session is UTC. Never pass the app clock into an expiry predicate.
   - The governance sweep (expire PENDING operations, close lapsed impersonations) must choose its rows in SQL against the database clock. A row the trigger considers not yet expired must never abort the batch: select with the same predicate the trigger checks.
   - Approve, reject and break-glass must refuse in SQL when `expiresAt <= now()`, using the same predicate.
5. **Withdraw** sets `decidedById` and `decidedAt` (the withdrawing actor) in the same UPDATE as `status='WITHDRAWN'`.
6. **Database-test teardown.** Follow the Fix-up 2 instructions exactly. Disable every delete or truncate guard inside one transaction, delete only your own tagged rows, re-enable, and assert `disabledTriggers()` is empty. Never TRUNCATE.

## Wave 1 streams have landed (D1 harness, D2 content, E /judge): what A, B, C build on

- **D1 exports** (all in the tree and tested):
  - from `@recx/shared/harness`: `comparatorIssues`, `validateFunctionTest`, `validateFunctionInput`, `starterStubs`, `checkerTemplate`, and `validationOutcome` / `effectiveVerdict` (in `harness/outcome.ts`);
  - from root `@recx/shared`: `supportsFunctionMode`, `FUNCTION_HARNESS_LANGUAGES`, `functionCompareMode`, `comparedTypeOf`, `FUNCTION_COMPARATOR_DESCRIPTIONS`.
- **D1 protocol and judging:** JUDGE_PROTOCOL_VERSION is 3. The worker judges all six FUNCTION comparators. Java runs get flags from `jvmRunFlags`.
- **Stream C (authoring)** must:
  - set `JUDGEABLE_FUNCTION_COMPARATORS` in `@recx/shared/authoring` to all six comparators;
  - in `validation.ts`, wire `supportsFunctionMode` into the runnable rule and `comparatorIssues` into approve and publish;
  - import `validationOutcome` / `effectiveVerdict` from `@recx/shared/harness` instead of duplicating them. `validation.ts` may re-export them so existing importers keep working.
- **D2** added six seed problems, REC-0007…REC-0012, to `AUTHORED_PROBLEMS`. Seeding them into the dev database happens in the integration and live stages.
- **E** added `/judge` (`app/(public)`), `PublicShell`, `components/workspace/language-version.tsx`, `server/queries/judge-languages.ts` and `revalidateLanguageConfigs()`.
  - Stream A: any `LanguageConfig` write in `/super/settings/judge` must call `revalidateLanguageConfigs()`. `setLanguageEnabled` already does.
- **Shared files touched by wave 1:**
  - `server/queries/problems.ts` (`version` and `functionUnavailable`)
  - `components/workspace/workspace.tsx` (footer)
  - `server/actions/admin-judge.ts` (`revalidateLanguageConfigs` in `setLanguageEnabled`)
  - `size-budgets.json` and `scripts/size-budget.mjs` (the /judge row and the `serverRendered` check)
  - `components/shell/nav.ts`
  - `docs/OPEN-QUESTIONS.md`

  Re-read these before editing.
