You are Phase 4 integration agent "I3 DB hardening + test infrastructure". First read C:\Users\SUBASH\AppData\Local\Temp\claude\C--Users-SUBASH-OneDrive-Documents-GitHub-REC-CODE\488a8ed9-9b4f-4a0f-9859-3a195105ba00\scratchpad\p4design\INTEGRATION-COMMON.md in full and follow it (it points you to STREAM-COMMON.md, PLAN.md, FOUNDATION-REPORT.md, the stream reports stream-*.md and the spec). Then do this task.

TASK: four parts.

OWNED FILES
- packages/db/test/support/guard-catalog.ts, packages/db/test/support/sql-text.ts
- packages/db/test/frozen-coverage.test.ts, guard-state.db.test.ts and governance-invariants.test.ts
- a new migration packages/db/prisma/migrations/20261010100200_phase4_integration_hardening/
- apps/web/vitest.config.ts and any test-infra helpers (apps/web/test/support/*db* helpers)
- apps/judge-worker/test/integration/adversarial.isolate.test.ts (box base only)
- .github/workflows/ci.yml
- scripts/dev/linux-gate.sh

1. DB fence completion (the last verifier report is in FOUNDATION-REPORT plus the fix-2 verify notes; the key items are below).
   (a) Add D1's three CHECKs from migrations/20261010100100_function_comparator_checks to HAND_WRITTEN_CHECKS, and move CHECK_CATALOG_THROUGH forward.
   (b) Live allow-list in guard-state.db.test.ts: the set of ALL triggers on every guarded table must equal an explicit expected list, so an extra trigger like a BEFORE UPDATE "AdminScope_touch" fails. Each guard trigger's tgfoid must equal 'public.<fn>'::regprocedure. No recx_refuse_* function may exist outside the public schema.
   (c) Static fence: flag any SET search_path in migrations, and any CREATE TRIGGER on a guarded table that is not in the catalog. Self-tests for each.
   (d) New migration 20261010100200:
       - In the Accommodation successor checks (both the "successor exists" and the "successor lock" rule), lock the rows the trigger reads with FOR SHARE or FOR UPDATE, so the concurrent races r1–r3 from the fix-2 verification (A SUPERSEDED with a withdrawn or deleted successor) are impossible.
       - CHECK decidedAt and grantedAt >= requestedAt on Accommodation.
       - PrivilegedOperation decision timestamps must not be in the future beyond the 5-minute tolerance at the deciding UPDATE.
       - Announcement: CHECK (publishedAt IS NOT NULL OR recipientCount = 0); id and createdById immutable.
       - ImpersonationSession INSERT must have endedAt NULL; endedAt may not be set more than 5 minutes ahead of the clock.
       Prove the race fix with a DB test that uses two separate connections and interleaves the transactions deterministically (for example, connection 1 locks; connection 2's statement must block or fail; check with pg_locks or a short lock_timeout).
       Apply the migration to recx_test and recx (override both DATABASE_URL and DATABASE_URL_DIRECT), run prisma generate on Windows and in the mirror, and run the drift check (exit 0) against a private shadow DB that you drop afterwards.
2. DB test parallelism. Web DB test files run in parallel against one recx_test, and teardowns that run ALTER TABLE … DISABLE TRIGGER deadlock with other suites. Stream C added apps/web/src/lib/authoring/retry.ts to retry whole transactions on 40P01 for that reason.
   - Fix the TEST side robustly. Recommended: when RECX_DB_TESTS=1, run *.db.test.ts files without file parallelism (a vitest project or poolMatchGlobs setting with fileParallelism false, or singleFork for those files). Unit tests stay parallel.
   - Measure the services-tests duration before and after.
   - Then REVIEW retry.ts and every use of it. A whole-transaction retry is only safe if the retried function has no side effects outside the transaction (audit() outside the tx, queue enqueues, blob or store writes, revalidatePath, redirect). List every call site and whether it is safe. Fix unsafe ones minimally, moving side effects after the retried transaction, or report them. Keep the retry if it is safe; production can deadlock too.
3. Box-id overlap: apps/judge-worker/test/integration/adversarial.isolate.test.ts uses self-check box base 900, which is in the live worker's maintenance range. Read apps/judge-worker/src to find the exact maintenance box ids, and move the test to a base that collides with nothing: run N, compile 100+N, checker 200+N, maintenance 900+, and the other test bases 40/50/60/70/80/90 with their derived compile and checker boxes.
4. CI (.github/workflows/ci.yml) and scripts/dev/linux-gate.sh:
   - RECX_GOLDEN_EXTRA_LANGUAGES=java21 on the isolate step;
   - make sure the DB/services step applies migrations to the test DB before the tests run, not relying on test order — add a migrate step if needed;
   - keep the existing steps.

Validate with: Windows test; mirror RECX_DB_TESTS=1 RECX_REDIS_TESTS=1 pnpm test run TWICE in a row with zero flakes; and the isolate suite (RECX_ISOLATE_INTEGRATION=1 RECX_CACHE_DIR=/tmp/recjudge-cache RECX_GOLDEN_EXTRA_LANGUAGES=java21 corepack pnpm@9.15.9 --filter @recx/judge-worker test:integration) green.