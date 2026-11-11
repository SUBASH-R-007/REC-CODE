D1 is complete. Everything was run as described below, and every suite I ran passed.

**What the other streams can use now:**
- **Imported by the authoring stream:**
  - from `@recx/shared/harness`: `comparatorIssues`, `validateFunctionTest`, `validateFunctionInput`, `starterStubs`, `checkerTemplate`;
  - from the root `@recx/shared`: `supportsFunctionMode`, `FUNCTION_HARNESS_LANGUAGES`, `functionCompareMode`, `comparedTypeOf`, `FUNCTION_COMPARATOR_DESCRIPTIONS`.
- **Protocol:** `JUDGE_PROTOCOL_VERSION` is now 3.
- **Worker:** every FUNCTION problem is compared structurally, all six comparators are judged, CUSTOM_CHECKER output is made canonical before testlib runs, and JVM runs get `-Xmx`/`-Xss` from `jvmRunFlags`.
- **Java:** the java21 harness is complete; `enabledByDefault` stays false.
- **Migration:** applied to recx_test and recx. The drift check printed `No difference detected.` and exited 0 against a temporary `recx_shadow_check`, which I created for the check and then dropped. Before applying, no frozen row in either database violated the new rules.
- **Seed problems:** D2's six problems have landed, so `seed-content` passes rather than failing as expected.

### Files created
- **`packages/shared/src/harness/`:**
  - `family.ts`: harness language map and `supportsFunctionMode`.
  - `compare.ts`: structured comparators.
  - `declaration.ts`: `comparatorIssues`.
  - `java.ts`: Java harness and stubs.
  - `remap.ts`: remapping for gcc, CPython, javac and JVM traces, hints, `renderDiagnostics`.
  - `checker-template.ts`
  - `outcome.ts`: `validationOutcome` and `effectiveVerdict`, shared with the golden test.
- **`packages/shared/test/`:** `function-compare`, `decode`, `java-harness`, `remap` (includes the line-range property test), `checker-template`, `outcome`.
- **`apps/judge-worker/test/`:**
  - `function-compare-job.test.ts`
  - `integration/golden.isolate.test.ts` (box base 70)
  - `integration/function-harness.isolate.test.ts` (base 80)
  - `integration/compile-errors.isolate.test.ts` (base 90)
- **`packages/db/prisma/migrations/20261010100100_function_comparator_checks/migration.sql`:** three CHECK constraints (checksum `ac977eab…`, the same in both databases and on disk).
- **`packages/db/test/function-comparator-constraints.db.test.ts`:** not in my ownership row, but design §10 names it.
- **`tests/repo/content-purity.test.ts`**
- **`apps/web/test/function-comparator-view.test.ts`**

### Files changed
- **`packages/shared`:**
  - `harness/signature.ts`: reserved names, comparator and type rules, descriptions.
  - `harness/values.ts`: BigInt decoder, test and input validators, ASCII-only `char`.
  - `harness/cpp.ts`: `cppReaderKit`, `null` accepted for empty trees and lists, surrogate-pair escapes, stub notes.
  - `harness/python.ts`: typed converters.
  - `harness/index.ts`
  - `languages.ts`: appended `JVM_LANGUAGE_KEYS` and `jvmRunFlags`.
  - `protocol.ts`: 2→3.
  - `index.ts`: export lines.
  - `samples/two-sum.ts`: java21 reference.
  - Tests: `harness`, `signature`, `values`.
- **`apps/judge-worker`:**
  - `src/judge/plan.ts`, `run-job.ts`, `limits.ts` (`runArgv`), `compare.ts`.
  - `src/judge/verdict.ts`: imports `JVM_LANGUAGE_KEYS` (two lines).
  - Tests: `scoring`, `run-job`, `argv`; `api`, `heartbeat`, `lifecycle` and `processor` now use `JUDGE_PROTOCOL_VERSION` instead of a hardcoded 2.
- **`apps/web`:**
  - `src/lib/judge/job-spec.ts`: the CHECKER mirror `JobSpecError`.
  - `src/lib/judge/view.ts`: `functionComparator` in the view.
  - `src/server/actions/judge.ts`: custom Run input checked with `validateFunctionInput`.
  - `src/server/queries/problems.ts`: `functionUnavailable`.
  - `src/server/queries/submissions.ts`: selects `functionSignature`.
  - `src/components/workspace/problem-description.tsx`: comparator-aware copy, the unavailable-languages note, and the `/judge#time-limits` link that stream E left for integration.
  - `src/components/workspace/result-view.tsx`: `waNote`.
  - `scripts/content/handle-maker.ts`, `scripts/content/lab-power-budget.ts`: java21 references only.
  - Tests: `seed-content`, `judge-job-spec`.
- **`scripts/dev/linux-gate.sh`:** `RECX_GOLDEN_EXTRA_LANGUAGES=java21`.
- **Docs:** `OPEN-QUESTIONS.md` (new section "### Phase 4 — D1 harness"), `ARCHITECTURE.md`, `RUNBOOK.md` (new §2.9 on the protocol-3 rollout), `JUDGE.md` (FUNCTION harness, comparators, Java, JVM flags).

### Tests run
| Suite | Command | Result |
|---|---|---|
| shared | `npx vitest run` in `packages/shared` | 17 files, 438 passed |
| judge-worker unit | `npx vitest run` in `apps/judge-worker` | 23 files, 403 passed |
| web unit | `npx vitest run` in `apps/web` | 65 passed, 12 skipped (1,068 tests); then 3 more in the new view test |
| repo | `npx vitest run --config vitest.repo.config.ts tests/repo` | 6 files, 122 passed |
| db (Windows) | `npx vitest run` in `packages/db` | 115 passed, 196 skipped |
| db (mirror) | `RECX_DB_TESTS=1 … --filter @recx/db exec vitest run test/function-comparator-constraints.db.test.ts test/frozen-coverage.test.ts` | 95 passed, 0 rows left behind |
| web (mirror, DB) | `RECX_DB_TESTS=1 … --filter @recx/web exec vitest run` on `judge-pipeline.db`, `seed-content`, `judge-job-spec`, `function-comparator-view` | 158 passed |
| isolate integration (mirror) | `RECX_ISOLATE_INTEGRATION=1 RECX_CACHE_DIR=/tmp/recjudge-cache RECX_GOLDEN_EXTRA_LANGUAGES=java21 corepack pnpm@9.15.9 --filter @recx/judge-worker test:integration` | 6 files, 260 passed in 250 s |

The 260 integration tests break down as: golden 53, function-harness 161, compile-errors 11, two-sum 15, judging 9, adversarial 11.

The first golden run, during heavy host load, had 2 failures, both "compilation exceeded resource limits". javac took 10.5 s of CPU (1.5 s on rerun), and a testlib checker went past its 25 s / 40 s caps. The same cases passed alone, and the full run above passed.

**Typecheck** exits 0 for shared, judge-worker, web, db and `tests/repo`. **eslint** with `--max-warnings=0` exits 0 on every file I touched.

### Requests for other streams
- **Authoring stream:**
  - set `JUDGEABLE_FUNCTION_COMPARATORS` in `@recx/shared/authoring` to all six comparators;
  - in `validation.ts`, wire `supportsFunctionMode` into the runnable rule and `comparatorIssues` into the publish and approve gates;
  - re-export `validationOutcome` and `effectiveVerdict` from `@recx/shared/harness`.
- **Foundation or integration stage:** add the three new CHECKs to `HAND_WRITTEN_CHECKS` in `packages/db/test/support/guard-catalog.ts` and move `CHECK_CATALOG_THROUGH` to `20261010100100_function_comparator_checks`. Until then the static fence does not protect them.
- **Integration stage, CI:** add `RECX_GOLDEN_EXTRA_LANGUAGES=java21` to the isolate step in `.github/workflows/ci.yml`. The golden test fails, rather than skips, when a toolchain or testlib is missing.
- **Live judge worker in WSL:** it is still the protocol-2 build, and I did not touch it. After the integration stage rebuilds them, the web app and worker must go out together (RUNBOOK §2.9).
- **Existing box-id overlap (not mine):** `adversarial.isolate.test.ts` uses self-check box base 900, which is the live worker's maintenance range.

### Open questions recorded
They are in `docs/OPEN-QUESTIONS.md` under "Phase 4 — D1 harness". The two that need a decision:
- Any extra standard output is currently Wrong Answer. Should the harness print a marker before the result line so debug prints are shown but ignored?
- The worker sends the comparator's reason (for example "not a valid list<int>") on visible tests. Admins see it in validation runs, but students do not see it yet; they see the comparator-aware note under the Wrong Answer instead. Should sample tests show the reason?

Nothing is left unfinished. I needed no schema change and no new dependency.